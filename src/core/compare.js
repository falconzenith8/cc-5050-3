// World-space evaluation and cross-scene comparison.
//
// The comparison deliberately uses independent signals: node hierarchy and
// per-node world matrices, instance placement matrices, triangles actually
// rasterised (not just vertex totals), and geometric hashes. Agreeing on one
// camera view is never treated as proof of a correct conversion.

import { multiply, determinant3, transformPoint, matrixDelta, IDENTITY } from './math.js';
import { triangleCount, findMesh, placementCount, placementNodes } from './scene.js';

/** Map nodeId -> world matrix, honouring parent order in scene.nodes.
 *
 * World = (scene.rootFix || I) * authoredWorld. The stage-level up-axis/unit
 * fix is never folded into a node's local, so authored hierarchy paths and
 * local matrices survive a round trip unchanged. */
export function worldMatrices(scene) {
  const world = new Map();
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const visiting = new Set();
  const fix = scene.rootFix?.matrix || null;

  function resolve(node) {
    if (world.has(node.id)) return world.get(node.id);
    if (visiting.has(node.id)) throw new Error(`cycle in node hierarchy at ${node.id}`);
    visiting.add(node.id);
    const local = node.matrix || IDENTITY;
    const parent = node.parent ? byId.get(node.parent) : null;
    let m = parent ? multiply(resolve(parent), local) : local.slice();
    if (!parent && fix) m = multiply(fix, m);
    visiting.delete(node.id);
    world.set(node.id, m);
    return m;
  }

  for (const node of scene.nodes) resolve(node);
  return world;
}

/**
 * Every drawable in the scene as { path, nodeId, meshId, world, instanceIndex }.
 * Instance draws are expanded here *for measurement only*; the scene model keeps
 * them shared. Both USD instance forms are covered: instanceable placement
 * nodes, and PointInstancer/EXT host nodes with N transforms.
 */
export function drawItems(scene) {
  const worlds = worldMatrices(scene);
  const items = [];
  const setById = new Map(scene.instanceSets.map((s) => [s.id, s]));

  for (const node of scene.nodes) {
    if (node.isPrototype) continue;
    if (node.mesh && !node.instanceOf) {
      items.push({
        path: node.sourcePath || node.name,
        nodeId: node.id,
        meshId: node.mesh,
        world: worlds.get(node.id),
        instanceIndex: -1,
        mirrored: determinant3(worlds.get(node.id)) < 0,
        kind: 'mesh',
      });
    }
    for (const setId of node.instanceSetIds || []) {
      const set = setById.get(setId);
      if (!set) continue;
      const base = worlds.get(node.id);
      if (set.kind === 'instanceable') {
        // The placement node's own world is the full placement; each prototype
        // row supplies its local inside the prototype.
        for (const row of set.rows) {
          const m = multiply(base, row.matrix || IDENTITY);
          items.push({
            path: `${node.sourcePath}${row.meshPath.replace(/^.*?\/[^/]+$/, '')}`,
            nodeId: node.id,
            meshId: row.mesh,
            world: m,
            instanceIndex: placementIndex(scene, set, node),
            mirrored: determinant3(m) < 0,
            kind: set.kind,
            instanceSetId: set.id,
          });
        }
      } else {
        set.transforms.forEach((local, k) => {
          for (const row of set.rows) {
            const m = multiply(base, multiply(local, row.matrix || IDENTITY));
            items.push({
              path: `${node.sourcePath || node.name}#${k}`,
              nodeId: node.id,
              meshId: row.mesh,
              world: m,
              instanceIndex: k,
              mirrored: determinant3(m) < 0,
              kind: set.kind,
              instanceSetId: set.id,
            });
          }
        });
      }
    }
  }
  return items;
}

function placementIndex(scene, set, node) {
  const placements = placementNodes(scene, set);
  return placements.findIndex((p) => p.id === node.id);
}

/** Bounding box of all drawable vertices in world space. */
export function worldBounds(scene) {
  const items = drawItems(scene);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const item of items) {
    if (!item.world) continue;
    const mesh = findMesh(scene, item.meshId);
    if (!mesh) continue;
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const w = transformPoint(item.world, [p[i], p[i + 1], p[i + 2]]);
      for (let c = 0; c < 3; c++) {
        if (w[c] < min[c]) min[c] = w[c];
        if (w[c] > max[c]) max[c] = w[c];
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return {
    min, max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

/**
 * Triangles rasterised after back-face culling. `frontFace` handling is
 * explicit: a mesh with negative determinant is mirrored, and three.js flips
 * the winding of the *node* (it cannot per instance). Mirrored instances are
 * therefore counted as facing-correct only if the renderer flips them too.
 */
export function visibleTriangles(scene, { rendererFlipsPerInstance = true } = {}) {
  const items = drawItems(scene);
  let visible = 0;
  let culled = 0;
  let mirroredInstancesCulled = 0;
  for (const item of items) {
    const mesh = findMesh(scene, item.meshId);
    if (!mesh) continue;
    const tris = triangleCount(mesh);
    const doubleSided = isDoubleSided(scene, mesh);
    if (item.mirrored && !doubleSided && !(item.instanceIndex >= 0 && rendererFlipsPerInstance)) {
      // A mirrored, single-sided draw under a renderer that only flips per
      // node is back-face culled: the part disappears.
      culled += tris;
      if (item.instanceIndex >= 0) mirroredInstancesCulled++;
      continue;
    }
    visible += tris;
  }
  return { visible, culled, mirroredInstancesCulled, total: visible + culled };
}

function isDoubleSided(scene, mesh) {
  const mat = scene.materials.find((m) => m.id === mesh.material);
  return !!(mat && mat.doubleSided);
}

/**
 * Tolerance-aware point set: quantises to a grid of `tol` and answers `has`
 * by probing the 27 neighbouring cells, so float32 storage noise near a cell
 * boundary (e.g. 0.2794 vs 0.2796) does not create a false difference. A real
 * edit of more than `tol` still changes membership.
 */
export function pointSet(tol = 2e-3) {
  const cells = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  const set = {
    tol,
    size: 0,
    points: [],
    add(p) {
      const i = Math.round(p[0] / tol), j = Math.round(p[1] / tol), k = Math.round(p[2] / tol);
      const ck = key(i, j, k);
      let bucket = cells.get(ck);
      if (!bucket) { bucket = []; cells.set(ck, bucket); }
      for (const q of bucket) {
        if (Math.abs(q[0] - p[0]) <= tol && Math.abs(q[1] - p[1]) <= tol && Math.abs(q[2] - p[2]) <= tol) return set;
      }
      bucket.push(p);
      set.points.push(p);
      set.size++;
      return set;
    },
    has(p) {
      const i = Math.round(p[0] / tol), j = Math.round(p[1] / tol), k = Math.round(p[2] / tol);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (let dk = -1; dk <= 1; dk++) {
            const bucket = cells.get(key(i + di, j + dj, k + dk));
            if (!bucket) continue;
            for (const q of bucket) {
              if (Math.abs(q[0] - p[0]) <= tol && Math.abs(q[1] - p[1]) <= tol && Math.abs(q[2] - p[2]) <= tol) return true;
            }
          }
        }
      }
      return false;
    },
  };
  return set;
}

/**
 * Conservative surface sample: unique world-space vertex positions plus the
 * triangle centroid set, so two scenes are compared on geometry actually
 * placed, not on array lengths. Compared with a 2 mm tolerance, which absorbs
 * float32 storage without hiding a real placement error.
 */
export function surfaceSignature(scene, { tolerance = 2e-3 } = {}) {
  const items = drawItems(scene);
  const verts = pointSet(tolerance);
  const centroids = pointSet(tolerance);
  for (const item of items) {
    const mesh = findMesh(scene, item.meshId);
    if (!mesh) continue;
    const p = mesh.positions;
    const idx = mesh.indices;
    const world = item.world;
    const triCount = idx ? idx.length / 3 : p.length / 9;
    const worldVerts = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const w = transformPoint(world, [p[i], p[i + 1], p[i + 2]]);
      worldVerts[i] = w[0]; worldVerts[i + 1] = w[1]; worldVerts[i + 2] = w[2];
      verts.add(w);
    }
    for (let t = 0; t < triCount; t++) {
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[t * 3 + k] : t * 3 + k;
        sx += worldVerts[vi * 3]; sy += worldVerts[vi * 3 + 1]; sz += worldVerts[vi * 3 + 2];
      }
      centroids.add([sx / 3, sy / 3, sz / 3]);
    }
  }
  return { verts, centroids, vertexCount: verts.size, triangleCount: centroids.size };
}

function jaccard(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const p of small.points) if (large.has(p)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Node-by-node structural comparison plus an independent instance comparison.
 *
 * The two formats encode the *same* instance relationship differently:
 * USD instanceable prims are one placement node each, while glTF carries N
 * transforms on one EXT_mesh_gpu_instancing host. Comparing node graphs
 * literally would report a false failure, so:
 *   - structural nodes (plain hierarchy) are matched by path;
 *   - instance placements are matched as a multiset of world matrices, keyed
 *     by the geometry they draw. Sharing is compared separately (draws per
 *     distinct mesh), so an implementation that silently expands instances
 *     fails even though every placement matrix matches.
 */
export function compareScenes(reference, candidate, { tolerance = 1e-4 } = {}) {
  const aWorld = worldMatrices(reference);
  const bWorld = worldMatrices(candidate);
  const aIndex = structuralIndex(reference);
  const bIndex = structuralIndex(candidate);

  const matched = [];
  const onlyInReference = [];
  const onlyInCandidate = [];

  for (const [path, node] of aIndex) {
    const other = bIndex.get(path);
    if (!other) { onlyInReference.push(path); continue; }
    const delta = matrixDelta(aWorld.get(node.id), bWorld.get(other.id));
    matched.push({
      path,
      referenceId: node.id,
      candidateId: other.id,
      worldDelta: delta,
      ok: delta <= tolerance,
      referenceMatrix: aWorld.get(node.id),
      candidateMatrix: bWorld.get(other.id),
    });
  }
  for (const path of bIndex.keys()) if (!aIndex.has(path)) onlyInCandidate.push(path);

  const aSig = surfaceSignature(reference);
  const bSig = surfaceSignature(candidate);
  const aTri = visibleTriangles(reference);
  const bTri = visibleTriangles(candidate);
  const aBounds = worldBounds(reference);
  const bBounds = worldBounds(candidate);
  const placements = comparePlacements(reference, candidate, tolerance);
  const sharing = {
    reference: reuseSummary(reference),
    candidate: reuseSummary(candidate),
  };

  const worst = matched.reduce((acc, m) => (m.worldDelta > acc.worldDelta ? m : acc), { worldDelta: 0, path: null });

  return {
    hierarchy: {
      matched: matched.length,
      onlyInReference,
      onlyInCandidate,
      maxWorldDelta: worst.worldDelta,
      worstPath: worst.path,
      nodesOverTolerance: matched.filter((m) => !m.ok).map((m) => ({ path: m.path, delta: m.worldDelta })),
    },
    matrices: matched,
    placements,
    geometry: {
      referenceVertices: aSig.vertexCount,
      candidateVertices: bSig.vertexCount,
      referenceTriangles: aSig.triangleCount,
      candidateTriangles: bSig.triangleCount,
      vertexOverlap: jaccard(aSig.verts, bSig.verts),
      triangleOverlap: jaccard(aSig.centroids, bSig.centroids),
    },
    facing: {
      reference: aTri,
      candidate: bTri,
      // A regression in visible triangles is a real fidelity failure even when
      // vertex totals agree.
      visibleTriangleDelta: bTri.visible - aTri.visible,
    },
    bounds: { reference: aBounds, candidate: bBounds, delta: boundsDelta(aBounds, bBounds) },
    instances: compareInstances(reference, candidate, tolerance),
    sharing,
    verdict: verdict({ matched, onlyInReference, onlyInCandidate, tolerance, aTri, bTri, aSig, bSig, placements, sharing }),
  };
}

function verdict({ matched, onlyInReference, onlyInCandidate, tolerance, aTri, bTri, aSig, bSig, placements, sharing }) {
  const bad = matched.filter((m) => m.worldDelta > tolerance).length;
  const badPlacements = placements.unmatchedReference.length + placements.unmatchedCandidate.length;
  const sharingChanged = sharing && sharing.reference.expansionFactor !== sharing.candidate.expansionFactor;
  const ok = bad === 0 && badPlacements === 0 && !sharingChanged &&
    onlyInReference.length === 0 && onlyInCandidate.length === 0 &&
    bTri.visible === aTri.visible && aSig.triangleCount === bSig.triangleCount &&
    placements.referenceCount === placements.candidateCount;
  return {
    ok,
    reasons: [
      ...(bad ? [`${bad} structural node world matrix/matrices exceed tolerance ${tolerance}`] : []),
      ...(onlyInReference.length ? [`${onlyInReference.length} structural node(s) missing from candidate`] : []),
      ...(onlyInCandidate.length ? [`${onlyInCandidate.length} extra structural node(s) in candidate`] : []),
      ...(placements.unmatchedReference.length ? [`${placements.unmatchedReference.length} instance placement(s) missing from candidate`] : []),
      ...(placements.unmatchedCandidate.length ? [`${placements.unmatchedCandidate.length} extra instance placement(s) in candidate`] : []),
      ...(placements.maxWorldDelta > tolerance ? [`instance placement world delta ${placements.maxWorldDelta} exceeds tolerance ${tolerance}`] : []),
      ...(sharingChanged ? [`resource sharing changed: expansion factor ${sharing.reference.expansionFactor} -> ${sharing.candidate.expansionFactor} (instances silently flattened?)`] : []),
      ...(bTri.visible !== aTri.visible ? [`visible triangle count differs: ${aTri.visible} vs ${bTri.visible}`] : []),
      ...(aSig.triangleCount !== bSig.triangleCount ? [`distinct placed triangle count differs: ${aSig.triangleCount} vs ${bSig.triangleCount}`] : []),
    ],
  };
}

/**
 * Match instance placements by (geometry drawn, world-space *position*).
 *
 * Position rather than the full matrix: converting Z-up cm -> Y-up m legitimately
 * re-expresses the placement basis (`world' = world * F^-1`) while drawing the
 * exact same geometry. Comparing positions plus the global surface signature
 * (which covers rotation and scale through actual vertex placement) catches real
 * errors without failing on a legal frame choice. The encoding (one node per
 * placement vs one host with transforms) is likewise not part of the key; it is
 * reported separately by `instances.*`.
 */
function comparePlacements(a, b, tolerance) {
  const aDraws = instanceDraws(a);
  const bDraws = instanceDraws(b);
  const used = new Set();
  const pairs = [];
  const unmatchedReference = [];
  let maxWorldDelta = 0;

  for (const draw of aDraws) {
    let best = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < bDraws.length; i++) {
      if (used.has(i)) continue;
      const other = bDraws[i];
      if (other.key !== draw.key) continue;
      const delta = vecDelta(draw.position, other.position);
      if (delta < bestDelta) { bestDelta = delta; best = i; }
    }
    if (best >= 0 && bestDelta <= tolerance) {
      used.add(best);
      maxWorldDelta = Math.max(maxWorldDelta, bestDelta);
      pairs.push({
        key: draw.key,
        referencePosition: draw.position,
        candidatePosition: bDraws[best].position,
        positionDelta: bestDelta,
        mirrored: draw.mirrored,
        referencePath: draw.path,
        candidatePath: bDraws[best].path,
      });
    } else {
      unmatchedReference.push({ key: draw.key, position: draw.position, path: draw.path });
    }
  }
  const unmatchedCandidate = bDraws
    .map((d, i) => (used.has(i) ? null : { key: d.key, position: d.position, path: d.path }))
    .filter(Boolean);

  return {
    referenceCount: aDraws.length,
    candidateCount: bDraws.length,
    matched: pairs.length,
    maxWorldDelta,
    unmatchedReference,
    unmatchedCandidate,
    pairs,
  };
}

function vecDelta(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Every instance draw as { key, position, world, mirrored }; key identifies the mesh. */
export function instanceDraws(scene) {
  const items = drawItems(scene).filter((i) => i.kind !== 'mesh');
  return items.map((item) => {
    const mesh = findMesh(scene, item.meshId);
    return {
      meshId: item.meshId,
      key: mesh ? geometryKey(mesh) : item.meshId,
      // World position of the drawn mesh origin under this placement.
      position: transformPoint(item.world, [0, 0, 0]),
      world: item.world,
      mirrored: item.mirrored,
      path: item.path,
      triangleCount: mesh ? triangleCount(mesh) : 0,
    };
  });
}

/**
 * Geometry identity that survives a format round trip but not a silent edit.
 *
 * Hashed over the *triangle soup* (positions in index order), not the raw vertex
 * array: the two formats legitimately differ in whether shared corners are
 * de-duplicated (glTF indexes 24 verts; USD face-varying expansion emits 36),
 * which changes array lengths without changing the surface. Positions are
 * quantised at 1e-3 so float32 storage noise does not break identity, while a
 * real geometry change (any coordinate move of >= 1 mm) does.
 */
export function geometryKey(mesh) {
  const p = mesh.positions;
  const idx = mesh.indices;
  const tris = idx ? idx.length / 3 : p.length / 9;
  let hash = 0x811c9dc5;
  for (let t = 0; t < tris * 3; t++) {
    const vi = idx ? idx[t] : t;
    for (let c = 0; c < 3; c++) {
      const v = Math.round(p[vi * 3 + c] * 1e3) | 0;
      hash ^= v & 0xff; hash = Math.imul(hash, 0x01000193);
      hash ^= (v >>> 8) & 0xff; hash = Math.imul(hash, 0x01000193);
      hash ^= (v >>> 16) & 0xff; hash = Math.imul(hash, 0x01000193);
      hash ^= (v >>> 24) & 0xff; hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${tris}t/${(hash >>> 0).toString(16)}`;
}

/** Plain hierarchy nodes: no placement prims, no transform-only instance hosts. */
export function structuralIndex(scene) {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const index = new Map();
  function pathOf(node) {
    const parts = [];
    let cur = node;
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    return '/' + parts.join('/');
  }
  for (const node of scene.nodes) {
    if (node.isPrototype) continue;
    if (node.instanceOf) continue;
    if (isInstanceHost(node)) continue;
    index.set(node.sourcePath || pathOf(node), node);
  }
  return index;
}

export function isInstanceHost(node) {
  return !node.mesh && Array.isArray(node.instanceSetIds) && node.instanceSetIds.length > 0;
}

function boundsDelta(a, b) {
  return {
    min: a.min.map((v, i) => Math.abs(v - b.min[i])),
    max: a.max.map((v, i) => Math.abs(v - b.max[i])),
    maxAbs: Math.max(...a.min.map((v, i) => Math.abs(v - b.min[i])), ...a.max.map((v, i) => Math.abs(v - b.max[i]))),
  };
}

function compareInstances(a, b, tolerance) {
  return {
    referenceSets: a.instanceSets.map(setSummary),
    candidateSets: b.instanceSets.map(setSummary),
    referenceMirrored: a.instanceSets.reduce((s, x) => s + (x.mirroredCount || 0), 0),
    candidateMirrored: b.instanceSets.reduce((s, x) => s + (x.mirroredCount || 0), 0),
    referenceReuse: reuseSummary(a),
    candidateReuse: reuseSummary(b),
    tolerance,
  };
}

function setSummary(set) {
  return {
    id: set.id,
    name: set.name,
    kind: set.kind,
    mesh: set.mesh,
    rows: set.rows.length,
    count: set.kind === 'instanceable' ? set.sourcePaths.length : set.transforms.length,
    mirrored: set.mirroredCount || 0,
    prototypePath: set.prototypePath || null,
  };
}

function reuseSummary(scene) {
  let draws = 0;
  // Sharing is a property of the physical resource, not the IR mesh object: a
  // material-only override legitimately produces two mesh objects that point at
  // one resourceKey, so unique resources (and thus the expansion factor) are
  // counted by key, never by mesh id.
  const drawsByResource = new Map();
  const keyOf = (mesh) => mesh.resourceKey || mesh.id;
  for (const mesh of scene.meshes) {
    let n = 0;
    for (const node of scene.nodes) if (node.mesh === mesh.id && node.visible && !node.instanceOf) n++;
    for (const set of scene.instanceSets) {
      if (set.rows.some((r) => r.mesh === mesh.id)) n += placementCount(scene, set);
    }
    if (n > 0) {
      const key = keyOf(mesh);
      drawsByResource.set(key, (drawsByResource.get(key) || 0) + n);
      draws += n;
    }
  }
  const uniqueMeshes = drawsByResource.size;
  return { draws, uniqueMeshes, expansionFactor: uniqueMeshes ? draws / uniqueMeshes : 0 };
}

/** Index nodes by a stable path so names/paths can be compared. */
export function pathIndex(scene) {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const index = new Map();
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
  for (const node of scene.nodes) {
    if (node.isPrototype) continue;
    index.set(pathOf(node), node);
  }
  return index;
}
