// Matrix and transform kernel for the declared glTF <-> USD subset.
//
// Conventions used throughout:
//  - USD (Sdf/Gf): row-vector maths, translation in the 4th row, local = child * parent.
//  - glTF: column-vector maths, translation in the 4th column, world = parent * child.
//  - Internally we store every transform as a glTF-style 16-float array in
//    column-major order (`[m00,m10,m20,m30, m01,m11,...]`) so it can be handed to
//    `THREE.Matrix4.fromArray` unchanged. USD data is converted at the boundary
//    by `usdMatrixToGltf` / `gltfMatrixToUsd`, which are exact transposes.
//
// No conversion happens silently: every axis/unit/order decision is recorded by
// the conversion report (`src/core/report.js`).

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * USD 16-float matrix -> our column-major storage.
 *
 * USDA writes `((r0),(r1),(r2),(r3))`, i.e. the row-major flattening of a
 * row-vector matrix U, where world positions are p' = p * U. Our storage is
 * the column-major flattening of A = U^T, because we place column vectors on
 * the right (p' = A * p). For those two layouts the arrays are element-for-
 * element identical:
 *
 *   usdFlat[r * 4 + c] = U[r][c]
 *   ourArray[c * 4 + r] = A[r][c] = U[c][r] = usdFlat[c * 4 + r]
 *
 * So this conversion is a straight copy. Transposing here (as an earlier
 * version did) silently corrupts every rotation; it only looked right for
 * diagonal and pure-translation matrices. Verified against OpenUSD XformCache.
 */
export function usdMatrixToGltf(usd) {
  assert16(usd, 'usdMatrixToGltf');
  return Array.from(usd);
}

/** Our column-major storage -> USD row-major text order (also a copy). */
export function gltfMatrixToUsd(gltf) {
  assert16(gltf, 'gltfMatrixToUsd');
  return Array.from(gltf);
}

/** Build a column-major matrix from TRS (glTF semantics, applied as T * R * S). */
export function compose({ translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1] } = {}) {
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  // Column-major (glTF / THREE.Matrix4.elements).
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

/** Multiply column-vector matrices: a * b (b applied first). */
export function multiply(a, b) {
  assert16(a, 'multiply.a');
  assert16(b, 'multiply.b');
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export function invert(m) {
  assert16(m, 'invert');
  // Column-major, same derivation as THREE.Matrix4.invert (verified against it
  // in tests): elements are read as column c, row r -> m[c * 4 + r].
  const [
    n11, n21, n31, n41,
    n12, n22, n32, n42,
    n13, n23, n33, n43,
    n14, n24, n34, n44,
  ] = m;

  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  const id = 1 / det;

  return [
    t11 * id,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * id,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * id,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * id,
    t12 * id,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * id,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * id,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * id,
    t13 * id,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * id,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * id,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * id,
    t14 * id,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * id,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * id,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * id,
  ];
}

export function determinant(m) {
  assert16(m, 'determinant');
  // Cofactor expansion, reading column-major: m[c*4+r].
  const a00 = m[0], a01 = m[4], a02 = m[8], a03 = m[12];
  const a10 = m[1], a11 = m[5], a12 = m[9], a13 = m[13];
  const a20 = m[2], a21 = m[6], a22 = m[10], a23 = m[14];
  const a30 = m[3], a31 = m[7], a32 = m[11], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

export function transformPoint(m, p) {
  assert16(m, 'transformPoint');
  const [x, y, z] = p;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = w === 0 ? 1 : 1 / w;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw,
  ];
}

export function transformDirection(m, v) {
  assert16(m, 'transformDirection');
  const [x, y, z] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

/**
 * Normal matrix for a column-vector matrix: inverse-transpose of the upper 3x3.
 * Returned column-major as 9 floats. This is the only correct normal transform
 * under non-uniform scale; using the model matrix directly shears normals.
 */
export function normalMatrix(m) {
  const inv = invert(m);
  if (inv === null) return null;
  // Inverse-transpose of the upper 3x3, column-major. A mirror is carried by
  // geometry and winding, not by flipping normals: flipping them here would
  // turn every mirrored part inside-out for lighting purposes.
  return transpose3(inv);
}

export function transpose3(m) {
  return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
}

export function determinant3(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** Column-major 4x4 -> { translation, rotation (quat), scale } (glTF composition). */
export function decompose(m) {
  assert16(m, 'decompose');
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = determinant3(m);
  const neg = det < 0;
  // Mirror is carried on X (the convention used by Blender's exporter).
  const s = [neg ? -sx : sx, sy, sz];

  const r00 = m[0] / (neg ? -sx : sx), r10 = m[1] / (neg ? -sx : sx), r20 = m[2] / (neg ? -sx : sx);
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;

  const trace = r00 + r11 + r22;
  let q;
  if (trace > 0) {
    const k = Math.sqrt(trace + 1) * 2;
    q = [(r21 - r12) / k, (r02 - r20) / k, (r10 - r01) / k, k / 4];
  } else if (r00 > r11 && r00 > r22) {
    const k = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q = [k / 4, (r01 + r10) / k, (r02 + r20) / k, (r21 - r12) / k];
  } else if (r11 > r22) {
    const k = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q = [(r01 + r10) / k, k / 4, (r12 + r21) / k, (r02 - r20) / k];
  } else {
    const k = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q = [(r02 + r20) / k, (r12 + r21) / k, k / 4, (r10 - r01) / k];
  }
  const qn = normalizeQuat(q);
  return { translation: [m[12], m[13], m[14]], rotation: qn, scale: s };
}

export function normalizeQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-12) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function isIdentity(m, eps = 1e-9) {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - IDENTITY[i]) > eps) return false;
  return true;
}

/** Compare two column-major matrices; returns max abs component delta. */
export function matrixDelta(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

export function maxAbsDeltaVec(a, b) {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

/**
 * Rotation taking a source up-axis to the target up-axis, expressed as a
 * column-major matrix. Both stages are converted into the canonical glTF Y-up
 * frame, so the returned matrix is the *source-to-canonical* rotation.
 */
export function upAxisRotation(fromUp, toUp = 'Y') {
  if (!fromUp || fromUp === toUp) return IDENTITY.slice();
  const from = String(fromUp).toUpperCase();
  const to = String(toUp).toUpperCase();
  if (to !== 'Y') throw new Error(`unsupported target up axis ${toUp}`);
  // Z-up -> Y-up: rotate -90deg about X: (x, y, z) -> (x, z, -y).
  if (from === 'Z') return [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  if (from === 'Y') return IDENTITY.slice();
  throw new Error(`unsupported source up axis ${fromUp}`);
}

export function applyUpAxisToMatrix(m, fromUp) {
  const r = upAxisRotation(fromUp, 'Y');
  // world' = R * world ; local' = R * local * R^-1 for every node.
  return multiply(multiply(r, m), transposeUp(r));
}

export function transposeUp(r) {
  // Rotation matrices transpose by swapping the 3x3 block.
  return [
    r[0], r[4], r[8], 0,
    r[1], r[5], r[9], 0,
    r[2], r[6], r[10], 0,
    0, 0, 0, 1,
  ];
}

function assert16(m, where) {
  if (!Array.isArray(m) && !ArrayBuffer.isView(m)) throw new TypeError(`${where}: matrix must be an array`);
  if (m.length !== 16) throw new TypeError(`${where}: expected 16 elements, got ${m.length}`);
}
