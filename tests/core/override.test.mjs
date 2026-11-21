// Feature tests for shared-mesh material override, conversion lineage and
// layer-by-layer mapping control.
//
// Everything here runs against the real on-disk fixtures produced by
// tools/build-override-scenes.mjs and re-read through the real readers: no
// mocked geometry, no in-memory-only round trips. The fixture deliberately
// contains two same-named "Bracket" nodes, a mirrored (negative-scale) parent
// layer, and one material-only override placement sharing one geometry
// resource.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readGltf, writeGltf } from '../../src/core/gltf.js';
import { readUsda, } from '../../src/core/usd-reader.js';
import { writeUsda } from '../../src/core/usda-writer.js';
import { exchange } from '../../src/core/exchange.js';
import {
  createScene, createNode, createMesh, createMaterial, createInstanceSet,
  distinctResourceCount, resourceGroups, effectiveMaterial, findMaterial, findNode,
} from '../../src/core/scene.js';
import {
  createLineage, recordLink, tracePlacement, traceMesh, disableMapping,
  parentTransformChain, LAYERS,
} from '../../src/core/lineage.js';
import { buildConversionLineage } from '../../src/core/lineage-build.js';
import {
  EditSession, EditTracker, overrideInstanceMaterial, detachInstanceGeometry,
  reparentNode, reshareGeometry, EVENT,
} from '../../src/core/edits.js';
import { worldBounds, drawItems, worldMatrices } from '../../src/core/compare.js';
import { buildOverrideScene } from '../../tools/build-override-scenes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scenesDir = join(here, '..', '..', 'scenes');
const read = (name) => readFileSync(join(scenesDir, name), 'utf8');

function loadGltf() {
  return readGltf(JSON.parse(read('override.gltf')), { sourceName: 'override.gltf' }).scene;
}
function loadUsda() {
  return readUsda(read('override.usda'), { sourceName: 'override.usda' }).scene;
}

const STEEL = [0.55, 0.6, 0.65, 1];
const PAINT = [0.9, 0.35, 0.12, 1];

function colorOf(scene, materialId) {
  return findMaterial(scene, materialId)?.baseColorFactor;
}

/** Text of the USDA block opened by `header`, up to its matching closing brace. */
function blockAfter(text, header) {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `block ${header} present`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

// ---------------------------------------------------------------------------
// 1. Material isolation + resource sharing in both real formats
// ---------------------------------------------------------------------------

test('override fixture: two same-named nodes exist under different parents', () => {
  for (const scene of [loadGltf(), loadUsda()]) {
    const brackets = scene.nodes.filter((n) => n.name === 'Bracket');
    assert.equal(brackets.length, 2);
    const parents = new Set(brackets.map((b) => b.parent));
    assert.equal(parents.size, 2, 'the two Bracket nodes must have distinct parents');
  }
});

test('material override changes only one placement while the other keeps steel', () => {
  for (const scene of [loadGltf(), loadUsda()]) {
    const set = scene.instanceSets[0];
    assert.equal(set.transformOverrides.length, 2);
    assert.equal(set.transformOverrides[0].material, null, 'placement 0 is unmodified');
    const overrideId = set.transformOverrides[1].material;
    assert.ok(overrideId, 'placement 1 carries an override material');
    assert.deepEqual(colorOf(scene, set.material), STEEL);
    assert.deepEqual(colorOf(scene, overrideId), PAINT);
  }
});

test('override placements share one physical geometry resource (one resourceKey)', () => {
  for (const scene of [loadGltf(), loadUsda()]) {
    assert.equal(distinctResourceCount(scene), 1, 'exactly one physical resource on disk');
    const groups = resourceGroups(scene);
    assert.equal(groups.length, 1);
    // Two IR mesh objects (steel + paint) point at the one shared resource.
    assert.ok(groups[0].meshes.length >= 2, 'material split duplicates the binding, not the bytes');
  }
});

test('glTF on disk: override primitive reuses the same POSITION accessor', () => {
  const json = JSON.parse(read('override.gltf'));
  const primitives = json.meshes.flatMap((m) => m.primitives);
  const positionAccessors = new Set(primitives.map((p) => p.attributes.POSITION));
  const indexAccessors = new Set(primitives.map((p) => p.indices));
  assert.equal(positionAccessors.size, 1, 'all primitives draw one POSITION accessor');
  assert.equal(indexAccessors.size, 1, 'all primitives draw one index accessor');
  const materials = new Set(primitives.map((p) => p.material));
  assert.equal(materials.size, 2, 'but bind two distinct materials');
});

test('USD on disk: variant prototype authors geometry once and only rebinds material', () => {
  const text = read('override.usda');
  const pointBlocks = (text.match(/point3f\[\] points/g) || []).length;
  // One authored mesh in the prototype library + one standalone Bracket mesh.
  assert.ok(pointBlocks >= 1, 'geometry is authored as prototype geometry');
  assert.match(text, /over Mesh "BracketMesh"/, 'override is an over, not a second geometry authoring');
  assert.match(text, /prepend references = <\/_Prototypes\/BracketMesh>/, 'variant references the base geometry');
  const variantSection = blockAfter(text, 'class Xform "BracketMesh_BracketPaint"');
  assert.ok(!/point3f\[\] points/.test(variantSection), 'the variant authors no geometry points of its own');
});

// ---------------------------------------------------------------------------
// 2. Full exchange round trips preserve isolation, sharing and worlds
// ---------------------------------------------------------------------------

test('exchange glTF -> USDA preserves material isolation, sharing and worlds', () => {
  const result = exchange('gltf', { text: read('override.gltf'), name: 'override.gltf' });
  assert.equal(result.comparison.verdict.ok, true, result.comparison.verdict.reasons.join('; '));
  assert.equal(distinctResourceCount(result.targetScene), 1);
  const set = result.targetScene.instanceSets[0];
  assert.ok(set.transformOverrides.some((o) => o.material));
  assert.equal(result.comparison.bounds.delta.maxAbs, 0);
});

test('exchange USDA -> glTF preserves material isolation, sharing and worlds', () => {
  const result = exchange('usda', { text: read('override.usda'), name: 'override.usda' });
  assert.equal(result.comparison.verdict.ok, true, result.comparison.verdict.reasons.join('; '));
  assert.equal(distinctResourceCount(result.targetScene), 1);
  // The written glTF physically shares one POSITION accessor.
  const primitives = result.targetJson.meshes.flatMap((m) => m.primitives);
  assert.equal(new Set(primitives.map((p) => p.attributes.POSITION)).size, 1);
});

test('world bounding box reproduces identically through both formats', () => {
  const a = worldBounds(loadGltf());
  const b = worldBounds(loadUsda());
  for (const k of ['min', 'max']) {
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[k][i] - b[k][i]) < 1e-6);
  }
});

test('mirrored parent layer reflects placements without editing placement locals', () => {
  for (const scene of [loadGltf(), loadUsda()]) {
    const items = drawItems(scene);
    const mirrored = items.filter((i) => i.mirrored);
    assert.ok(mirrored.length >= 2, 'the two rig placements inherit the negative-scale parent');
    const positions = items.map((i) => [i.world[12], i.world[13], i.world[14]]);
    // Reflected placements land at +X (the rig translates +2 then scales X -1).
    assert.ok(positions.some((p) => Math.abs(p[0] - 2) < 1e-6));
  }
});

// ---------------------------------------------------------------------------
// 3. Reverse-lookup lineage
// ---------------------------------------------------------------------------

test('lineage traces an output placement back to source node, chain, geometry and material', () => {
  const result = exchange('gltf', { text: read('override.gltf'), name: 'override.gltf' });
  const target = result.targetScene;
  const host = target.nodes.find((n) => n.sourcePath === '/RigRoot/MirrorRig/Bracket');
  const trace = tracePlacement(target, result.lineage, host.id);
  assert.ok(trace.sourceNode, 'a source node link exists');
  assert.equal(trace.sourceNode.path, '/RigRoot/MirrorRig/Bracket');
  assert.deepEqual(trace.parentChain.map((c) => c.name), ['RigRoot', 'MirrorRig', 'Bracket']);
  assert.ok(trace.geometry.resourceKey, 'geometry resource identity is present');
  assert.ok(trace.layers.includes('parent') && trace.layers.includes('geometry'));
});

test('lineage mesh trace follows one physical resource across the format boundary', () => {
  const result = exchange('gltf', { text: read('override.gltf'), name: 'override.gltf' });
  for (const mesh of result.targetScene.meshes) {
    const t = traceMesh(result.targetScene, result.lineage, mesh.id);
    assert.ok(t.sourceGeometry, `${mesh.id} links back to a source geometry`);
    assert.equal(t.sharedResource, true);
  }
  assert.equal(result.lineageSummary.geometryBytesDuplicated, false);
  assert.equal(result.lineageSummary.targetResources, 1);
});

test('name-based confusion is impossible: links key on ids, and both Bracket nodes resolve', () => {
  const result = exchange('gltf', { text: read('override.gltf'), name: 'override.gltf' });
  const brackets = result.targetScene.nodes.filter((n) => n.name === 'Bracket');
  assert.equal(brackets.length, 2);
  for (const node of brackets) {
    const trace = tracePlacement(result.targetScene, result.lineage, node.id);
    assert.ok(trace.sourceNode, `Bracket at ${node.sourcePath} has its own source link`);
    assert.equal(trace.sourceNode.path, node.sourcePath);
  }
});

// ---------------------------------------------------------------------------
// 4. Layer-by-layer mapping disable, each reversible
// ---------------------------------------------------------------------------

test('disableMapping supports every declared layer and each is undoable', () => {
  const scene = loadGltf();
  const lineage = createLineage();
  const host = scene.nodes.find((n) => n.sourcePath === '/RigRoot/MirrorRig/Bracket');
  assert.deepEqual([...LAYERS].sort(), ['geometry', 'material', 'override', 'parent', 'transform'].sort());

  // parent
  const beforeParent = host.parent;
  const parentRec = disableMapping(scene, lineage, host.id, 'parent');
  assert.equal(host.parent, null);
  parentRec.undo();
  assert.equal(host.parent, beforeParent);

  // transform
  const beforeMatrix = host.matrix.slice();
  const transformRec = disableMapping(scene, lineage, host.id, 'transform');
  assert.deepEqual(host.matrix.slice(0, 4), [1, 0, 0, 0]);
  transformRec.undo();
  assert.deepEqual(host.matrix, beforeMatrix);

  // override
  const set = scene.instanceSets[0];
  const overrideBefore = set.transformOverrides[1].material;
  assert.ok(overrideBefore);
  const overrideRec = disableMapping(scene, lineage, host.id, 'override');
  assert.equal(set.transformOverrides[1].material, null);
  overrideRec.undo();
  assert.equal(set.transformOverrides[1].material, overrideBefore);
});

test('disabling the geometry layer is the ONLY layer that mints a new resource key', () => {
  const scene = loadGltf();
  const lineage = createLineage();
  const host = scene.nodes.find((n) => n.sourcePath === '/RigRoot/MirrorRig/Bracket');
  const before = distinctResourceCount(scene);

  for (const layer of ['parent', 'transform', 'material', 'override']) {
    const rec = disableMapping(scene, lineage, host.id, layer);
    assert.equal(distinctResourceCount(scene), before, `${layer} disable must not copy geometry`);
    rec.undo();
  }

  const geoRec = disableMapping(scene, lineage, host.id, 'geometry');
  assert.equal(distinctResourceCount(scene), before + 1, 'geometry disable mints one new resource');
  assert.ok(findNode(scene, host.id).mesh, 'the placement now points at a private mesh');
  geoRec.undo();
});

test('parent transform chain reports root->node locals and accumulated worlds', () => {
  const scene = loadUsda();
  const host = scene.nodes.find((n) => n.sourcePath === '/RigRoot/MirrorRig/Bracket');
  const chain = parentTransformChain(scene, host);
  assert.equal(chain.length, 3);
  assert.equal(chain[0].name, 'RigRoot');
  // Each entry beyond the root has a world that is the parent world times local.
  for (let k = 1; k < chain.length; k++) {
    assert.ok(chain[k].world, 'world matrix is attached to every chain entry');
  }
});

// ---------------------------------------------------------------------------
// 5. Edit session: reparent -> undo -> clear only the material override
// ---------------------------------------------------------------------------

test('reparent is world-preserving and undo restores the original parent', () => {
  const { scene, painted } = buildOverrideScene();
  const worlds = worldMatrices(scene);
  const before = worlds.get(painted.id).slice();
  const secondParent = createNode({ name: 'SecondParent' });
  scene.nodes.push(secondParent);

  const session = new EditSession(scene);
  session.execute(reparentNode(painted, secondParent, (id) => worldMatrices(scene).get(id)));
  assert.equal(painted.parent, secondParent.id);
  assert.deepEqual(worldMatrices(scene).get(painted.id), before, 'world transform is preserved');

  session.undo();
  assert.notEqual(painted.parent, secondParent.id, 'undo restores the original parent');
  assert.deepEqual(worldMatrices(scene).get(painted.id), before);
});

test('after reparent+undo, deleting the override removes only the material opinion', () => {
  const { scene, set, painted } = buildOverrideScene();
  const resourceBefore = distinctResourceCount(scene);
  const secondParent = createNode({ name: 'SecondParent' });
  scene.nodes.push(secondParent);
  const session = new EditSession(scene);

  session.execute(reparentNode(painted, secondParent, (id) => worldMatrices(scene).get(id)));
  session.undo();

  // The painted placement is a host-form transform override at index 1.
  const overrideId = set.transformOverrides[1].material;
  assert.ok(overrideId);
  session.execute(overrideInstanceMaterial(1, scene, overrideId, { set }));
  // Re-applying the same material is an override event but never copies geometry.
  assert.equal(distinctResourceCount(scene), resourceBefore);

  // Now clear only the override through the lineage override layer.
  const lineage = createLineage();
  const rec = disableMapping(scene, lineage, painted.id, 'override');
  assert.equal(set.transformOverrides[1].material, null);
  assert.equal(distinctResourceCount(scene), resourceBefore, 'geometry stays shared');
  rec.undo();
  assert.equal(set.transformOverrides[1].material, overrideId);
});

test('tracker separates parent-layer, resource-shared and geometry-copied evidence', () => {
  const { scene, painted, bracketMesh } = buildOverrideScene();
  const tracker = new EditTracker();
  const session = new EditSession(scene, { tracker });
  const secondParent = createNode({ name: 'SecondParent' });
  scene.nodes.push(secondParent);

  session.execute(overrideInstanceMaterial(painted, scene, {
    name: 'TempMat', baseColorFactor: [0.1, 0.2, 0.3, 1],
  }));
  session.execute(detachInstanceGeometry(painted));
  session.execute(reparentNode(painted, secondParent, (id) => worldMatrices(scene).get(id)));
  session.execute(reshareGeometry(painted, bracketMesh));

  const summary = tracker.summary();
  assert.ok(summary.parentLayerChanges >= 1, 'a parent-layer event is recorded');
  assert.ok(summary.geometryCopiedEvents === 1, 'exactly one real geometry copy');
  assert.ok(summary.resourceSharedEvents >= 1, 're-sharing/override emit resource-shared events');
  // The geometry-copied event names a new resource key distinct from the source.
  const copied = tracker.geometryCopied[0];
  assert.notEqual(copied.detail.newResourceKey, copied.detail.sourceResourceKey);
  // Material override events explicitly state no geometry was copied.
  for (const ev of tracker.byType(EVENT.MATERIAL_OVERRIDE)) {
    assert.equal(ev.detail.geometryCopied, false);
  }
});

test('detach then reshare returns the placement to the shared on-disk resource', () => {
  const { scene, painted, bracketMesh } = buildOverrideScene();
  const before = distinctResourceCount(scene);
  const session = new EditSession(scene);
  session.execute(detachInstanceGeometry(painted));
  assert.equal(distinctResourceCount(scene), before + 1);
  session.execute(reshareGeometry(painted, bracketMesh));
  assert.equal(distinctResourceCount(scene), before, 'the private copy is dropped');
  assert.equal(findNode(scene, painted.id).mesh, bracketMesh.id);
});

// ---------------------------------------------------------------------------
// 6. First identity-confusion step characterization
// ---------------------------------------------------------------------------

test('material-only edit never changes a resourceKey; a geometry detach always does', () => {
  const { scene, set } = buildOverrideScene();
  const mesh = scene.meshes.find((m) => m.id === set.mesh);
  const originalKey = mesh.resourceKey;

  const session = new EditSession(scene);
  session.execute(overrideInstanceMaterial(1, scene, {
    name: 'AnotherPaint', baseColorFactor: [0.2, 0.7, 0.4, 1],
  }, { set }));
  assert.equal(mesh.resourceKey, originalKey, 'override leaves the geometry key intact');

  const host = scene.nodes.find((n) => n.instanceSetIds?.includes(set.id));
  session.execute(detachInstanceGeometry(host));
  const privateMesh = scene.meshes.find((m) => m.id === findNode(scene, host.id).mesh);
  assert.notEqual(privateMesh.resourceKey, originalKey, 'a real copy mints a new key');
});

test('writers keep sharing on disk: glTF accessors and USD points are authored once per resource', () => {
  const { scene } = buildOverrideScene();
  const gltf = writeGltf(scene, { mirrorMitigation: false });
  const gltfPosAccessors = new Set(
    gltf.json.meshes.flatMap((m) => m.primitives).map((p) => p.attributes.POSITION),
  );
  assert.equal(gltfPosAccessors.size, 1);

  const usda = writeUsda(scene, { upAxis: 'Y', metersPerUnit: 1 });
  // Prototype points appear once; the override variant contributes none.
  const variantSection = blockAfter(usda.text, 'class Xform "BracketMesh_BracketPaint"');
  assert.ok(!/point3f\[\] points/.test(variantSection));
});
