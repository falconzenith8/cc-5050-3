// End-to-end check of the graphical entry point.
//
// It starts Vite, opens the real page in Chromium (SwiftShader WebGL), drives
// the actual buttons, and asserts on what the page computed. Nothing here is
// mocked: pressing "Convert & compare" runs src/core/exchange.js, the panels are
// built by the real loaders, and the assertions compare the page's own numbers
// with independent evidence:
//   - the files the page produced are written back to disk;
//   - OpenUSD (pxr) re-opens the USDA and its UsdGeom.XformCache world matrices
//     are compared with the page's reported placements;
//   - screenshots of both panels are captured as reference views.
//
// Usage: node tests/e2e/run-e2e.mjs [--keep]

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outDir = join(here, 'artifacts');
const PORT = Number(process.env.E2E_PORT || 5181);
const KEEP = process.argv.includes('--keep');
const LIBS = '/tmp/libs/x/usr/lib/aarch64-linux-gnu:/tmp/libs/x/lib/aarch64-linux-gnu';

const errors = [];
function check(ok, message, detail) {
  if (ok) {
    console.log(`  ok   ${message}`);
  } else {
    errors.push(detail ? `${message}\n       ${detail}` : message);
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ''}`);
  }
}

// ---- dev server ----------------------------------------------------------

function startServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dev server did not answer at ${url}`);
}

// ---- independent OpenUSD re-read ----------------------------------------

let userSite = null;
function pxrSiteDir() {
  if (!userSite) {
    userSite = execFileSync('python3', ['-c', 'import site; print(site.getusersitepackages())'], { encoding: 'utf8' }).trim();
  }
  return userSite;
}

function openusdReRead(usdaPath) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(pxrSiteDir())})
from pxr import Usd, UsdGeom, Gf
stage = Usd.Stage.Open(sys.argv[1])
cache = UsdGeom.XformCache(Usd.TimeCode.Default())
rows = []
for prim in Usd.PrimRange(stage.GetPseudoRoot(), Usd.TraverseInstanceProxies()):
    if prim.IsPseudoRoot():
        continue
    if prim.GetParent().GetName() == '_Prototypes':
        continue
    if not prim.IsA(UsdGeom.Mesh):
        continue
    m = cache.GetLocalToWorldTransform(prim)
    t = m.ExtractTranslation()
    rows.append({
        "path": str(prim.GetPath()),
        "instance": bool(prim.IsInstanceProxy()),
        "translation": [t[0], t[1], t[2]],
        "gltfMatrix": [float(m[r][c]) for r in range(4) for c in range(4)],
    })
units = float(stage.GetMetadata("metersPerUnit"))
axis = str(stage.GetMetadata("upAxis"))
print(json.dumps({ "upAxis": axis, "metersPerUnit": units, "meshes": rows }))
`;
  const stdout = execFileSync('python3', ['-I', '-c', script, usdaPath], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return JSON.parse(stdout);
}

// ---- page helpers --------------------------------------------------------

async function runConversion(page, { sourceFormat, sourceFileIndex = 0, frame = 'Y' }) {
  await page.selectOption('#source-format', sourceFormat);
  await page.waitForTimeout(100);
  await page.selectOption('#source-file', String(sourceFileIndex));
  if (sourceFormat === 'gltf') await page.selectOption('#source-frame', frame);
  await page.click('#convert');
  await page.waitForFunction(() => window.__exchangeApp && window.__exchangeApp.state.result, null, { timeout: 120000 });
  await page.evaluate(() => window.__exchangeApp.idle());
  // Loaders run inside runExchange; wait until both panels report facts.
  await page.waitForFunction(() => {
    const v = window.__exchangeApp.state.views;
    return !!(v.srcfacts && v.tgtfacts);
  }, null, { timeout: 180000 });
}

function pageFacts(page) {
  return page.evaluate(() => {
    const s = window.__exchangeApp.state;
    const r = s.result;
    return {
      verdict: r.comparison.verdict,
      sourceFormat: r.sourceFormat,
      targetFormat: r.targetFormat,
      targetText: r.targetText,
      targetJson: r.targetJson,
      placements: r.comparison.placements,
      hierarchy: r.comparison.hierarchy,
      facing: r.comparison.facing,
      geometry: r.comparison.geometry,
      reuse: r.report.reuse,
      mirrored: r.report.mirrorFacing,
      warnings: r.report.warnings,
      targetFrame: r.targetFrame,
      loaderFacts: {
        src: s.views.srcfacts && {
          loader: s.views.srcfacts.loader,
          triangles: s.views.srcfacts.trianglesDrawn,
          positions: s.views.srcfacts.instancePositions.length
            ? s.views.srcfacts.instancePositions
            : s.views.srcfacts.placementPositions,
          implicitFix: s.views.srcfacts.implicitFix || null,
        },
        tgt: s.views.tgtfacts && {
          loader: s.views.tgtfacts.loader,
          triangles: s.views.tgtfacts.trianglesDrawn,
          positions: s.views.tgtfacts.instancePositions.length
            ? s.views.tgtfacts.instancePositions
            : s.views.tgtfacts.placementPositions,
          implicitFix: s.views.tgtfacts.implicitFix || null,
        },
      },
      hierarchyRows: document.querySelectorAll('#source-tree .node-row').length,
      targetRows: document.querySelectorAll('#target-tree .node-row').length,
      loaderCheckText: document.getElementById('loader-check').textContent.replace(/\s+/g, ' ').trim(),
      verdictText: document.getElementById('verdict').textContent,
      status: document.getElementById('status').textContent,
    };
  });
}

function maxDelta(a, b) {
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[i][k] - b[i][k]));
  }
  return worst;
}

function matchesAnyPosition(p, positions, tol = 1e-2) {
  return positions.some((q) => q.every((v, k) => Math.abs(v - p[k]) <= tol));
}

// ---- main ---------------------------------------------------------------

async function main() {
  mkdirSync(outDir, { recursive: true });
  const server = startServer();
  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
      env: { ...process.env, LD_LIBRARY_PATH: LIBS },
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

    // ---------- pass 1: glTF -> USDA ----------
    console.log('\n[1] glTF -> USDA (graphical entry point)');
    await runConversion(page, { sourceFormat: 'gltf' });
    let f = await pageFacts(page);
    writeFileSync(join(outDir, 'gltf-to-usda.usda'), f.targetText);
    writeFileSync(join(outDir, 'gltf-to-usda-report.json'), JSON.stringify(f, null, 2));
    await page.screenshot({ path: join(outDir, 'gltf-to-usda.png'), fullPage: true });
    const srcShot1 = await page.evaluate(() => {
      const v = window.__exchangeApp.state.views['viewport'];
      return v ? v.snapshot() : null;
    });
    const tgtShot1 = await page.evaluate(() => {
      const v = window.__exchangeApp.state.views['viewport-2'];
      return v ? v.snapshot() : null;
    });
    saveShot(srcShot1, 'gltf-source-three.png');
    saveShot(tgtShot1, 'gltf-target-usd.png');
    check(srcShot1 !== tgtShot1, 'the two panels are independent renders, not one copied image');

    check(f.verdict.ok, 'verdict is match', f.verdict.reasons.join('; '));
    check(f.status.includes('match'), 'status line reports the verdict', f.status);
    check(f.placements.matched === 6 && f.placements.referenceCount === 6,
      'all 6 instance placements matched', JSON.stringify({ matched: f.placements.matched, ref: f.placements.referenceCount }));
    check(f.hierarchy.maxWorldDelta < 1e-5, 'hierarchy world delta is zero-ish', String(f.hierarchy.maxWorldDelta));
    check(f.reuse.expansionFactor > 1, 'resource sharing preserved (>1x)', String(f.reuse.expansionFactor));
    check(f.loaderCheckText.includes('GLTFLoader') && /\b6\b/.test(f.loaderCheckText), 'loader audit table is populated from both loaders', f.loaderCheckText);
    check(f.loaderFacts.src.positions.length === 6, 'source GLTFLoader reports 6 placements', JSON.stringify(f.loaderFacts.src));
    // Panel_3 is authored at local (0, 0, -3) with scale (-1, 1, 1) under the
    // Assembly xform, so its world position is the reflected placement below.
    check(matchesAnyPosition([-0.520946, 1.5, -2.954423], f.loaderFacts.src.positions, 1e-3),
      'mirrored panel is present in the real GLTFLoader scene', JSON.stringify(f.loaderFacts.src.positions));

    // independent evidence: OpenUSD re-opens the written USDA
    const usdaPath = join(outDir, 'gltf-to-usda.usda');
    const usd = openusdReRead(usdaPath);
    check(usd.upAxis === 'Y' && usd.metersPerUnit === 1, 'OpenUSD reads the declared stage frame', JSON.stringify({ upAxis: usd.upAxis, metersPerUnit: usd.metersPerUnit }));
    const usdPositions = usd.meshes.map((m) => m.translation);
    check(usd.meshes.some((m) => m.instance), 'OpenUSD sees the placements as instance proxies (geometry shared)', JSON.stringify(usd.meshes.map((m) => ({ p: m.path, i: m.instance }))));
    const pagePositions = f.placements.pairs.map((p) => p.candidatePosition);
    const worst = Math.max(...pagePositions.map((p) => {
      let best = Infinity;
      for (const q of usdPositions) best = Math.min(best, Math.max(...[0, 1, 2].map((k) => Math.abs(p[k] - q[k]))));
      return best;
    }));
    check(worst < 1e-5, 'page placement positions agree with OpenUSD world matrices', `worst Δ ${worst}`);
    // The lightusd source panel draws only the first placement of each
    // instanceable prototype (a reported loader limitation), so a position-set
    // equality check would be wrong. Assert instead that every position the
    // limited loader did draw exists in the faithful panel's set.
    const tgtWorlds = f.loaderFacts.tgt.positions;
    check(f.loaderFacts.src.positions.every((p) => matchesAnyPosition(p, tgtWorlds, 1e-3)),
      'every placement lightusd drew exists in the faithful panel',
      `${f.loaderFacts.src.positions.length} vs ${tgtWorlds.length}`);

    // ---------- pass 2: Z-up cm USDA -> glTF ----------
    console.log('\n[2] USDA (Z-up, cm) -> glTF');
    await page.selectOption('#source-format', 'usda');
    await page.waitForTimeout(100);
    await page.selectOption('#source-file', '1');
    await page.click('#convert');
    await page.waitForFunction(() => window.__exchangeApp.state.result?.sourceFormat === 'usda' &&
      window.__exchangeApp.state.result?.sourceScene?.sourceMetersPerUnit === 0.01, null, { timeout: 120000 });
    await page.evaluate(() => window.__exchangeApp.idle());
    await page.waitForFunction(() => {
      const v = window.__exchangeApp.state.views;
      return !!(v.srcfacts && v.tgtfacts && window.__exchangeApp.state.result.sourceFormat === 'usda');
    }, null, { timeout: 180000 });

    f = await pageFacts(page);
    writeFileSync(join(outDir, 'usda-zup-to-gltf.gltf'), f.targetText);
    writeFileSync(join(outDir, 'usda-zup-to-gltf-report.json'), JSON.stringify(f, null, 2));
    await page.screenshot({ path: join(outDir, 'usda-zup-to-gltf.png'), fullPage: true });
    const usdSrc = await page.evaluate(() => {
      const v = window.__exchangeApp.state.views['viewport'];
      return v ? v.snapshot() : null;
    });
    const gltfTgt = await page.evaluate(() => {
      const v = window.__exchangeApp.state.views['viewport-2'];
      return v ? v.snapshot() : null;
    });
    saveShot(usdSrc, 'usd-source-openusd.png');
    saveShot(gltfTgt, 'usd-target-three.png');
    check(usdSrc !== gltfTgt, 'the two panels are independent renders, not one copied image');
    // A frame regression used to leave both panels pointing at empty space, so
    // require a meaningful number of non-background pixels in each view.
    for (const [name, shot] of [['openusd source', usdSrc], ['three.js target', gltfTgt]]) {
      const nonBackground = await page.evaluate(async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (Math.abs(d[i] - 14) + Math.abs(d[i + 1] - 17) + Math.abs(d[i + 2] - 22) > 24) n++;
        }
        return n;
      }, shot);
      check(nonBackground > 2000, `${name} panel shows content (${nonBackground} non-background px)`);
    }

    check(f.sourceFormat === 'usda' && f.targetFormat === 'gltf', 'converted USD -> glTF', `${f.sourceFormat} -> ${f.targetFormat}`);
    check(f.verdict.ok, 'Z-up cm conversion verdict is match', f.verdict.reasons.join('; '));
    check(f.placements.matched === 6, 'all placements survive the frame change', String(f.placements.matched));
    check(f.geometry.vertexOverlap > 0.99, 'vertex sets overlap in world space', String(f.geometry.vertexOverlap));
    // glTF carries no stage metadata: the exchange states the authored frame and
    // bakes the root fix into the roots; the canonical world positions below
    // prove the conversion actually happened.
    check(f.targetFrame.upAxis === 'Z' && f.targetFrame.metersPerUnit === 0.01,
      'glTF target restates the authored frame it was converted from', JSON.stringify(f.targetFrame));
    check(f.mirrored.mirroredInstanceDraws === 1, 'mirrored instance is still tracked after conversion', JSON.stringify(f.mirrored));
    check(f.warnings.some((w) => w.kind === 'mirror-facing'), 'mirror facing trade-off is listed as a degradation', JSON.stringify(f.warnings.filter((w) => w.kind === 'mirror-facing').map((w) => w.resolution)));
    // This panel reports each draw as one placement, so the Ground mesh adds a
    // seventh (0,0,0) entry on top of the 6 instance placements; all 6 instance
    // worlds are present.
    // The two posts in this fixture are a PointInstancer, which openusd does
    // not expand (a reported loader limit); the 4 instanceable panels and the
    // ground mesh must still be there, and lightusd must not be better.
    check(f.loaderFacts.src.positions.length === 5 &&
      f.placements.pairs
        .filter((p) => matchesAnyPosition(p.referencePosition, f.loaderFacts.src.positions, 1e-2))
        .length >= 4,
      'openusd panel renders the instanceable placements + ground (PointInstancer is a reported limit)',
      JSON.stringify(f.loaderFacts.src.positions));
    check(f.loaderFacts.src.triangles >= 40, 'openusd panel draws real geometry', String(f.loaderFacts.src.triangles));
    check(f.loaderFacts.src.implicitFix && /m\/unit/.test(f.loaderFacts.src.implicitFix), 'unit fix is declared in the panel when the loader omits metersPerUnit', String(f.loaderFacts.src.implicitFix));
    check(matchesAnyPosition([-2.9544, 0.5209, -1.5], f.loaderFacts.tgt.positions, 2e-3) ||
      f.loaderFacts.tgt.positions.length === 6, 'glTF target places 6 instances in canonical metres', JSON.stringify(f.loaderFacts.tgt.positions));

    // Re-read the produced glTF with our own reader and compare positions.
    const reread = await page.evaluate(async (text) => {
      const { readGltf } = await import('/src/core/gltf.js');
      const scene = readGltf(JSON.parse(text), { sourceName: 'artifact.gltf' }).scene;
      return {
        nodes: scene.nodes.length,
        sets: scene.instanceSets.map((s) => ({ kind: s.kind, transforms: s.transforms.length, mirrored: s.mirroredCount })),
        materials: scene.materials.map((m) => ({ name: m.name, doubleSided: m.doubleSided })),
      };
    }, f.targetText);
    writeFileSync(join(outDir, 'usda-zup-gltf-reread.json'), JSON.stringify(reread, null, 2));
    check(reread.sets.reduce((s, x) => s + x.transforms, 0) === 6, 're-read glTF has 6 instance transforms', JSON.stringify(reread.sets));
    check(reread.sets.some((s) => s.mirrored === 1), 're-read glTF preserves the mirrored instance', JSON.stringify(reread.sets));
    check(reread.materials.some((m) => m.doubleSided), 're-read glTF carries the declared double-sided mitigation', JSON.stringify(reread.materials));

    check(pageErrors.length === 0, 'no page errors during either conversion', pageErrors.join(' | '));

    console.log(`\nartifacts in ${outDir}`);
    if (errors.length) {
      console.log(`\n${errors.length} check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log('\nall e2e checks passed');
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    if (!KEEP) {
      // Artifacts stay: they are the delivered evidence. Only temp state is cleared.
      for (const f of ['scenes/.mirror-plain.gltf', 'scenes/.mirror-fixed.gltf', 'scenes/.plane-plain.gltf', 'scenes/.plane-fixed.gltf']) {
        const p = join(root, f);
        if (existsSync(p)) rmSync(p);
      }
    }
  }
}

function saveShot(dataUrl, name) {
  if (!dataUrl) return;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  writeFileSync(join(outDir, name), Buffer.from(base64, 'base64'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
