// Canonical in-memory scene model for the declared glTF <-> USD subset.
//
// Both readers produce this model and both writers consume it, so a conversion
// is always read(real file) -> SceneIR -> write(real file). The IR keeps the
// provenance needed to make audit claims rather than infer them later:
// instance reuse, source prim paths, degraded material inputs, and the exact
// axis/unit decisions taken.

import { compose as composeFromTRS } from './math.js';

export const SUBSET = Object.freeze({
  version: 1,
  geometry: ['TRIANGLES'],
  uvSets: 1,
  attributes: ['POSITION', 'NORMAL', 'TEXCOORD_0'],
  materials: ['pbrMetallicRoughness', 'doubleSided', 'alphaMode'],
  pbrInputs: ['baseColorFactor', 'metallicFactor', 'roughnessFactor', 'baseColorTexture'],
  unsupportedMaterialInputs: [
    'emissiveFactor',
    'emissiveTexture',
    'normalTexture',
    'occlusionTexture',
    'metallicRoughnessTexture',
    'alphaCutoff',
    'clearcoat',
    'transmission',
    'sheen',
    'iridescence',
    'specular',
    'IOR',
  ],
  instancing: 'EXT_mesh_gpu_instancing on glTF, instanceable prims + PointInstancer in USD',
});

export function createScene({ name = 'scene', upAxis = 'Y', metersPerUnit = 1 } = {}) {
  return {
    name,
    // Canonical frame: right-handed, Y-up, metres. Units are still carried so
    // the report can state the scale applied, never left implicit.
    upAxis,
    metersPerUnit,
    // One explicit source->canonical fix matrix, applied at world evaluation
    // (and baked into the file root by format writers that have no stage
    // metadata). Node locals stay in authored coordinates.
    rootFix: null,
    nodes: [],
    meshes: [],
    materials: [],
    textures: [],
    instanceSets: [],
    warnings: [],
    provenance: { source: null, reader: null, writer: null },
  };
}

let nodeCounter = 0;
export function createNode({ name = 'node', parent = null, translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1], matrix = null } = {}) {
  return {
    id: `n${++nodeCounter}`,
    name,
    parent,
    children: [],
    translation, rotation, scale,
    matrix: matrix || composeFromTRS({ translation, rotation, scale }),
    mesh: null,
    // instanceable form: this node is one placement of a shared prototype.
    instanceOf: null,
    instanceSetIds: null,
    instanceIndex: -1,
    sourcePath: null,
    sourcePrimType: null,
    visible: true,
    isPrototypeSource: false,
  };
}

let meshCounter = 0;
export function createMesh({ name = 'mesh', positions, normals = null, uvs = null, indices, material = null } = {}) {
  return {
    id: `m${++meshCounter}`,
    name,
    positions,
    normals,
    uvs,
    indices,
    material,
    sourcePath: null,
    // Winding-facing normalisation applied during read, e.g. 'flipped'.
    windingFix: null,
  };
}

let materialCounter = 0;
export function createMaterial({ name = 'material', baseColorFactor = [1, 1, 1, 1], metallicFactor = 1, roughnessFactor = 1, doubleSided = false, alphaMode = 'OPAQUE', baseColorTexture = null } = {}) {
  return {
    id: `mat${++materialCounter}`,
    name,
    baseColorFactor,
    metallicFactor,
    roughnessFactor,
    doubleSided,
    alphaMode,
    alphaCutoff: 0.5,
    baseColorTexture,
    sourcePath: null,
  };
}

let instanceSetCounter = 0;
/**
 * An instance set is a *shared prototype* plus the way placements refer to it.
 *
 *  - rows:       geometry inside the prototype, one entry per drawn mesh, with
 *                its transform relative to the prototype root. Authored once.
 *  - transforms: placement matrices relative to the *host node* that carries
 *                the set. glTF EXT_mesh_gpu_instancing and USD PointInstancer
 *                use this form: one host node, N transforms.
 *  - kind 'instanceable': the other USD form. Each placement is its own node
 *                with `instanceOf`, and draws every row relative to itself, so
 *                `transforms` stays empty and the placements are nodes.
 *
 * Keeping both forms explicit stops a reader from pretending N USD prims are
 * one glTF instancing node (or the reverse) and losing the relationship.
 */
export function createInstanceSet({ name = 'instances', mesh = null, material = null, transforms = [], rows = null, sourcePath = null, kind = 'node' } = {}) {
  return {
    id: `is${++instanceSetCounter}`,
    name,
    mesh,
    material,
    rows: rows || [{ mesh, matrix: null, }],
    transforms,
    sourcePath,
    // 'instanceable' | 'pointInstancer' | 'gltf-instancing'
    kind,
    mirroredCount: 0,
    sourcePaths: [],
    prototypePath: null,
    expandedCount: 0,
    reuseDelta: 0,
  };
}

/** Number of placements drawing this set, counted per representation. */
export function placementCount(scene, set) {
  if (set.kind === 'instanceable') {
    let n = 0;
    for (const node of scene.nodes) {
      if (node.instanceOf && node.instanceSetIds?.includes(set.id)) n++;
    }
    return n;
  }
  return set.transforms.length;
}

/** Nodes that place this set (instanceable form). */
export function placementNodes(scene, set) {
  return scene.nodes.filter((n) => n.instanceOf && n.instanceSetIds?.includes(set.id));
}

export function resetIds() {
  nodeCounter = 0;
  meshCounter = 0;
  materialCounter = 0;
  instanceSetCounter = 0;
}

export function addChild(scene, parent, node) {
  node.parent = parent ? parent.id : null;
  scene.nodes.push(node);
  if (parent) {
    const parentNode = scene.nodes.find((n) => n.id === parent.id);
    if (!parentNode) throw new Error(`parent ${parent.id} not in scene`);
    parentNode.children.push(node.id);
  }
  return node;
}

export function findNode(scene, id) {
  return scene.nodes.find((n) => n.id === id) || null;
}

export function findMesh(scene, id) {
  return scene.meshes.find((m) => m.id === id) || null;
}

export function findMaterial(scene, id) {
  return scene.materials.find((m) => m.id === id) || null;
}

export function rootNodes(scene) {
  return scene.nodes.filter((n) => n.parent === null);
}

export function triangleCount(mesh) {
  return mesh.indices ? Math.floor(mesh.indices.length / 3) : Math.floor(mesh.positions.length / 9);
}

/** Total triangles drawn if every placement were expanded. */
export function visibleTriangleCount(scene) {
  let total = 0;
  for (const node of scene.nodes) {
    if (node.instanceOf) continue; // counted through its instance set
    if (node.mesh && node.visible) total += triangleCount(findMesh(scene, node.mesh));
  }
  for (const set of scene.instanceSets) {
    const tris = set.rows.reduce((s, row) => s + triangleCount(findMesh(scene, row.mesh)), 0);
    total += tris * placementCount(scene, set);
  }
  return total;
}

/** Resource reuse: how many drawn copies share one mesh, and saved memory. */
export function resourceReuse(scene) {
  const drawCount = new Map();
  for (const node of scene.nodes) {
    if (node.mesh && !node.instanceOf) drawCount.set(node.mesh, (drawCount.get(node.mesh) || 0) + 1);
  }
  for (const set of scene.instanceSets) {
    const placements = placementCount(scene, set);
    for (const row of set.rows) drawCount.set(row.mesh, (drawCount.get(row.mesh) || 0) + placements);
  }
  return scene.meshes.map((mesh) => ({
    mesh: mesh.id,
    name: mesh.name,
    draws: drawCount.get(mesh.id) || 0,
    vertices: mesh.positions.length / 3,
    triangles: triangleCount(mesh),
    shared: (drawCount.get(mesh.id) || 0) > 1,
  }));
}
