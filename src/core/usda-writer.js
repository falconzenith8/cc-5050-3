// USDA writer for the declared subset.
//
// Frame policy (matches src/core/usd-reader.js): the IR keeps geometry and
// node locals in *authored* coordinates and carries one explicit root fix
// matrix F = S(metersPerUnit) * R(upAxis -> Y). Writing back to USD therefore
// removes F from the root node and re-states upAxis/metersPerUnit in stage
// metadata; every other local matrix and all geometry is written verbatim.
//
// Instancing policy: the shared geometry of an instance set is authored once
// as a `class` prim at stage root, placed *after* the default prim. OpenUSD and
// @openusd-wasm do not traverse class prims under the default prim, so no
// source copy is drawn; lightusd renders the first root prim, so putting
// /World first means it renders the instances, which reference the class prim.
// Each placement is a separate `instanceable` prim under the host node: that
// is how USD expresses instances, and the geometry stays shared. No instance
// network is ever flattened into unique meshes.

import { invert, isIdentity, multiply } from './math.js';

const INDENT = '    ';
const PROTOTYPE_ROOT = '_Prototypes';
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function writeUsda(scene, { upAxis = null, metersPerUnit = null, rootName = null } = {}) {
  const axis = (upAxis || scene.sourceUpAxis || 'Y').toUpperCase();
  const unit = metersPerUnit ?? scene.sourceMetersPerUnit ?? 1;

  const nodesById = new Map(scene.nodes.map((n) => [n.id, n]));
  const meshById = new Map(scene.meshes.map((m) => [m.id, m]));
  const matById = new Map(scene.materials.map((m) => [m.id, m]));

  // Scene roots are the stage's root prims. Their locals are authored as-is:
  // the source axis/unit live in stage metadata, never in a node matrix, so
  // the authored hierarchy and locals survive a round trip unchanged. An IR
  // that carries the old node-rooted fix (rootFix !== null from a previous
  // reader) has it stripped from the root here.
  const roots = scene.nodes.filter((n) => n.parent === null && !n.isPrototype);
  if (roots.length === 0) throw new Error('scene has no root node');
  const primary = rootName || roots[0].name || 'World';

  const warnings = [];
  const usedPaths = new Set();
  const pathByNode = new Map();
  const prototypes = collectPrototypes();

  const out = [];
  writeHeader(out, { rootName: primary, axis, unit });
  const rootFixMatrix = scene.rootFix?.matrix || null;
  const fixInv = rootFixMatrix ? invert(rootFixMatrix) : null;
  if (rootFixMatrix && !fixInv) warnings.push({ message: 'root fix matrix is singular; cannot strip', layer: 'usda-writer' });

  for (const rootNode of roots) {
    // Strip a legacy node-carried fix if the reader folded one into the local.
    const local = rootFixMatrix && rootNode.isRootFix
      ? (fixInv ? multiply(fixInv, rootNode.matrix) : rootNode.matrix)
      : rootNode.matrix;
    const name = rootNode === roots[0] ? primary : sanitize(rootNode.name);
    usedPaths.add(`/${name}`);
    out.push(`def Xform "${name}"`);
    out.push('{');
    writeXformOps(out, INDENT, local);
    for (const id of rootNode.children) {
      const child = nodesById.get(id);
      if (child) writeNode(out, child, INDENT, `/${name}`);
    }
    out.push('}');
    out.push('');
  }
  if (prototypes.length) {
    out.push(`class Xform "${PROTOTYPE_ROOT}"`);
    out.push('{');
    for (const proto of prototypes) writePrototype(out, proto, INDENT);
    out.push('}');
    out.push('');
  }

  return { text: out.join('\n'), warnings, upAxis: axis, metersPerUnit: unit, prototypes };

  // ---- hierarchy ---------------------------------------------------------

  function writeNode(target, node, indent, parentPath) {
    if (node.isPrototype) return;
    const name = uniqueName(parentPath, node.name);
    const path = `${parentPath}/${name}`;
    pathByNode.set(node.id, path);

    // USD instanceable form: the node *is* a placement referencing a class
    // prototype. Its own local is the placement transform.
    if (node.instanceOf) {
      const proto = prototypes.find((p) => p.set.id === (node.instanceSetIds || [])[0]);
      target.push(`${indent}def Xform "${name}" (`);
      if (proto) {
        target.push(`${indent}${INDENT}instanceable = true`);
        target.push(`${indent}${INDENT}prepend references = <${proto.path}>`);
      }
      target.push(`${indent})`);
      target.push(`${indent}{`);
      writeXformOps(target, indent + INDENT, node.matrix);
      for (const childId of node.children) {
        const child = nodesById.get(childId);
        if (child) writeNode(target, child, indent + INDENT, path);
      }
      target.push(`${indent}}`);
      target.push('');
      return;
    }

    // A pure instance host (glTF EXT_mesh_gpu_instancing node) has no mesh and
    // no ordinary children. Keep the host as an Xform (so its path and local
    // survive) and author one `instanceable` placement prim per transform,
    // all referencing the same class prototype: the geometry stays shared.
    // instanceable is chosen over PointInstancer deliberately: it is the form
    // both real USD loaders used here can render, and it is what DCC tools
    // produce for repeated geometry.
    const hostSets = instanceSetsOf(node);
    let hostWritten = false;
    if (!node.mesh && node.children.length === 0 && hostSets.length === 1) {
      const set = hostSets[0];
      const proto = prototypes.find((p) => p.set.id === set.id);
      if (proto) {
        target.push(`${indent}def Xform "${name}"`);
        target.push(`${indent}{`);
        const inner = indent + INDENT;
        writeXformOps(target, inner, node.matrix);
        const placements = hostPlacements(set);
        placements.forEach((placementMatrix, k) => {
          const placementName = uniqueName(path, `${name}_${k}`);
          target.push(`${inner}def Xform "${placementName}" (`);
          target.push(`${inner}${INDENT}instanceable = true`);
          target.push(`${inner}${INDENT}prepend references = <${proto.path}>`);
          target.push(`${inner})`);
          target.push(`${inner}{`);
          writeXformOps(target, inner + INDENT, placementMatrix);
          target.push(`${inner}}`);
          target.push('');
        });
        target.push(`${indent}}`);
        target.push('');
        hostWritten = true;
      }
    }
    if (hostWritten) return;

    const type = node.mesh ? 'Mesh' : 'Xform';
    target.push(`${indent}def ${type} "${name}"`);
    target.push(`${indent}{`);
    const inner = indent + INDENT;
    writeXformOps(target, inner, node.matrix);
    if (node.mesh) writeMesh(target, meshById.get(node.mesh), inner, path);
    for (const childId of node.children) {
      const child = nodesById.get(childId);
      if (child) writeNode(target, child, inner, path);
    }
    for (const set of hostSets) {
      const proto = prototypes.find((p) => p.set.id === set.id);
      if (!proto) continue;
      // Same instanceable-placement encoding as a pure host: shared geometry,
      // one placement prim per transform, a form the real loaders can render.
      set.transforms.forEach((t, k) => {
        const row = set.rows[0];
        const placementName = uniqueName(path, `${sanitize(set.name)}_${k}`);
        target.push(`${inner}def Xform "${placementName}" (`);
        target.push(`${inner}${INDENT}instanceable = true`);
        target.push(`${inner}${INDENT}prepend references = <${proto.path}>`);
        target.push(`${inner})`);
        target.push(`${inner}{`);
        writeXformOps(target, inner + INDENT, multiply(t, row?.matrix || IDENTITY_MATRIX));
        target.push(`${inner}}`);
        target.push('');
      });
    }
    target.push(`${indent}}`);
    target.push('');
  }

  function instanceSetsOf(node) {
    return (node.instanceSetIds || [])
      .map((id) => scene.instanceSets.find((s) => s.id === id))
      .filter(Boolean);
  }

  /**
   * Placement locals for a glTF instancing host: each authored transform is a
   * placement beneath the host, so a placement local is
   * transform * row.matrix. The host's own local is written on the Xform.
   */
  function hostPlacements(set) {
    const row = set.rows[0];
    if (!row) return [];
    return set.transforms.map((t) => multiply(t, row.matrix || IDENTITY_MATRIX));
  }

  // ---- prototypes --------------------------------------------------------

  function collectPrototypes() {
    const list = [];
    for (const set of scene.instanceSets) {
      const mesh = meshById.get(set.mesh);
      if (!mesh) continue;
      const authoredPlacements = set.kind === 'instanceable'
        ? scene.nodes.filter((n) => n.instanceOf && n.instanceSetIds?.includes(set.id)).length
        : scene.nodes.filter((n) => (n.instanceSetIds || []).includes(set.id) && !n.mesh).length;
      if (authoredPlacements === 0) continue;
      list.push({
        set,
        mesh,
        name: sanitize(mesh.name || 'Prototype'),
        path: null,
      });
    }
    let n = 0;
    for (const group of list) {
      let name;
      do {
        name = n === 0 ? group.name : `${group.name}_${n}`;
        n++;
      } while (usedPaths.has(`/${PROTOTYPE_ROOT}/${name}`));
      group.path = `/${PROTOTYPE_ROOT}/${name}`;
      usedPaths.add(group.path);
    }
    return list;
  }

  function writePrototype(target, proto, indent) {
    const inner = indent + INDENT;
    const mesh = meshById.get(proto.set.mesh);
    const row = proto.set.rows[0] || { mesh: proto.set.mesh, matrix: null };
    target.push(`${indent}class Xform "${proto.path.split('/').pop()}"`);
    target.push(`${indent}{`);
    target.push(`${inner}def Mesh "${sanitize(mesh.name || 'Geo')}"`);
    target.push(`${inner}{`);
    const meshIndent = inner + INDENT;
    // The prototype row's local keeps geometry in the same place as authored.
    writeXformOps(target, meshIndent, row.matrix);
    writeMesh(target, mesh, meshIndent, proto.path);
    target.push(`${inner}}`);
    target.push(`${indent}}`);
    target.push('');
  }

  // ---- geometry ----------------------------------------------------------

  function writeMesh(target, mesh, indent, meshPath) {
    if (!mesh) return;
    const p = mesh.positions;
    const idx = mesh.indices;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(p.length / 9);
    const pointCount = p.length / 3;

    const points = [];
    for (let i = 0; i < pointCount; i++) points.push(vec3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
    const counts = new Array(triCount).fill(3);
    const indices = [];
    for (let i = 0; i < triCount * 3; i++) indices.push(idx ? idx[i] : i);

    target.push(`${indent}int[] faceVertexCounts = [${counts.join(', ')}]`);
    target.push(`${indent}int[] faceVertexIndices = [${indices.join(', ')}]`);
    target.push(`${indent}point3f[] points = [${points.join(', ')}]`);

    if (mesh.normals) {
      const normals = [];
      for (let i = 0; i < pointCount; i++) normals.push(vec3(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]));
      target.push(`${indent}normal3f[] normals = [${normals.join(', ')}] (`);
      target.push(`${indent}${INDENT}interpolation = "vertex"`);
      target.push(`${indent})`);
    }
    if (mesh.uvs) {
      const uvs = [];
      for (let i = 0; i < pointCount; i++) uvs.push(`(${fmt(mesh.uvs[i * 2])}, ${fmt(mesh.uvs[i * 2 + 1])})`);
      target.push(`${indent}texCoord2f[] primvars:st = [${uvs.join(', ')}] (`);
      target.push(`${indent}${INDENT}interpolation = "vertex"`);
      target.push(`${indent})`);
    }

    const mat = mesh.material ? matById.get(mesh.material) : null;
    if (mat) {
      const matPath = `${meshPath}/${sanitize(mat.name || 'Material')}`;
      // doubleSided is a Mesh attribute in USD, not a Material one.
      if (mat.doubleSided) target.push(`${indent}uniform bool doubleSided = 1`);
      target.push(`${indent}rel material:binding = <${matPath}>`);
      writeMaterial(target, mat, indent, matPath);
    }
  }

  function writeMaterial(target, mat, indent, matPath) {
    target.push(`${indent}def Material "${matPath.split('/').pop()}"`);
    target.push(`${indent}{`);
    const inner = indent + INDENT;
    target.push(`${inner}token outputs:surface.connect = <${matPath}/Surface.outputs:surface>`);
    target.push('');
    target.push(`${inner}def Shader "Surface"`);
    target.push(`${inner}{`);
    const s = inner + INDENT;
    target.push(`${s}uniform token info:id = "UsdPreviewSurface"`);
    const [r, g, b, a] = mat.baseColorFactor;
    target.push(`${s}color3f inputs:diffuseColor = (${fmt(r)}, ${fmt(g)}, ${fmt(b)})`);
    target.push(`${s}float inputs:metallic = ${fmt(mat.metallicFactor)}`);
    target.push(`${s}float inputs:roughness = ${fmt(mat.roughnessFactor)}`);
    if (a < 1) target.push(`${s}float inputs:opacity = ${fmt(a)}`);
    if (mat.alphaMode === 'MASK') target.push(`${s}float inputs:opacityThreshold = ${fmt(mat.alphaCutoff ?? 0.5)}`);
    target.push(`${s}token outputs:surface`);
    target.push(`${inner}}`);
    target.push(`${indent}}`);
  }

  // ---- helpers -----------------------------------------------------------

  function uniqueName(parentPath, raw) {
    const base = sanitize(raw);
    let name = base;
    let k = 1;
    while (usedPaths.has(`${parentPath}/${name}`)) name = `${base}_${k++}`;
    usedPaths.add(`${parentPath}/${name}`);
    return name;
  }
}

function writeHeader(out, { rootName, axis, unit }) {
  out.push('#usda 1.0');
  out.push('(');
  out.push(`${INDENT}defaultPrim = "${rootName}"`);
  out.push(`${INDENT}metersPerUnit = ${fmt(unit)}`);
  out.push(`${INDENT}upAxis = "${axis}"`);
  out.push(')');
  out.push('');
}

function writeXformOps(out, indent, matrix) {
  if (!matrix || isIdentity(matrix, 1e-12)) return;
  // Our column-major array and USDA's row-major text are the same 16 numbers in
  // the same order (see math.usdMatrixToGltf); emit them in groups of four.
  const m = matrix;
  const row = (r) => `${fmt(m[r * 4])}, ${fmt(m[r * 4 + 1])}, ${fmt(m[r * 4 + 2])}, ${fmt(m[r * 4 + 3])}`;
  out.push(`${indent}matrix4d xformOp:transform = ((${row(0)}), (${row(1)}), (${row(2)}), (${row(3)}))`);
  out.push(`${indent}uniform token[] xformOpOrder = ["xformOp:transform"]`);
}

export function rootFix(upAxis, metersPerUnit) {
  const u = Number(metersPerUnit);
  if (String(upAxis).toUpperCase() === 'Z') {
    // (x, y, z) -> (x, z, -y), then scale by units.
    return [
      u, 0, 0, 0,
      0, 0, -u, 0,
      0, u, 0, 0,
      0, 0, 0, 1,
    ];
  }
  return [u, 0, 0, 0, 0, u, 0, 0, 0, 0, u, 0, 0, 0, 0, 1];
}

function vec3(x, y, z) {
  return `(${fmt(x)}, ${fmt(y)}, ${fmt(z)})`;
}

function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  const rounded = Math.round(v * 1e7) / 1e7;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function sanitize(name) {
  const s = String(name || 'Prim').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(s) ? s : `_${s}`;
}
