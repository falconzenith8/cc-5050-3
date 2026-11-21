// Conversion lineage: reverse-lookup from an output object back to the source
// node, geometry resource, parent transform and local override that produced
// it, plus layer-by-layer disabling of one mapping.
//
// The mapping is recorded as immutable `links` while a conversion runs (see
// exchange.js), never inferred from names afterwards. Identity confusion that
// used to appear when two nodes share a name is therefore impossible by
// construction: a link is between stable ids, not strings.
//
// Each link names the layers it carries:
//   parent     - the parent transform chain a placement was re-parented under
//   transform  - the placement's own local matrix
//   geometry   - the geometry resource the draw references
//   material   - the prototype/material binding the draw starts from
//   override   - a per-placement local override (e.g. material replacement)
//
// `disableMapping` switches one layer off inside the *target* scene tree and
// records the inverse so the call is reversible. The geometry layer is the one
// layer whose disable actually mints a new resource key; material, transform
// and parent disables edit only the layer named.

import { findMesh, findNode } from './scene.js';
import { IDENTITY, multiply } from './math.js';

export const LAYERS = Object.freeze(['parent', 'transform', 'geometry', 'material', 'override']);

export function createLineage() {
  return { links: [], disabledLayers: [] };
}

/** Record one source -> target mapping. Extra fields are stored verbatim. */
export function recordLink(lineage, link) {
  const entry = {
    source: link.source, // { kind: 'node'|'mesh'|'material'|'placement', id, path }
    target: link.target, // { kind, id, path }
    layers: link.layers ? link.layers.slice() : [],
    detail: link.detail || {},
  };
  lineage.links.push(entry);
  return entry;
}

/** Every link whose target matches (kind + id). */
export function linksTo(lineage, targetKind, targetId) {
  return lineage.links.filter((l) => l.target.kind === targetKind && l.target.id === targetId);
}

/** Every link whose source matches (kind + id). */
export function linksFrom(lineage, sourceKind, sourceId) {
  return lineage.links.filter((l) => l.source.kind === sourceKind && l.source.id === sourceId);
}

/**
 * Full reverse chain for an output placement/node:
 *   { node, sourceNode, parentChain, geometry, material, override, layers }
 *
 * The chain is answered from the recorded links and the live target scene, so
 * geometry identity uses `resourceKey` (one physical resource) rather than the
 * mesh object id, which a material-only override deliberately duplicates.
 */
export function tracePlacement(scene, lineage, targetNodeId) {
  const node = findNode(scene, targetNodeId);
  if (!node) return null;
  const nodeLinks = linksTo(lineage, 'node', targetNodeId)
    .concat(linksTo(lineage, 'placement', targetNodeId));

  const sourceNodeLink = nodeLinks.find((l) => l.source.kind === 'node' || l.source.kind === 'placement');
  const parentChain = parentTransformChain(scene, node);
  const geometry = geometryFor(scene, node);
  const overrideMaterial = node.overrides?.material || null;

  return {
    target: { kind: 'node', id: node.id, path: node.sourcePath || node.name },
    sourceNode: sourceNodeLink ? sourceNodeLink.source : null,
    layers: nodeLinks.flatMap((l) => l.layers),
    parentChain,
    geometry,
    material: {
      binding: geometry?.mesh?.material ?? null,
      override: overrideMaterial,
      effective: overrideMaterial || geometry?.mesh?.material || null,
    },
    links: nodeLinks,
  };
}

/**
 * Reverse chain for an output mesh resource: which source geometry it came
 * from and every placement drawing it.
 */
export function traceMesh(scene, lineage, meshId) {
  const mesh = findMesh(scene, meshId);
  if (!mesh) return null;
  const meshLinks = linksTo(lineage, 'mesh', meshId);
  const sourceGeometry = meshLinks.find((l) => l.source.kind === 'mesh')?.source || null;
  const drawnBy = [];
  for (const n of scene.nodes) {
    if (n.mesh === meshId) drawnBy.push({ kind: 'node', id: n.id, path: n.sourcePath || n.name });
    for (const setId of n.instanceSetIds || []) {
      const set = scene.instanceSets.find((s) => s.id === setId);
      if (set?.rows.some((r) => r.mesh === meshId)) {
        drawnBy.push({ kind: 'placement', id: n.id, path: n.sourcePath || n.name, instanceSet: set.id });
      }
    }
  }
  return {
    target: { kind: 'mesh', id: mesh.id, resourceKey: mesh.resourceKey, path: mesh.sourcePath },
    sourceGeometry,
    sharedResource: meshLinks.some((l) => l.detail?.resourceShared),
    drawnBy,
  };
}

/** Parent transform chain root -> node, each entry with its local and world matrices. */
export function parentTransformChain(scene, node) {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const chain = [];
  let cur = node;
  while (cur) {
    chain.unshift({
      id: cur.id,
      name: cur.name,
      path: cur.sourcePath || cur.name,
      local: (cur.matrix || IDENTITY).slice(),
    });
    cur = cur.parent ? byId.get(cur.parent) : null;
  }
  let world = IDENTITY.slice();
  for (const link of chain) {
    world = multiply(world, link.local);
    link.world = world.slice();
  }
  return chain;
}

function geometryFor(scene, node) {
  if (node.mesh) {
    const mesh = findMesh(scene, node.mesh);
    return mesh ? { mesh, resourceKey: mesh.resourceKey, meshId: mesh.id } : null;
  }
  for (const setId of node.instanceSetIds || []) {
    const set = scene.instanceSets.find((s) => s.id === setId);
    const row = set?.rows[0];
    if (!row) continue;
    const mesh = findMesh(scene, row.mesh);
    if (!mesh) continue;
    return { mesh, resourceKey: mesh.resourceKey, meshId: mesh.id, rowLocal: row.matrix ? row.matrix.slice() : null, instanceSet: set.id };
  }
  return null;
}

/**
 * Disable one mapping layer on a target node, inside the scene tree.
 *
 * The exact edit depends on the layer, and each edit returns an `undo` record
 * so the caller can restore the authored mapping:
 *   'parent'    - move the node to the scene root (parent layer detached)
 *   'transform' - replace the placement local with identity
 *   'geometry'  - detach the shared resource: the mesh becomes a private copy
 *                 with a new resourceKey (the only layer that copies geometry)
 *   'material'  - clear the prototype material binding on the placement's mesh
 *   'override'  - clear only the per-placement local override
 *
 * `lineage.disabledLayers` receives a reversible entry either way.
 */
export function disableMapping(scene, lineage, targetNodeId, layer, { cloneMesh = null } = {}) {
  if (!LAYERS.includes(layer)) throw new Error(`unknown mapping layer '${layer}'`);
  const node = findNode(scene, targetNodeId);
  if (!node) throw new Error(`node ${targetNodeId} not in scene`);
  const before = snapshotLayer(scene, node, layer);
  const record = { node: targetNodeId, layer, at: new Date().toISOString(), before, undo: null };

  if (layer === 'parent') {
    const byId = new Map(scene.nodes.map((n) => [n.id, n]));
    const parent = node.parent ? byId.get(node.parent) : null;
    if (parent) {
      parent.children = parent.children.filter((id) => id !== node.id);
      node.parent = null;
    }
  } else if (layer === 'transform') {
    node.matrix = IDENTITY.slice();
    node.translation = [0, 0, 0];
    node.rotation = [0, 0, 0, 1];
    node.scale = [1, 1, 1];
  } else if (layer === 'geometry') {
    detachGeometry(scene, node, cloneMesh);
  } else if (layer === 'material') {
    const geo = geometryFor(scene, node);
    if (geo?.mesh) geo.mesh.material = null;
  } else if (layer === 'override') {
    if (node.overrides) node.overrides.material = null;
    // A host-form set (glTF instancing / PointInstancer) carries one override
    // slot per transform; clearing the placement's override clears every slot
    // this node hosts, restoring the prototype binding for all of them.
    for (const setId of node.instanceSetIds || []) {
      const set = scene.instanceSets.find((s) => s.id === setId);
      for (const slot of set?.transformOverrides || []) {
        if (slot) slot.material = null;
      }
    }
  }

  record.undo = () => restoreLayer(scene, node, layer, before);
  lineage.disabledLayers.push(record);
  return record;
}

function snapshotLayer(scene, node, layer) {
  if (layer === 'parent') return { parent: node.parent, matrix: node.matrix.slice() };
  if (layer === 'transform') return { matrix: node.matrix.slice(), translation: node.translation.slice(), rotation: node.rotation.slice(), scale: node.scale.slice() };
  if (layer === 'geometry') {
    const geo = geometryFor(scene, node);
    return geo ? { meshId: geo.meshId, resourceKey: geo.resourceKey } : null;
  }
  if (layer === 'material') {
    const geo = geometryFor(scene, node);
    return geo ? { meshId: geo.meshId, material: geo.mesh.material } : null;
  }
  // override
  const setSlots = [];
  for (const setId of node.instanceSetIds || []) {
    const set = scene.instanceSets.find((s) => s.id === setId);
    (set?.transformOverrides || []).forEach((slot, index) => {
      setSlots.push({ set: set.id, index, material: slot?.material ?? null });
    });
  }
  return { material: node.overrides?.material ?? null, setSlots };
}

function restoreLayer(scene, node, layer, before) {
  if (layer === 'parent') {
    const byId = new Map(scene.nodes.map((n) => [n.id, n]));
    if (node.parent && byId.get(node.parent)) {
      byId.get(node.parent).children = byId.get(node.parent).children.filter((id) => id !== node.id);
    }
    node.parent = before.parent;
    if (before.parent) {
      const parent = byId.get(before.parent);
      if (parent && !parent.children.includes(node.id)) parent.children.push(node.id);
    }
    node.matrix = before.matrix;
    return;
  }
  if (layer === 'transform') {
    node.matrix = before.matrix;
    node.translation = before.translation;
    node.rotation = before.rotation;
    node.scale = before.scale;
    return;
  }
  if (layer === 'geometry') {
    if (node.mesh === before.meshId) {
      const mesh = findMesh(scene, node.mesh);
      if (mesh) mesh.resourceKey = before.resourceKey;
    }
    return;
  }
  if (layer === 'material') {
    const mesh = findMesh(scene, before.meshId);
    if (mesh) mesh.material = before.material;
    return;
  }
  if (node.overrides) node.overrides.material = before.material;
  for (const saved of before.setSlots || []) {
    const set = scene.instanceSets.find((s) => s.id === saved.set);
    if (set?.transformOverrides[saved.index]) set.transformOverrides[saved.index].material = saved.material;
  }
}

/**
 * Detach the shared geometry of one placement into a private mesh copy.
 *
 * This is the only layer-disable that copies geometry bytes. The copy keeps
 * the prototype's positions/normals/indices but gets a fresh `resourceKey`,
 * so downstream sharing statistics stop counting the placement as shared.
 * Returns the new mesh (also pushed onto scene.meshes).
 */
function detachGeometry(scene, node, cloneMesh) {
  const geo = geometryFor(scene, node);
  if (!geo) return null;
  const copy = cloneMesh
    ? cloneMesh(geo.mesh)
    : {
        ...geo.mesh,
        id: `m-copy-${node.id}`,
        positions: geo.mesh.positions,
        normals: geo.mesh.normals,
        uvs: geo.mesh.uvs,
        indices: geo.mesh.indices,
        sourcePath: `${geo.mesh.sourcePath || geo.mesh.name}#detached:${node.sourcePath || node.id}`,
      };
  copy.resourceKey = `key-detached-${node.id}-${Date.now()}`;
  copy.name = `${geo.mesh.name}_detached`;
  scene.meshes.push(copy);
  node.mesh = copy.id;
  node.instanceOf = null;
  node.instanceSetIds = null;
  return copy;
}
