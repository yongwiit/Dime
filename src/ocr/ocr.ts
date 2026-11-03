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

export interface ImageResult { parse: ParseResult; width: number; height: number; preview: string }
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

export class DimeOcr {
  private tha?: Worker;
  private eng?: Worker;
  private stage = '';
  private onProgress?: Progress;
  private log = (m: { status: string; progress: number }) => this.onProgress?.(m.status === 'recognizing text' ? this.stage : 'กำลังโหลดตัวอ่านภาพ (ครั้งแรกอาจนานกว่า)', m.progress ?? 0);

  async recognize(file: Blob, onProgress?: Progress): Promise<ImageResult> {
    this.onProgress = onProgress;
    const { c, ctx } = await loadCanvas(file);
    const preview = c.toDataURL('image/jpeg', 0.7);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    toOcrGrayscale(img.data);
    ctx.putImageData(img, 0, 0);
    this.tha ??= await createWorker(['tha', 'eng'], 1, options(this.log));
    this.stage = 'อ่านข้อความภาษาไทยและตัวเลข';
    const t = await this.tha.recognize(c, {}, { text: true, blocks: true });
    this.eng ??= await createWorker(['eng'], 1, options(this.log));
    this.stage = 'อ่านชื่อหุ้นและตรวจตัวเลขซ้ำ';
    const e = await this.eng.recognize(c, {}, { text: true, blocks: true });
    return { parse: parseDimeScreenshot(toPass(t.data as never), toPass(e.data as never)), width: c.width, height: c.height, preview };
  }

  async dispose() { await this.tha?.terminate(); await this.eng?.terminate(); this.tha = this.eng = undefined; }
}
