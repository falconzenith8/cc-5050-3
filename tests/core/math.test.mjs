import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  IDENTITY, compose, multiply, invert, determinant, transformPoint, normalMatrix,
  determinant3, decompose, usdMatrixToGltf, gltfMatrixToUsd, upAxisRotation, isIdentity, matrixDelta,
} from '../../src/core/math.js';

test('usdMatrixToGltf is an identity copy, not a transpose', () => {
  const m = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  assert.deepEqual(usdMatrixToGltf(m), m);
  assert.deepEqual(gltfMatrixToUsd(m), m);
  // A transpose would swap elements 1 and 4; the USD and glTF layouts are the
  // same 16 numbers because one is row-major and the other column-major.
  assert.notEqual(usdMatrixToGltf(m)[1], m[4]);
});

test('invert matches THREE.Matrix4.invert and m*inv = I', () => {
  const cases = [
    compose({ translation: [3, -2, 5], rotation: [0.2, 0.3, 0.1, 0.9], scale: [2, 0.5, 1.5] }),
    compose({ translation: [0, 1.5, 0], rotation: [0, Math.sin(Math.PI / 20), 0, Math.cos(Math.PI / 20)], scale: [1, 0.5, 1] }),
    [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    [2, 0, 0, 0, 0.5, 1, 0, 0, 0.25, 0.3, 3, 0, 7, -4, 2, 1],
  ];
  for (const m of cases) {
    const ours = invert(m);
    const three = new THREE.Matrix4().fromArray(m).invert().toArray();
    assert.ok(matrixDelta(ours, three) < 1e-12, `inverse delta ${matrixDelta(ours, three)}`);
    assert.ok(matrixDelta(multiply(m, ours), IDENTITY) < 1e-9, 'm * inv != I');
  }
});

test('multiply order: a*b applies b first (column vectors)', () => {
  const t = compose({ translation: [10, 0, 0] });
  const r = compose({ rotation: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)] });
  // rotate then translate: point (1,0,0) -> rotated (0,1,0) -> +10x
  const rt = transformPoint(multiply(t, r), [1, 0, 0]);
  assert.ok(Math.abs(rt[0] - 10) < 1e-9 && Math.abs(rt[1] - 1) < 1e-9, `got ${rt}`);
  // translate then rotate: (1+10,0,0) -> rotated about origin -> (-0? no: (11,0,0)->(0,11,0))
  const tr = transformPoint(multiply(r, t), [1, 0, 0]);
  assert.ok(Math.abs(tr[0]) < 1e-9 && Math.abs(tr[1] - 11) < 1e-9, `got ${tr}`);
});

test('xformOpOrder composes as ops[0]*ops[1] (verified against OpenUSD)', () => {
  // ["translate","rotateZ"] on a point at origin: T * R -> origin (10,0,0).
  const t = compose({ translation: [10, 0, 0] });
  const rz = compose({ rotation: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)] });
  const a = transformPoint(multiply(t, rz), [0, 0, 0]);
  const b = transformPoint(multiply(rz, t), [0, 0, 0]);
  assert.ok(Math.abs(a[0] - 10) < 1e-9 && Math.abs(a[1]) < 1e-9);
  assert.ok(Math.abs(b[0]) < 1e-9 && Math.abs(b[1] - 10) < 1e-9);
});

test('upAxisRotation: Z-up -> Y-up maps (x,y,z) to (x,z,-y), scaled by units', () => {
  const r = upAxisRotation('Z', 'Y');
  assert.deepEqual(Array.from(transformPoint(r, [1, 0, 0])), [1, 0, 0]);
  const y = transformPoint(r, [0, 1, 0]);
  assert.ok(Math.abs(y[2] + 1) < 1e-12, 'old +Y becomes -Z');
  const z = transformPoint(r, [0, 0, 1]);
  assert.ok(Math.abs(z[1] - 1) < 1e-12, 'old +Z becomes +Y');
  assert.throws(() => upAxisRotation('X', 'Y'));
});

test('normalMatrix is inverse-transpose and preserves mirror handedness', () => {
  const m = compose({ scale: [2, 0.5, 1] });
  const n = normalMatrix(m);
  // Under non-uniform scale, normals need inv-transpose: a +X normal stays +X,
  // a +Y normal stays +Y, but their lengths are reciprocal to the scale.
  const nx = [n[0], n[1], n[2]];
  const ny = [n[3], n[4], n[5]];
  assert.ok(Math.abs(nx[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(ny[1] - 2) < 1e-12);
  // Mirrored matrix: determinant is negative; normal matrix keeps sign (does not
  // flip normals to compensate), so geometry + winding carry the mirror.
  const mirror = compose({ scale: [-1, 1, 1] });
  assert.ok(determinant(mirror) < 0);
  assert.ok(determinant3(mirror) < 0);
});

test('decompose round-trips through compose for non-uniform scale', () => {
  const q = [0.1, 0.4, -0.2, 0.88];
  const n = Math.hypot(...q);
  const src = compose({ translation: [1, 2, 3], rotation: q.map((v) => v / n), scale: [1.5, 0.5, 2] });
  const d = decompose(src);
  const back = compose(d);
  assert.ok(matrixDelta(src, back) < 1e-9, `delta ${matrixDelta(src, back)}`);
});

test('decompose carries a mirror on X (negative determinant)', () => {
  const mirrorX = compose({ translation: [0, 0, -3], scale: [-1, 1, 1] });
  const d = decompose(mirrorX);
  assert.ok(d.scale[0] < 0, 'mirror must appear as a negative scale, not be silently dropped');
  assert.ok(matrixDelta(compose(d), mirrorX) < 1e-12);
});

test('determinant of a transform with a mirror is negative', () => {
  const m = multiply(compose({ translation: [5, 1, 0] }), compose({ scale: [1, 1, -1] }));
  assert.ok(determinant(m) < 0);
});

test('isIdentity honours epsilon', () => {
  assert.ok(isIdentity(IDENTITY));
  const near = IDENTITY.slice();
  near[12] = 1e-12;
  assert.ok(isIdentity(near));
  near[12] = 1e-6;
  assert.ok(!isIdentity(near));
});
