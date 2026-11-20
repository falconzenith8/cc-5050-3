// Serializable snapshot of a SceneIR for the UI and tests.
//
// Flattens the IR into a hierarchy the page can render directly: node paths,
// local/world matrices, instance relationships, and per-mesh reuse counts.
// Everything here is derived from the scene the reader produced, so the page
// inspects real parsed data, never hard-coded fixtures.

import { resourceReuse, triangleCount, findMesh, placementCount, placementNodes } from './scene.js';
import { worldMatrices } from './compare.js';

export function serializeScene(scene) {
  const worlds = worldMatrices(scene);
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const reuse = resourceReuse(scene);

  function pathOf(node) {
    if (node.sourcePath) return node.sourcePath;
    const parts = [];
    let cur = node;
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    return '/' + parts.join('/');
  }

  const nodes = scene.nodes
    .filter((n) => !n.isPrototype)
    .map((n) => {
      const mesh = n.mesh ? findMesh(scene, n.mesh) : null;
      const world = worlds.get(n.id) || n.matrix;
      return {
        id: n.id,
        name: n.name,
        path: pathOf(n),
        parent: n.parent,
        children: n.children.slice(),
        mesh: n.mesh,
        meshName: mesh?.name || null,
        triangles: mesh ? triangleCount(mesh) : 0,
        sourcePrimType: n.sourcePrimType,
        instanceOf: n.instanceOf,
        instanceSetIds: n.instanceSetIds ? n.instanceSetIds.slice() : null,
        local: n.matrix ? n.matrix.slice() : null,
        world: world ? world.slice() : null,
        worldPosition: world ? [world[12], world[13], world[14]] : [0, 0, 0],
        mirrored: world ? world[0] * (world[5] * world[10] - world[6] * world[9]) - world[4] * (world[1] * world[10] - world[2] * world[9]) + world[8] * (world[1] * world[6] - world[2] * world[5]) < 0 : false,
      };
    });

  const instanceSets = scene.instanceSets.map((set) => ({
    id: set.id,
    name: set.name,
    kind: set.kind,
    mesh: set.mesh,
    meshName: scene.meshes.find((m) => m.id === set.mesh)?.name || null,
    prototypePath: set.prototypePath || null,
    placements: placementCount(scene, set),
    transforms: set.transforms.map((m) => m.slice()),
    rows: set.rows.map((r) => ({ mesh: r.mesh, meshPath: r.meshPath, matrix: r.matrix ? r.matrix.slice() : null })),
    mirrored: set.mirroredCount || 0,
    sourcePaths: set.sourcePaths.slice(),
    placementNodes: placementNodes(scene, set).map((n) => pathOf(n)),
  }));

  return {
    name: scene.name,
    upAxis: scene.upAxis,
    metersPerUnit: scene.metersPerUnit,
    sourceUpAxis: scene.sourceUpAxis ?? null,
    sourceMetersPerUnit: scene.sourceMetersPerUnit ?? null,
    rootFix: scene.rootFix?.matrix || null,
    nodes,
    meshes: scene.meshes.map((m) => ({
      id: m.id,
      name: m.name,
      vertices: m.positions.length / 3,
      triangles: triangleCount(m),
      sourcePath: m.sourcePath,
      material: m.material,
    })),
    materials: scene.materials.map((m) => ({
      id: m.id,
      name: m.name,
      baseColorFactor: m.baseColorFactor,
      metallicFactor: m.metallicFactor,
      roughnessFactor: m.roughnessFactor,
      doubleSided: m.doubleSided,
      alphaMode: m.alphaMode,
      degradedInputs: m.degradedInputs || [],
      sourcePath: m.sourcePath,
    })),
    instanceSets,
    reuse,
    warnings: scene.warnings || [],
  };
}
