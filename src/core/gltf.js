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
            set.sourcePaths.push(node.sourcePath);
            if (determinant3(local) < 0) set.mirroredCount++;
          }
          scene.instanceSets.push(set);
          node.instanceSetIds = [set.id];
          node.visible = def.extras?.usdgltf?.visible !== false;
        }
        for (const c of def.children || []) buildNode(c, node, node.sourcePath);
        return node;
      }
      const mesh = readMesh(def.mesh, 0);
      if (mesh) node.mesh = mesh.id;
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
  function meshEntry(mesh, { doubleSided = false } = {}) {
    const key = doubleSided ? `${mesh.id}#doubleSided` : mesh.id;
    if (meshIndex.has(key)) return meshIndex.get(key);
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
    const primitive = { attributes, mode: 4 };
    if (mesh.indices) {
      const idx = Uint32Array.from(mesh.indices);
      primitive.indices = pushAccessor(idx, { type: 'SCALAR', componentType: 5125, target: 34963 });
    }
    const mat = scene.materials.find((m) => m.id === mesh.material);
    if (mat) primitive.material = materialIndex(mat, doubleSided ? 'doubleSided' : 'asAuthored');
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
    // separate instancing child.
    const extSets = (node.instanceSetIds || [])
      .map((id) => scene.instanceSets.find((s) => s.id === id))
      .filter((s) => s && s.kind !== 'instanceable');
    if (extSets.length === 1 && !node.mesh && node.children.length === 0) {
      const { meshIdx, mirrorFix } = instanceMeshEntry(extSets[0], mirrorMitigation);
      def.mesh = meshIdx;
      def.extensions = { EXT_mesh_gpu_instancing: { attributes: pushInstanceAccessors(extSets[0].transforms.length ? extSets[0].transforms : [IDENTITY_MATRIX]) } };
      if (includeExtras) {
        def.extras = {
          usdgltf: {
            kind: 'instance-set',
            instanceSet: extSets[0].id,
            encoding: extSets[0].kind,
            prototypePath: extSets[0].prototypePath || null,
            sourcePaths: extSets[0].sourcePaths,
            mirroredInstances: mirroredCountOf(extSets[0]),
            mirrorPolicy: mirrorPolicyText(mirrorFix),
            mirrorFix,
          },
        };
      }
      return idx;
    }
    for (const set of extSets) children.push(instancedNodeFor(node, set));

    // USD instanceable placements are nodes. All placements of one set that
    // share this parent collapse into a single instancing node with N
    // transforms, instead of N single-instance nodes.
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
      const c = emitNode(child);
      if (c !== null) children.push(c);
    }
    for (const [setId, placements] of placementGroups) {
      const set = scene.instanceSets.find((s) => s.id === setId);
      if (!set) continue;
      children.push(emitInstancingNode(set, placements));
    }
    for (const placement of placementsWithChildren) {
      children.push(emitNode(placement));
    }
    if (children.length) def.children = children;
    return idx;
  }

  /** One EXT_mesh_gpu_instancing node for a group of USD placement nodes. */
  function emitInstancingNode(set, placements) {
    const { meshIdx, mirrorFix } = instanceMeshEntry(set, mirrorMitigation);
    const row = set.rows[0]?.matrix || IDENTITY_MATRIX;
    // Placements are siblings: their locals are relative to the same parent,
    // and the prototype row is relative to the prototype root.
    const transforms = placements.map((p) => multiply(p.matrix, row));
    const attributes = pushInstanceAccessors(transforms);
    const idx = nodesJson.length;
    const def = {
      name: set.name,
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
          sourcePaths: placements.map((p) => p.sourcePath),
          mirroredInstances: mirroredCountOf(set),
          mirrorPolicy: mirrorPolicyText(mirrorFix),
          mirrorFix,
        },
      };
    }
    nodesJson.push(def);
    return idx;
  }

  function instancedNodeFor(node, set) {
    const { meshIdx, mirrorFix } = instanceMeshEntry(set, mirrorMitigation);
    const transforms = set.transforms.length ? set.transforms : [IDENTITY_MATRIX];
    const attributes = pushInstanceAccessors(transforms);
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
