// Conversion report: the auditable artefact.
//
// Every axis/unit/order decision, every instance that was (or was not)
// expanded, and every degraded material input is written down here. A
// conversion that cannot state these is treated as failed by the UI and tests.

import { resourceReuse, visibleTriangleCount, triangleCount, findMesh, placementCount } from './scene.js';
import { worldBounds, surfaceSignature, compareScenes } from './compare.js';
import { determinant3, multiply, IDENTITY } from './math.js';

export function buildReport({ scene, reference = null, targetFormat, sourceFormat, warnings = [], extra = {} }) {
  const bounds = worldBounds(scene);
  const sig = surfaceSignature(scene);
  const reuse = resourceReuse(scene);
  const instanceFacts = scene.instanceSets.map((set) => {
    const rows = set.rows.map((row) => {
      const mesh = findMesh(scene, row.mesh);
      return { mesh: row.mesh, triangles: mesh ? triangleCount(mesh) : 0 };
    });
    return {
      id: set.id,
      name: set.name,
      kind: set.kind,
      mesh: set.mesh,
      rows,
      trianglesPerPlacement: rows.reduce((s, r) => s + r.triangles, 0),
      authoredInstances: placementCount(scene, set),
      mirroredInstances: set.mirroredCount || 0,
      prototypePath: set.prototypePath || null,
      sourcePaths: set.sourcePaths,
      representAs: set.kind,
      // Sharing is preserved: this is deliberately >1 for prototypes.
      sharedDraws: placementCount(scene, set),
    };
  });

  const expansions = scene.nodes
    .filter((n) => n.instanceOf)
    .map((n) => ({
      path: n.sourcePath,
      prototype: n.instanceOf,
      instanceCount: n.instanceSetIds?.length || 0,
      collapsed: true,
      note: 'kept as an instance set; not flattened into unique meshes',
    }));
  const reusedDraws = reuse.filter((r) => r.shared);
  const totalDraws = reuse.reduce((s, r) => s + r.draws, 0);
  const uniqueMeshes = reuse.filter((r) => r.draws > 0).length;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: { format: sourceFormat, ...(scene.provenance || {}) },
    target: { format: targetFormat },
    units: {
      sourceMetersPerUnit: scene.sourceMetersPerUnit ?? null,
      canonicalUnit: 'metre',
      // State the number, do not merely promise consistency.
      appliedScale: scene.sourceMetersPerUnit ?? 1,
    },
    axis: {
      sourceUpAxis: scene.sourceUpAxis ?? 'Y',
      canonicalUpAxis: 'Y',
      rootFixMatrix: scene.rootFix?.matrix || null,
      policy: 'Z-up -> Y-up by rotating -90 degrees about X on the root only; descendants keep authored locals',
    },
    counts: {
      nodes: scene.nodes.length,
      renderableNodes: scene.nodes.filter((n) => (n.mesh || n.instanceSetIds) && !n.isPrototype).length,
      meshes: scene.meshes.length,
      materials: scene.materials.length,
      trianglesExpanded: visibleTriangleCount(scene),
      trianglesDistinct: sig.triangleCount,
      verticesDistinct: sig.vertexCount,
    },
    bounds,
    instances: {
      sets: instanceFacts,
      authoredInstanceDraws: instanceFacts.reduce((s, i) => s + i.authoredInstances, 0),
      mirroredInstanceDraws: instanceFacts.reduce((s, i) => s + i.mirroredInstances, 0),
      placements: scene.nodes.filter((n) => n.instanceOf).map((n) => ({
        path: n.sourcePath,
        prototype: n.instanceOf,
        mirrored: (n.instanceSetIds || []).some((id) => {
          const set = scene.instanceSets.find((s) => s.id === id);
          return set?.rows.some((row) => determinant3(multiply(n.matrix, row.matrix || IDENTITY)) < 0);
        }),
      })),
      expansions,
      expansionPolicy: 'instances are preserved; expansion only happens transiently for measurement and is counted',
    },
    reuse: {
      totalDraws,
      uniqueMeshes,
      expansionFactor: uniqueMeshes ? totalDraws / uniqueMeshes : 0,
      shared: reusedDraws,
      note: 'expansionFactor > 1 means geometry is shared, not duplicated',
    },
    materials: scene.materials.map((m) => ({
      name: m.name,
      sourcePath: m.sourcePath,
      baseColorFactor: m.baseColorFactor,
      metallicFactor: m.metallicFactor,
      roughnessFactor: m.roughnessFactor,
      doubleSided: m.doubleSided,
      alphaMode: m.alphaMode,
      degradedInputs: m.degradedInputs || [],
    })),
    degradedMaterials: scene.materials
      .filter((m) => m.degradedInputs?.length)
      .map((m) => ({ name: m.name, sourcePath: m.sourcePath, dropped: m.degradedInputs })),
    // Mirrored placements are the one case where a loader difference would
    // silently delete geometry. Count them and state what this conversion did
    // about facing — per target, not from an unrelated material.
    mirrorFacing: (() => {
      const mirrored = instanceFacts.reduce((s, i) => s + i.mirroredInstances, 0);
      const mirrorWarnings = warnings.filter((w) => w.kind === 'mirror-facing');
      const widened = mirrorWarnings.length > 0;
      let mitigation;
      if (mirrored === 0) mitigation = 'no mirrored placements';
      else if (targetFormat === 'gltf') {
        mitigation = widened
          ? 'glTF writer emitted a doubleSided material variant for the mirrored instanced mesh (declared; instance matrices unchanged)'
          : 'material already double-sided; instance matrices unchanged';
      } else {
        mitigation = 'mirrored instance matrices kept; USD writes doubleSided on the Mesh when authored, and three.js flips winding per object, not per instance';
      }
      return {
        mirroredInstanceDraws: mirrored,
        setsWithMirrors: instanceFacts.filter((i) => i.mirroredInstances > 0).map((i) => i.name || i.id),
        mitigation,
        widenedInstancedMeshes: mirrorWarnings.map((w) => w.instanceSet),
        note: 'three.js flips winding from the object matrix determinant only; a mirrored instance of an InstancedMesh is not flipped, so a single-sided mirrored copy is culled',
      };
    })(),
    warnings,
    comparison: reference ? compareScenes(reference, scene) : null,
    ...extra,
  };
}
