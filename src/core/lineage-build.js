// Build conversion lineage by matching the source scene to the re-read target
// scene. Links are recorded from stable identity evidence, never from names:
//   - nodes/placements match by `sourcePath` (the writers preserve it in extras
//     and in USD prim paths);
//   - geometry matches by `resourceKey` (one physical accessor/prototype), so a
//     material-only override that duplicated the mesh IR object still links back
//     to the one source resource;
//   - materials match by name + binding path carried through the writers.
//
// This is also where the first identity-confusion step is made observable: each
// link records the layer opinions that survived the conversion and whether the
// target split one source identity into several objects (material override) or
// collapsed several into one (instance set).

import { createLineage, recordLink } from './lineage.js';
import { distinctResourceCount } from './scene.js';

/**
 * Record the full source -> target mapping for one conversion.
 *
 * @returns {{ lineage: object, summary: object }}
 */
export function buildConversionLineage(sourceScene, targetScene) {
  const lineage = createLineage();

  const targetNodesByPath = new Map();
  for (const node of targetScene.nodes) {
    const key = node.sourcePath || node.name;
    if (!targetNodesByPath.has(key)) targetNodesByPath.set(key, []);
    targetNodesByPath.get(key).push(node);
  }

  const sourceMeshesByResource = new Map();
  for (const mesh of sourceScene.meshes) {
    const key = mesh.resourceKey || mesh.id;
    if (!sourceMeshesByResource.has(key)) sourceMeshesByResource.set(key, []);
    sourceMeshesByResource.get(key).push(mesh);
  }

  const stats = {
    nodeLinks: 0,
    meshLinks: 0,
    materialLinks: 0,
    overrideLinks: 0,
    sameNameNodes: 0,
    splitResources: 0,
    mergedResources: 0,
  };

  // ---- node / placement links ---------------------------------------------
  for (const sourceNode of sourceScene.nodes) {
    if (sourceNode.isPrototype) continue;
    const path = sourceNode.sourcePath || sourceNode.name;
    const matches = targetNodesByPath.get(path) || [];
    if (matches.length > 1) stats.sameNameNodes++;
    for (const targetNode of matches) {
      const layers = ['parent', 'transform'];
      if (sourceNode.mesh || sourceNode.instanceOf || sourceNode.instanceSetIds?.length) layers.push('geometry');
      layers.push('material');
      const sourceOverride = sourceNode.overrides?.material || null;
      const targetOverride = targetNode.overrides?.material || null;
      if (sourceOverride || targetOverride) layers.push('override');

      recordLink(lineage, {
        source: { kind: sourceNode.instanceOf ? 'placement' : 'node', id: sourceNode.id, path },
        target: { kind: 'node', id: targetNode.id, path: targetNode.sourcePath || targetNode.name },
        layers,
        detail: {
          sourceName: sourceNode.name,
          targetName: targetNode.name,
          sameName: sourceNode.name === targetNode.name,
          override: { source: sourceOverride, target: targetOverride, preserved: sourceOverride === targetOverride },
        },
      });
      stats.nodeLinks++;
      if (sourceOverride || targetOverride) stats.overrideLinks++;
    }
  }

  // ---- geometry resource links ---------------------------------------------
  // Across an exchange the resourceKey format changes (gltf accessor key vs usd
  // geometry signature key), so physical resources are matched by their actual
  // byte content instead of the key string. One source resource can still map to
  // several target mesh objects (a material-only override), all sharing one key.
  const targetMeshesBySignature = new Map();
  for (const mesh of targetScene.meshes) {
    const sig = geometrySignature(mesh);
    if (!targetMeshesBySignature.has(sig)) targetMeshesBySignature.set(sig, []);
    targetMeshesBySignature.get(sig).push(mesh);
  }

  for (const [resourceKey, sourceMeshes] of sourceMeshesByResource) {
    const representative = sourceMeshes[0];
    const targetMeshes = targetMeshesBySignature.get(geometrySignature(representative)) || [];
    const targetResourceKeys = new Set(targetMeshes.map((m) => m.resourceKey || m.id));
    if (targetMeshes.length > sourceMeshes.length) stats.splitResources++;
    if (targetMeshes.length && targetMeshes.length < sourceMeshes.length) stats.mergedResources++;
    for (const sourceMesh of sourceMeshes) {
      for (const targetMesh of targetMeshes) {
        recordLink(lineage, {
          source: { kind: 'mesh', id: sourceMesh.id, path: sourceMesh.sourcePath || sourceMesh.name },
          target: { kind: 'mesh', id: targetMesh.id, path: targetMesh.sourcePath || targetMesh.name },
          layers: ['geometry'],
          detail: {
            sourceResourceKey: resourceKey,
            targetResourceKey: targetMesh.resourceKey || targetMesh.id,
            targetResourceKeys: [...targetResourceKeys],
            resourceShared: true,
            sourceMaterial: sourceMesh.material,
            targetMaterial: targetMesh.material,
            materialRebound: sourceMesh.material !== targetMesh.material,
            vertices: targetMesh.positions.length / 3,
          },
        });
        stats.meshLinks++;
      }
    }
  }

  // ---- material binding links ----------------------------------------------
  const targetMaterialByName = new Map(targetScene.materials.map((m) => [m.name, m]));
  for (const sourceMaterial of sourceScene.materials) {
    const targetMaterial = targetMaterialByName.get(sourceMaterial.name);
    if (!targetMaterial) continue;
    recordLink(lineage, {
      source: { kind: 'material', id: sourceMaterial.id, path: sourceMaterial.sourcePath || sourceMaterial.name },
      target: { kind: 'material', id: targetMaterial.id, path: targetMaterial.sourcePath || targetMaterial.name },
      layers: ['material'],
      detail: {
        name: sourceMaterial.name,
        baseColorFactor: targetMaterial.baseColorFactor,
        colorPreserved: sameColor(sourceMaterial.baseColorFactor, targetMaterial.baseColorFactor),
      },
    });
    stats.materialLinks++;
  }

  // ---- per-transform overrides on host-form instance sets ------------------
  for (const sourceSet of sourceScene.instanceSets) {
    sourceSet.transformOverrides?.forEach((slot, k) => {
      if (!slot?.material) return;
      const targetSet = targetScene.instanceSets.find((s) => s.sourcePath === sourceSet.sourcePath || s.name === sourceSet.name);
      const preserved = targetSet?.transformOverrides?.[k]?.material || null;
      recordLink(lineage, {
        source: { kind: 'placement', id: `${sourceSet.id}#${k}`, path: `${sourceSet.sourcePath || sourceSet.name}#${k}` },
        target: {
          kind: preserved ? 'placement' : 'node',
          id: preserved ? `${targetSet.id}#${k}` : `${sourceSet.id}#${k}`,
          path: `${targetSet?.sourcePath || sourceSet.sourcePath || sourceSet.name}#${k}`,
        },
        layers: ['override', 'geometry', 'material'],
        detail: {
          instanceSet: sourceSet.id,
          placementIndex: k,
          sourceMaterial: slot.material,
          targetMaterial: preserved,
          overridePreserved: preserved !== null,
          resourceKey: sourceScene.meshes.find((m) => m.id === sourceSet.mesh)?.resourceKey || null,
          geometryCopied: false,
        },
      });
      stats.overrideLinks++;
    });
  }

  const lineageSummary = {
    ...stats,
    sourceResources: distinctResourceCount(sourceScene),
    targetResources: distinctResourceCount(targetScene),
    geometryBytesDuplicated: distinctResourceCount(targetScene) > distinctResourceCount(sourceScene),
  };

  return { lineage, summary: lineageSummary };
}

function sameColor(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
}

function geometrySignature(mesh) {
  // Quantized vertex *set* plus triangle count. Readers legitimately expand
  // shared vertices (e.g. USDA per-face triangulation duplicates corner points),
  // so neither array order nor length is part of the identity: the same physical
  // surface has the same distinct point set and the same number of triangles.
  const points = new Set();
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    points.add(`${round(p[i])}|${round(p[i + 1])}|${round(p[i + 2])}`);
  }
  const triangles = mesh.indices ? mesh.indices.length / 3 : p.length / 9;
  return `${triangles}:${[...points].sort().join(',')}`;
}

function round(v) {
  return Math.round(v * 1e6);
}
