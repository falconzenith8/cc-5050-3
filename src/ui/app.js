// Graphical entry point for scene exchange.
//
// Every panel is driven by real data: the hierarchy and reuse tables come from
// the parsed files (via src/core/serialize.js), the viewports from the actual
// third-party loaders (src/render/loaders.js), and the results area from the
// diff computed on the re-read output file. There is no fixture data in this
// module — pressing "Convert & compare" runs src/core/exchange.js.

import * as THREE from 'three';
import { exchange } from '../core/exchange.js';
import { createViewport } from '../render/viewport.js';
import { buildWith, disposeObject, LOADER_LIMITS } from '../render/loaders.js';

const SCENE_FILES = {
  gltf: [
    { label: 'exchange.gltf', url: '/scenes/exchange.gltf', name: 'exchange.gltf' },
  ],
  usda: [
    { label: 'exchange-yup.usda (Y-up, m)', url: '/scenes/exchange-yup.usda', name: 'exchange-yup.usda' },
    { label: 'exchange-zup.usda (Z-up, cm)', url: '/scenes/exchange-zup.usda', name: 'exchange-zup.usda' },
  ],
};

const LOADERS_FOR = {
  gltf: ['gltf'],
  usda: ['usd-lightusd', 'usd-openusd'],
};

const LOADER_LABELS = {
  gltf: 'three.js GLTFLoader',
  'usd-lightusd': 'lightusd (WASM)',
  'usd-openusd': '@openusd-wasm/three-loader',
};

const $ = (sel) => document.querySelector(sel);

const state = {
  sourceFormat: 'gltf',
  file: null,
  sourceFrame: 'Y',
  result: null,
  views: {},
  loaderSel: { src: null, tgt: null },
  selectedNode: null,
  loading: false,
};

const tree = { source: $('#source-tree'), target: $('#target-tree') };

// ---- bootstrap -----------------------------------------------------------

$('#source-format').addEventListener('change', () => {
  state.sourceFormat = $('#source-format').value;
  populateFiles();
  refreshLoaderButtons();
});

$('#source-file').addEventListener('change', () => {
  const opts = SCENE_FILES[state.sourceFormat];
  state.file = opts[Number($('#source-file').value)] || opts[0];
});

$('#source-frame').addEventListener('change', () => {
  state.sourceFrame = $('#source-frame').value;
});

$('#convert').addEventListener('click', runExchange);
$('#download').addEventListener('click', downloadOutputs);

function populateFiles() {
  const sel = $('#source-file');
  sel.innerHTML = '';
  SCENE_FILES[state.sourceFormat].forEach((f, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = f.label;
    sel.appendChild(o);
  });
  state.file = SCENE_FILES[state.sourceFormat][0];
  $('#gltf-frame').hidden = state.sourceFormat !== 'gltf';
  $('#zup-export').hidden = state.sourceFormat === 'gltf';
  $('#source-frame').value = 'Y';
}

function refreshLoaderButtons() {
  for (const side of ['src', 'tgt']) {
    const host = document.getElementById(side === 'src' ? 'loader-buttons' : 'loader-buttons-2');
    host.innerHTML = '';
    if (!state.result) continue;
    const format = side === 'src' ? state.result.sourceFormat : state.result.targetFormat;
    const options = format === 'gltf' ? ['gltf'] : LOADERS_FOR.usda;
    if (!options.includes(state.loaderSel[side])) state.loaderSel[side] = options[0];
    for (const id of options) {
      const b = document.createElement('button');
      b.textContent = LOADER_LABELS[id];
      b.className = state.loaderSel[side] === id ? 'active' : '';
      b.addEventListener('click', async () => {
        state.loaderSel[side] = id;
        refreshLoaderButtons();
        await renderSide(side);
      });
      host.appendChild(b);
    }
  }
}

// ---- exchange ------------------------------------------------------------

async function runExchange() {
  if (state.loading) return;
  state.loading = true;
  setStatus('reading source file…');
  try {
    const file = await loadFile(state.file);
    const result = exchange(state.sourceFormat, file, {
      sourceUpAxis: state.sourceFrame,
      sourceMetersPerUnit: state.sourceFrame === 'Z' ? 0.01 : 1,
      targetUpAxis: $('#target-zup').checked ? 'Z' : 'Y',
      targetMetersPerUnit: $('#target-zup').checked ? 0.01 : 1,
    });
    state.result = result;
    state.sourceFileText = file.text;

    $('#source-tag').textContent = `${file.name}`;
    $('#target-tag').textContent = result.targetFormat === 'gltf' ? 'converted.gltf' : 'converted.usda';

    // Both panels default to the loader that draws instances faithfully in
    // this build (measured: openusd expands instanceable placements, lightusd
    // does not). Both remain selectable so the lightusd limitation can be
    // inspected; the independent loader check reports what each one drew.
    state.loaderSel.src = state.sourceFormat === 'gltf' ? 'gltf' : 'usd-openusd';
    state.loaderSel.tgt = result.targetFormat === 'gltf' ? 'gltf' : 'usd-openusd';
    refreshLoaderButtons();

    renderTree('source', result.sourceSerialized);
    renderTree('target', result.targetSerialized);
    renderReuse(result.sourceSerialized, result.targetSerialized);
    renderMaterials(result.sourceSerialized);
    renderResults(result);

    $('#download').disabled = false;
    setStatus('loading real loaders…');
    await Promise.all([renderSide('src'), renderSide('tgt')]);
    // Frame both panels from the union of what each loader actually built, so
    // neither panel's rendering limit decides the camera on its own.
    if (state.views.srcObject || state.views.tgtObject) {
      const shared = getViewport('src').cameraStateFor([state.views.srcObject, state.views.tgtObject]);
      if (shared) {
        getViewport('src').applyCameraState(shared);
        getViewport('tgt').applyCameraState(shared);
      }
    }
    renderLoaderCheck();
    setStatus(`done · ${result.comparison.verdict.ok ? 'verdict: match' : 'verdict: differences found'}`);
  } catch (err) {
    console.error(err);
    setStatus(`error: ${err.message}`);
    $('#verdict').textContent = 'error';
    $('#verdict').className = 'verdict bad';
  } finally {
    state.loading = false;
  }
}

async function loadFile(f) {
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`cannot fetch ${f.url}: ${res.status}`);
  const text = await res.text();
  return { text, name: f.name, url: f.url };
}

// ---- viewports -----------------------------------------------------------

function getViewport(side) {
  const key = side === 'src' ? 'viewport' : 'viewport-2';
  if (!state.views[key]) {
    state.views[key] = createViewport(document.getElementById(key), { label: side });
  }
  return state.views[key];
}

async function renderSide(side) {
  if (!state.result) return;
  const format = side === 'src' ? state.result.sourceFormat : state.result.targetFormat;
  const loaderId = state.loaderSel[side];
  const vp = getViewport(side);
  const title = document.getElementById(side === 'src' ? 'vp-title' : 'vp2-title');
  title.textContent = `${side === 'src' ? 'Source' : 'Target'} · ${LOADER_LABELS[loaderId]}`;

  let file;
  if (side === 'src') {
    file = { text: state.sourceFileText, name: state.file.name, url: state.file.url, json: format === 'gltf' ? JSON.parse(state.sourceFileText) : undefined };
  } else {
    file = { text: state.result.targetText, name: format === 'gltf' ? 'converted.gltf' : 'converted.usda', url: blobUrl(side + ':' + state.result.targetText) };
    if (format === 'gltf') file.json = state.result.targetJson;
  }

  setStatus(`building ${side} with ${LOADER_LABELS[loaderId]}…`);
  try {
    if (side === 'src' && state.views.srcObject) disposeObject(state.views.srcObject);
    if (side === 'tgt' && state.views.tgtObject) disposeObject(state.views.tgtObject);
    const built = await buildWith(loaderId, file);
    // The USD loaders do not apply the stage up-axis or metersPerUnit (measured:
    // Z-up cm content arrives with Z-up cm coordinates in both). Wrapping it in
    // the canonical frame fix here, and reporting it, keeps the two panels
    // comparable; it is a declared presentation step, not a silent correction.
    const implicit = implicitFrameFix(built, format, loaderId);
    const shown = implicit ? implicit.object : built.object;
    vp.setObject(shown, { frame: true });
    state.views[side === 'src' ? 'srcObject' : 'tgtObject'] = shown;
    vp.limitNotes = built.limitNotes;
    let facts = built.facts;
    if (implicit) {
      // Re-measure positions after the presentation fix so the audit compares
      // canonical world positions, not raw stage-space ones.
      facts = { ...facts, ...rebasePositions(shown, implicit.matrix), implicitFix: implicit.label };
    }
    renderLoaderFacts(side, facts, built.limitNotes);
    state.views[side + 'facts'] = facts;
    if (state.result) renderLoaderCheck();
  } catch (err) {
    console.error(err);
    const wrap = vp.renderer.domElement.parentElement;
    let note = document.getElementById(`${side}-err`);
    if (!note) {
      note = document.createElement('div');
      note.id = `${side}-err`;
      note.className = 'loader-note';
      wrap.parentElement.appendChild(note);
    }
    note.innerHTML = `<strong>${LOADER_LABELS[loaderId]} failed:</strong> ${escapeHtml(err.message)}`;
    setStatus(`${LOADER_LABELS[loaderId]} failed: ${err.message}`);
  }
}

const blobUrls = new Map();
/**
 * USD loaders return stage-space geometry: they read upAxis/metersPerUnit into
 * metadata but do not transform the scene. If a loader reports Z-up or a
 * non-metre unit, wrap its object in F = S(unit) * R(Z->Y) so the panel shows
 * canonical Y-up metres, the same frame the comparison reasons in. glTF is
 * already converted by the exchange writer, so it is never wrapped.
 */
/**
 * What each loader already does with the stage frame, measured in this build:
 *   - three.js GLTFLoader: the exchange writer already baked Y-up metres in.
 *   - @openusd-wasm: passes convertZUp:true, so it rotates Z->Y, but its
 *     USDStageInfo has no metersPerUnit and it never scales.
 *   - lightusd: builds stage-space geometry as authored; it applies neither
 *     the up-axis rotation nor the unit scale.
 * The presentation wrapper below applies only the missing parts, so a panel is
 * not double-rotated. It is reported in the panel and never affects the file
 * verdict, which is computed by re-reading the written files.
 */
const FRAME_APPLIED = {
  gltf: { axis: true, unit: true },
  'usd-openusd': { axis: true, unit: false },
  'usd-lightusd': { axis: false, unit: false },
};

function implicitFrameFix(built, format, loaderId) {
  const applied = FRAME_APPLIED[loaderId];
  if (!applied) return null;
  const frame = built.facts?.stageFrame;
  // @openusd-wasm's USDStageInfo omits metersPerUnit; use the value the
  // exchange parsed from the file instead of its default 1.
  const parsedUnits = state.result?.report?.units?.sourceMetersPerUnit;
  const upAxis = String(frame?.upAxis || state.result?.report?.axis?.sourceUpAxis || 'Y').toUpperCase();
  const unit = Number(frame?.metersPerUnit && frame.metersPerUnit !== 1 ? frame.metersPerUnit : (parsedUnits ?? frame?.metersPerUnit ?? 1));

  const needAxis = upAxis === 'Z' && !applied.axis;
  const needUnit = unit !== 1 && !applied.unit;
  if (!needAxis && !needUnit) return null;

  const fix = new THREE.Matrix4();
  if (needUnit) fix.makeScale(unit, unit, unit);
  if (needAxis) {
    // Z-up -> Y-up: (x, y, z) -> (x, z, -y).
    const rot = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
    fix.multiply(rot);
  }
  const wrapper = new THREE.Group();
  wrapper.name = 'frame-fix';
  wrapper.applyMatrix4(fix);
  wrapper.add(built.object);
  wrapper.updateMatrixWorld(true);
  const parts = [needAxis ? `${upAxis}-up -> Y-up` : null, needUnit ? `${unit} m/unit -> metres` : null].filter(Boolean);
  return {
    object: wrapper,
    matrix: fix,
    label: `${parts.join(', ')} applied for display; ${LOADER_LABELS[loaderId]} did not do it`,
  };
}

/** Re-read placement world positions from a scene after a frame fix. */
function rebasePositions(root, fix) {
  const THREE_v = new THREE.Vector3();
  const instPos = [];
  const placements = [];
  root.traverse((o) => {
    if (o.isInstancedMesh) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        const p = new THREE_v.setFromMatrixPosition(m).applyMatrix4(o.matrixWorld).toArray();
        instPos.push(p);
      }
    } else if (o.isMesh && !(o.parent && o.parent.isInstancedMesh)) {
      placements.push({ name: o.name, position: o.getWorldPosition(new THREE.Vector3()).toArray() });
    }
  });
  return {
    instancePositions: instPos,
    placements,
    placementPositions: instPos.length ? instPos : placements.map((p) => p.position),
  };
}

function blobUrl(key) {
  if (blobUrls.has(key)) return blobUrls.get(key);
  const text = key.slice(key.indexOf(':') + 1);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  blobUrls.set(key, url);
  return url;
}

function renderLoaderFacts(side, facts, notes) {
  const id = `${side}-facts`;
  const host = document.getElementById(side === 'src' ? 'viewport' : 'viewport-2').parentElement;
  let panel = document.getElementById(id);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = id;
    panel.className = 'loader-note';
    host.appendChild(panel);
  }
  const inst = facts.instancePositions.length
    ? { label: 'instance positions', list: facts.instancePositions }
    : { label: 'mesh placements', list: facts.placementPositions };
  const positions = inst.list.slice(0, 8).map((p) => `(${p.map((v) => v.toFixed(2)).join(', ')})`);
  panel.innerHTML = `
    <div class="loader-facts">
      ${facts.loader} ${facts.loaderVersion}<br/>
      draw calls ${facts.drawCalls} · triangles ${facts.trianglesDrawn}
      ${inst.list.length ? `<br/>${inst.label} ${inst.list.length}: ${positions.join(' ')}${inst.list.length > 8 ? ' …' : ''}` : ''}
      ${facts.implicitFix ? `<br/><span class="warn">view frame: ${escapeHtml(facts.implicitFix)}</span>` : ''}
      ${facts.samePosition ? `<br/><span class="warn">two placements share one position — inspect placement</span>` : ''}
    </div>
    ${notes && notes.length ? `<div><strong>loader limits:</strong> ${notes.map(escapeHtml).join(' · ')}</div>` : ''}
  `;
}

// ---- hierarchy -----------------------------------------------------------

function renderTree(side, data) {
  const host = tree[side];
  host.innerHTML = '';
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  for (const n of data.nodes) {
    const p = n.parent ?? '__root__';
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  const roots = childrenOf.get('__root__') || data.nodes.filter((n) => n.parent === null);
  const wrap = document.createElement('div');
  for (const r of roots) wrap.appendChild(treeRow(r, childrenOf, data, side));
  host.appendChild(wrap);
  if (!roots.length) host.innerHTML = '<p class="muted">no nodes</p>';
  void byId;
}

function treeRow(node, childrenOf, data, side) {
  const el = document.createElement('div');
  el.className = 'node';
  const kids = childrenOf.get(node.id) || [];
  const row = document.createElement('div');
  row.className = 'node-row';
  row.dataset.path = node.path;

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = kids.length ? '▾' : '·';
  row.appendChild(twisty);

  const name = document.createElement('span');
  name.className = 'node-name';
  name.textContent = node.name;
  name.title = node.path;
  row.appendChild(name);

  const badges = [];
  if (node.instanceOf) badges.push(['instance', 'instance']);
  if (node.instanceSetIds?.length && !node.instanceOf) badges.push(['point', 'instances']);
  if (node.meshName) badges.push(['mesh', `mesh:${node.meshName}`]);
  if (node.mirrored) badges.push(['mirror', 'mirror']);
  for (const [cls, text] of badges) {
    const b = document.createElement('span');
    b.className = `badge ${cls}`;
    b.textContent = text;
    row.appendChild(b);
  }

  const meta = document.createElement('span');
  meta.className = 'node-meta';
  meta.textContent = `${fmtVec(node.worldPosition)}${node.triangles ? `  ${node.triangles}△` : ''}`;
  row.appendChild(meta);

  row.addEventListener('click', () => selectNode(row, node));

  el.appendChild(row);
  if (kids.length) {
    const box = document.createElement('div');
    box.className = 'children';
    for (const k of kids) box.appendChild(treeRow(k, childrenOf, data, side));
    el.appendChild(box);
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      box.hidden = !box.hidden;
      twisty.textContent = box.hidden ? '▸' : '▾';
    });
  }
  return el;
}

function selectNode(row, node) {
  document.querySelectorAll('.node-row.selected').forEach((r) => r.classList.remove('selected'));
  row.classList.add('selected');
  state.selectedNode = node;
  setStatus(`${node.path} · local→world ${fmtVec(node.worldPosition)} · mesh ${node.meshName || '—'} · ${node.sourcePrimType || 'node'}`);
}

// ---- reuse & materials ---------------------------------------------------

function renderReuse(src, tgt) {
  const host = $('#source-reuse');
  host.innerHTML = '';
  host.appendChild(reuseTable('source', src));
  host.appendChild(reuseTable('target', tgt));
}

function reuseTable(label, data) {
  const box = document.createElement('div');
  const shared = data.reuse.filter((r) => r.draws > 0);
  const totalDraws = shared.reduce((s, r) => s + r.draws, 0);
  const unique = shared.length;
  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="k">${label} draws</div><div class="v">${totalDraws}</div></div>
      <div class="stat"><div class="k">distinct meshes</div><div class="v">${unique}</div></div>
      <div class="stat"><div class="k">expansion factor</div><div class="v">${unique ? (totalDraws / unique).toFixed(2) : '0'}</div></div>
      <div class="stat"><div class="k">instance sets</div><div class="v">${data.instanceSets.length}</div></div>
    </div>
    <table>
      <thead><tr><th>mesh</th><th class="num">draws</th><th class="num">verts</th><th class="num">tris</th><th>shared</th></tr></thead>
      <tbody>
        ${shared.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.draws}</td><td class="num">${r.vertices}</td><td class="num">${r.triangles}</td><td>${r.shared ? '<span class="badge instance">shared</span>' : '—'}</td></tr>`).join('')}
      </tbody>
    </table>
    <div class="materials">
      ${data.instanceSets.map((s) => `
        <div class="degraded" style="color:var(--muted)">
          ${escapeHtml(s.name)} · ${s.kind} · ${s.placements} placement(s)${s.mirrored ? ` · <span class="pill mirror">${s.mirrored} mirrored</span>` : ''}
          ${s.prototypePath ? `<br/><span class="mono">proto ${escapeHtml(s.prototypePath)}</span>` : ''}
        </div>`).join('')}
    </div>
  `;
  return box;
}

function renderMaterials(data) {
  const host = $('#source-materials');
  if (!data.materials.length) { host.innerHTML = '<p class="muted">none</p>'; return; }
  host.innerHTML = `
    <table>
      <thead><tr><th>name</th><th>base color</th><th class="num">metal</th><th class="num">rough</th><th>2-sided</th><th>degraded</th></tr></thead>
      <tbody>
        ${data.materials.map((m) => `
          <tr>
            <td>${escapeHtml(m.name)}</td>
            <td><span class="swatch" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgb(${m.baseColorFactor.slice(0, 3).map((v) => Math.round(v * 255)).join(',')})"></span> ${m.baseColorFactor.slice(0, 3).map((v) => v.toFixed(2)).join(', ')}</td>
            <td class="num">${m.metallicFactor.toFixed(2)}</td>
            <td class="num">${m.roughnessFactor.toFixed(2)}</td>
            <td>${m.doubleSided ? 'yes' : 'no'}</td>
            <td class="degraded">${m.degradedInputs.length ? m.degradedInputs.join(', ') : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

// ---- results -------------------------------------------------------------

function renderResults(result) {
  const c = result.comparison;
  const r = result.report;
  const verdictEl = $('#verdict');
  verdictEl.textContent = c.verdict.ok ? 'match' : 'differences';
  verdictEl.className = `verdict ${c.verdict.ok ? 'ok' : 'bad'}`;

  const host = $('#results');
  host.innerHTML = `
    <h3>Conversion</h3>
    <table>
      <tr><th>source</th><td>${result.sourceFormat} · ${r.counts.trianglesExpanded}△ drawn · ${r.counts.trianglesDistinct}△ distinct</td></tr>
      <tr><th>target</th><td>${result.targetFormat} · ${result.targetFormat === 'usda' ? 'stage' : 'baked root'} up ${result.targetFrame.upAxis} / ${result.targetFrame.metersPerUnit} m</td></tr>
      <tr><th>units</th><td>${r.units.sourceMetersPerUnit} m/unit → metre (canonical)</td></tr>
      <tr><th>axis</th><td>${r.axis.sourceUpAxis} → Y · root fix ${r.axis.rootFixMatrix ? 'applied' : 'identity'}</td></tr>
      <tr><th>instances</th><td>${r.instances.authoredInstanceDraws} draws · ${r.instances.mirroredInstanceDraws} mirrored · not flattened</td></tr>
      <tr><th>mirror facing</th><td>${r.mirrorFacing.mirroredInstanceDraws === 0
        ? 'no mirrored placements'
        : `${r.mirrorFacing.mirroredInstanceDraws} mirrored draw(s) · ${escapeHtml(r.mirrorFacing.mitigation)}`}</td></tr>
      <tr><th>reuse</th><td>${r.reuse.totalDraws} draws / ${r.reuse.uniqueMeshes} meshes = ${r.reuse.expansionFactor.toFixed(2)}× sharing</td></tr>
    </table>

    <h3>Hierarchy</h3>
    <table>
      <tr><th>matched nodes</th><td>${c.hierarchy.matched}</td></tr>
      <tr><th>max world Δ</th><td>${c.hierarchy.maxWorldDelta.toExponential(2)}</td></tr>
      <tr><th>missing / extra</th><td>${c.hierarchy.onlyInReference.length} / ${c.hierarchy.onlyInCandidate.length}</td></tr>
    </table>

    <h3>Instance placements (world positions)</h3>
    <table>
      <thead><tr><th>#</th><th>source</th><th>target</th><th class="num">Δ</th></tr></thead>
      <tbody>
        ${c.placements.pairs.map((p, i) => `
          <tr>
            <td>${i + 1}${p.mirrored ? '<span class="pill mirror">mirror</span>' : ''}</td>
            <td>${fmtVec(p.referencePosition)}</td>
            <td>${fmtVec(p.candidatePosition)}</td>
            <td class="num">${p.positionDelta.toExponential(1)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${c.placements.unmatchedReference.length || c.placements.unmatchedCandidate.length ? `
      <p class="reason">unmatched: ${c.placements.unmatchedReference.length} source / ${c.placements.unmatchedCandidate.length} target</p>` : ''}

    <h3>Geometry &amp; facing</h3>
    <table>
      <tr><th>vertex overlap</th><td>${(c.geometry.vertexOverlap * 100).toFixed(1)}%</td></tr>
      <tr><th>triangle overlap</th><td>${(c.geometry.triangleOverlap * 100).toFixed(1)}%</td></tr>
      <tr><th>visible triangles</th><td>${c.facing.reference.visible} → ${c.facing.candidate.visible} (Δ ${c.facing.visibleTriangleDelta})</td></tr>
      <tr><th>mirrored culled</th><td>${c.facing.candidate.mirroredInstancesCulled}</td></tr>
    </table>

    <h3>Independent loader check</h3>
    <div id="loader-check" class="loader-audit"></div>

    <h3>Verdict</h3>
    ${c.verdict.reasons.length
      ? `<ul class="reasons">${c.verdict.reasons.map((x) => `<li class="reason">${escapeHtml(x)}</li>`).join('')}</ul>`
      : '<p class="reason-ok">All structural nodes, instance placements, visible triangles and sharing agree.</p>'}

    ${r.degradedMaterials.length ? `
      <h3>Declared degradations</h3>
      <ul class="reasons">
        ${r.degradedMaterials.map((m) => `<li class="degraded">${escapeHtml(m.name)}: dropped ${m.dropped.map(escapeHtml).join(', ')}</li>`).join('')}
      </ul>` : ''}

    ${r.warnings.length ? `
      <h3>Warnings</h3>
      <ul class="reasons">
        ${r.warnings.slice(0, 12).map((w) => `<li class="warn">${escapeHtml(w.message)}</li>`).join('')}
      </ul>` : ''}
  `;
  renderLoaderCheck();
}

/**
 * Compare what the two real loaders actually built against the IR placements
 * and the reference triangle count. This is display-only evidence: it never
 * changes the verdict, which is computed on the re-read files. It makes the
 * loader mismatches visible instead of hiding them behind a green badge.
 */
function renderLoaderCheck() {
  const host = document.getElementById('loader-check');
  if (!host) return;
  const srcFacts = state.views.srcfacts;
  const tgtFacts = state.views.tgtfacts;
  if (!srcFacts && !tgtFacts) { host.innerHTML = '<p class="muted">loaders still running…</p>'; return; }

  const rows = [];
  for (const [side, facts] of [['source', srcFacts], ['target', tgtFacts]]) {
    if (!facts) { rows.push(`<tr><td>${side}</td><td colspan="3" class="muted">not loaded</td></tr>`); continue; }
    const list = facts.instancePositions.length ? facts.instancePositions : facts.placementPositions;
    const match = matchPositions(list, state.result?.comparison?.placements?.pairs || []);
    rows.push(`
      <tr>
        <td>${escapeHtml(facts.loader)}</td>
        <td class="num">${facts.trianglesDrawn}</td>
        <td class="num">${list.length}</td>
        <td class="num">${match.matched}/${match.total}${match.worst > 1e-3 ? ` <span class="warn">Δ${match.worst.toFixed(3)}</span>` : ''}</td>
      </tr>`);
  }
  host.innerHTML = `
    <table>
      <thead><tr><th>loader</th><th class="num">triangles</th><th class="num">placements</th><th class="num">at IR position</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <p class="muted">Triangles and placements are measured from the built THREE scene; the last column checks each against the reference placement positions. A loader that under-renders instances shows fewer triangles here without changing the file verdict.</p>
  `;
}

function matchPositions(list, pairs) {
  const refs = pairs.map((p) => p.referencePosition);
  let matched = 0;
  let worst = 0;
  const used = new Set();
  for (const p of list) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < refs.length; i++) {
      if (used.has(i)) continue;
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs(p[k] - refs[i][k])));
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD <= 1e-2) { used.add(best); matched++; worst = Math.max(worst, bestD); }
  }
  return { matched, total: refs.length, worst };
}

// ---- download ------------------------------------------------------------

function downloadOutputs() {
  if (!state.result) return;
  const a = document.createElement('a');
  const name = state.result.targetFormat === 'gltf' ? 'converted.gltf' : 'converted.usda';
  const type = state.result.targetFormat === 'gltf' ? 'model/gltf+json' : 'text/plain';
  a.href = URL.createObjectURL(new Blob([state.result.targetText], { type }));
  a.download = name;
  a.click();
  const b = document.createElement('a');
  b.href = URL.createObjectURL(new Blob([JSON.stringify(state.result.report, null, 2)], { type: 'application/json' }));
  b.download = 'conversion-report.json';
  b.click();
}

// ---- helpers -------------------------------------------------------------

function fmtVec(v) {
  return `(${v.map((x) => (Math.abs(x) < 1e-4 ? '0' : x.toFixed(2))).join(', ')})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(msg) {
  $('#status').textContent = msg;
}

// ---- dev handle for the e2e test -----------------------------------------

window.__exchangeApp = {
  state,
  run: runExchange,
  /** Await the currently running conversion + loader render. */
  idle: () => new Promise((resolve) => {
    const check = () => (state.loading ? setTimeout(check, 50) : resolve());
    check();
  }),
  limits: LOADER_LIMITS,
};

populateFiles();
refreshLoaderButtons();
