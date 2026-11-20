// Real-loader scene builders.
//
// Each builder takes the *bytes of a real file* and returns a THREE.Group
// rendered by an actual third-party loader:
//   - glTF: three.js GLTFLoader (parses EXT_mesh_gpu_instancing into InstancedMesh)
//   - USD:  lightusd (WASM) and @openusd-wasm/three-loader (pxr WASM bindings)
//
// The builders also return measured facts (draw counts, per-instance world
// positions, visible triangles in the resulting THREE.Scene) so the UI and the
// e2e test can compare what each loader actually rasterises, rather than trust
// our own IR.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let lightusdPromise = null;
async function lightusd() {
  if (!lightusdPromise) {
    lightusdPromise = import('lightusd').then(async (mod) => {
      const loader = new mod.LightUSDLoader();
      await loader.init();
      return { ...mod, loader };
    });
  }
  return lightusdPromise;
}

let openusdPromise = null;
async function openusd() {
  if (!openusdPromise) openusdPromise = import('@openusd-wasm/three-loader');
  return openusdPromise;
}

/**
 * @param {'gltf'|'usd-lightusd'|'usd-openusd'} loaderId
 * @param {{text?: string, json?: object, name: string}} file
 */
export async function buildWith(loaderId, file) {
  if (loaderId === 'gltf') return buildGltf(file);
  if (loaderId === 'usd-lightusd') return buildLightusd(file);
  if (loaderId === 'usd-openusd') return buildOpenusd(file);
  throw new Error(`unknown loader ${loaderId}`);
}

async function buildGltf(file) {
  const loader = new GLTFLoader();
  const json = file.json || JSON.parse(file.text);
  const gltf = await loader.parseAsync(JSON.stringify(json), '');
  return finish(gltf.scene, {
    loader: 'three.js GLTFLoader',
    loaderVersion: THREE.REVISION ? `three r${THREE.REVISION}` : 'three',
    object: gltf,
  });
}

async function buildLightusd(file) {
  const { loader, LightUSDLoaderUtils } = await lightusd();
  const usdScene = await loader.loadAsync(file.url, { backend: 'next' });
  const root = await LightUSDLoaderUtils.buildThreeNode(
    usdScene.getDefaultRootNode(),
    LightUSDLoaderUtils.createDefaultMaterial(),
    usdScene,
    { yieldMode: 'none', overrideMaterial: false },
  );
  const group = new THREE.Group();
  group.name = 'lightusd-root';
  group.add(root);
  return finish(group, { loader: 'lightusd', loaderVersion: '1.0.0 (WASM)', usdScene });
}

async function buildOpenusd(file) {
  const { USDLoader } = await openusd();
  const loader = new USDLoader();
  // Z-up stages are converted here so both USD loaders share one convention.
  const model = await loader.parseAsync(file.text, {
    fileName: file.name || 'scene.usda',
    convertZUp: true,
    loadTextures: false,
  });
  return finish(model.scene, { loader: '@openusd-wasm/three-loader', loaderVersion: '0.0.17 (pxr WASM)', model });
}

/** Collect measured facts from a real THREE scene. */
function finish(object, meta) {
  object.updateMatrixWorld(true);
  const meshes = [];
  const instancePositions = [];
  const placements = [];
  let drawCalls = 0;
  let trianglesDrawn = 0;
  const meshNames = new Map();

  object.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    drawCalls++;
    const geom = o.geometry;
    const posAttr = geom?.attributes?.position;
    const triCount = posAttr ? (geom.index ? geom.index.count : posAttr.count) / 3 : 0;
    const instanced = Number(o.count || 1);
    trianglesDrawn += triCount * instanced;
    const worldPos = o.getWorldPosition(new THREE.Vector3()).toArray();
    if (o.isInstancedMesh) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        p.applyMatrix4(new THREE.Matrix4().copy(o.matrixWorld));
        instancePositions.push(p.toArray());
      }
    } else if (!(o.parent && o.parent.isInstancedMesh)) {
      // A plain Mesh is one placement. A loader that expands instances emits
      // one Mesh per placement, so the mesh's own world position is the
      // placement position; this keeps the count comparable across loaders
      // that use InstancedMesh and loaders that do not.
      placements.push({ name: o.name || '(unnamed)', position: worldPos });
    }
    meshNames.set(o.name || '(unnamed)', (meshNames.get(o.name || '(unnamed)') || 0) + 1);
    meshes.push({
      name: o.name || '(unnamed)',
      path: o.userData?.usd?.path || null,
      instanced,
      triangles: triCount * instanced,
      worldPosition: worldPos,
    });
  });

  const placementPositions = instancePositions.length ? instancePositions : placements.map((p) => p.position);

  return {
    object,
    limitNotes: LOADER_LIMITS[meta.loader] || [],
    facts: {
      ...meta,
      drawCalls,
      trianglesDrawn,
      meshes,
      instancePositions,
      placements,
      placementPositions,
      meshNameCounts: Object.fromEntries(meshNames),
      samePosition: samePositions(placementPositions),
      stageFrame: stageFrameOf(meta),
    },
  };
}

/**
 * Stage frame a USD loader reported, in the form {upAxis, metersPerUnit}.
 * Neither loader transforms the scene to Y-up metres; they only expose the
 * metadata, so the caller can decide how to present it.
 */
function stageFrameOf(meta) {
  const usdScene = meta.usdScene;
  if (usdScene?.sceneMetadata) {
    return { upAxis: usdScene.sceneMetadata.upAxis || 'Y', metersPerUnit: usdScene.sceneMetadata.metersPerUnit ?? 1 };
  }
  const stage = meta.model?.data?.stage;
  if (stage) return { upAxis: stage.upAxis || 'Y', metersPerUnit: stage.metersPerUnit ?? 1 };
  return null;
}

function samePositions(points, tol = 1e-4) {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (points[i].every((v, k) => Math.abs(v - points[j][k]) <= tol)) return [points[i], points[j]];
    }
  }
  return null;
}

/**
 * Loader limitations observed while building this project. They are reported
 * in the UI so a difference between panels is attributed to the loader, not
 * silently claimed as a conversion error.
 */
export const LOADER_LIMITS = {
  'three.js GLTFLoader': [
    'EXT_mesh_gpu_instancing becomes one InstancedMesh; three.js does not flip winding per instance, so a mirrored instance can be back-face culled.',
  ],
  lightusd: [
    'Draws only the first placement of each instanceable prototype in this build (measured: 1 of 4 panels, 1 of 2 posts). The remaining placements are composed by OpenUSD but never reach the three.js mesh.',
    'Does not expand PointInstancer into individual meshes.',
  ],
  '@openusd-wasm/three-loader': [
    'Expands instanceable prims at their correct world positions (measured: all 4 panels and both posts), so it is the default target loader.',
    'Does not render PointInstancer instances; the studio sample uses instanceable placement prims precisely so the geometry is visible here.',
  ],
};

export function disposeObject(object) {
  object.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) m.dispose?.();
  });
}
