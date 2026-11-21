// glTF 2.0 (.gltf + embedded/base64 buffers) reader and writer for the
// declared subset.
//
// Instances are carried by EXT_mesh_gpu_instancing (core-valid extension), never
// by duplicating meshes. Mirrored instances keep their negative-determinant
// matrix, and per-instance mirrored flags stay in extras. three.js decides the
// winding of a draw with the *object* matrix determinant
// (`three.module.js: const frontFaceCW = ( object.isMesh &&
// object.matrixWorld.determinant() < 0 );`), so an InstancedMesh whose own
// determinant is positive never flips for its mirrored instance. A single-sided
// mirrored instance is therefore back-face culled and disappears.
//
// The writer's mitigation is explicit rather than silent: when an instance set
// contains a mirrored placement and its material is single-sided, that set gets
// a second material variant with `doubleSided: true` (sharing the same
// accessors). The trade-off — those instances become visible from both sides
// instead of vanishing — is returned as a warning and surfaced in the report.
// No instance matrix is modified and no mesh is duplicated.

import { createScene, createNode, createMesh, createMaterial, createInstanceSet, addChild } from './scene.js';
import { compose, decompose, multiply, determinant3 } from './math.js';

const GENERATOR = 'usdgltf-bridge 0.1.0';
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function readGltf(json, { sourceName = 'scene.gltf' } = {}) {
  const warnings = [];
  const scene = createScene({ name: sourceName, upAxis: 'Y', metersPerUnit: 1 });
  scene.provenance = { source: sourceName, reader: 'gltf-reader', writer: null };
  scene.warnings = warnings;

  if (json.asset?.version !== '2.0') {
    warnings.push({ message: `asset.version is '${json.asset?.version}'; only 2.0 is supported`, layer: sourceName });
  }
  if (!json.extensionsUsed?.includes('EXT_mesh_gpu_instancing') && json.nodes?.some((n) => n.extensions?.EXT_mesh_gpu_instancing)) {
    warnings.push({ message: 'instancing extension used without declaring extensionsUsed', layer: sourceName });
  }

  // Decode buffers (data URIs only; external .bin is outside the declared subset).
  const buffers = (json.buffers || []).map((b, i) => {
    if (!b.uri) throw new Error(`buffer ${i} has no uri (GLB binary is outside the declared subset)`);
    return decodeDataUri(b.uri);
  });

  const accessorCache = new Map();
  function readAccessor(index) {
    if (accessorCache.has(index)) return accessorCache.get(index);
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const buffer = buffers[view.buffer];
    const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
    const numComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[acc.type];
    const ArrayType = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType];
    const viewOffset = (view.byteOffset || 0) + (acc.byteOffset || 0);
    // Copy to satisfy alignment requirements of typed array constructors.
    const byteLength = acc.count * numComp * compSize;
    const copy = buffer.slice(viewOffset, viewOffset + byteLength);
    const typed = new ArrayType(copy.buffer, copy.byteOffset, acc.count * numComp);
    const result = { data: typed, count: acc.count, numComp, normalized: !!acc.normalized, componentType: acc.componentType, min: acc.min, max: acc.max };
    accessorCache.set(index, result);
    return result;
  }

  const materials = new Map();
  function readMaterial(i) {
    if (i === undefined || i === null) return null;
    if (materials.has(i)) return materials.get(i);
    const def = json.materials[i] || {};
    const pbr = def.pbrMetallicRoughness || {};
    const mat = createMaterial({
      name: def.name || `material_${i}`,
      baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      doubleSided: !!def.doubleSided,
      alphaMode: def.alphaMode || 'OPAQUE',
    });
    mat.alphaCutoff = def.alphaCutoff ?? 0.5;
    mat.sourcePath = `materials/${i}`;
    if (pbr.baseColorTexture) mat.baseColorTexture = pbr.baseColorTexture.index;
    const unsupported = [];
    if (def.emissiveFactor && def.emissiveFactor.some((v) => v !== 0)) unsupported.push('emissiveFactor');
    if (def.emissiveTexture) unsupported.push('emissiveTexture');
    if (def.normalTexture) unsupported.push('normalTexture');
    if (def.occlusionTexture) unsupported.push('occlusionTexture');
    if (pbr.metallicRoughnessTexture) unsupported.push('metallicRoughnessTexture');
    if (def.extensions) unsupported.push(...Object.keys(def.extensions));
    if (unsupported.length) {
      mat.degradedInputs = unsupported;
      warnings.push({ message: `material '${mat.name}': ${unsupported.join(', ')} outside the declared subset were dropped`, layer: sourceName });
    }
    materials.set(i, mat);
    scene.materials.push(mat);
    return mat;
  }

  const meshes = new Map();
  // glTF mesh primitives that draw the same POSITION accessor are one physical
  // geometry resource (e.g. a material-only override). They get distinct IR
  // mesh objects so each can carry its own material, but one shared resourceKey
  // so sharing statistics and lineage treat the bytes as authored once.
  const resourceKeyByAccessor = new Map();
  function readMesh(i, primitiveIndex = 0) {
    const key = `${i}:${primitiveIndex}`;
    if (meshes.has(key)) return meshes.get(key);
    const def = json.meshes[i];
    const prim = def.primitives[primitiveIndex];
    if (prim.mode !== undefined && prim.mode !== 4) {
      warnings.push({ message: `mesh '${def.name || i}' primitive ${primitiveIndex}: mode ${prim.mode} is not TRIANGLES and was skipped`, layer: sourceName });
      meshes.set(key, null);
      return null;
    }
    const pos = readAccessor(prim.attributes.POSITION);
    const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
    const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;
    const idx = prim.indices !== undefined ? readAccessor(prim.indices) : null;
    const mesh = createMesh({
      name: def.name || `mesh_${i}`,
      positions: Float32Array.from(pos.data),
      normals: nrm ? Float32Array.from(nrm.data) : null,
      uvs: uv ? Float32Array.from(uv.data) : null,
      indices: idx ? Uint32Array.from(idx.data) : null,
    });
    mesh.material = readMaterial(prim.material)?.id ?? null;
    mesh.sourcePath = `meshes/${i}/primitives/${primitiveIndex}`;
    if (!resourceKeyByAccessor.has(prim.attributes.POSITION)) {
      resourceKeyByAccessor.set(prim.attributes.POSITION, `key-gltf-accessor-${prim.attributes.POSITION}`);
    }
    mesh.resourceKey = resourceKeyByAccessor.get(prim.attributes.POSITION);
    for (const attr of Object.keys(prim.attributes)) {
      if (!['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(attr)) {
        warnings.push({ message: `mesh '${mesh.name}': attribute ${attr} outside the declared subset was dropped`, layer: sourceName });
      }
    }
    meshes.set(key, mesh);
    scene.meshes.push(mesh);
    return mesh;
  }

  // Nodes.
  const nodes = json.nodes || [];
  const nodeToIr = new Map();
  const parents = new Map();
  nodes.forEach((n, i) => {
    for (const c of n.children || []) parents.set(c, i);
  });

  function buildNode(i, parentIr, parentPath) {
    if (nodeToIr.has(i)) return nodeToIr.get(i);
    const def = nodes[i];
    const node = createNode({ name: def.name || `node_${i}` });
    node.parent = parentIr ? parentIr.id : null;
    if (parentIr) parentIr.children.push(node.id);
    node.sourcePath = `${parentPath}/${def.name || i}`;
    node.sourcePrimType = def.extensions?.EXT_mesh_gpu_instancing ? 'instance-node' : def.mesh !== undefined ? 'mesh-node' : 'node';
    if (def.matrix) {
      node.matrix = Array.from(def.matrix);
      const d = decompose(node.matrix);
      node.translation = d.translation;
      node.rotation = d.rotation;
      node.scale = d.scale;
    } else {
      node.translation = def.translation || [0, 0, 0];
      node.rotation = def.rotation || [0, 0, 0, 1];
      node.scale = def.scale || [1, 1, 1];
      node.matrix = compose(node);
    }
    scene.nodes.push(node);
    nodeToIr.set(i, node);

    if (def.mesh !== undefined) {
      if (def.extensions?.EXT_mesh_gpu_instancing) {
        const ext = def.extensions.EXT_mesh_gpu_instancing;
        const mesh = readMesh(def.mesh, 0);
        if (mesh) {
          const count = countOfExt(ext);
          const set = createInstanceSet({
            name: `${node.name}_instances`,
            mesh: mesh.id,
            rows: [{ mesh: mesh.id, matrix: null, meshPath: node.sourcePath }],
            transforms: [],
            sourcePath: node.sourcePath,
            kind: 'gltf-instancing',
          });
          set.material = mesh.material;
          set.sourcePaths = [];
          set.mirroredCount = 0;
          for (let k = 0; k < count; k++) {
            // EXT_mesh_gpu_instancing transforms are relative to the hosting
            // node (glTF spec); keep them that way so world = nodeWorld * instance.
            const local = compose({
              translation: readInstanceAttr(ext, 'TRANSLATION', k, [0, 0, 0]),
              rotation: readInstanceAttr(ext, 'ROTATION', k, [0, 0, 0, 1]),
              scale: readInstanceAttr(ext, 'SCALE', k, [1, 1, 1]),
            });
            set.transforms.push(local);
            set.transformOverrides.push({ material: null });
            set.sourcePaths.push(node.sourcePath);
            if (determinant3(local) < 0) set.mirroredCount++;
          }
          scene.instanceSets.push(set);
          node.instanceSetIds = [set.id];
          node.visible = def.extras?.usdgltf?.visible !== false;
          // Material-override placements were split into sibling mesh nodes
          // that reuse the same geometry accessors. Fold them back into this
          // set as per-transform material overrides, keyed by the placement
          // indices the writer recorded; their mesh objects keep the same
          // resourceKey because they point at one accessor set.
          const remainingChildren = foldOverrideChildren(def, node, set);
          for (const c of remainingChildren) buildNode(c, node, node.sourcePath);
          return node;
        }
        for (const c of def.children || []) buildNode(c, node, node.sourcePath);
        return node;
      }
      // A material-override placement produced by this tool: it draws the same
      // geometry as its sibling instance set but carries its own material.
      const overrideInfo = def.extras?.usdgltf?.kind === 'material-override-placement'
        ? def.extras.usdgltf
        : null;
      if (overrideInfo && parentIr?.instanceSetIds?.length) {
        attachOverridePlacement(def, node, parentIr, overrideInfo);
        for (const c of def.children || []) buildNode(c, node, node.sourcePath);
        return node;
      }
      const plainMesh = readMesh(def.mesh, 0);
      if (plainMesh) node.mesh = plainMesh.id;
    }
    // Host Xform whose children are one shared InstancedMesh plus material-
    // override sibling nodes (the writer's split for per-placement materials).
    // Fold the siblings back into the instancing child's set so one set carries
    // N transforms with per-transform overrides, instead of separate meshes.
    if (def.children?.length && !def.mesh && !def.extensions?.EXT_mesh_gpu_instancing &&
        def.children.some((c) => nodes[c]?.extras?.usdgltf?.kind === 'material-override-placement')) {
      const remaining = foldHostOverrideChildren(def, node);
      for (const c of remaining) buildNode(c, node, node.sourcePath);
      return node;
    }
    for (const c of def.children || []) buildNode(c, node, node.sourcePath);
    return node;
  }

  function countOfExt(ext) {
    const attr = ext.attributes.TRANSLATION || ext.attributes.ROTATION || ext.attributes.SCALE;
    return readAccessor(attr).count;
  }

  function readInstanceAttr(ext, name, k, fallback) {
    const idx = ext.attributes[name];
    if (idx === undefined) return fallback;
    const acc = readAccessor(idx);
    return Array.from(acc.data.slice(k * acc.numComp, k * acc.numComp + acc.numComp));
  }

  /**
   * Material-override sibling nodes are folded back into the host's instance
   * set as per-transform material overrides. The override node is removed from
   * the scene tree: it is not a separate piece of geometry, only a different
   * material opinion on one placement of the shared resource.
   */
  function foldOverrideChildren(hostDef, hostNode, set) {
    const children = hostDef.children || [];
    const removeIndices = [];
    children.forEach((childJsonIndex, k) => {
      const childDef = nodes[childJsonIndex];
      const info = childDef?.extras?.usdgltf;
      if (info?.kind !== 'material-override-placement') return;
      const childMesh = readMesh(childDef.mesh, 0);
      if (!childMesh) return;
      const material = childMesh.material;
      const local = compose({
        translation: childDef.translation || [0, 0, 0],
        rotation: childDef.rotation || [0, 0, 0, 1],
        scale: childDef.scale || [1, 1, 1],
      });
      const indices = info.placementIndices && info.placementIndices.length
        ? info.placementIndices
        : [set.transforms.length];
      for (const placementIndex of indices) {
        // Prefer an authored slot; otherwise append the placement transform.
        if (placementIndex < set.transforms.length) {
          set.transformOverrides[placementIndex] = { material };
        } else {
          set.transforms.push(local);
          set.transformOverrides.push({ material });
          set.sourcePaths.push(`${hostNode.sourcePath}#${placementIndex}`);
        }
      }
      removeIndices.push(k);
    });
    return children.filter((_, k) => !removeIndices.includes(k));
  }

  /**
   * Fold a host Xform's split children — one shared InstancedMesh plus one or
   * more material-override sibling nodes — back into the instancing child's
   * set. The override siblings are consumed (not built as scene nodes): they
   * only re-bind the material of a placement whose geometry is the shared
   * accessor set. Returns the child indices that still need normal buildNode.
   */
  function foldHostOverrideChildren(hostDef, hostNode) {
    const children = hostDef.children || [];
    const instancedIndices = [];
    const overrideIndices = [];
    children.forEach((childJsonIndex, k) => {
      const childDef = nodes[childJsonIndex];
      const kind = childDef?.extras?.usdgltf?.kind;
      if (childDef?.extensions?.EXT_mesh_gpu_instancing) instancedIndices.push(k);
      else if (kind === 'material-override-placement') overrideIndices.push(k);
    });
    // Only fold the unambiguous shape: exactly one shared instancing child and
    // at least one override sibling, with no other child kinds present.
    if (instancedIndices.length !== 1 || overrideIndices.length === 0 ||
        instancedIndices.length + overrideIndices.length !== children.length) {
      return children.map((_, k) => k);
    }
    const instancedJsonIndex = children[instancedIndices[0]];
    const instancedDef = nodes[instancedJsonIndex];
    // Build the instancing child as its own node so its path and identity
    // survive the fold; the folded set is attached there, not on the parent.
    const innerNode = buildNode(instancedJsonIndex, hostNode, hostNode.sourcePath);
    const set = scene.instanceSets.find((s) => s.id === innerNode?.instanceSetIds?.[0]);
    if (!set) return children.map((_, k) => k);
    const sharedMesh = scene.meshes.find((m) => m.id === set.mesh);
    if (sharedMesh) set.resourceKey = sharedMesh.resourceKey;
    const consumed = new Set([instancedIndices[0]]);
    for (const k of overrideIndices) {
      const childDef = nodes[children[k]];
      const info = childDef.extras.usdgltf;
      const overrideMesh = readMesh(childDef.mesh, 0);
      if (overrideMesh) overrideMesh.resourceKey = set.resourceKey || overrideMesh.resourceKey;
      const local = compose({
        translation: childDef.translation || [0, 0, 0],
        rotation: childDef.rotation || [0, 0, 0, 1],
        scale: childDef.scale || [1, 1, 1],
      });
      const indices = info.placementIndices?.length ? info.placementIndices : [set.transforms.length];
      for (const placementIndex of indices) {
        if (placementIndex < set.transforms.length) {
          set.transformOverrides[placementIndex] = { material: overrideMesh.material };
        } else {
          set.transforms.push(local);
          set.transformOverrides.push({ material: overrideMesh.material });
          set.sourcePaths.push(`${innerNode.sourcePath}#${placementIndex}`);
        }
      }
      consumed.add(k);
    }
    return children.map((_, k) => k).filter((k) => !consumed.has(k));
  }

  /**
   * An override placement read on its own (foreign or reordered file) is kept
   * as a node but marked with the override relationship, so it never looks like
   * independent geometry: its mesh shares the instance set's resourceKey.
   */
  function attachOverridePlacement(def, node, parentNode, info) {
    const set = scene.instanceSets.find((s) => s.id === parentNode.instanceSetIds[0]);
    const overrideMesh = readMesh(def.mesh, 0);
    if (set && overrideMesh) {
      overrideMesh.resourceKey = scene.meshes.find((m) => m.id === set.mesh)?.resourceKey || overrideMesh.resourceKey;
      node.overrides = { material: overrideMesh.material };
      node.materialOverrideOf = set.id;
      node.placementIndices = info.placementIndices || [];
      node.isOverridePlacement = true;
    } else if (overrideMesh) {
      node.mesh = overrideMesh.id;
    }
  }

  const sceneIndex = json.scene ?? 0;
  const sceneDef = json.scenes?.[sceneIndex];
  const roots = sceneDef?.nodes || nodes.map((_, i) => i).filter((i) => !parents.has(i));
  for (const r of roots) buildNode(r, null, '');
  return { scene, warnings, sourceName, json };
}

// ---- writer --------------------------------------------------------------

export function writeGltf(scene, { includeExtras = true, mirrorMitigation = true } = {}) {
  // Build the node list grouped by parent, skipping prototype subtrees.
  const binChunks = [];
  let binLength = 0;
  const bufferViews = [];
  const accessors = [];
  const mirrorWarnings = [];
  const mirrorReported = new Set();

  function pushView(typedArray, target) {
    // 4-byte align every view.
    const pad = (4 - (binLength % 4)) % 4;
    if (pad) { binChunks.push(new Uint8Array(pad)); binLength += pad; }
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    binChunks.push(copy);
    const view = { buffer: 0, byteOffset: binLength, byteLength: bytes.length };
    if (target !== undefined) view.target = target;
    bufferViews.push(view);
    binLength += bytes.length;
    return bufferViews.length - 1;
  }

  function pushAccessor(typedArray, { type, componentType, min, max, target }) {
    const view = pushView(typedArray, target);
    const acc = { bufferView: view, componentType, count: typedArray.length / componentsOf(type), type };
    if (min) acc.min = min;
    if (max) acc.max = max;
    accessors.push(acc);
    return accessors.length - 1;
  }

  const meshesJson = [];
  const meshIndex = new Map();
  // Geometry accessors are emitted once per physical resource and reused by
  // every primitive that draws that mesh, so a material-only override (two IR
  // mesh objects sharing one resourceKey) writes a second primitive referencing
  // the same POSITION/NORMAL/indices accessors: the bytes are physically shared
  // on disk, not merely equal.
  const geometryAccessorCache = new Map();
  function geometryAccessors(mesh) {
    const cacheKey = mesh.resourceKey || mesh.id;
    if (geometryAccessorCache.has(cacheKey)) return geometryAccessorCache.get(cacheKey);
    const position = Float32Array.from(mesh.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], position[i + c]);
        max[c] = Math.max(max[c], position[i + c]);
      }
    }
    const attributes = { POSITION: pushAccessor(position, { type: 'VEC3', componentType: 5126, min, max, target: 34962 }) };
    if (mesh.normals) attributes.NORMAL = pushAccessor(Float32Array.from(mesh.normals), { type: 'VEC3', componentType: 5126, target: 34962 });
    if (mesh.uvs) attributes.TEXCOORD_0 = pushAccessor(Float32Array.from(mesh.uvs), { type: 'VEC2', componentType: 5126, target: 34962 });
    const indices = mesh.indices ? pushAccessor(Uint32Array.from(mesh.indices), { type: 'SCALAR', componentType: 5125, target: 34963 }) : null;
    const acc = { attributes, indices };
    geometryAccessorCache.set(cacheKey, acc);
    return acc;
  }

  function meshEntry(mesh, { doubleSided = false, materialOverride = null } = {}) {
    // A material override produces a second glTF mesh primitive that points at
    // the *same* geometry accessors: no position/normal/index bytes are
    // authored twice, only the primitive's material index changes.
    const key = materialOverride
      ? `${mesh.id}#mat:${materialOverride}`
      : doubleSided ? `${mesh.id}#doubleSided` : mesh.id;
    if (meshIndex.has(key)) return meshIndex.get(key);
    const { attributes, indices } = geometryAccessors(mesh);
    const primitive = { attributes, mode: 4 };
    if (indices !== null) primitive.indices = indices;
    if (materialOverride) {
      const overrideMat = scene.materials.find((m) => m.id === materialOverride);
      if (overrideMat) primitive.material = materialIndex(overrideMat, 'asAuthored');
    } else {
      const mat = scene.materials.find((m) => m.id === mesh.material);
      if (mat) primitive.material = materialIndex(mat, doubleSided ? 'doubleSided' : 'asAuthored');
    }
    meshesJson.push({ name: mesh.name, primitives: [primitive] });
    const index = meshesJson.length - 1;
    meshIndex.set(key, index);
    return index;
  }

  const materialsJson = [];
  const matIndex = new Map();
  function materialIndex(mat, mode = 'asAuthored') {
    const key = `${mat.id}#${mode}`;
    if (matIndex.has(key)) return matIndex.get(key);
    const def = {
      name: mode === 'doubleSided' ? `${mat.name}_doubleSided` : mat.name,
      pbrMetallicRoughness: {
        baseColorFactor: mat.baseColorFactor.map(round6),
        metallicFactor: round6(mat.metallicFactor),
        roughnessFactor: round6(mat.roughnessFactor),
      },
      alphaMode: mat.alphaMode,
    };
    // A variant is only emitted to make mirrored instances visible; otherwise
    // the authored side is kept exactly.
    if (mat.doubleSided || mode === 'doubleSided') def.doubleSided = true;
    materialsJson.push(def);
    const i = materialsJson.length - 1;
    matIndex.set(key, i);
    return i;
  }

  /**
   * glTF-facing material for an instance set: widen to double-sided exactly
   * when the set has a mirrored placement and the mesh is single-sided. The
   * returned `mirrorFix` is null when no change is needed, so the caller can
   * record the degradation honestly instead of claiming a winding flip.
   */
  function instanceMeshEntry(set, mirrorMitigation) {
    const mesh = scene.meshes.find((m) => m.id === set.mesh);
    if (!mesh) return { meshIdx: undefined, mirrorFix: null };
    const mat = scene.materials.find((m) => m.id === mesh.material);
    const mirrored = mirroredCountOf(set);
    if (mirrorMitigation && mirrored > 0 && mat && !mat.doubleSided) {
      const meshIdx = meshEntry(mesh, { doubleSided: true });
      if (!mirrorReported.has(set.id)) {
        mirrorReported.add(set.id);
        mirrorWarnings.push({
          message: `${mirrored} mirrored placement(s) in instance set '${set.name || set.id}' use a single-sided material; ` +
            'three.js flips winding per object, not per instance, so those instances would be back-face culled and disappear. ' +
            'That instance mesh is given a doubleSided material variant (same geometry, same matrices): the mirrored copies stay visible ' +
            'and become visible from both sides. See extras.usdgltf.mirrorPolicy.',
          layer: 'gltf-writer',
          kind: 'mirror-facing',
          instanceSet: set.id,
          mirroredPlacements: mirrored,
          resolution: 'doubleSided variant for this instanced mesh only',
        });
      }
      return { meshIdx, mirrorFix: 'widened-to-doubleSided' };
    }
    return { meshIdx: meshEntry(mesh), mirrorFix: null };
  }

  function mirroredCountOf(set) {
    if (typeof set.mirroredCount === 'number') return set.mirroredCount;
    return (set.transforms || []).filter((m) => determinant3(m) < 0).length;
  }

  const nodesJson = [];
  const nodeIndex = new Map();
  const sceneRootIndices = [];

  function emitNode(node) {
    if (node.isPrototype) return null;
    if (nodeIndex.has(node.id)) return nodeIndex.get(node.id);
    const idx = nodesJson.length;
    const def = { name: node.name };
    // glTF has no stage metadata, so the declared axis/unit fix is baked into
    // the root transform — exactly once, on root nodes only.
    const isRoot = node.parent === null;
    const local = isRoot && scene.rootFix?.matrix ? multiply(scene.rootFix.matrix, node.matrix) : node.matrix;
    if (!isTRSIdentity(local)) {
      const d = decompose(local);
      if (d.translation.some((v) => Math.abs(v) > 1e-9)) def.translation = d.translation.map(round6);
      def.rotation = d.rotation.map(round6);
      def.scale = d.scale.map(round6);
    }
    if (node.mesh) {
      def.mesh = meshEntry(scene.meshes.find((m) => m.id === node.mesh));
    }
    nodesJson.push(def);
    nodeIndex.set(node.id, idx);
    const children = [];

    // EXT-form hosts carry their own transforms (PointInstancer / gltf input).
    // A host with nothing but transforms becomes the instancing node itself, so
    // it maps back to one node; a host that also has a mesh or children keeps a
    // separate instancing child. Per-transform material overrides cannot be
    // expressed on an InstancedMesh, so those placements are emitted as
    // separate nodes whose mesh primitive reuses the same geometry accessors.
    const extSets = (node.instanceSetIds || [])
      .map((id) => scene.instanceSets.find((s) => s.id === id))
      .filter((s) => s && s.kind !== 'instanceable');
    if (extSets.length === 1 && !node.mesh && node.children.length === 0) {
      const set = extSets[0];
      const groups = splitByMaterialOverride(set);
      if (groups.overrides.length === 0) {
        const { meshIdx, mirrorFix } = instanceMeshEntry(set, mirrorMitigation);
        def.mesh = meshIdx;
        def.extensions = { EXT_mesh_gpu_instancing: { attributes: pushInstanceAccessors(set.transforms.length ? set.transforms : [IDENTITY_MATRIX]) } };
        if (includeExtras) {
          def.extras = {
            usdgltf: {
              kind: 'instance-set',
              instanceSet: set.id,
              encoding: set.kind,
              prototypePath: set.prototypePath || null,
              sourcePaths: set.sourcePaths,
              mirroredInstances: mirroredCountOf(set),
              mirrorPolicy: mirrorPolicyText(mirrorFix),
              mirrorFix,
            },
          };
        }
        nodesJson.push(def);
        return idx;
      }
      // Overrides present: keep the host Xform (no mesh) with the shared
      // InstancedMesh and one shared-accessor node per override placement.
      const childIndices = [];
      if (groups.shared.length) childIndices.push(emitInstancedNode(set, groups.shared, { name: node.name }));
      for (const group of groups.overrides) childIndices.push(emitOverridePlacement(set, group));
      def.children = childIndices;
      nodesJson.push(def);
      return idx;
    }
    for (const set of extSets) {
      const groups = splitByMaterialOverride(set);
      if (groups.shared.length) children.push(instancedNodeFor(node, set, groups.shared));
      for (const group of groups.overrides) children.push(emitOverridePlacement(set, group));
    }
    // A host node already emitted through extSets above (e.g. a PointInstancer)
    // must not be emitted a second time when it appears in the child list.
    const extSetIds = new Set(extSets.map((s) => s.id));

    // USD instanceable placements are nodes. All placements of one set that
    // share this parent collapse into a single instancing node with N
    // transforms, instead of N single-instance nodes. Placements carrying a
    // local material override are split into shared-accessor override nodes.
    const placementGroups = new Map();
    const placementsWithChildren = [];
    for (const childId of node.children) {
      const child = scene.nodes.find((n) => n.id === childId);
      if (!child) continue;
      if (child.instanceOf) {
        for (const setId of child.instanceSetIds || []) {
          if (!placementGroups.has(setId)) placementGroups.set(setId, []);
          placementGroups.get(setId).push(child);
        }
        // A USD instanceable prim may carry child prims; keep that subtree
        // next to the shared instancing node rather than dropping it.
        if (child.children.length) placementsWithChildren.push(child);
        continue;
      }
      if ((child.instanceSetIds || []).some((id) => extSetIds.has(id))) continue;
      // A child that itself hosts an EXT-form set emits its instancing node
      // here; naming it after the child node keeps the single-host identity a
      // recursive emitNode would produce and avoids authoring it twice.
      const childExtSets = (child.instanceSetIds || [])
        .map((id) => scene.instanceSets.find((s) => s.id === id))
        .filter((s) => s && s.kind !== 'instanceable');
      if (childExtSets.length) {
        for (const set of childExtSets) {
          const groups = splitByMaterialOverride(set);
          if (groups.shared.length) children.push(emitInstancingNode(set, groups.shared, { name: child.name }));
          for (const group of groups.overrides) children.push(emitOverridePlacement(set, group));
        }
        for (const grandchildId of child.children) {
          const grandchild = scene.nodes.find((n) => n.id === grandchildId);
          if (grandchild) {
            const gc = emitNode(grandchild);
            if (gc !== null) children.push(gc);
          }
        }
        continue;
      }
      const c = emitNode(child);
      if (c !== null) children.push(c);
    }
    for (const [setId, placements] of placementGroups) {
      const set = scene.instanceSets.find((s) => s.id === setId);
      if (!set) continue;
      const asEntry = (p) => ({ placement: p, transform: multiply(p.matrix, set.rows[0]?.matrix || IDENTITY_MATRIX) });
      const plain = placements.filter((p) => !p.overrides?.material).map(asEntry);
      const overridden = placements.filter((p) => p.overrides?.material);
      if (plain.length) children.push(emitInstancingNode(set, plain));
      for (const p of overridden) {
        children.push(emitOverridePlacement(set, { entries: [asEntry(p)], material: p.overrides.material }));
      }
    }
    for (const placement of placementsWithChildren) {
      children.push(emitNode(placement));
    }
    if (children.length) def.children = children;
    return idx;
  }

  /**
   * Split a host-form set into one shared group (no override) and one group
   * per override material. Each entry keeps its original transform index so
   * placement identity and order survive the split.
   */
  function splitByMaterialOverride(set) {
    const shared = [];
    const byMaterial = new Map();
    set.transforms.forEach((transform, k) => {
      const material = set.transformOverrides[k]?.material || null;
      const entry = { index: k, transform };
      if (!material) { shared.push(entry); return; }
      if (!byMaterial.has(material)) byMaterial.set(material, []);
      byMaterial.get(material).push(entry);
    });
    const overrides = [...byMaterial.entries()].map(([material, entries]) => ({ material, entries }));
    return { shared, overrides };
  }

  /**
   * A plain (non-instanced) node for one override placement. Its mesh primitive
   * reuses the set geometry's accessors through `meshEntry(..., {
   * materialOverride })`, so the geometry resource is physically shared while
   * only the material binding differs.
   */
  function emitOverridePlacement(set, group) {
    const mesh = scene.meshes.find((m) => m.id === set.mesh);
    const meshIdx = meshEntry(mesh, { materialOverride: group.material });
    const idx = nodesJson.length;
    const first = group.entries[0];
    const def = {
      name: `${set.name || 'instances'}__override_${group.material}`,
      mesh: meshIdx,
    };
    applyTransform(def, first.transform);
    if (includeExtras) {
      def.extras = {
        usdgltf: {
          kind: 'material-override-placement',
          instanceSet: set.id,
          materialOverride: group.material,
          placementIndices: group.entries.map((e) => e.index),
          geometryShared: true,
          prototypePath: set.prototypePath || null,
        },
      };
    }
    // One node can only hold one transform; additional placements of the same
    // override material become sibling nodes, all on the same shared mesh.
    nodesJson.push(def);
    for (const entry of group.entries.slice(1)) {
      const extra = { name: `${def.name}_${entry.index}`, mesh: meshIdx };
      applyTransform(extra, entry.transform);
      if (includeExtras) extra.extras = def.extras;
      nodesJson.push(extra);
    }
    return idx;
  }

  function applyTransform(def, matrix) {
    const d = decompose(matrix);
    if (d.translation.some((v) => Math.abs(v) > 1e-9)) def.translation = d.translation.map(round6);
    def.rotation = d.rotation.map(round6);
    def.scale = d.scale.map(round6);
  }

  /** One EXT_mesh_gpu_instancing node for a group of placement entries. */
  function emitInstancingNode(set, entries, { name = null } = {}) {
    const { meshIdx, mirrorFix } = instanceMeshEntry(set, mirrorMitigation);
    const transforms = entries.map((e) => e.transform);
    const attributes = pushInstanceAccessors(transforms);
    const idx = nodesJson.length;
    const def = {
      name: name || set.name,
      mesh: meshIdx,
      extensions: { EXT_mesh_gpu_instancing: { attributes } },
    };
    if (includeExtras) {
      def.extras = {
        usdgltf: {
          kind: 'instance-set',
          instanceSet: set.id,
          encoding: 'instanceable',
          prototypePath: set.prototypePath || null,
          sourcePaths: entries.map((e) => e.placement?.sourcePath).filter(Boolean),
          mirroredInstances: mirroredCountOf(set),
          mirrorPolicy: mirrorPolicyText(mirrorFix),
          mirrorFix,
        },
      };
    }
    nodesJson.push(def);
    return idx;
  }

  function instancedNodeFor(node, set, entries = null) {
    const { meshIdx, mirrorFix } = instanceMeshEntry(set, mirrorMitigation);
    const transforms = (entries || set.transforms.map((transform, index) => ({ index, transform }))).map((e) => e.transform);
    const attributes = pushInstanceAccessors(transforms.length ? transforms : [IDENTITY_MATRIX]);
    const idx = nodesJson.length;
    const def = {
      name: set.name || `${node.name}:instances`,
      mesh: meshIdx,
      extensions: { EXT_mesh_gpu_instancing: { attributes } },
    };
    if (includeExtras) {
      def.extras = {
        usdgltf: {
          kind: 'instance-set',
          instanceSet: set.id,
          encoding: set.kind,
          prototypePath: set.prototypePath || null,
          sourcePaths: set.sourcePaths,
          mirroredInstances: mirroredCountOf(set),
          mirrorPolicy: mirrorPolicyText(mirrorFix),
          mirrorFix,
        },
      };
    }
    nodesJson.push(def);
    return idx;
  }

  function pushInstanceAccessors(transforms) {
    const translations = new Float32Array(transforms.length * 3);
    const rotations = new Float32Array(transforms.length * 4);
    const scales = new Float32Array(transforms.length * 3);
    transforms.forEach((m, k) => {
      const d = decompose(m);
      translations.set(d.translation, k * 3);
      rotations.set(d.rotation, k * 4);
      scales.set(d.scale, k * 3);
    });
    return {
      TRANSLATION: pushAccessor(translations, { type: 'VEC3', componentType: 5126, target: 34962 }),
      ROTATION: pushAccessor(rotations, { type: 'VEC4', componentType: 5126, target: 34962 }),
      SCALE: pushAccessor(scales, { type: 'VEC3', componentType: 5126, target: 34962 }),
    };
  }

  const roots = scene.nodes.filter((n) => n.parent === null && !n.isPrototype);
  for (const root of roots) {
    const r = emitNode(root);
    if (r !== null) sceneRootIndices.push(r);
  }

  const bin = concatBytes(binChunks);
  const json = {
    asset: { version: '2.0', generator: GENERATOR },
    scene: 0,
    scenes: [{ name: scene.name, nodes: sceneRootIndices }],
    nodes: nodesJson,
    meshes: meshesJson,
    materials: materialsJson,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${toBase64(bin)}` }],
  };
  if (nodesJson.some((n) => n.extensions?.EXT_mesh_gpu_instancing)) {
    json.extensionsUsed = ['EXT_mesh_gpu_instancing'];
    json.extensionsRequired = [];
    json.extensionsRequired = [];
  }
  if (scene.warnings?.length) {
    json.extras = { warnings: scene.warnings };
  }
  return { json, bin, warnings: mirrorWarnings };
}

/**
 * Stated per instance set in extras. It describes what this file actually
 * requires of a loader: three.js (and this project's measured build) flips
 * winding per object, not per instance, so a mirror cannot rely on a loader
 * flip. `mirrorFix` says how the writer made the mirrored copies survive.
 */
function mirrorPolicyText(mirrorFix) {
  const base = 'negative-determinant instance matrices are retained verbatim; three.js flips winding per object, not per instance, so no renderer is assumed to flip a mirrored instance';
  if (mirrorFix === 'widened-to-doubleSided') {
    return `${base}; this instanced mesh uses a double-sided material variant so mirrored copies are not back-face culled (they are visible from both sides)`;
  }
  return `${base}; every instance in this set has a positive determinant, so single-sided materials keep their authored facing`;
}

// ---- helpers --------------------------------------------------------------

function componentsOf(type) {
  return { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

function isTRSIdentity(matrix) {
  const d = decompose(matrix);
  return d.translation.every((v) => Math.abs(v) < 1e-9) &&
    Math.abs(d.rotation[0]) < 1e-9 && Math.abs(d.rotation[1]) < 1e-9 &&
    Math.abs(d.rotation[2]) < 1e-9 && Math.abs(d.rotation[3] - 1) < 1e-9 &&
    d.scale.every((v) => Math.abs(v - 1) < 1e-9);
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function decodeDataUri(uri) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new Error('only data: URI buffers are supported in the declared subset');
  if (m[2]) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(m[3], 'base64'));
    const bin = atob(m[3]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(m[3]));
}

export { decodeDataUri, toBase64 };
