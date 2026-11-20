// The scene-exchange implementation.
//
// This is the single code path used by the graphical entry point (UI buttons),
// the CLI and the tests. It never fabricates a result: it reads a real file,
// builds the canonical IR, writes the other real format, re-reads *that file*,
// and returns both texts plus a diff computed from the re-read scene.

import { readGltf, writeGltf } from './gltf.js';
import { readUsda } from './usd-reader.js';
import { writeUsda, rootFix } from './usda-writer.js';
import { buildReport } from './report.js';
import { compareScenes } from './compare.js';
import { serializeScene } from './serialize.js';

export const CONVERSIONS = Object.freeze({
  'gltf->usda': { source: 'gltf', target: 'usda', label: 'glTF 2.0 -> USDA' },
  'usda->gltf': { source: 'usda', target: 'gltf', label: 'USDA -> glTF 2.0' },
});

/**
 * @param {'gltf'|'usda'} sourceFormat
 * @param {{ text?: string, json?: object, name: string }} file
 * @param {object} opts
 * @param {'Y'|'Z'} [opts.targetUpAxis]        written stage up axis (usda target)
 * @param {number} [opts.targetMetersPerUnit]  written stage unit (usda target)
 * @param {'Y'|'Z'} [opts.sourceUpAxis]        only if the source has no metadata (gltf)
 */
export function exchange(sourceFormat, file, opts = {}) {
  const read = sourceFormat === 'gltf'
    ? readGltf(file.json || JSON.parse(file.text), { sourceName: file.name })
    : readUsda(file.text, { sourceName: file.name });
  const sourceScene = read.scene;

  // A glTF file carries no stage metadata, so the caller declares the frame it
  // was authored in; it is recorded on the scene and applied once on export.
  if (sourceFormat === 'gltf') {
    const upAxis = (opts.sourceUpAxis || 'Y').toUpperCase();
    const metersPerUnit = Number(opts.sourceMetersPerUnit ?? 1);
    sourceScene.sourceUpAxis = upAxis;
    sourceScene.sourceMetersPerUnit = metersPerUnit;
    // glTF has no stage metadata, so the declared frame is *interpreted* with
    // the same explicit root fix the USD reader derives from stage metadata.
    // Both sides of the comparison then evaluate in one canonical Y-up metre
    // frame, and no node local is modified.
    sourceScene.rootFix = { matrix: rootFix(upAxis, metersPerUnit), unitScale: metersPerUnit, upAxis };
    sourceScene.authoredFrame = { upAxis, metersPerUnit };
  }

  const targetFormat = sourceFormat === 'gltf' ? 'usda' : 'gltf';
  // glTF has no stage metadata; the frame is stated as the one the writer
  // baked into the root nodes, so the two targets are equally legible.
  let targetText;
  let targetJson = null;
  let writerWarnings = [];
  let targetUpAxis = sourceScene.sourceUpAxis ?? 'Y';
  let targetMetersPerUnit = sourceScene.sourceMetersPerUnit ?? 1;

  if (targetFormat === 'usda') {
    const out = writeUsda(sourceScene, {
      upAxis: opts.targetUpAxis ?? sourceScene.sourceUpAxis ?? 'Y',
      metersPerUnit: opts.targetMetersPerUnit ?? sourceScene.sourceMetersPerUnit ?? 1,
    });
    targetText = out.text;
    writerWarnings = out.warnings;
    targetUpAxis = out.upAxis;
    targetMetersPerUnit = out.metersPerUnit;
  } else {
    const out = writeGltf(sourceScene, { mirrorMitigation: opts.mirrorMitigation !== false });
    targetJson = out.json;
    targetText = JSON.stringify(out.json, null, 2);
    writerWarnings = out.warnings || [];
  }

  // Re-read the file we just wrote — the diff must come from parsing the real
  // output, not from the in-memory IR we already had.
  const reread = targetFormat === 'gltf'
    ? readGltf(JSON.parse(targetText), { sourceName: `converted.${targetFormat}` })
    : readUsda(targetText, { sourceName: `converted.${targetFormat}` });
  const targetScene = reread.scene;
  if (targetFormat === 'gltf') {
    targetScene.authoredFrame = sourceScene.authoredFrame || {
      upAxis: sourceScene.sourceUpAxis ?? 'Y',
      metersPerUnit: sourceScene.sourceMetersPerUnit ?? 1,
    };
  }

  const comparison = compareScenes(sourceScene, targetScene);

  const report = buildReport({
    scene: sourceScene,
    reference: targetScene,
    targetFormat,
    sourceFormat,
    warnings: [...read.warnings, ...writerWarnings],
    extra: {
      targetFrame: { upAxis: targetUpAxis, metersPerUnit: targetMetersPerUnit },
      reread: {
        format: targetFormat,
        nodes: targetScene.nodes.length,
        meshes: targetScene.meshes.length,
        instanceSets: targetScene.instanceSets.map((s) => ({ kind: s.kind, count: s.transforms.length })),
        warnings: reread.warnings,
      },
    },
  });

  return {
    sourceFormat,
    targetFormat,
    sourceScene,
    targetScene,
    targetText,
    targetJson,
    targetFrame: { upAxis: targetUpAxis, metersPerUnit: targetMetersPerUnit },
    comparison,
    report,
    sourceSerialized: serializeScene(sourceScene),
    targetSerialized: serializeScene(targetScene),
  };
}
