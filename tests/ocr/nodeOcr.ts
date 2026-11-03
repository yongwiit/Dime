// Node-side OCR for tests: same preprocessing, same Tesseract language data and same parser as the browser.
import { createWorker, type Worker } from 'tesseract.js';
import { PNG } from 'pngjs';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { toOcrGrayscale } from '../../src/ocr/preprocess';
import { toPass } from '../../src/ocr/tesseractResult';
import { parseDimeScreenshot } from '../../src/ocr/dimeParser';

const langPath = path.resolve('public/tesseract/lang'); // copied by scripts/copy-ocr-assets.mjs
const cachePath = path.resolve('node_modules/.cache/tesseract');
let tha: Worker | undefined, eng: Worker | undefined;

export function preprocessPng(png: PNG): Buffer {
  const copy = new PNG({ width: png.width, height: png.height });
  png.data.copy(copy.data);
  toOcrGrayscale(copy.data);
  return PNG.sync.write(copy);
}

export async function ocrPng(png: PNG) {
  mkdirSync(cachePath, { recursive: true });
  tha ??= await createWorker(['tha', 'eng'], 1, { langPath, cachePath, gzip: true });
  eng ??= await createWorker(['eng'], 1, { langPath, cachePath, gzip: true });
  const img = preprocessPng(png);
  const t = await tha.recognize(img, {}, { text: true, blocks: true });
  const e = await eng.recognize(img, {}, { text: true, blocks: true });
  return parseDimeScreenshot(toPass(t.data as never), toPass(e.data as never));
}

export const ocrFile = (file: string) => ocrPng(PNG.sync.read(readFileSync(file)));
export async function closeOcr() { await tha?.terminate(); await eng?.terminate(); tha = eng = undefined; }
