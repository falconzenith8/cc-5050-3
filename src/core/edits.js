// Editable scene session with an audit tracker.
//
// Every edit goes through one command object with `apply` and `undo`. The
// tracker records evidence in three distinct categories so a report can prove
// which kind of work actually happened:
//
//   parent-layer   - a node's parent changed (a placement moved between xforms)
//   resource-shared - geometry was re-shared or kept shared: no bytes copied
//   geometry-copied  - a private mesh resource was truly minted (new resourceKey)
//
// The distinguishing rule the whole module enforces: replacing one instance's
// material must never touch geometry bytes, so it emits a resource-shared
// event and zero geometry-copied events. Only an explicit detach (or a real
// geometry edit) emits geometry-copied.

import { createMaterial, findMesh, findNode, addChild } from './scene.js';
import { multiply as multiply4, invert as invert4 } from './math.js';

export const EVENT = Object.freeze({
  PARENT_CHANGED: 'parent-layer',
  RESOURCE_SHARED: 'resource-shared',
  GEOMETRY_COPIED: 'geometry-copied',
  MATERIAL_OVERRIDE: 'material-override',
});

export class EditTracker {
  constructor() {
    this.events = [];
  }

  record(type, detail) {
    const event = { seq: this.events.length + 1, type, at: new Date().toISOString(), detail };
    this.events.push(event);
    return event;
  }

  byType(type) {
    return this.events.filter((e) => e.type === type);
  }

  get parentChanges() { return this.byType(EVENT.PARENT_CHANGED); }
  get resourceShared() { return this.byType(EVENT.RESOURCE_SHARED); }
  get geometryCopied() { return this.byType(EVENT.GEOMETRY_COPIED); }

  summary() {
    return {
      parentLayerChanges: this.parentChanges.length,
      resourceSharedEvents: this.resourceShared.length,
      geometryCopiedEvents: this.geometryCopied.length,
      materialOverrideEvents: this.byType(EVENT.MATERIAL_OVERRIDE).length,
    };
  }
}

export class EditSession {
  constructor(scene, { tracker = new EditTracker() } = {}) {
    this.scene = scene;
    this.tracker = tracker;
    this.undoStack = [];
  }

  /** Run a command, record its tracker events, and keep it for undo. */
  execute(command) {
    const applied = command.apply(this.scene, this.tracker);
    this.undoStack.push(command);
    return applied;
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return null;
    command.undo(this.scene, this.tracker);
    this.tracker.record('undo', { command: command.label });
    return command;
  }

  get canUndo() { return this.undoStack.length > 0; }
}

/**
 * Replace the material of one instance placement only.
 *
 * Geometry is never copied: the mesh resource keeps its `resourceKey`, the
 * prototype and every sibling placement keep the original binding, and the
 * replacement is stored as a local override on the placement (or on the
 * matching transform for host-form sets). Undo clears only this override.
 */
export function overrideInstanceMaterial(nodeOrIndex, scene, materialSpec, { set = null } = {}) {
  const isHostForm = !!set;
  const node = isHostForm ? null : nodeOrIndex;
  const index = isHostForm ? nodeOrIndex : null;
  const label = `override material on ${isHostForm ? `${set.name}[${index}]` : nodeOrIndex.name}`;

  let target;
  let previousMaterial;
  let createdMaterial = null;

  return {
    label,
    apply(sceneRef, tracker) {
      if (isHostForm) {
        if (!set.transformOverrides[index]) set.transformOverrides[index] = { material: null };
        previousMaterial = set.transformOverrides[index].material;
        target = { kind: 'transform', set: set.id, index };
      } else {
        if (!node.overrides) node.overrides = { material: null };
        previousMaterial = node.overrides.material;
        target = { kind: 'node', node: node.id, path: node.sourcePath || node.name };
      }
      createdMaterial = ensureMaterial(sceneRef, materialSpec);
      setOverride(sceneRef, target, createdMaterial.id);
      tracker.record(EVENT.MATERIAL_OVERRIDE, {
        target,
        previousMaterial,
        newMaterial: createdMaterial.id,
        resourceKey: geometryKeyOf(sceneRef, target, set),
        geometryCopied: false,
      });
      tracker.record(EVENT.RESOURCE_SHARED, {
        target,
        resourceKey: geometryKeyOf(sceneRef, target, set),
        reason: 'material-only override: geometry bytes untouched, resource key retained',
      });
      return { target, material: createdMaterial.id };
    },
    undo(sceneRef) {
      setOverride(sceneRef, target, previousMaterial);
      if (createdMaterial) {
        const i = sceneRef.materials.indexOf(createdMaterial);
        if (i >= 0) sceneRef.materials.splice(i, 1);
      }
    },
  };
}

/**
 * Detach one placement's shared geometry into a private mesh resource.
 *
 * This is the command that truly copies: a fresh mesh with a new resourceKey
 * is minted, and the tracker emits geometry-copied. Used by the lineage
 * geometry-layer disable and by explicit geometry edits.
 */
export function detachInstanceGeometry(node, { name = null } = {}) {
  const label = `detach geometry of ${node.name}`;
  let created = null;
  let previousMesh = null;
  let previousInstance = null;
  let previousSetIds = null;

  return {
    label,
    apply(sceneRef, tracker) {
      const source = findMesh(sceneRef, node.mesh || firstSetMesh(sceneRef, node));
      if (!source) throw new Error(`placement ${node.id} has no geometry to detach`);
      previousMesh = source.id;
      previousInstance = node.instanceOf;
      previousSetIds = node.instanceSetIds ? node.instanceSetIds.slice() : null;
      created = {
        ...source,
        id: `m-detached-${node.id}`,
        name: name || `${source.name}_${node.name}_private`,
        positions: source.positions,
        normals: source.normals,
        uvs: source.uvs,
        indices: source.indices,
        material: node.overrides?.material || source.material,
        sourcePath: `${source.sourcePath || source.name}#detached:${node.sourcePath || node.id}`,
        resourceKey: `key-detached-${node.id}-${Date.now()}`,
      };
      sceneRef.meshes.push(created);
      node.mesh = created.id;
      node.instanceOf = null;
      node.instanceSetIds = null;
      tracker.record(EVENT.GEOMETRY_COPIED, {
        node: node.id,
        path: node.sourcePath || node.name,
        sourceMesh: previousMesh,
        sourceResourceKey: source.resourceKey,
        newMesh: created.id,
        newResourceKey: created.resourceKey,
        vertices: created.positions.length / 3,
      });
      return created;
    },
    undo(sceneRef) {
      node.mesh = previousMesh;
      node.instanceOf = previousInstance;
      node.instanceSetIds = previousSetIds;
      const i = sceneRef.meshes.indexOf(created);
      if (i >= 0) sceneRef.meshes.splice(i, 1);
    },
  };
}

/**
 * Move a placement node under a different parent.
 *
 * To keep the world transform still, the local is re-expressed relative to the
 * new parent (world = parentWorld * local). The tracker emits a parent-layer
 * event with both parents. Undo restores the original parent and local.
 */
export function reparentNode(node, newParent, worldOf) {
  const label = `reparent ${node.name} -> ${newParent?.name || '(root)'}`;
  const oldParent = node.parent;
  const oldMatrix = node.matrix.slice();
  let newMatrix = null;

  return {
    label,
    apply(sceneRef, tracker) {
      const newParentWorld = newParent ? worldOf(newParent.id) : identity4();
      const nodeWorld = worldOf(node.id);
      const invParent = invert4(newParentWorld);
      newMatrix = invParent ? multiply4(invParent, nodeWorld) : nodeWorld.slice();
      removeFromCurrentParent(sceneRef, node);
      if (newParent) addChild(sceneRef, newParent, node);
      else node.parent = null;
      node.matrix = newMatrix;
      tracker.record(EVENT.PARENT_CHANGED, {
        node: node.id,
        path: node.sourcePath || node.name,
        from: oldParent,
        to: node.parent,
        worldPreserved: true,
      });
      return node;
    },
    undo(sceneRef, trackerRef) {
      removeFromCurrentParent(sceneRef, node);
      if (oldParent) {
        const parent = findNode(sceneRef, oldParent);
        if (parent) addChild(sceneRef, parent, node);
        else node.parent = oldParent;
      } else {
        node.parent = null;
      }
      node.matrix = oldMatrix;
      trackerRef?.record(EVENT.PARENT_CHANGED, {
        node: node.id,
        path: node.sourcePath || node.name,
        from: oldParent,
        to: node.parent,
        undone: true,
        worldPreserved: true,
      });
    },
  };
}

/**
 * Re-share a detached placement back onto a prototype mesh resource: the
 * private copy is dropped and the placement points at the shared resource key
 * again. Emits resource-shared evidence and no geometry-copied event.
 */
export function reshareGeometry(node, sharedMesh) {
  const label = `reshare ${node.name} onto ${sharedMesh.name}`;
  let detachedMeshId = null;
  let previousInstance = null;
  let previousSetIds = null;

  return {
    label,
    apply(sceneRef, tracker) {
      detachedMeshId = node.mesh;
      previousInstance = node.instanceOf;
      previousSetIds = node.instanceSetIds ? node.instanceSetIds.slice() : null;
      node.mesh = sharedMesh.id;
      const detached = findMesh(sceneRef, detachedMeshId);
      tracker.record(EVENT.RESOURCE_SHARED, {
        node: node.id,
        path: node.sourcePath || node.name,
        droppedPrivateMesh: detachedMeshId,
        sharedMesh: sharedMesh.id,
        resourceKey: sharedMesh.resourceKey,
        reason: 'private copy removed; placement rejoins the shared geometry resource',
      });
      if (detached && detached.resourceKey !== sharedMesh.resourceKey) {
        const i = sceneRef.meshes.indexOf(detached);
        if (i >= 0) sceneRef.meshes.splice(i, 1);
      }
      return node;
    },
    undo(sceneRef, tracker2) {
      node.mesh = detachedMeshId;
      node.instanceOf = previousInstance;
      node.instanceSetIds = previousSetIds;
      const mesh = findMesh(sceneRef, detachedMeshId);
      if (mesh && !sceneRef.meshes.includes(mesh)) sceneRef.meshes.push(mesh);
    },
  };
}

// ---- helpers --------------------------------------------------------------

function ensureMaterial(scene, spec) {
  if (typeof spec === 'string') {
    const existing = scene.materials.find((m) => m.id === spec);
    if (existing) return existing;
    throw new Error(`material ${spec} not in scene`);
  }
  const mat = createMaterial(spec);
  scene.materials.push(mat);
  return mat;
}

function setOverride(scene, target, materialId) {
  if (target.kind === 'node') {
    const node = findNode(scene, target.node);
    if (!node.overrides) node.overrides = { material: null };
    node.overrides.material = materialId;
  } else {
    const set = scene.instanceSets.find((s) => s.id === target.set);
    if (!set.transformOverrides[target.index]) set.transformOverrides[target.index] = { material: null };
    set.transformOverrides[target.index].material = materialId;
  }
}

function geometryKeyOf(scene, target, set) {
  let meshId;
  if (target.kind === 'node') {
    const node = findNode(scene, target.node);
    meshId = node.mesh || firstSetMesh(scene, node);
  } else {
    meshId = set.rows[0]?.mesh;
  }
  return findMesh(scene, meshId)?.resourceKey || null;
}

function firstSetMesh(scene, node) {
  const setId = node.instanceSetIds?.[0];
  if (setId === undefined) return null;
  const set = scene.instanceSets.find((s) => s.id === setId);
  return set?.rows[0]?.mesh || null;
}

function removeFromCurrentParent(scene, node) {
  if (!node.parent) return;
  const parent = findNode(scene, node.parent);
  if (parent) parent.children = parent.children.filter((id) => id !== node.id);
}

function identity4() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
