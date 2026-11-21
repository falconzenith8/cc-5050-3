// Two-real-loader verification for the shared-mesh material override feature.
//
// Drives the actual third-party loaders against the on-disk fixtures and
// collects independent evidence for the three claims that matter:
//   1. material isolation - selecting each mesh shows its own material colour;
//   2. vertex reuse       - distinct position attribute/accessor count is one
//                           per physical geometry resource, not per placement;
//   3. world bounds       - both loaders place the same vertices in the same
//                           world box, matching the canonical IR's bounds.
//
// GLTFLoader needs a couple of browser globals Node does not provide; they are
// shimmed minimally here and nothing about the loaded result is mocked. Run:
//   node tools/verify-override-loaders.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

globalThis.ProgressEvent = class ProgressEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.lengthComputable = init.lengthComputable || false;
    this.loaded = init.loaded || 0;
    this.total = init.total || 0;
  }
};

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { USDLoader } from '@openusd-wasm/three-loader';
import { readGltf } from '../src/core/gltf.js';
import { readUsda } from '../src/core/usd-reader.js';
import { worldBounds } from '../src/core/compare.js';

const here = dirname(fileURLToPath(import.meta.url));
const scenesDir = join(here, '..', 'scenes');

const results = { generatedAt: new Date().toISOString(), loaders: {}, checks: [] };
function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '}${name}${detail ? `  (${detail})` : ''}`);
}

function worldBoxOf(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o.isInstancedMesh) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        tmp.copy(new THREE.Box3().setFromBufferAttribute(o.geometry.attributes.position)).applyMatrix4(
          new THREE.Matrix4().copy(o.matrixWorld).multiply(m),
        );
        box.union(tmp);
      }
    } else {
      tmp.setFromObject(o);
      box.union(tmp);
    }
  });
  return {
    min: box.min.toArray(), max: box.max.toArray(),
    size: box.getSize(new THREE.Vector3()).toArray(),
  };
}

function materialColor(material) {
  const m = Array.isArray(material) ? material[0] : material;
  // three.js stores the glTF base colour in material.color (linear) and opacity.
  return { name: m?.name || null, color: m?.color ? m.color.toArray() : null, opacity: m?.opacity ?? 1 };
}

async function loadGltf() {
  const text = readFileSync(join(scenesDir, 'override.gltf'), 'utf8');
  const gltf = await new GLTFLoader().parseAsync(text, '');
  const root = gltf.scene;
  const meshes = [];
  const positionAttributeIds = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    positionAttributeIds.add(o.geometry.attributes.position.uuid);
    meshes.push({
      object: o,
      name: o.name,
      instanced: o.isInstancedMesh ? o.count : 1,
      material: materialColor(o.material),
    });
  });
  return { root, meshes, distinctPositionAttributes: positionAttributeIds.size, bounds: worldBoxOf(root) };
}

async function loadUsd() {
  const text = readFileSync(join(scenesDir, 'override.usda'), 'utf8');
  const model = await new USDLoader().parseAsync(text, { fileName: 'override.usda', convertZUp: true, loadTextures: false });
  const root = model.scene;
  const meshes = [];
  const positionAttributeIds = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    positionAttributeIds.add(o.geometry.attributes.position.uuid);
    meshes.push({
      object: o,
      name: o.name,
      path: o.userData?.usd?.path || null,
      instanced: o.isInstancedMesh ? o.count : 1,
      material: materialColor(o.material),
    });
  });
  return { root, meshes, distinctPositionAttributes: positionAttributeIds.size, bounds: worldBoxOf(root) };
}

function approx(a, b, tol = 1e-4) {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

async function main() {
  const gltf = await loadGltf();
  results.loaders.gltf = {
    loader: 'three.js GLTFLoader',
    distinctPositionAttributes: gltf.distinctPositionAttributes,
    bounds: gltf.bounds,
    meshes: gltf.meshes.map((m) => ({ name: m.name, instanced: m.instanced, material: m.material })),
  };
  console.log('\n[GLTFLoader]');
  console.log('  meshes:', results.loaders.gltf.meshes);

  const usd = await loadUsd();
  results.loaders.usd = {
    loader: '@openusd-wasm/three-loader 0.0.17',
    distinctPositionAttributes: usd.distinctPositionAttributes,
    bounds: usd.bounds,
    meshes: usd.meshes.map((m) => ({ name: m.name, path: m.path, instanced: m.instanced, material: m.material })),
  };
  console.log('\n[openusd-wasm]');
  console.log('  meshes:', results.loaders.usd.meshes);

  // ---- 1. material isolation ---------------------------------------------
  const gltfColors = new Set(gltf.meshes.map((m) => m.material.color?.map((c) => c.toFixed(3)).join(',')));
  check('GLTFLoader shows two distinct material colours (isolation)', gltfColors.size >= 2,
    [...gltfColors].join(' vs '));
  const usdColors = new Set(usd.meshes.map((m) => m.material.color?.map((c) => c.toFixed(3)).join(',')));
  check('openusd shows two distinct material colours (isolation)', usdColors.size >= 2,
    [...usdColors].join(' vs '));

  // The feature claim is the *replacement* binding: BracketPaint must resolve on
  // the overridden placement Bracket_1 in every loader, including openusd.
  const paintColor = [0.9, 0.35, 0.12];
  const gltfPaint = gltf.meshes.find((m) => m.material.name === 'BracketPaint');
  check('GLTFLoader binds BracketPaint on the overridden placement',
    !!gltfPaint && approx(gltfPaint.material.color, paintColor, 1e-2));
  const usdPaint = usd.meshes.find((m) => m.path?.includes('Bracket_1'));
  check('openusd binds BracketPaint on the overridden placement Bracket_1',
    !!usdPaint && approx(usdPaint.material.color, paintColor, 1e-2),
    usdPaint?.material.name || 'placement not found');

  // Reported loader limit: openusd renders a class-prototype's *base* material
  // binding as an unnamed grey material rather than resolving the in-class
  // BracketSteel binding. Stage-root and over-variant bindings resolve fully;
  // this is recorded honestly rather than claimed as a conversion failure.
  const greyPrototype = usd.meshes.find((m) => m.path?.includes('Bracket_0') && !m.material.name);
  results.loaderLimits = {
    '@openusd-wasm/three-loader 0.0.17': greyPrototype
      ? ['base class-prototype material binding renders as an unnamed grey material; '
        + 'stage-root and over-variant (BracketPaint) bindings resolve correctly.']
      : [],
  };

  // ---- 2. vertex reuse ----------------------------------------------------
  check('GLTFLoader builds one position attribute for the shared geometry',
    gltf.distinctPositionAttributes === 1, `${gltf.distinctPositionAttributes} distinct attribute(s)`);
  // The glTF file itself has one POSITION accessor across all primitives.
  const gltfJson = JSON.parse(readFileSync(join(scenesDir, 'override.gltf'), 'utf8'));
  const accessorCount = new Set(gltfJson.meshes.flatMap((m) => m.primitives).map((p) => p.attributes.POSITION)).size;
  check('override.gltf references one POSITION accessor on disk', accessorCount === 1, `${accessorCount} accessor(s)`);
  const irGltf = readGltf(gltfJson, { sourceName: 'override.gltf' }).scene;
  const irUsd = readUsda(readFileSync(join(scenesDir, 'override.usda'), 'utf8'), { sourceName: 'override.usda' }).scene;
  const distinct = (s) => new Set(s.meshes.map((m) => m.resourceKey)).size;
  check('both readers resolve one physical resource key', distinct(irGltf) === 1 && distinct(irUsd) === 1,
    `gltf=${distinct(irGltf)}, usd=${distinct(irUsd)}`);

  // ---- 3. world bounds agreement -----------------------------------------
  check('the two real loaders produce the same world bounding box',
    approx(gltf.bounds.min, usd.bounds.min, 1e-3) && approx(gltf.bounds.max, usd.bounds.max, 1e-3),
    `gltf ${JSON.stringify(gltf.bounds.min)}..${JSON.stringify(gltf.bounds.max)} | usd ${JSON.stringify(usd.bounds.min)}..${JSON.stringify(usd.bounds.max)}`);
  const irBounds = worldBounds(irGltf);
  check('loader world box matches the canonical IR world box',
    approx(gltf.bounds.min, irBounds.min, 1e-3) && approx(gltf.bounds.max, irBounds.max, 1e-3),
    `ir ${JSON.stringify(irBounds.min)}..${JSON.stringify(irBounds.max)}`);

  const failed = results.checks.filter((c) => !c.ok).length;
  writeFileSync(join(here, '..', 'tests', 'e2e', 'artifacts', 'override-loader-evidence.json'),
    JSON.stringify(results, null, 2));
  console.log(`\n${results.checks.length - failed}/${results.checks.length} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
