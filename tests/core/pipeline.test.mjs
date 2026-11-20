import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readUsda } from '../../src/core/usd-reader.js';
import { writeUsda } from '../../src/core/usda-writer.js';
import { readGltf, writeGltf } from '../../src/core/gltf.js';
import { exchange } from '../../src/core/exchange.js';
import { compareScenes, worldMatrices, drawItems } from '../../src/core/compare.js';
import { buildReport } from '../../src/core/report.js';
import { placementCount } from '../../src/core/scene.js';

const here = dirname(fileURLToPath(import.meta.url));
const scenesDir = join(here, '..', '..', 'scenes');
const read = (name) => readFileSync(join(scenesDir, name), 'utf8');

test('USD reader: instanceable placements share one prototype row', () => {
  const { scene } = readUsda(read('exchange-yup.usda'));
  const panel = scene.instanceSets.find((s) => s.kind === 'instanceable');
  assert.ok(panel, 'expected an instanceable set');
  assert.equal(panel.rows.length, 1, 'one shared mesh row');
  assert.equal(placementCount(scene, panel), 4, 'four placements');
  const mirrored = placementCount(scene, panel) - (4 - panel.mirroredCount);
  assert.equal(panel.mirroredCount, 1, 'exactly one mirrored placement tracked');
  assert.ok(mirrored >= 0);
});

test('USD reader: PointInstancer becomes one host with N transforms', () => {
  const { scene } = readUsda(read('exchange-yup.usda'));
  const pi = scene.instanceSets.find((s) => s.kind === 'pointInstancer');
  assert.ok(pi, 'expected a pointInstancer set');
  assert.equal(pi.transforms.length, 2);
  const host = scene.nodes.find((n) => n.sourcePrimType === 'PointInstancer');
  assert.ok(host, 'host node present');
  assert.equal(host.instanceSetIds.length, 1);
});

test('USD reader: authored hierarchy and frame are recorded separately', () => {
  const { scene } = readUsda(read('exchange-zup.usda'));
  assert.equal(scene.sourceUpAxis, 'Z');
  assert.equal(scene.sourceMetersPerUnit, 0.01);
  assert.ok(scene.rootFix, 'root fix recorded');
  // The frame fix is not a node: the root has no synthetic parent above World.
  const roots = scene.nodes.filter((n) => n.parent === null);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, 'World');
});

test('USD reader: non-inherited degradation is listed, not silently dropped', () => {
  const { scene } = readUsda(read('exchange-zup.usda'));
  const degraded = scene.materials.filter((m) => m.degradedInputs?.length);
  assert.ok(degraded.length >= 1, 'Post material has emissiveColor');
  assert.ok(degraded[0].degradedInputs.includes('emissiveColor'));
});

test('USD reader: visibility=invisible is reported as not honoured', () => {
  const text = read('exchange-yup.usda').replace(
    '    def Xform "Assembly"\n    {\n',
    '    def Xform "Assembly"\n    {\n        uniform token visibility = "invisible"\n',
  );
  const { warnings } = readUsda(text);
  assert.ok(warnings.some((w) => /visibility=invisible/.test(w.message)), JSON.stringify(warnings));
});

test('glTF reader: EXT_mesh_gpu_instancing becomes an instance set with N transforms', () => {
  const { scene } = readGltf(JSON.parse(read('exchange.gltf')));
  const inst = scene.instanceSets.filter((s) => s.kind === 'gltf-instancing');
  assert.equal(inst.length, 2);
  const counts = inst.map((s) => s.transforms.length).sort();
  assert.deepEqual(counts, [2, 4]);
  assert.equal(inst.reduce((a, s) => a + s.mirroredCount, 0), 1);
});

test('USD writer: output re-reads to the same world matrices', () => {
  const src = readUsda(read('exchange-yup.usda')).scene;
  const out = writeUsda(src, { upAxis: 'Y', metersPerUnit: 1 });
  const back = readUsda(out.text).scene;
  const a = worldMatrices(src);
  const b = worldMatrices(back);
  const byPath = new Map(back.nodes.map((n) => [n.sourcePath, n]));
  let max = 0;
  for (const n of src.nodes) {
    if (n.instanceOf) continue;
    const other = byPath.get(n.sourcePath);
    if (!other) continue;
    const am = a.get(n.id), bm = b.get(other.id);
    for (let i = 0; i < 16; i++) max = Math.max(max, Math.abs(am[i] - bm[i]));
  }
  assert.ok(max < 1e-6, `world delta ${max}`);
});

test('USD writer: prototypes are class prims after the default prim', () => {
  const src = readUsda(read('exchange-yup.usda')).scene;
  const out = writeUsda(src, { upAxis: 'Y', metersPerUnit: 1 });
  const defaultIdx = out.text.indexOf('def Xform "World"');
  const classIdx = out.text.indexOf('class Xform "_Prototypes"');
  assert.ok(defaultIdx >= 0 && classIdx > defaultIdx, 'class library must follow the default prim');
  assert.ok(!/def Xform "_Prototypes"/.test(out.text), 'prototypes must be class, not def');
});

test('glTF writer: USD instanceable input collapses to one instancing node of N transforms', () => {
  const src = readUsda(read('exchange-yup.usda')).scene;
  const { json } = writeGltf(src);
  const instancingNodes = json.nodes.filter((n) => n.extensions?.EXT_mesh_gpu_instancing);
  // One for the 4 panels, one for the 2 posts — not 4 + 2 separate nodes.
  assert.equal(instancingNodes.length, 2, `got ${instancingNodes.length} instancing nodes`);
  const counts = instancingNodes.map((n) => {
    const tr = n.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION;
    return json.accessors[tr].count;
  }).sort();
  assert.deepEqual(counts, [2, 4]);
});

test('exchange glTF -> USDA: real file, re-read, hierarchy and placements agree', () => {
  const result = exchange('gltf', { text: read('exchange.gltf'), name: 'exchange.gltf' });
  assert.ok(result.targetText.startsWith('#usda 1.0'));
  assert.equal(result.comparison.verdict.ok, true, result.comparison.verdict.reasons.join('; '));
  assert.equal(result.comparison.placements.matched, 6);
  assert.equal(result.comparison.placements.referenceCount, 6);
  assert.equal(result.targetFrame.upAxis, 'Y');
});

test('exchange USDA(Z-up cm) -> glTF: frame converted, placements preserved', () => {
  const result = exchange('usda', { text: read('exchange-zup.usda'), name: 'exchange-zup.usda' });
  assert.equal(result.comparison.verdict.ok, true, result.comparison.verdict.reasons.join('; '));
  assert.equal(result.targetFormat, 'gltf');
  assert.equal(result.comparison.placements.matched, 6);
  assert.ok(result.comparison.geometry.vertexOverlap > 0.99);
  assert.ok(result.comparison.geometry.triangleOverlap > 0.99);
  // Degradation carried into the report, addressed to the real source path.
  assert.ok(result.report.degradedMaterials.some((m) => m.dropped.includes('emissiveColor')));
});

test('report states units, axis policy and sharing rather than only totals', () => {
  const result = exchange('usda', { text: read('exchange-zup.usda'), name: 'exchange-zup.usda' });
  const r = result.report;
  assert.equal(r.units.sourceMetersPerUnit, 0.01);
  assert.equal(r.axis.sourceUpAxis, 'Z');
  assert.ok(Array.isArray(r.axis.rootFixMatrix));
  assert.ok(r.instances.authoredInstanceDraws >= 6);
  assert.equal(r.instances.mirroredInstanceDraws, 1);
  assert.ok(r.reuse.expansionFactor > 1, 'shared geometry should report reuse > 1');
  assert.ok(r.instances.sets.every((s) => s.rows.length >= 1));
});

test('comparison refuses to call a vertex-total match a proof', () => {
  // Identical totals, one placement shifted: the comparison must fail.
  const result = exchange('usda', { text: read('exchange-yup.usda'), name: 'exchange-yup.usda' });
  const moved = result.targetScene;
  const sets = moved.instanceSets.filter((s) => s.transforms.length >= 2);
  assert.ok(sets.length >= 1, 'expected multi-transform instance sets');
  const set = sets[0];
  const before = set.transforms[0].slice();
  set.transforms[0] = set.transforms[0].slice();
  set.transforms[0][12] += 1;
  const cmp = compareScenes(result.sourceScene, moved);
  assert.equal(cmp.verdict.ok, false, 'a moved instance must fail even if vertex totals match');
  assert.ok(cmp.verdict.reasons.some((r) => /placement/.test(r)), cmp.verdict.reasons.join('; '));
  assert.equal(cmp.geometry.referenceVertices, cmp.geometry.candidateVertices);
  set.transforms[0] = before;
});

test('mirrored instance is visible-triangle-correct in the IR', () => {
  const { scene } = readUsda(read('exchange-yup.usda'));
  const r = buildReport({ scene, sourceFormat: 'usda', targetFormat: 'usda' });
  const panel = r.instances.sets.find((s) => s.kind === 'instanceable');
  assert.equal(panel.mirroredInstances, 1);
  // Single-sided material + mirror: the draw is counted, not dropped.
  assert.ok(drawItems(scene).length === 7);
});

test('glTF writer: a mirrored instance set is widened to doubleSided and reported', () => {
  const src = readGltf(JSON.parse(read('exchange.gltf'))).scene;
  const plain = writeGltf(src, { mirrorMitigation: false });
  const fixed = writeGltf(src, { mirrorMitigation: true });

  // Without mitigation the mirrored set keeps the authored single-sided material.
  const plainPanel = plain.json.nodes.find((n) => n.name === 'PanelInstances');
  const plainMat = plain.json.materials[plain.json.meshes[plainPanel.mesh].primitives[0].material];
  assert.equal(plainMat.doubleSided, undefined);
  assert.equal(plainPanel.extras.usdgltf.mirrorFix, null);

  // With mitigation only that instanced mesh gets a doubleSided variant; the
  // instance matrices are untouched, so the mirror itself is preserved.
  const fixedPanel = fixed.json.nodes.find((n) => n.name === 'PanelInstances');
  const fixedMat = fixed.json.materials[fixed.json.meshes[fixedPanel.mesh].primitives[0].material];
  assert.equal(fixedMat.doubleSided, true);
  assert.equal(fixedPanel.extras.usdgltf.mirrorFix, 'widened-to-doubleSided');
  assert.deepEqual(
    fixedPanel.extensions.EXT_mesh_gpu_instancing.attributes,
    plainPanel.extensions.EXT_mesh_gpu_instancing.attributes,
    'instance accessors are identical: no matrix was rewritten',
  );

  // The honest claim replaces the old "winding flipped per instance" text.
  assert.match(fixedPanel.extras.usdgltf.mirrorPolicy, /not per instance/);
  assert.ok(!/winding flipped per instance at load/.test(fixedPanel.extras.usdgltf.mirrorPolicy));

  // Non-mirrored sets are left single-sided and emit no warning.
  const post = fixed.json.nodes.find((n) => n.name === 'PostInstances');
  assert.equal(post.extras.usdgltf.mirrorFix, null);
  assert.equal(fixed.warnings.length, 1);
  assert.equal(fixed.warnings[0].kind, 'mirror-facing');
  assert.equal(fixed.warnings[0].mirroredPlacements, 1);
});

test('exchange USD -> glTF reports the mirror mitigation in the report', () => {
  const result = exchange('usda', { text: read('exchange-yup.usda'), name: 'exchange-yup.usda' });
  assert.equal(result.comparison.verdict.ok, true, result.comparison.verdict.reasons.join('; '));
  assert.equal(result.report.mirrorFacing.mirroredInstanceDraws, 1);
  const mirrorWarning = result.report.warnings.find((w) => w.kind === 'mirror-facing');
  assert.ok(mirrorWarning, 'a mirror-facing trade-off must be listed');
  assert.match(mirrorWarning.resolution, /doubleSided/);
});

test('Z-up cm fixture is a real Z-up authoring of the same world', () => {
  const y = readUsda(read('exchange-yup.usda')).scene;
  const z = readUsda(read('exchange-zup.usda')).scene;
  const wy = worldMatrices(y);
  const wz = worldMatrices(z);
  // worldMatrices applies each scene's root fix, so both files must resolve to
  // the same canonical Y-up metre worlds. A fixture that only relabelled
  // upAxis/metersPerUnit, or applied the forward rotation instead of its
  // inverse, would differ by far more than this tolerance (the earlier bug was
  // a 180-degree X rotation: panels below the ground).
  const byName = (scene, worlds) => {
    const out = new Map();
    for (const node of scene.nodes) {
      if (node.isPrototype) continue;
      const m = worlds.get(node.id);
      if (m) out.set(node.name, m);
    }
    return out;
  };
  const a = byName(y, wy);
  const b = byName(z, wz);
  assert.equal(a.size, b.size);
  for (const [name, ma] of a) {
    const mb = b.get(name);
    assert.ok(mb, `node ${name} exists in both`);
    for (let k = 0; k < 16; k++) {
      assert.ok(Math.abs(ma[k] - mb[k]) < 1e-4,
        `${name} canonical world[${k}]: ${ma[k]} vs ${mb[k]}`);
    }
  }
  // Sanity: the Assembly is above the ground (positive Y) in canonical space.
  assert.ok(wz.get(z.nodes.find((n) => n.name === 'Assembly').id)[13] > 1,
    'Assembly is above the ground in canonical Y-up metres');
});
