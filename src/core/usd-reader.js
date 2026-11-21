// USD stage -> canonical SceneIR reader (declared subset).
//
// Frame policy, verified against OpenUSD 26.11 and cross-checked in the two
// real browser loaders:
//  - USD transforms are row-vector; usdMatrixToGltf transposes them into our
//    column-major storage. xformOpOrder composes as ops[0] * ops[1] * ...
//  - Geometry and node locals stay in *authored* coordinates. Stage
//    upAxis/metersPerUnit become one explicit root fix matrix
//    F = S(unit) * R(axis) attached to the root node, so every descendant's
//    local is untouched and world = F * stageWorld.
//  - `instanceable` prims are modelled as one placement node each, sharing an
//    instance set whose rows are the prototype's geometry relative to the
//    prototype root. PointInstancer is a single host node plus N transforms.
//    Neither form is flattened into unique meshes.
//  - A `class` prim is not drawable content, so class prototype subtrees are
//    not emitted as render nodes. When such a subtree is also the referenced
//    prototype, only its mesh rows are kept, inside the instance set.
//  - `visibility`, face-varying normals other than per-face-vertex, non-triangle
//    topology and external references are outside the declared subset and are
//    reported in `warnings` rather than silently dropped.

import { parseUsda } from './usda-parser.js';
import {
  IDENTITY, compose, multiply, usdMatrixToGltf, upAxisRotation, decompose, determinant3,
} from './math.js';
import {
  createScene, createNode, createMesh, createMaterial, createInstanceSet,
} from './scene.js';

const GEOM_TYPES = new Set(['Mesh', 'Cube', 'Sphere', 'Cylinder', 'Capsule', 'Cone']);

export function readUsda(text, { sourceName = 'scene.usda' } = {}) {
  const { layer, warnings: parseWarnings } = parseUsda(text, sourceName);
  const warnings = [...parseWarnings];

  const upAxis = String(layer.metadata.upAxis || 'Y').toUpperCase();
  const metersPerUnit = Number(layer.metadata.metersPerUnit ?? 1);
  const defaultPrimName = layer.metadata.defaultPrim || null;

  const scene = createScene({ name: sourceName, upAxis: 'Y', metersPerUnit });
  scene.provenance = { source: sourceName, reader: 'usd-reader', writer: null };
  scene.warnings = warnings;
  scene.sourceUpAxis = upAxis;
  scene.sourceMetersPerUnit = metersPerUnit;

  const fix = multiply(
    compose({ scale: [metersPerUnit, metersPerUnit, metersPerUnit] }),
    upAxisRotation(upAxis, 'Y'),
  );
  // The frame fix is stage metadata, not a prim. It is carried on the scene so
  // the authored prim hierarchy (and its paths) is reproduced node-for-node.
  scene.rootFix = { matrix: fix.slice(), unitScale: metersPerUnit, upAxis };

  const byPath = new Map();
  const indexSpecs = (specs, prefix) => {
    for (const spec of specs) {
      const path = `${prefix}/${spec.name}`;
      byPath.set(path, spec);
      indexSpecs(spec.prims, path);
    }
  };
  indexSpecs(layer.prims, '');

  const materials = new Map();
  const twoSided = new Map();
  const meshes = new Map();
  const instanceSets = new Map();
  // Mesh prims that carry byte-identical geometry are one physical resource,
  // even when authored at different prim paths (e.g. a standalone mesh that
  // duplicates a prototype's geometry). Keyed on a cheap content signature so
  // material-only differences never collapse the resource, and genuinely
  // different geometry never shares a key.
  const resourceKeyBySignature = new Map();

  // ---- transforms --------------------------------------------------------
  function localMatrix(spec) {
    const props = spec.props;
    const order = props.xformOpOrder?.value;
    if (Array.isArray(order) && order.length > 0) {
      let m = IDENTITY.slice();
      for (const opName of order) {
        if (opName === '!resetXformStack!') { m = IDENTITY.slice(); continue; }
        const op = props[opName];
        if (!op) {
          warnings.push({ message: `${spec.name || 'prim'}: xformOpOrder lists missing '${opName}'`, layer: sourceName });
          continue;
        }
        const opMatrix = buildOpMatrix(opName, op.value);
        if (opMatrix) m = multiply(m, opMatrix);
        else warnings.push({ message: `${spec.name || 'prim'}: unsupported xformOp '${opName}' ignored`, layer: sourceName });
      }
      return m;
    }
    const legacy = props['xformOp:transform']?.value;
    if (legacy) {
      const flat = flattenNumbers(legacy);
      if (flat.length === 16) return usdMatrixToGltf(flat);
    }
    return IDENTITY.slice();
  }

  function buildOpMatrix(opName, value) {
    if (opName.includes('transform')) {
      const flat = flattenNumbers(value);
      return flat.length === 16 ? usdMatrixToGltf(flat) : null;
    }
    if (opName.includes('orient')) {
      const v = flattenNumbers(value);
      return v.length === 4 ? compose({ rotation: v }) : null;
    }
    if (opName.includes('translate')) {
      const v = flattenNumbers(value);
      return v.length >= 3 ? compose({ translation: v.slice(0, 3) }) : null;
    }
    if (opName.includes('scale')) {
      const v = flattenNumbers(value);
      return v.length >= 3 ? compose({ scale: v.slice(0, 3) }) : null;
    }
    if (opName.includes('rotateX')) return compose({ rotation: axisAngle([1, 0, 0], Number(value)) });
    if (opName.includes('rotateY')) return compose({ rotation: axisAngle([0, 1, 0], Number(value)) });
    if (opName.includes('rotateZ')) return compose({ rotation: axisAngle([0, 0, 1], Number(value)) });
    return null;
  }

  // ---- materials ---------------------------------------------------------
  function materialFor(materialSpec, path) {
    if (materials.has(path)) return materials.get(path);
    const material = createMaterial({ name: materialSpec.name });
    material.sourcePath = path;

    const shader = pickSurfaceShader(materialSpec);
    if (!shader) {
      warnings.push({ message: `material ${path} has no Shader child; defaults used`, layer: sourceName });
    } else {
      const shaderId = shader.props['info:id']?.value ?? null;
      material.shaderId = shaderId;
      if (shaderId && shaderId !== 'UsdPreviewSurface') {
        warnings.push({ message: `material ${path}: shader '${shaderId}' outside the declared subset; approximated as UsdPreviewSurface`, layer: sourceName });
      }
      const inputs = {};
      for (const [key, prop] of Object.entries(shader.props)) {
        if (key.startsWith('inputs:') && !key.endsWith('.connect')) inputs[key.slice(7)] = prop.value;
      }
      if (Array.isArray(inputs.diffuseColor)) {
        const c = flattenNumbers(inputs.diffuseColor);
        material.baseColorFactor = [c[0], c[1], c[2], 1];
      }
      if (typeof inputs.opacity === 'number') material.baseColorFactor[3] = inputs.opacity;
      if (typeof inputs.metallic === 'number') material.metallicFactor = inputs.metallic;
      if (typeof inputs.roughness === 'number') material.roughnessFactor = inputs.roughness;
      if (inputs.opacityThreshold !== undefined) {
        material.alphaMode = 'MASK';
        material.alphaCutoff = Number(inputs.opacityThreshold);
      } else if (material.baseColorFactor[3] < 1) {
        material.alphaMode = 'BLEND';
      }
      if (materialSpec.props['doubleSided']?.value === true || materialSpec.props['doubleSided']?.value === 1) material.doubleSided = true;

      const dropped = [];
      for (const key of ['emissiveColor', 'normal', 'occlusion', 'clearcoat', 'clearcoatRoughness',
        'ior', 'specular', 'useSpecularWorkflow', 'displacement', 'metallicRoughnessTexture', 'emissiveStrength']) {
        if (inputs[key] !== undefined) dropped.push(key);
      }
      for (const key of Object.keys(shader.props)) {
        if (key.startsWith('inputs:') && key.endsWith('.connect')) dropped.push(`${key.slice(7, -8)}(texture)`);
      }
      if (dropped.length) {
        material.degradedInputs = dropped;
        warnings.push({ message: `material ${path}: ${dropped.length} input(s) outside the declared subset were dropped: ${dropped.join(', ')}`, layer: sourceName });
      }
    }
    materials.set(path, material);
    scene.materials.push(material);
    return material;
  }

  function pickSurfaceShader(materialSpec) {
    const shaders = materialSpec.prims.filter((p) => p.typeName === 'Shader');
    if (shaders.length === 0) return null;
    const link = materialSpec.props['outputs:surface.connect']?.value;
    const target = link && typeof link === 'object' ? link.path : null;
    if (target) {
      const base = target.replace(/\.outputs:surface$/, '');
      const explicit = shaders.find((s) => base.endsWith(`/${s.name}`));
      if (explicit) return explicit;
    }
    return shaders[0];
  }

  // ---- geometry ----------------------------------------------------------
  function meshFor(meshSpec, path) {
    if (meshes.has(path)) return meshes.get(path);
    const props = meshSpec.props;
    const points = props.points?.value;
    if (!Array.isArray(points) || points.length === 0) {
      warnings.push({ message: `mesh ${path}: no points attribute; skipped`, layer: sourceName });
      return null;
    }
    const counts = props.faceVertexCounts?.value || [];
    const faceIndices = props.faceVertexIndices?.value || [];
    const normals = props.normals?.value || null;
    const normalsInterp = props.normals?.meta?.interpolation || 'vertex';
    const st = props['primvars:st']?.value || null;
    const stInterp = props['primvars:st']?.meta?.interpolation || 'faceVarying';

    const positions = [];
    const outNormals = [];
    const outUvs = [];
    const indices = [];
    let cursor = 0;
    let outIndex = 0;
    let triangulated = 0;
    const stFaceVarying = st && stInterp !== 'vertex' && st.length === faceIndices.length;
    const nFaceVarying = normals && normalsInterp !== 'vertex' && normals.length === faceIndices.length;

    for (const count of counts) {
      if (count !== 3) triangulated++;
      const face = faceIndices.slice(cursor, cursor + count);
      for (let t = 1; t + 1 < count; t++) {
        const tri = [face[0], face[t], face[t + 1]];
        for (const vi of tri) {
          const p = points[vi];
          positions.push(Number(p[0]), Number(p[1]), Number(p[2]));
          if (normals) {
            const local = face.indexOf(vi);
            const n = nFaceVarying ? normals[cursor + local] : normals[vi];
            if (n) outNormals.push(Number(n[0]), Number(n[1]), Number(n[2]));
          }
          if (st) {
            const uv = stFaceVarying ? st[cursor + face.indexOf(vi)] : st[vi];
            if (uv) outUvs.push(Number(uv[0]), Number(uv[1]));
          }
          indices.push(outIndex++);
        }
      }
      cursor += count;
    }
    if (triangulated) {
      warnings.push({ message: `mesh ${path}: ${triangulated} non-triangle face(s) fan-triangulated`, layer: sourceName });
    }

    const mesh = createMesh({
      name: meshSpec.name,
      positions: Float32Array.from(positions),
      normals: outNormals.length === positions.length ? Float32Array.from(outNormals) : null,
      uvs: outUvs.length / 2 === positions.length / 3 ? Float32Array.from(outUvs) : null,
      indices: Uint32Array.from(indices),
    });
    mesh.sourcePath = path;
    mesh.sourceVertexCount = points.length;
    // doubleSided is a Mesh attribute in USD. When set, the bound material must
    // be drawn two-sided; a material shared with a single-sided mesh is cloned
    // so each side keeps its own value rather than letting one mesh change the
    // other's facing.
    const doubleSided = props.doubleSided?.value === true || props.doubleSided?.value === 1;

    const bindingPath = boundMaterialPath(meshSpec);
    if (bindingPath && byPath.has(bindingPath)) {
      const bound = materialFor(byPath.get(bindingPath), bindingPath);
      mesh.material = doubleSided ? twoSidedVariant(bound, bindingPath) : bound.id;
    } else {
      const owned = meshSpec.prims.find((p) => p.typeName === 'Material');
      if (owned) {
        const ownMat = materialFor(owned, `${path}/${owned.name}`);
        mesh.material = doubleSided ? twoSidedVariant(ownMat, `${path}/${owned.name}`) : ownMat.id;
      } else {
        const color = props['primvars:displayColor']?.value;
        if (color) {
          const c = flattenNumbers(color);
          const mat = createMaterial({ name: `${meshSpec.name}_displayColor`, baseColorFactor: [c[0], c[1], c[2], c[3] ?? 1], doubleSided });
          mat.sourcePath = `displayColor:${path}`;
          mesh.material = mat.id;
          scene.materials.push(mat);
        }
      }
    }
    meshes.set(path, mesh);
    mesh.resourceKey = sharedResourceKey(mesh);
    scene.meshes.push(mesh);
    return mesh;
  }

  /**
   * Stable resource key for byte-identical geometry. A material-only difference
   * changes the binding, not the positions/indices, so two prims with the same
   * signature share one key; a geometry edit changes the signature and the key.
   */
  function sharedResourceKey(mesh) {
    const signature = geometrySignature(mesh);
    if (!resourceKeyBySignature.has(signature)) {
      resourceKeyBySignature.set(signature, `key-usd-geometry-${resourceKeyBySignature.size}`);
    }
    return resourceKeyBySignature.get(signature);
  }

  function geometrySignature(mesh) {
    const pos = Array.from(mesh.positions).map((v) => Math.round(v * 1e7));
    const idx = mesh.indices ? Array.from(mesh.indices) : [];
    return `${pos.length}:${pos.join(',')}|${idx.join(',')}`;
  }

  function twoSidedVariant(material, basePath) {
    if (material.doubleSided) return material.id;
    const key = `${basePath}#doubleSided`;
    if (twoSided.has(key)) return twoSided.get(key);
    const copy = createMaterial({
      name: material.name,
      baseColorFactor: material.baseColorFactor.slice(),
      metallicFactor: material.metallicFactor,
      roughnessFactor: material.roughnessFactor,
      doubleSided: true,
      alphaMode: material.alphaMode,
    });
    copy.sourcePath = material.sourcePath;
    copy.alphaCutoff = material.alphaCutoff;
    copy.degradedInputs = material.degradedInputs;
    scene.materials.push(copy);
    twoSided.set(key, copy.id);
    return copy.id;
  }

  function boundMaterialPath(spec) {
    const binding = spec.props['material:binding']?.value;
    return binding && typeof binding === 'object' ? binding.path ?? null : null;
  }

  // ---- prototypes --------------------------------------------------------
  /**
   * Resolve a referenced prototype, following one level of material-override
   * variant. A variant class references the base geometry prototype and only
   * re-binds its Mesh through an `over`; the geometry rows therefore come from
   * the base, so an override placement shares the exact same geometry identity
   * as its unmodified siblings. The override is returned separately, never
   * folded into the mesh resource.
   */
  function resolvePrototype(targetSpec, ref) {
    const overBinding = findOverrideBinding(targetSpec);
    if (!overBinding) return { rows: prototypeRows(targetSpec, ref), basePath: ref, overrideMaterialId: null };
    const baseRef = refPath(targetSpec.metadata.references);
    const baseSpec = baseRef ? byPath.get(baseRef) : null;
    if (!baseSpec) {
      warnings.push({ message: `${ref}: material-override variant references unknown base '${baseRef}'; read without override`, layer: sourceName });
      return { rows: prototypeRows(targetSpec, ref), basePath: ref, overrideMaterialId: null };
    }
    const bound = byPath.get(overBinding);
    const materialId = bound ? materialFor(bound, overBinding).id : null;
    return {
      rows: prototypeRows(baseSpec, baseRef),
      basePath: baseRef,
      overrideMaterialId: materialId,
      variantPath: ref,
    };
  }

  /** Material binding path declared on an `over Mesh` child, if this spec is an override variant. */
  function findOverrideBinding(spec) {
    const overMesh = spec.prims.find((p) => p.kind === 'over' && GEOM_TYPES.has(p.typeName));
    const binding = overMesh?.props['material:binding']?.value;
    return binding && typeof binding === 'object' ? binding.path ?? null : null;
  }

  /**
   * Geometry rows of a prototype rooted at `rootSpec`. Each row keeps its
   * transform relative to the prototype root, so one authored mesh serves
   * every placement.
   */
  function prototypeRows(rootSpec, rootPath) {
    const rows = [];
    const walk = (spec, path, matrix) => {
      if (GEOM_TYPES.has(spec.typeName)) {
        const mesh = meshFor(spec, path);
        if (mesh) rows.push({ mesh: mesh.id, matrix, meshPath: path });
        return;
      }
      for (const child of spec.prims) {
        if (child.typeName === 'Material' || child.typeName === 'Shader') continue;
        walk(child, `${path}/${child.name}`, multiply(matrix, localMatrix(child)));
      }
    };
    for (const child of rootSpec.prims) {
      if (child.typeName === 'Material' || child.typeName === 'Shader') continue;
      walk(child, `${rootPath}/${child.name}`, localMatrix(child));
    }
    return rows;
  }

  function instanceSetForRows(rows, prototypePath, placementPath, kind) {
    const sets = [];
    for (const row of rows) {
      const key = `${prototypePath}|${row.mesh}`;
      let set = instanceSets.get(key);
      if (!set) {
        set = createInstanceSet({
          name: `${placementName(placementPath)}_${row.meshPath.split('/').pop()}`,
          mesh: row.mesh,
          rows: [row],
          transforms: [],
          sourcePath: placementPath,
          kind,
        });
        const mesh = scene.meshes.find((m) => m.id === row.mesh);
        set.material = mesh?.material ?? null;
        set.prototypePath = prototypePath;
        set.prototypeMeshPath = row.meshPath;
        instanceSets.set(key, set);
      }
      sets.push(set);
    }
    return sets;
  }

  function placementName(path) {
    return path.split('/').filter(Boolean).pop() || 'instance';
  }

  // ---- hierarchy ---------------------------------------------------------
  const initialSpecs = defaultPrimName
    ? layer.prims.filter((p) => p.name === defaultPrimName)
    : layer.prims;
  if (initialSpecs.length === 0) {
    warnings.push({ message: `defaultPrim '${defaultPrimName}' not found at stage root`, layer: sourceName });
  }
  // Nodes are parented to null: the stage's own roots are the scene's roots,
  // and the frame fix is applied once, at world evaluation.
  for (const spec of initialSpecs) visitPrim(spec, null, '', false);
  scene.instanceSets.push(...instanceSets.values());

  function visitPrim(spec, parentNode, prefix, inPrototype) {
    const path = `${prefix}/${spec.name}`;
    const className = spec.kind === 'class';

    // An `over` only carries opinions about a referenced prim; it never
    // declares geometry of its own. Its material binding is consumed by
    // resolvePrototype, so it is not a drawable node in the scene tree.
    if (spec.kind === 'over') return;
    if (spec.typeName === 'PointInstancer') {
      readPointInstancer(spec, path, parentNode);
      return;
    }
    if (spec.typeName === 'Material' || spec.typeName === 'Shader') {
      if (spec.typeName === 'Material' && !className) materialFor(spec, path);
      return;
    }
    if (className) {
      // Reusable prototype libraries are not drawable content. Their meshes
      // are reached through instance-set rows instead. `over` children of an
      // override variant only re-bind a material and carry no geometry of
      // their own, so they are never visited as drawable prims.
      for (const child of spec.prims) {
        if (child.kind === 'over') continue;
        visitPrim(child, parentNode, path, true);
      }
      return;
    }
    if (GEOM_TYPES.has(spec.typeName)) {
      const mesh = meshFor(spec, path);
      if (!mesh) return;
      const node = makeNode(spec, parentNode, path);
      node.mesh = mesh.id;
      node.sourcePrimType = spec.typeName;
      return;
    }
    if (spec.metadata?.instanceable === true) {
      readInstanceable(spec, path, parentNode);
      return;
    }

    const node = makeNode(spec, parentNode, path);
    node.sourcePrimType = spec.typeName;
    if (!inPrototype && tryCollapsePlacementHost(spec, node, path)) return;
    if (spec.metadata?.references) {
      const ref = refPath(spec.metadata.references);
      const target = ref ? byPath.get(ref) : null;
      if (target) {
        for (const child of target.prims) visitPrim(child, node, path, false);
      } else if (ref) {
        warnings.push({ message: `${path}: external reference '${ref}' outside the declared subset; not composed`, layer: sourceName });
      }
    }
    for (const child of spec.prims) visitPrim(child, node, path, inPrototype);

    // `visibility` is a property in USDA (a token, not prim metadata).
    const visibility = spec.props.visibility?.value ?? spec.metadata?.visibility;
    if (visibility === 'invisible') {
      warnings.push({
        message: `${path}: authored visibility=invisible is outside the declared subset; both real loaders render it, so it is kept visible`,
        layer: sourceName,
      });
      node.authoredVisibility = 'invisible';
    }
  }

  function makeNode(spec, parentNode, path) {
    const node = createNode({ name: spec.name });
    node.parent = parentNode ? parentNode.id : null;
    if (parentNode) parentNode.children.push(node.id);
    node.sourcePath = path;
    node.sourcePrimType = spec.typeName || null;
    applyMatrix(node, localMatrix(spec));
    scene.nodes.push(node);
    return node;
  }

  function applyMatrix(node, matrix) {
    node.matrix = matrix.slice();
    const d = decompose(matrix);
    node.translation = d.translation;
    node.rotation = d.rotation;
    node.scale = d.scale;
  }

  // ---- instanceable prims ------------------------------------------------
  function readInstanceable(spec, path, parentNode) {
    const ref = refPath(spec.metadata.references);
    const targetSpec = ref ? byPath.get(ref) : null;
    if (!ref || !targetSpec) {
      warnings.push({ message: `instance ${path}: reference '${ref}' cannot be resolved in this layer; kept as a plain Xform`, layer: sourceName });
      const node = makeNode(spec, parentNode, path);
      for (const child of spec.prims) visitPrim(child, node, path, false);
      return;
    }
    const { rows, basePath, overrideMaterialId, variantPath } = resolvePrototype(targetSpec, ref);
    if (rows.length === 0) {
      warnings.push({ message: `instance ${path}: prototype '${ref}' contains no drawable geometry`, layer: sourceName });
      return;
    }
    const node = makeNode(spec, parentNode, path);
    node.sourcePrimType = 'instanceable';
    node.instanceOf = basePath;
    node.prototypeVariant = variantPath || null;
    node.instanceSetIds = [];
    const sets = instanceSetForRows(rows, basePath, path, 'instanceable');
    for (const set of sets) {
      set.sourcePaths.push(path);
      if (!node.instanceSetIds.includes(set.id)) node.instanceSetIds.push(set.id);
      // The material override is a local opinion on this placement only. The
      // instance set (and its geometry row) is shared with every sibling, so
      // changing this material cannot change the others.
      if (overrideMaterialId) {
        node.overrides = node.overrides || { material: null };
        node.overrides.material = overrideMaterialId;
      }
      for (const row of set.rows) {
        if (determinant3(multiply(node.matrix, row.matrix || IDENTITY)) < 0) set.mirroredCount++;
      }
    }
  }

  // ---- PointInstancer ----------------------------------------------------
  function readPointInstancer(spec, path, parentNode) {
    const protoRel = spec.props.prototypes?.value;
    const protoList = Array.isArray(protoRel) ? protoRel : protoRel ? [protoRel] : [];
    const protoPaths = protoList
      .filter((v) => v && typeof v === 'object' && v.path)
      .map((v) => v.path);
    if (protoPaths.length === 0) {
      warnings.push({ message: `PointInstancer ${path}: no prototypes relationship; skipped`, layer: sourceName });
      return;
    }
    const positions = spec.props.positions?.value || [];
    const orientations = spec.props.orientations?.value || [];
    const scales = spec.props.scales?.value || [];
    const protoIndices = spec.props.protoIndices?.value || [];
    if (positions.length === 0) {
      warnings.push({ message: `PointInstancer ${path}: no positions; skipped`, layer: sourceName });
      return;
    }
    const node = makeNode(spec, parentNode, path);
    node.sourcePrimType = 'PointInstancer';
    node.instanceSetIds = [];
    node.pointInstancerCount = positions.length;

    const rowCache = new Map();
    for (let i = 0; i < positions.length; i++) {
      const protoIndex = protoIndices[i] ?? 0;
      const protoPath = protoPaths[protoIndex] ?? protoPaths[0];
      const protoSpec = byPath.get(protoPath);
      if (!protoSpec) {
        warnings.push({ message: `PointInstancer ${path}: prototype '${protoPath}' not found`, layer: sourceName });
        continue;
      }
      if (!rowCache.has(protoPath)) rowCache.set(protoPath, prototypeRows(protoSpec, protoPath));
      const placement = compose({
        translation: positions[i] ? flattenNumbers(positions[i]).slice(0, 3) : [0, 0, 0],
        rotation: orientations[i] ? flattenNumbers(orientations[i]).slice(0, 4) : [0, 0, 0, 1],
        scale: scales[i] ? flattenNumbers(scales[i]).slice(0, 3) : [1, 1, 1],
      });
      for (const row of rowCache.get(protoPath)) {
        const key = `${path}|${protoPath}|${row.mesh}`;
        let set = instanceSets.get(key);
        if (!set) {
          set = createInstanceSet({
            name: `${spec.name}_${row.meshPath.split('/').pop()}`,
            mesh: row.mesh,
            rows: [row],
            transforms: [],
            sourcePath: path,
            kind: 'pointInstancer',
          });
          const mesh = scene.meshes.find((m) => m.id === row.mesh);
          set.material = mesh?.material ?? null;
          set.prototypePath = protoPath;
          set.prototypeMeshPath = row.meshPath;
          instanceSets.set(key, set);
          node.instanceSetIds.push(set.id);
        }
        const local = multiply(placement, row.matrix || IDENTITY);
        set.transforms.push(local);
        set.sourcePaths.push(path);
        if (determinant3(local) < 0) set.mirroredCount++;
      }
    }
  }

  /**
   * A plain Xform whose only children are instanceable placements referencing
   * one shared prototype is the USD encoding of a glTF EXT_mesh_gpu_instancing
   * host. Fold it back into a single host node with N transforms, so a glTF ->
   * USD -> IR round trip reproduces the host node (path, local, one shared
   * set) instead of leaving N separate placement nodes.
   */
  function tryCollapsePlacementHost(spec, node, path) {
    const instChildren = spec.prims.filter(
      (c) => c.typeName === 'Xform' && c.metadata?.instanceable === true,
    );
    if (instChildren.length === 0 || instChildren.length !== spec.prims.length) return false;
    // Placements may reference the base prototype or an `over` material variant
    // of it; all of them still share one geometry resource, so they collapse
    // into one set, carrying any material difference as a per-transform
    // override rather than as different geometry.
    const baseRefs = new Set(instChildren.map((c) => baseReferencePath(c)));
    if (baseRefs.size !== 1) return false;
    const ref = [...baseRefs][0];
    const targetSpec = ref ? byPath.get(ref) : null;
    if (!targetSpec) return false;
    const rows = prototypeRows(targetSpec, ref);
    if (rows.length !== 1) return false;

    const created = [];
    const transforms = [];
    const transformOverrides = [];
    for (const child of instChildren) {
      // Set transforms are placement locals relative to the host; the host's
      // own world is applied at draw time (world = hostWorld * local). Baking
      // the host matrix in here would double-apply it on re-read.
      const local = localMatrix(child);
      const childNode = createNode({ name: child.name });
      childNode.parent = node.id;
      childNode.sourcePath = `${path}/${child.name}`;
      childNode.sourcePrimType = 'instanceable';
      childNode.instanceOf = ref;
      childNode.instanceSetIds = [];
      const variantRef = refPath(child.metadata.references);
      const variantSpec = variantRef ? byPath.get(variantRef) : null;
      const binding = variantSpec ? findOverrideBinding(variantSpec) : null;
      if (binding && byPath.has(binding)) {
        childNode.overrides = { material: materialFor(byPath.get(binding), binding).id };
        childNode.prototypeVariant = variantRef;
      }
      applyMatrix(childNode, local);
      scene.nodes.push(childNode);
      created.push(childNode);
      transforms.push(multiply(local, rows[0].matrix || IDENTITY));
      transformOverrides.push({ material: childNode.overrides?.material || null });
    }

    const set = createInstanceSet({
      name: `${spec.name}_instances`,
      mesh: rows[0].mesh,
      rows: [rows[0]],
      transforms,
      sourcePath: path,
      kind: 'gltf-instancing',
    });
    set.transformOverrides = transformOverrides;
    const mesh = scene.meshes.find((m) => m.id === rows[0].mesh);
    set.material = mesh?.material ?? null;
    set.prototypePath = ref;
    set.prototypeMeshPath = rows[0].meshPath;
    set.sourcePaths = created.map((c) => c.sourcePath);
    set.mirroredCount = transforms.filter((m) => determinant3(m) < 0).length;
    instanceSets.set(`${path}|${ref}|${rows[0].mesh}`, set);

    for (const c of created) {
      scene.nodes.splice(scene.nodes.indexOf(c), 1);
      c.isPrototype = true;
    }
    node.sourcePrimType = 'gltf-instancing-host';
    node.instanceSetIds = [set.id];
    node.pointInstancerCount = transforms.length;
    return true;
  }

  /** Base geometry prototype behind a placement, unwrapping one material variant. */
  function baseReferencePath(placementSpec) {
    const direct = refPath(placementSpec.metadata.references);
    const directSpec = direct ? byPath.get(direct) : null;
    if (directSpec && findOverrideBinding(directSpec)) {
      return refPath(directSpec.metadata.references) || direct;
    }
    return direct;
  }

  return { scene, warnings, sourceName };
}

// ---- helpers -------------------------------------------------------------

function flattenNumbers(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (Array.isArray(v)) out.push(...v.map(Number));
    else out.push(Number(v));
  }
  return out;
}

function axisAngle(axis, degrees) {
  const half = (degrees * Math.PI) / 360;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

function refPath(refs) {
  if (!refs) return null;
  if (Array.isArray(refs)) return refs[0]?.path ?? null;
  return refs.path ?? null;
}
