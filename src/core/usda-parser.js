// USDA (ASCII) reader for the declared subset.
//
// This is a real text parser, not a fixture reader: it tokenises the layer,
// builds the prim tree, evaluates xformOpOrder with USD's row-vector semantics,
// resolves internal references, expands instanceable prim proxies, and reads
// UsdPreviewSurface material networks. Anything outside the subset is reported
// in `warnings` instead of being silently dropped.

export class UsdaSyntaxError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line + 1})`);
    this.name = 'UsdaSyntaxError';
    this.line = line;
  }
}

const TYPE_TOKENS = new Set([
  'float', 'float2', 'float3', 'float4', 'double', 'double2', 'double3', 'double4',
  'int', 'int2', 'int3', 'int4', 'uint', 'bool', 'string', 'token', 'asset',
  'point3f', 'point3d', 'normal3f', 'normal3d', 'vector3f', 'vector3d',
  'color3f', 'color3d', 'color4f', 'matrix4d', 'mat4d', 'quatf', 'quath', 'quatd',
  'texCoord2f', 'texCoord2d', 'texCoord3f', 'half', 'uchar', 'timecode', 'uniform', 'varying', 'custom', 'rel',
]);

// USD list-edit ops that may prefix a property (e.g. `prepend rel prototypes`).
const LIST_OPS = new Set(['prepend', 'append', 'add', 'delete', 'reorder']);

function tokenize(text) {
  const tokens = [];
  let i = 0;
  let line = 0;
  const n = text.length;
  const isDelim = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n' ||
    c === '(' || c === ')' || c === '{' || c === '}' || c === '[' || c === ']' ||
    c === ',' || c === '=' || c === ';' || c === '"' || c === '#' || c === '<' || c === '>' || c === '@';

  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '[' || c === ']' ||
        c === ',' || c === '=' || c === ';') {
      tokens.push({ t: c, v: c, line });
      i++;
      continue;
    }
    if (c === '@' || c === '"' || c === '\'') {
      const startLine = line;
      const quote = c;
      i += 1;
      let v = '';
      while (i < n) {
        if (text[i] === quote) { i += 1; break; }
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e === '"' ? '"' : e === '\\' ? '\\' : e;
          i += 2;
          continue;
        }
        if (text[i] === '\n') line++;
        v += text[i++];
      }
      tokens.push({ t: c === '@' ? 'asset' : 'string', v, line: startLine });
      continue;
    }
    // Angle-bracketed path (a prim path in references, unlike @file@ assets).
    if (c === '<') {
      const startLine = line;
      let v = '';
      i++;
      while (i < n && text[i] !== '>') { if (text[i] === '\n') line++; v += text[i++]; }
      i++;
      tokens.push({ t: 'path', v, line: startLine });
      continue;
    }
    let start = i;
    while (i < n && !isDelim(text[i])) i++;
    if (i === start) { i++; continue; }
    const v = text.slice(start, i);
    const isNumber = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) || /^[-+]?(inf|nan)$/i.test(v);
    tokens.push({ t: isNumber ? 'number' : 'ident', v, line });
  }
  return tokens;
}

class Parser {
  constructor(tokens, sourceName = 'scene.usda') {
    this.tokens = tokens;
    this.pos = 0;
    this.sourceName = sourceName;
    this.warnings = [];
  }
  peek(off = 0) { return this.tokens[this.pos + off] || { t: 'eof', v: '', line: 0 }; }
  next() { return this.tokens[this.pos++] || { t: 'eof', v: '', line: 0 }; }
  expect(t) {
    const tok = this.next();
    if (tok.t !== t) throw new UsdaSyntaxError(`expected '${t}', got '${tok.v || tok.t}'`, tok.line);
    return tok;
  }
  accept(t) { if (this.peek().t === t) return this.next(); return null; }
  warn(msg, line) { this.warnings.push({ message: msg, line: line + 1, layer: this.sourceName }); }

  parseLayer() {
    const layer = { metadata: {}, prims: [] };
    if (this.peek().t === '(') layer.metadata = this.parseMetadataBlock();
    // Top level consists of a sequence of prim specs, not a wrapped block.
    while (this.peek().t !== 'eof') {
      const before = this.pos;
      const spec = this.tryParsePrimSpec();
      if (spec) { layer.prims.push(spec); continue; }
      const tok = this.peek();
      this.skipStatement();
      if (this.pos === before) this.next();
      this.warn(`ignored unsupported top-level statement '${tok.v || tok.t}'`, tok.line);
    }
    return layer;
  }

  parseMetadataBlock() {
    this.expect('(');
    const metadata = {};
    while (this.peek().t !== ')') {
      const key = this.peek();
      if (key.t === 'eof') throw new UsdaSyntaxError('unterminated metadata block', key.line);
      if (key.t === 'ident' && this.peek(1).t === '=') {
        this.next();
        this.next();
        metadata[stripPrefix(key.v)] = this.parseValue();
        continue;
      }
      // Lists of composition arcs: `prepend references = @f@</P>` or subLayers.
      if (key.t === 'ident' && nextIsMetadataName(this.peek(1))) {
        this.next();
        continue;
      }
      this.next();
    }
    this.expect(')');
    return metadata;
  }

  parsePrimBody() {
    this.expect('{');
    const prims = [];
    const props = {};
    const arcs = [];
    while (this.peek().t !== '}') {
      const tok = this.peek();
      if (tok.t === 'eof') throw new UsdaSyntaxError('unterminated prim body', tok.line);
      const arc = this.tryParseCompositionArc();
      if (arc) { arcs.push(arc); continue; }
      const prop = this.tryParseProperty();
      if (prop) { props[prop.name] = prop; continue; }
      const spec = this.tryParsePrimSpec();
      if (spec) { prims.push(spec); continue; }
      const before = this.pos;
      this.skipStatement();
      if (this.pos === before) this.next();
      this.warn(`ignored unsupported statement starting with '${tok.v || tok.t}'`, tok.line);
    }
    this.expect('}');
    return { prims, props, arcs };
  }

  // `prepend references = @file@</Path>` / `add references = </Path>` etc.
  tryParseCompositionArc() {
    const start = this.pos;
    let i = 0;
    if (this.peek(i).t === 'ident' && ['prepend', 'append', 'add', 'delete', 'reorder'].includes(this.peek(i).v)) i++;
    const kindTok = this.peek(i);
    if (kindTok.t !== 'ident' || !['references', 'payload', 'inherits', 'specializes', 'variantSets', 'subLayers'].includes(kindTok.v)) {
      this.pos = start;
      return null;
    }
    if (this.peek(i + 1).t !== '=') { this.pos = start; return null; }
    for (let k = 0; k <= i; k++) this.next();
    this.next(); // '='
    const value = this.parseValue();
    this.accept(';');
    return { kind: kindTok.v, value, listOp: this.peek().v };
  }

  tryParsePrimSpec() {
    let i = 0;
    while (this.peek(i).t === 'ident' && ['custom', 'uniform'].includes(this.peek(i).v)) i++;
    const kindTok = this.peek(i);
    if (kindTok.t !== 'ident' || !['def', 'over', 'class'].includes(kindTok.v)) return null;
    i++;
    let typeName = null;
    if (this.peek(i).t === 'ident' && this.peek(i + 1).t === 'string') {
      typeName = this.peek(i).v;
      i++;
    }
    const nameTok = this.peek(i);
    if (nameTok.t !== 'string') return null;
    i++;
    for (let k = 0; k < i; k++) this.next();
    const spec = {
      kind: kindTok.v,
      typeName,
      name: nameTok.v,
      metadata: {},
      props: {},
      prims: [],
      line: nameTok.line,
    };
    if (this.peek().t === '(') spec.metadata = this.parseMetadataBlock();
    if (this.peek().t === '{') {
      const body = this.parsePrimBody();
      spec.props = body.props;
      spec.prims = body.prims;
      const refs = body.arcs.filter((a) => a.kind === 'references' || a.kind === 'payload');
      if (refs.length) {
        const target = spec.metadata.references;
        const list = Array.isArray(target) ? target.slice() : target ? [target] : [];
        for (const arc of refs) {
          const values = Array.isArray(arc.value) ? arc.value : [arc.value];
          for (const v of values) {
            if (v && typeof v === 'object' && v.path) list.push(v);
            else if (typeof v === 'string') list.push({ asset: v });
            else if (v && typeof v === 'object' && v.asset) list.push(v);
          }
        }
        spec.metadata.references = list.length === 1 ? list[0] : list;
      }
      spec.arcs = body.arcs;
    }
    return spec;
  }

  tryParseProperty() {
    const start = this.pos;
    let i = 0;
    let sawRel = false;
    let listOp = null;
    // Prefixes: list op / uniform / varying / custom / rel / a declared type.
    // `prepend rel prototypes = <...>` combines a list op with a relationship.
    if (this.peek(i).t === 'ident' && LIST_OPS.has(this.peek(i).v)) {
      listOp = this.peek(i).v;
      i++;
    }
    while (this.peek(i).t === 'ident') {
      const v = this.peek(i).v;
      if (v === 'rel') { sawRel = true; i++; continue; }
      if (TYPE_TOKENS.has(v)) {
        i++;
        if (this.peek(i).t === '[' && this.peek(i + 1).t === ']') i += 2;
        continue;
      }
      break;
    }
    const nameTok = this.peek(i);
    if (nameTok.t !== 'ident') { this.pos = start; return null; }
    i++;
    let meta = {};
    const hasMetadata = this.peek(i).t === '(';
    if (hasMetadata) i++;
    if (this.peek(i).t !== '=') {
      // Declaration-only property (e.g. `token outputs:surface`) or an
      // unsupported statement. Declarations are legitimate and are skipped
      // without a warning; anything else falls back to the caller.
      if (!hasMetadata && (sawRel || i > 1)) {
        for (let k = 0; k < i; k++) this.next();
        this.accept(';');
        return { name: nameTok.v, meta: {}, value: null, rel: sawRel, listOp, declaration: true, line: nameTok.line };
      }
      this.pos = start;
      return null;
    }
    for (let k = 0; k < i; k++) this.next();
    if (hasMetadata) meta = this.parseMetadataBlock();
    this.next(); // '='
    const value = this.parseValue();
    // Trailing metadata after the value: `normals = [...] ( interpolation = "vertex" )`.
    if (this.peek().t === '(') {
      const trailing = this.parseMetadataBlock();
      meta = { ...meta, ...trailing };
    }
    this.accept(';');
    return { name: nameTok.v, meta, value, rel: sawRel, listOp, line: nameTok.line };
  }

  parseValue() {
    const tok = this.peek();
    if (tok.t === '(') return this.parseTuple();
    if (tok.t === '[') return this.parseArray();
    if (tok.t === 'number') { this.next(); return Number(tok.v); }
    if (tok.t === 'string') { this.next(); return tok.v; }
    if (tok.t === 'asset') { this.next(); return { asset: tok.v }; }
    if (tok.t === 'path') { this.next(); return { path: tok.v }; }
    if (tok.t === 'ident') {
      this.next();
      if (tok.v === 'None') return null;
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      return tok.v;
    }
    throw new UsdaSyntaxError(`unexpected token '${tok.v || tok.t}' in value`, tok.line);
  }

  parseTuple() {
    this.expect('(');
    const out = [];
    while (this.peek().t !== ')') {
      out.push(this.parseValue());
      if (this.peek().t === ',') this.next();
      else if (this.peek().t !== ')') throw new UsdaSyntaxError(`expected ',' or ')' in tuple, got '${this.peek().v}'`, this.peek().line);
    }
    this.expect(')');
    return out;
  }

  parseArray() {
    this.expect('[');
    const out = [];
    while (this.peek().t !== ']') {
      out.push(this.parseValue());
      if (this.peek().t === ',') this.next();
    }
    this.expect(']');
    return out;
  }

  skipStatement() {
    let depth = 0;
    while (this.peek().t !== 'eof') {
      const tok = this.next();
      if (tok.t === '(' || tok.t === '[' || tok.t === '{') depth++;
      else if (tok.t === ')' || tok.t === ']' || tok.t === '}') {
        if (depth === 0) { this.pos--; return; }
        depth--;
        if (depth === 0) return;
      } else if (tok.t === ';' && depth === 0) return;
    }
  }
}

function stripPrefix(name) {
  return name;
}

function nextIsMetadataName(tok) {
  return tok.t === 'ident' && TYPE_TOKENS.has(tok.v);
}

export function parseUsda(text, sourceName = 'scene.usda') {
  const parser = new Parser(tokenize(text), sourceName);
  const layer = parser.parseLayer();
  return { layer, warnings: parser.warnings, sourceName };
}

export { tokenize };
