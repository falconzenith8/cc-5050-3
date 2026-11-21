// Fixture for the shared-mesh material-override feature.
//
// One scene, three deliberate identity traps:
//   1. Two nodes with the SAME name ("Bracket") under different parents, so any
//      name-based reverse lookup must confuse them; id/sourcePath linkage must not.
//   2. A mirrored parent layer ("MirrorRig", negative X scale): the world of
//      everything under it is reflected without any placement local changing.
//   3. One instance ("Bracket" under MirrorRig) carrying a MATERIAL-ONLY
//      override: its geometry must stay the one shared resource, only the
//      material opinion changes.
//
// The same IR is emitted as both real formats, then re-read by the tests, so
// every claim is checked against the files on disk rather than the in-memory IR.
//
// Run: node tools/build-override-scenes.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose } from '../src/core/math.js';
import {
  createScene, createNode, createMesh, createMaterial, createInstanceSet,
} from '../src/core/scene.js';
import { writeGltf } from '../src/core/gltf.js';
import { writeUsda } from '../src/core/usda-writer.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'scenes');

/** Small L-bracket: 8 vertices, non-symmetric, so mirroring is visible. */
function bracket() {
  const p = [
    [0, 0, 0], [1, 0, 0], [1, 0, 0.4], [0, 0, 0.4],
    [0, 1.6, 0], [0.4, 1.6, 0], [0.4, 1.6, 0.4], [0, 1.6, 0.4],
  ];
  const faces = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const quad of faces) {
    const base = positions.length / 3;
    const [a, b, c, d] = quad.map((i) => p[i]);
    const n = faceNormal(a, b, c);
    for (const idx of quad) {
      positions.push(...p[idx]);
      normals.push(...n);
      uvs.push(0, 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}

function faceNormal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const len = Math.hypot(...n) || 1;
  return n.map((x) => x / len);
}

export function buildOverrideScene() {
  const scene = createScene({ name: 'override-fixture', upAxis: 'Y', metersPerUnit: 1 });
  scene.sourceUpAxis = 'Y';
  scene.sourceMetersPerUnit = 1;

  const baseMat = createMaterial({ name: 'BracketSteel', baseColorFactor: [0.55, 0.6, 0.65, 1], metallicFactor: 0.8, roughnessFactor: 0.35 });
  // The replacement material is deliberately distinct: a warm painted finish.
  const paintMat = createMaterial({ name: 'BracketPaint', baseColorFactor: [0.9, 0.35, 0.12, 1], metallicFactor: 0.1, roughnessFactor: 0.6 });
  scene.materials.push(baseMat, paintMat);

  const geo = bracket();
  const bracketMesh = createMesh({ name: 'BracketMesh', ...geo, material: baseMat.id });
  bracketMesh.sourcePath = '/_Prototypes/Bracket/BracketMesh';
  scene.meshes.push(bracketMesh);

  const root = createNode({ name: 'RigRoot' });
  root.sourcePath = '/RigRoot';
  scene.nodes.push(root);

  // Parent layer A: ordinary holder with one standalone same-named node. This
  // "Bracket" is the identity trap for name-based lookups.
  const holderA = createNode({ name: 'HolderA' });
  holderA.parent = root.id;
  holderA.sourcePath = '/RigRoot/HolderA';
  holderA.matrix = compose({ translation: [-2, 0, 0] });
  root.children.push(holderA.id);
  scene.nodes.push(holderA);

  // Parent layer B: mirrored rig, negative determinant (scale X = -1). Its
  // child is the SAME-named host, so name-based lookup cannot tell the two
  // "Bracket" objects apart; only the id/sourcePath lineage can.
  const mirrorRig = createNode({ name: 'MirrorRig' });
  mirrorRig.parent = root.id;
  mirrorRig.sourcePath = '/RigRoot/MirrorRig';
  mirrorRig.matrix = compose({ translation: [2, 0, 0], scale: [-1, 1, 1] });
  root.children.push(mirrorRig.id);
  scene.nodes.push(mirrorRig);

  // One shared geometry resource, one glTF-style host with two transforms.
  // Placement 0 is plain; placement 1 carries a MATERIAL-ONLY override: its
  // geometry keeps the same resourceKey, only the material opinion changes.
  const set = createInstanceSet({
    name: 'BracketSet',
    mesh: bracketMesh.id,
    material: baseMat.id,
    rows: [{ mesh: bracketMesh.id, matrix: null, meshPath: '/_Prototypes/Bracket/BracketMesh' }],
    transforms: [
      compose({ translation: [0, 0, 1] }),
      compose({ translation: [0, 0, -1] }),
    ],
    kind: 'gltf-instancing',
    sourcePath: '/RigRoot/MirrorRig/Bracket',
  });
  set.prototypePath = '/_Prototypes/Bracket';
  set.transformOverrides = [{ material: null }, { material: paintMat.id }];
  scene.instanceSets.push(set);

  // Standalone node named "Bracket" (trap), drawing the same shared mesh.
  const plain = createNode({ name: 'Bracket' });
  plain.parent = holderA.id;
  plain.sourcePath = '/RigRoot/HolderA/Bracket';
  plain.matrix = compose({});
  plain.mesh = bracketMesh.id;
  holderA.children.push(plain.id);
  scene.nodes.push(plain);

  // Instancing host, also named "Bracket", under the mirrored parent.
  const painted = createNode({ name: 'Bracket' });
  painted.parent = mirrorRig.id;
  painted.sourcePath = '/RigRoot/MirrorRig/Bracket';
  painted.matrix = compose({});
  painted.instanceSetIds = [set.id];
  mirrorRig.children.push(painted.id);
  scene.nodes.push(painted);

  return { scene, set, plain, painted, bracketMesh, baseMat, paintMat };
}

function main() {
  const { scene } = buildOverrideScene();

  const gltf = writeGltf(scene, { mirrorMitigation: false });
  writeFileSync(join(outDir, 'override.gltf'), JSON.stringify(gltf.json, null, 2));

  const usda = writeUsda(scene, { upAxis: 'Y', metersPerUnit: 1 });
  writeFileSync(join(outDir, 'override.usda'), usda.text);

  console.log('wrote scenes/override.gltf and scenes/override.usda');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
