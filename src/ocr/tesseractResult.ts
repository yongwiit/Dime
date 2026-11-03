import type { OcrLine, OcrPass } from './dimeParser';

// Normalises a Tesseract.js result (v5 exposes `lines`; newer versions nest them in `blocks`).
interface TLine { text: string; confidence: number; bbox: OcrLine['bbox']; words: { text: string; confidence: number; bbox: OcrLine['bbox'] }[] }
interface TData { lines?: TLine[]; blocks?: { paragraphs: { lines: TLine[] }[] }[] | null }

export function toPass(data: TData): OcrPass {
  const lines = data.lines?.length ? data.lines : (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines));
  return {
    lines: lines.map(l => ({
      text: l.text.trim(), confidence: l.confidence, bbox: l.bbox,
      words: l.words.map(w => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })),
    })),
  };
}
