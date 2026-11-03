/**
 * Image preprocessing for OCR, shared by the browser (canvas ImageData) and the Node tests (PNG decode).
 * Converts RGBA pixels to grayscale and, for dark-mode screenshots, inverts them so text becomes dark on light,
 * which Tesseract reads far more reliably. Operates in place and returns whether the image was inverted.
 */
export function toOcrGrayscale(rgba: Uint8ClampedArray | Uint8Array): { inverted: boolean } {
  let sum = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    rgba[i] = rgba[i + 1] = rgba[i + 2] = y;
    sum += y;
  }
  const inverted = sum / n < 128; // dark background → invert
  if (inverted) for (let i = 0; i < rgba.length; i += 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = 255 - rgba[i];
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { inverted };
}
