#!/usr/bin/env node
// Regenerates the label review artifacts and verifies every QR code in them (doc 016):
//   qr-validation-sheet.pdf   A4 sheet: 10/12/15/18 mm × EC M/Q, rulers, checklist (test URLs)
//   calibration.pdf           one page at a template version's exact size
//   dev-sample-label.pdf      a DEV label with the "DEV - NOT FOR PRODUCTION" marker
//   *.png                     page previews for visual inspection
//   verification.txt          decoded QR content of every code, checked against expectations
//
// Usage (repository root):  pnpm label-artifacts [--out DIR] [--api URL --template-version ID]
//   Default output: artifacts/label-review/ (git-ignored). Without --template-version the
//   calibration page uses the bundled sample template (scripts/fixtures/sample-label-70x110.svg);
//   with it, the calibration PDF of that version is downloaded from a running local API.
// Needs a build of @ayvo/api (`pnpm label-artifacts` builds first) and Node 24 (type stripping
// is used to share the QR decoder with the tests).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { decodeQrOnPage, openPdf } from '../test/support/pdf-inspect.ts';

const apiRoot = resolve(import.meta.dirname, '..');
const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: resolve(apiRoot, '../../artifacts/label-review') },
    api: { type: 'string', default: 'http://localhost:4000' },
    'template-version': { type: 'string' },
  },
});

const dist = (path) => import(resolve(apiRoot, 'dist', path));
const {
  renderQrValidationSheet,
  renderTemplateCalibration,
  validationSheetVariants,
  validationUrl,
  variantId,
} = await dist('labels/calibration-pdf.js');
const { PdfLibLabelRenderer } = await dist('labels/label-pdf-renderer.js');
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const report = [];
let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  report.push(
    `${ok ? 'OK  ' : 'FAIL'} ${name}: ${actual ?? '(no QR decoded)'}${ok ? '' : ` (expected ${expected})`}`,
  );
};

async function preview(file, pxPerMm) {
  const pdf = await getDocument({
    data: new Uint8Array(readFileSync(join(out, file))),
    verbosity: 0,
  }).promise;
  const page = await pdf.getPage(1);
  // PDF user space is points; pxPerMm pixels per millimetre = pxPerMm * 25.4 / 72 per point.
  const viewport = page.getViewport({ scale: (pxPerMm * 25.4) / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, viewport }).promise;
  writeFileSync(join(out, file.replace(/\.pdf$/, '.png')), canvas.toBuffer('image/png'));
}

// 1. QR validation sheet: decode every variant in its own region.
const sheet = await renderQrValidationSheet({
  environment: 'development',
  generatedAt: new Date(),
});
writeFileSync(join(out, 'qr-validation-sheet.pdf'), sheet);
const sheetPdf = await openPdf(sheet);
for (const v of validationSheetVariants()) {
  const decoded = await decodeQrOnPage(sheetPdf, 1, 16, {
    left: v.xMm - 3,
    top: v.yMm - 3,
    width: v.sizeMm + 6,
    height: v.sizeMm + 6,
  });
  check(`validation ${v.id}${v.candidate ? ' (candidate)' : ''}`, decoded?.data, v.url);
}

// 2. Calibration page: a selected template version from the API, or the bundled sample.
let calibration;
let calibrationQr;
if (args['template-version']) {
  const res = await fetch(
    `${args.api}/api/admin/label-template-versions/${args['template-version']}/calibration.pdf`,
  );
  if (!res.ok) throw new Error(`API returned HTTP ${res.status} for the calibration PDF`);
  calibration = new Uint8Array(await res.arrayBuffer());
  const settings = await (await fetch(`${args.api}/api/admin/label-designer/settings`)).json();
  const version = await (
    await fetch(`${args.api}/api/admin/label-template-versions/${args['template-version']}`)
  ).json();
  calibrationQr = validationUrl(variantId(version.elements[0].widthMm, settings.qrErrorCorrection));
} else {
  const template = sampleTemplate();
  calibration = await renderTemplateCalibration({
    template,
    errorCorrection: 'Q',
    devMarker: true,
  });
  calibrationQr = validationUrl(variantId(15, 'Q'));
}
writeFileSync(join(out, 'calibration.pdf'), calibration);
check('calibration QR', (await decodeQrOnPage(await openPdf(calibration), 1))?.data, calibrationQr);

// 3. DEV sample label (a DEV URL; never a production URL).
const sampleUrl = `https://dev.ayvo.co/q/${'A'.repeat(22)}`;
const sample = await new PdfLibLabelRenderer().render({
  title: 'AYVO OS - DEV sample label',
  template: sampleTemplate(),
  labels: [{ code: 'AYV-B-000000', url: sampleUrl }],
  errorCorrection: 'Q',
  devMarker: true,
});
writeFileSync(join(out, 'dev-sample-label.pdf'), sample);
check('DEV sample label QR', (await decodeQrOnPage(await openPdf(sample), 1))?.data, sampleUrl);

for (const [file, pxPerMm] of [
  ['qr-validation-sheet.pdf', 4],
  ['calibration.pdf', 12],
  ['dev-sample-label.pdf', 12],
]) {
  await preview(file, pxPerMm);
}
writeFileSync(join(out, 'verification.txt'), `${report.join('\n')}\n`);
console.log(report.join('\n'));
console.log(
  `\n${failures === 0 ? 'All QR codes verified.' : `${failures} QR check(s) FAILED.`} Output: ${out}`,
);
process.exit(failures === 0 ? 0 : 1);

function sampleTemplate() {
  return {
    ref: { label: 'sample v1', templateName: 'sample', versionNumber: 1 },
    widthMm: 70,
    heightMm: 110,
    artwork: {
      format: 'SVG',
      bytes: readFileSync(join(apiRoot, 'scripts/fixtures/sample-label-70x110.svg')),
    },
    elements: [
      { type: 'QR_CODE', xMm: 48.2, yMm: 78.5, widthMm: 15, heightMm: 15, rotationDeg: 0 },
    ],
  };
}
