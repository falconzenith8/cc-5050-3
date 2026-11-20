// Fixture generator for the declared glTF <-> USD subset.
//
// Produces the two real files the comparison UI loads, plus USDA authored by
// hand-shaped geometry (not by our own writer) so the round trip is exercised
// against an independent source. Each fixture intentionally contains:
//   - a parent with non-uniform scale (0.5 in Y) and a child that adds its own
//     non-uniform scale (0.4 in X): inherited scale is genuinely non-uniform;
//   - four placements of one shared mesh, one of them mirrored on X;
//   - a second shared mesh used by two placements (a sharing pair);
//   - a double-sided material and a material with inputs outside the subset so
//     the degradation path has real data.
//
// Run: node tools/build-scenes.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, multiply } from '../src/core/math.js';
import { createScene, createNode, createMesh, createMaterial, createInstanceSet } from '../src/core/scene.js';
import { writeGltf } from '../src/core/gltf.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'scenes');

// ---- geometry ------------------------------------------------------------

/** Axis-aligned box, 12 triangles, with per-face normals and unit UVs. */
function box({ sx = 2, sy = 1, sz = 1 } = {}) {
  const x = sx / 2;
  const y = sy / 2;
  const z = sz / 2;
  const faces = [
    // [normal, four corners ccw seen from outside]
    [[0, 0, -1], [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z]]],
    [[0, 0, 1], [[-x, -y, z], [-x, y, z], [x, y, z], [x, -y, z]]],
    [[-1, 0, 0], [[-x, -y, -z], [-x, y, -z], [-x, y, z], [-x, -y, z]]],
    [[1, 0, 0], [[x, -y, -z], [x, -y, z], [x, y, z], [x, y, -z]]],
    [[0, -1, 0], [[-x, -y, -z], [-x, -y, z], [x, -y, z], [x, -y, -z]]],
    [[0, 1, 0], [[-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z]]],
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const [n, quad] of faces) {
    const base = positions.length / 3;
    quad.forEach((c, k) => {
      positions.push(...c);
      normals.push(...n);
      uvs.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

/** Ground plane, 2 triangles, +Y normal, sized to the scene. */
function plane(size = 30) {
  return {
    positions: Float32Array.from([-size, 0, -size, size, 0, -size, size, 0, size, -size, 0, size]),
    normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

// ---- shared scene specification (one source of truth) --------------------

function buildScene({ upAxis = 'Y', metersPerUnit = 1 } = {}) {
  const scene = createScene({ name: 'exchange-fixture', upAxis: 'Y', metersPerUnit });

  // Authored frame is recorded, applied at export/load; nodes stay authored.
  scene.sourceUpAxis = upAxis;
  scene.sourceMetersPerUnit = metersPerUnit;

  const panelMat = createMaterial({ name: 'PanelRed', baseColorFactor: [0.85, 0.2, 0.2, 1], metallicFactor: 0.1, roughnessFactor: 0.4 });
  const groundMat = createMaterial({ name: 'GroundGreen', baseColorFactor: [0.2, 0.75, 0.3, 1], metallicFactor: 0.0, roughnessFactor: 0.8, doubleSided: true });
  const postMat = createMaterial({ name: 'PostBlue', baseColorFactor: [0.2, 0.35, 0.85, 1], metallicFactor: 0.2, roughnessFactor: 0.5 });
  // Declared-subset degradation: these inputs cannot be represented.
  postMat.degradedInputs = ['emissiveFactor', 'clearcoat'];
  scene.materials.push(panelMat, groundMat, postMat);

  const panel = createMesh({ name: 'Panel', ...box({ sx: 2, sy: 1, sz: 1 }), material: panelMat.id });
  panel.sourcePath = '/fixture/Panel';
  const ground = createMesh({ name: 'Ground', ...plane(12), material: groundMat.id });
  ground.sourcePath = '/fixture/Ground';
  const post = createMesh({ name: 'Post', ...box({ sx: 0.4, sy: 4, sz: 0.4 }), material: postMat.id });
  post.sourcePath = '/fixture/Post';
  scene.meshes.push(panel, ground, post);

  const root = createNode({ name: 'World' });
  root.sourcePath = '/World';
  const groundNode = createNode({ name: 'Ground' });
  groundNode.mesh = ground.id;
  groundNode.matrix = compose({ translation: [0, 0, 0] });
  groundNode.sourcePath = '/World/Ground';
  const assembly = createNode({ name: 'Assembly' });
  // Parent: non-uniform scale (0.5 on Y) and a z-offset.
  assembly.matrix = compose({ translation: [0, 1.5, 0], rotation: quatY(10), scale: [1, 0.5, 1] });
  assembly.sourcePath = '/World/Assembly';

  root.children.push(groundNode.id, assembly.id);
  groundNode.parent = root.id;
  assembly.parent = root.id;
  scene.nodes.push(root, groundNode, assembly);

  // Shared panel prototype placed four times. The rows keep the panel local
  // (identity here) relative to the prototype root; placements supply worlds.
  const panelSet = createInstanceSet({
    name: 'PanelInstances',
    mesh: panel.id,
    material: panelMat.id,
    rows: [{ mesh: panel.id, matrix: null, meshPath: '/_Prototypes/Panel/Panel' }],
    kind: 'instanceable',
    sourcePath: '/World/Assembly/Panel_0',
  });
  panelSet.prototypePath = '/_Prototypes/Panel';
  scene.instanceSets.push(panelSet);

  const placements = [
    { name: 'Panel_0', translation: [-3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: 'Panel_1', translation: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: 'Panel_2', translation: [0, 0, 3], rotation: quatY(35), scale: [1, 1, 1] },
    // Mirrored on X: negative determinant; must not silently vanish.
    { name: 'Panel_3', translation: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [-1, 1, 1] },
  ];
  for (const p of placements) {
    const node = createNode({ name: p.name });
    node.parent = assembly.id;
    node.sourcePath = `/World/Assembly/${p.name}`;
    node.matrix = compose(p);
    node.translation = p.translation;
    node.rotation = p.rotation;
    node.scale = p.scale;
    node.instanceOf = '/_Prototypes/Panel';
    node.instanceSetIds = [panelSet.id];
    node.sourcePrimType = 'instanceable';
    assembly.children.push(node.id);
    scene.nodes.push(node);
    panelSet.sourcePaths.push(node.sourcePath);
    if (determinantSign(multiply(node.matrix, panelSet.rows[0].matrix || identity()))) panelSet.mirroredCount++;
  }

  // Second shared mesh: two posts under a *child* with its own non-uniform
  // scale, so inherited scale is non-uniform in two axes.
  const postHolder = createNode({ name: 'Posts' });
  postHolder.parent = assembly.id;
  postHolder.sourcePath = '/World/Assembly/Posts';
  postHolder.matrix = compose({ translation: [0, 1, 5], scale: [0.4, 1, 1] });
  assembly.children.push(postHolder.id);
  scene.nodes.push(postHolder);

  const postSet = createInstanceSet({
    name: 'PostInstances',
    mesh: post.id,
    material: postMat.id,
    rows: [{ mesh: post.id, matrix: null, meshPath: '/_Prototypes/Post/Post' }],
    kind: 'instanceable',
    sourcePath: '/World/Assembly/Posts/Post_0',
  });
  postSet.prototypePath = '/_Prototypes/Post';
  scene.instanceSets.push(postSet);

  [
    { name: 'Post_0', translation: [-2, 0, 0] },
    { name: 'Post_1', translation: [2, 0, 0] },
  ].forEach((p) => {
    const node = createNode({ name: p.name });
    node.parent = postHolder.id;
    node.sourcePath = `/World/Assembly/Posts/${p.name}`;
    node.matrix = compose({ translation: p.translation });
    node.instanceOf = '/_Prototypes/Post';
    node.instanceSetIds = [postSet.id];
    node.sourcePrimType = 'instanceable';
    postHolder.children.push(node.id);
    scene.nodes.push(node);
    postSet.sourcePaths.push(node.sourcePath);
    if (determinantSign(node.matrix)) postSet.mirroredCount++;
  });

  return scene;
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function quatY(deg) {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}
function determinantSign(m) {
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  return det < 0 ? 1 : 0;
}

// ---- emit ---------------------------------------------------------------

const yUp = buildScene({ upAxis: 'Y', metersPerUnit: 1 });
// The shipped glTF fixture stays plainly single-sided: the mirrored panel is
// the real failure case the conversion has to mitigate and report.
const { json: yJson } = writeGltf(yUp, { mirrorMitigation: false });
writeFileSync(join(outDir, 'exchange.gltf'), JSON.stringify(yJson, null, 2));

// A Z-up centimetre variant exercises the frame conversion. The IR keeps
// authored locals; only the declared stage frame changes.
const zUp = buildScene({ upAxis: 'Z', metersPerUnit: 0.01 });
zUp.sourceUpAxis = 'Z';
zUp.sourceMetersPerUnit = 0.01;
writeFileSync(join(outDir, 'exchange-zup.usda'), zUpUsda(zUp));
writeFileSync(join(outDir, 'exchange-yup.usda'), yUpUsda(yUp));

console.log('wrote scenes/exchange.gltf, scenes/exchange-yup.usda, scenes/exchange-zup.usda');

// Independent USDA authoring (not via usda-writer): explicit class prototype
// library after the default prim, instanceable placement prims, and a
// PointInstancer host for the posts to cover both USD instance forms.
function yUpUsda() {
  return usdaText({ upAxis: 'Y', metersPerUnit: 1, zUp: false });
}
function zUpUsda() {
  return usdaText({ upAxis: 'Z', metersPerUnit: 0.01, zUp: true });
}

function usdaText({ upAxis, metersPerUnit, zUp }) {
  const panel = box({ sx: 2, sy: 1, sz: 1 });
  const post = box({ sx: 0.4, sy: 4, sz: 0.4 });
  const g = plane(12);
  const fmtM = (m) => {
    const r = (i) => [m[i * 4], m[i * 4 + 1], m[i * 4 + 2], m[i * 4 + 3]].map(num).join(', ');
    return `((${r(0)}), (${r(1)}), (${r(2)}), (${r(3)}))`;
  };
  // Authored coordinates equal the glTF ones; stage metadata declares the frame.
  const assembly = compose({ translation: [0, 1.5, 0], rotation: quatY(10), scale: [1, 0.5, 1] });
  const postHolder = compose({ translation: [0, 1, 5], scale: [0.4, 1, 1] });
  const p3 = compose({ translation: [0, 0, -3], scale: [-1, 1, 1] });
  const p2 = compose({ translation: [0, 0, 3], rotation: quatY(35) });

  const mesh = (name, geo, mat, pad) => [
    `${pad}def Mesh "${name}"`,
    `${pad}{`,
    `${pad}    int[] faceVertexCounts = [${'3, '.repeat(geo.indices.length / 3 - 1)}3]`,
    `${pad}    int[] faceVertexIndices = [${Array.from(geo.indices).join(', ')}]`,
    `${pad}    point3f[] points = [${points(geo.positions)}]`,
    `${pad}    normal3f[] normals = [${points(geo.normals)}] (`,
    `${pad}        interpolation = "vertex"`,
    `${pad}    )`,
    `${pad}    texCoord2f[] primvars:st = [${uvs(geo.uvs)}] (`,
    `${pad}        interpolation = "vertex"`,
    `${pad}    )`,
    mat.doubleSided ? `${pad}    uniform bool doubleSided = 1` : '',
    `${pad}    rel material:binding = </${mat.path}>`,
    material(mat.path, mat.name, mat.color, mat.metal, mat.rough, mat.doubleSided, `${pad}    `, mat.emissive),
    `${pad}}`,
  ].filter(Boolean).join('\n');

  // A Z-up centimetre authoring of the same scene places the whole Y-up metre
  // content at C = S(100) * R(Z->Y)^-1, i.e. (x, y, z) -> (100x, -100z, 100y).
  // Stage-space coordinates are then real Z-up centimetres; a correct reader
  // applies F = S(0.01) * R(Z->Y) to get the identical Y-up metre world back.
  // (Using R instead of R^-1 here would leave a 180-degree X rotation.)
  const toZUpCm = [
    100, 0, 0, 0,
    0, 0, 100, 0,
    0, -100, 0, 0,
    0, 0, 0, 1,
  ];

  const lines = [];
  lines.push('#usda 1.0');
  lines.push('(');
  lines.push(`    defaultPrim = "World"`);
  lines.push(`    metersPerUnit = ${num(metersPerUnit)}`);
  lines.push(`    upAxis = "${upAxis}"`);
  lines.push(')');
  lines.push('');
  lines.push('def Xform "World"');
  lines.push('{');
  if (zUp) {
    lines.push(`    matrix4d xformOp:transform = ${fmtM(toZUpCm)}`);
    lines.push('    uniform token[] xformOpOrder = ["xformOp:transform"]');
  }
  lines.push('    def Mesh "Ground"');
  lines.push('    {');
  lines.push(`        int[] faceVertexCounts = [3, 3]`);
  lines.push(`        int[] faceVertexIndices = [${Array.from(g.indices).join(', ')}]`);
  lines.push(`        point3f[] points = [${points(g.positions)}]`);
  lines.push(`        normal3f[] normals = [${points(g.normals)}] (`);
  lines.push('            interpolation = "vertex"');
  lines.push('        )');
  lines.push(`        rel material:binding = </World/Ground/GroundMat>`);
  lines.push('        uniform bool doubleSided = 1');
  lines.push(material('World/Ground/GroundMat', 'GroundMat', [0.2, 0.75, 0.3], 0.0, 0.8, true, '        '));
  lines.push('    }');
  lines.push('');
  lines.push('    def Xform "Assembly"');
  lines.push('    {');
  lines.push(`        matrix4d xformOp:transform = ${fmtM(assembly)}`);
  lines.push('        uniform token[] xformOpOrder = ["xformOp:transform"]');
  lines.push('        def Xform "Panel_0" (');
  lines.push('            instanceable = true');
  lines.push('            prepend references = </_Prototypes/Panel>');
  lines.push('        )');
  lines.push('        {');
  lines.push(`            matrix4d xformOp:transform = ${fmtM(compose({ translation: [-3, 0, 0] }))}`);
  lines.push('            uniform token[] xformOpOrder = ["xformOp:transform"]');
  lines.push('        }');
  lines.push('        def Xform "Panel_1" (');
  lines.push('            instanceable = true');
  lines.push('            prepend references = </_Prototypes/Panel>');
  lines.push('        )');
  lines.push('        {');
  lines.push(`            matrix4d xformOp:transform = ${fmtM(compose({ translation: [3, 0, 0] }))}`);
  lines.push('            uniform token[] xformOpOrder = ["xformOp:transform"]');
  lines.push('        }');
  lines.push('        def Xform "Panel_2" (');
  lines.push('            instanceable = true');
  lines.push('            prepend references = </_Prototypes/Panel>');
  lines.push('        )');
  lines.push('        {');
  lines.push(`            matrix4d xformOp:transform = ${fmtM(p2)}`);
  lines.push('            uniform token[] xformOpOrder = ["xformOp:transform"]');
  lines.push('        }');
  lines.push('        def Xform "Panel_3" (');
  lines.push('            instanceable = true');
  lines.push('            prepend references = </_Prototypes/Panel>');
  lines.push('        )');
  lines.push('        {');
  lines.push(`            matrix4d xformOp:transform = ${fmtM(p3)}`);
  lines.push('            uniform token[] xformOpOrder = ["xformOp:transform"]');
  lines.push('        }');
  lines.push('        def Xform "Posts"');
  lines.push('        {');
  lines.push(`            matrix4d xformOp:transform = ${fmtM(postHolder)}`);
  lines.push('            uniform token[] xformOpOrder = ["xformOp:transform"]');
  lines.push('            def PointInstancer "PostInstances"');
  lines.push('            {');
  lines.push('                int[] protoIndices = [0, 0]');
  lines.push('                prepend rel prototypes = </_Prototypes/Post>');
  lines.push('                point3f[] positions = [(-2, 0, 0), (2, 0, 0)]');
  lines.push('                quatf[] orientations = [(0, 0, 0, 1), (0, 0, 0, 1)]');
  lines.push('                float3[] scales = [(1, 1, 1), (1, 1, 1)]');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push('class Xform "_Prototypes"');
  lines.push('{');
  lines.push('    class Xform "Panel"');
  lines.push('    {');
  lines.push(mesh('Panel', panel, { path: '_Prototypes/Panel/PanelMat', name: 'PanelMat', color: [0.85, 0.2, 0.2], metal: 0.1, rough: 0.4, doubleSided: false }, '        '));
  lines.push('    }');
  lines.push('');
  lines.push('    class Xform "Post"');
  lines.push('    {');
  lines.push(mesh('Post', post, { path: '_Prototypes/Post/PostMat', name: 'PostMat', color: [0.2, 0.35, 0.85], metal: 0.2, rough: 0.5, doubleSided: false, emissive: [1, 0.4, 0] }, '        '));
  lines.push('    }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function material(path, name, color, metal, rough, doubleSided, pad = '            ', emissive = null) {
  const mp = `/${path}`;
  return [
    `${pad}def Material "${name}"`,
    `${pad}{`,
    `${pad}    token outputs:surface.connect = <${mp}/Surface.outputs:surface>`,
    `${pad}    def Shader "Surface"`,
    `${pad}    {`,
    `${pad}        uniform token info:id = "UsdPreviewSurface"`,
    `${pad}        color3f inputs:diffuseColor = (${color.map(num).join(', ')})`,
    `${pad}        float inputs:metallic = ${num(metal)}`,
    `${pad}        float inputs:roughness = ${num(rough)}`,
    ...(emissive ? [`${pad}        color3f inputs:emissiveColor = (${emissive.map(num).join(', ')})`] : []),
    `${pad}        token outputs:surface`,
    `${pad}    }`,
    `${pad}}`,
  ].filter((l) => l !== '').join('\n');
}

function points(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 3) out.push(`(${num(arr[i])}, ${num(arr[i + 1])}, ${num(arr[i + 2])})`);
  return out.join(', ');
}
function uvs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 2) out.push(`(${num(arr[i])}, ${num(arr[i + 1])})`);
  return out.join(', ');
}
function num(v) {
  const r = Math.round(v * 1e7) / 1e7;
  return Object.is(r, -0) ? '0' : String(r);
}
