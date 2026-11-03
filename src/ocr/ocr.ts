import { createWorker, type Worker } from 'tesseract.js';
import { toOcrGrayscale } from './preprocess';
import { toPass } from './tesseractResult';
import { parseDimeScreenshot, type ParseResult } from './dimeParser';

// Runs entirely in the browser. The worker, WASM core and language data are served from this app
// (public/tesseract, copied from node_modules at build time) — no CDN, no API key, the image never leaves the device.
const base = () => `${import.meta.env.BASE_URL}tesseract/`;
const options = (logger?: (m: { status: string; progress: number }) => void) => ({
  workerPath: `${base()}worker.min.js`, corePath: `${base()}core`, langPath: `${base()}lang`,
  gzip: true, workerBlobURL: false, logger,
});

export interface ImageResult { parse: ParseResult; width: number; height: number; crops: string[] }
export type Progress = (stage: string, fraction: number) => void;

async function loadCanvas(file: Blob) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { c, ctx };
}

/** Full-width strip of the screenshot around a row, scaled to at most 720 px wide, as a small JPEG. */
function cropRow(src: HTMLCanvasElement, y0: number, y1: number): string {
  const pad = Math.round((y1 - y0) * 0.12) + 16;
  const top = Math.max(0, y0 - pad), bottom = Math.min(src.height, y1 + pad);
  const scale = Math.min(1, 720 / src.width);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale); c.height = Math.max(1, Math.round((bottom - top) * scale));
  c.getContext('2d')!.drawImage(src, 0, top, src.width, bottom - top, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.8);
  c.width = c.height = 0;
  return url;
}

export class DimeOcr {
  private tha?: Worker;
  private eng?: Worker;
  private stage = '';
  private onProgress?: Progress;
  private log = (m: { status: string; progress: number }) => this.onProgress?.(m.status === 'recognizing text' ? this.stage : 'กำลังโหลดตัวอ่านภาพ (ครั้งแรกอาจนานกว่า)', m.progress ?? 0);

  async recognize(file: Blob, onProgress?: Progress): Promise<ImageResult> {
    this.onProgress = onProgress;
    const { c, ctx } = await loadCanvas(file);
    // keep an untouched copy to cut per-row thumbnails from (the OCR copy is converted to grayscale/inverted)
    const orig = document.createElement('canvas');
    orig.width = c.width; orig.height = c.height;
    orig.getContext('2d')!.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    toOcrGrayscale(img.data);
    ctx.putImageData(img, 0, 0);
    this.tha ??= await createWorker(['tha', 'eng'], 1, options(this.log));
    this.stage = 'อ่านข้อความภาษาไทยและตัวเลข';
    const t = await this.tha.recognize(c, {}, { text: true, blocks: true });
    this.eng ??= await createWorker(['eng'], 1, options(this.log));
    this.stage = 'อ่านชื่อหุ้นและตรวจตัวเลขซ้ำ';
    const e = await this.eng.recognize(c, {}, { text: true, blocks: true });
    const parse = parseDimeScreenshot(toPass(t.data as never), toPass(e.data as never));
    const crops = parse.rows.map(r => cropRow(orig, r.band.y0, r.band.y1));
    const out = { parse, width: c.width, height: c.height, crops };
    c.width = c.height = orig.width = orig.height = 0; // release canvas memory early (iOS limits total canvas memory)
    return out;
  }

  async dispose() { await this.tha?.terminate(); await this.eng?.terminate(); this.tha = this.eng = undefined; }
}
