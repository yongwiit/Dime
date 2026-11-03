// Copies the Tesseract.js worker, WASM core and language data from node_modules into public/tesseract
// so the app serves them itself (no CDN at runtime). public/tesseract is git-ignored and rebuilt on demand.
import { cpSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const out = path.resolve('public/tesseract');
const pkgDir = name => path.dirname(require.resolve(`${name}/package.json`));
const files = [
  [path.join(pkgDir('tesseract.js'), 'dist/worker.min.js'), 'worker.min.js'],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']
    .map(f => [path.join(pkgDir('tesseract.js-core'), f), `core/${f}`]),
  [path.join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int/eng.traineddata.gz'), 'lang/eng.traineddata.gz'],
  [path.join(pkgDir('@tesseract.js-data/tha'), '4.0.0_best_int/tha.traineddata.gz'), 'lang/tha.traineddata.gz'],
];
let bytes = 0;
for (const [src, rel] of files) {
  if (!existsSync(src)) continue; // optional variants
  const dst = path.join(out, rel);
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst);
  bytes += statSync(dst).size;
}
console.log(`OCR assets copied to public/tesseract (${(bytes / 1048576).toFixed(1)} MB)`);
