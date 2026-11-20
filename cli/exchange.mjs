#!/usr/bin/env node
// Auxiliary CLI for scene exchange.
//
// The primary entry point is the graphical one: `npm run dev` and the
// "Convert & compare" button (see README). This CLI exists for scripted checks
// and calls exactly the same implementation (src/core/exchange.js); it cannot
// produce results the page could not.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, dirname, join, resolve } from 'node:path';
import { exchange } from '../src/core/exchange.js';

const HELP = `usage: node cli/exchange.mjs <input.gltf|input.usda> [options]

options:
  -o, --out <dir>          output directory (default: alongside the input, ./out-<name>)
      --up <Y|Z>           up axis to declare for a glTF input (default Y)
      --meters <number>    metres per unit to declare for a glTF input (default 1)
      --target-up <Y|Z>    up axis of the written USDA (default: source frame)
      --target-unit <n>    metres per unit of the written USDA (default: source frame)
      --no-mirror-fix      do not widen mirrored instanced meshes to doubleSided
      --json               print the report to stdout instead of a summary
  -h, --help               this help

The CLI is auxiliary. The graphical entry point is the Vite page:
  npm run dev   ->  open the printed URL, press "Convert & compare".
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--no-mirror-fix') args.mirrorMitigation = false;
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--up') args.up = argv[++i];
    else if (a === '--meters') args.meters = Number(argv[++i]);
    else if (a === '--target-up') args.targetUp = argv[++i];
    else if (a === '--target-unit') args.targetUnit = Number(argv[++i]);
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args._.length !== 1) {
  console.log(HELP);
  process.exit(args.help ? 0 : 2);
}

const inputPath = resolve(args._[0]);
const ext = extname(inputPath).toLowerCase();
const sourceFormat = ext === '.gltf' || ext === '.gltf.json' ? 'gltf' : ext === '.usda' || ext === '.usd' ? 'usda' : null;
if (!sourceFormat) {
  console.error(`unsupported extension '${ext}': expected .gltf or .usda`);
  process.exit(2);
}

const text = readFileSync(inputPath, 'utf8');
const result = exchange(sourceFormat, { text, name: basename(inputPath) }, {
  sourceUpAxis: args.up,
  sourceMetersPerUnit: args.meters === undefined ? undefined : args.meters,
  targetUpAxis: args.targetUp,
  targetMetersPerUnit: args.targetUnit,
  mirrorMitigation: args.mirrorMitigation !== false,
});
const targetText = result.targetText;

const outDir = args.out
  ? resolve(args.out)
  : join(dirname(inputPath), `out-${basename(inputPath, ext)}`);
mkdirSync(outDir, { recursive: true });

const base = basename(inputPath, ext);
const targetExt = result.targetFormat === 'gltf' ? '.gltf' : '.usda';
const targetPath = join(outDir, `${base}${targetExt}`);
writeFileSync(targetPath, targetText);
const reportPath = join(outDir, `${base}.report.json`);
writeFileSync(reportPath, JSON.stringify(result.report, null, 2));

if (args.json) {
  console.log(JSON.stringify(result.report, null, 2));
} else {
  const v = result.comparison.verdict;
  console.log(`source      ${sourceFormat}  ${basename(inputPath)}`);
  console.log(`target      ${result.targetFormat}  ${targetPath}`);
  console.log(`report      ${reportPath}`);
  console.log(`verdict     ${v.ok ? 'MATCH' : 'DIFFERENCES'}`);
  for (const reason of v.reasons) console.log(`  - ${reason}`);
  console.log(`hierarchy   ${result.comparison.hierarchy.matched} nodes, max world Δ ${result.comparison.hierarchy.maxWorldDelta.toExponential(2)}`);
  console.log(`instances   ${result.comparison.placements.matched}/${result.comparison.placements.referenceCount} placements matched, ${result.report.mirrorFacing.mirroredInstanceDraws} mirrored`);
  console.log(`sharing     ${result.report.reuse.totalDraws} draws / ${result.report.reuse.uniqueMeshes} meshes = ${result.report.reuse.expansionFactor.toFixed(2)}x`);
  const mirrorWarnings = result.report.warnings.filter((w) => w.kind === 'mirror-facing');
  for (const w of mirrorWarnings) console.log(`mirror      ${w.resolution}`);
  if (result.report.degradedMaterials.length) {
    for (const d of result.report.degradedMaterials) console.log(`degraded    ${d.name}: ${d.dropped.join(', ')}`);
  }
  process.exitCode = v.ok ? 0 : 1;
}
