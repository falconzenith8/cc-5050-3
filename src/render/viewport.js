// Per-loader viewport: three.js renderer, OrbitControls, reference grid.
//
// The viewport is deliberately minimal: it shows exactly the object returned by
// the real loader, with no axis/unit fixups layered on top. Any difference in
// orientation or position between panels is the loader's own interpretation of
// the file and is reported as such.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeObject } from './loaders.js';

export function createViewport(container, { label = '' } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x0e1116, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  camera.position.set(6, 6, 9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 1.6);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(5, 10, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-6, 4, -5);
  scene.add(fill);

  const grid = new THREE.GridHelper(20, 20, 0x2a3340, 0x1b222b);
  scene.add(grid);
  const axes = new THREE.AxesHelper(2);
  scene.add(axes);

  let current = null;
  let raf = 0;

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function frameObject(object, { padding = 1.4 } = {}) {
    applyCameraState(cameraStateFor(object, { padding }));
  }

  /**
   * Camera state fitted to `object`, so it can be applied to other panels.
   * Framing both panels from the reference scene (rather than each panel's own
   * content) is what makes the two views comparable: a panel that renders less
   * cannot appear "correctly framed".
   */
  function cameraStateFor(objects, { padding = 1.25 } = {}) {
    const list = Array.isArray(objects) ? objects : [objects];
    const box = new THREE.Box3();
    let any = false;
    for (const o of list) {
      if (!o) continue;
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) continue;
      box.union(b);
      any = true;
    }
    if (!any) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 1e-3) * padding;
    const position = center.clone().add(new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(radius * 2.4));
    return { position: position.toArray(), target: center.toArray(), near: Math.max(radius / 500, 0.01), far: radius * 50, radius };
  }

  function applyCameraState(s) {
    if (!s) return;
    camera.position.fromArray(s.position);
    controls.target.fromArray(s.target);
    camera.near = s.near;
    camera.far = s.far;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function setObject(object, { frame = true } = {}) {
    if (current) { scene.remove(current); disposeObject(current); }
    current = object;
    if (object) scene.add(object);
    if (object && frame) frameObject(object);
  }

  function tick() {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener('resize', resize);
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  tick();

  return {
    label,
    camera,
    controls,
    scene,
    renderer,
    setObject,
    frameObject,
    cameraStateFor,
    applyCameraState,
    /** Screenshot as a data URL (used by the export and e2e evidence). */
    snapshot() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', resize);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    },
  };
}
