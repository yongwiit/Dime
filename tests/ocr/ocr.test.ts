// Real OCR tests on FULLY SYNTHETIC screenshots (tests/fixtures/make-fixtures.py — fictional tickers, dates and
// amounts, drawn from scratch). Every test runs Tesseract on an actual image through the same preprocessing,
// language data and parser the browser uses. Ground truth comes from tests/fixtures/synthetic-expected.json.
import { describe, it, expect, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { ocrPng, closeOcr } from './nodeOcr';
import type { ExtractedRow, ParseResult } from '../../src/ocr/dimeParser';
import { toImportRows } from '../../src/ocr/toImportRows';
import { applyImport, checkImportRows, suggestedPending, type ImportRow } from '../../src/importer';
import { computePortfolio } from '../../src/engine';
import { migrate } from '../../src/store';
import type { AppData, Txn } from '../../src/types';

interface Truth { side: 'BUY' | 'SELL'; ticker: string; date: string; time: string; priceUSD: string; quantity: string; amountTHB: string }
const TRUTH: { completed: Truth[]; ignored: Record<string, Truth>; totalTHB: string } = JSON.parse(readFileSync('tests/fixtures/synthetic-expected.json', 'utf8'));
const EXP = TRUTH.completed;
const COMPLETED = 'tests/fixtures/synthetic-completed.png';
const SECTIONS = 'tests/fixtures/synthetic-sections.png';
const FIELDS = ['side', 'ticker', 'priceUSD', 'quantity', 'amountTHB', 'date', 'time'] as const;
const T = 120_000;

const readPng = (f: string) => PNG.sync.read(readFileSync(f));
function crop(png: PNG, y0: number, y1: number) {
  const out = new PNG({ width: png.width, height: y1 - y0 });
  png.data.copy(out.data, 0, y0 * png.width * 4, y1 * png.width * 4);
  return out;
}
/** Simulates an unclear screenshot: shrink by `f` (box filter) then enlarge again (nearest). */
function degrade(png: PNG, f: number) {
  const w = Math.round(png.width * f), h = Math.round(png.height * f), s = 1 / f;
  const small = new Float64Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.floor(y * s); yy < Math.min(png.height, Math.floor((y + 1) * s)); yy++)
      for (let xx = Math.floor(x * s); xx < Math.min(png.width, Math.floor((x + 1) * s)); xx++) {
        const i = (yy * png.width + xx) * 4; r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
      }
    small.set([r / n, g / n, b / n], (y * w + x) * 3);
  }
  const out = new PNG({ width: png.width, height: png.height });
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const j = (Math.min(h - 1, Math.floor(y * f)) * w + Math.min(w - 1, Math.floor(x * f))) * 3, i = (y * png.width + x) * 4;
    out.data[i] = small[j]; out.data[i + 1] = small[j + 1]; out.data[i + 2] = small[j + 2]; out.data[i + 3] = 255;
  }
  return out;
}
const truthFor = (r: ExtractedRow, i: number) => EXP.find(e => e.ticker === r.ticker.value && e.time === r.time.value) ?? EXP[i];
/** The safety property that matters most: a field marked "ok" must be correct. Wrong values may only appear flagged. */
function confidentlyWrong(rows: ExtractedRow[]) {
  const wrong: string[] = [];
  rows.forEach((r, i) => {
    const exp = EXP.find(e => e.ticker === r.ticker.value && (r.time.value === null || e.time === r.time.value));
    if (!exp) { if (r.ticker.status === 'ok') wrong.push(`row ${i + 1}: unknown ticker ${r.ticker.value} marked ok`); return; }
    for (const f of FIELDS) if (r[f].status === 'ok' && r[f].value !== exp[f]) wrong.push(`${exp.ticker}.${f}=${r[f].value}`);
  });
  return wrong;
}
/** What the user does on the review screen: compare each flagged value with the screenshot, fix or confirm it. */
function userReviews(rows: ImportRow[]): ImportRow[] {
  return rows.map((r, i) => {
    const exp = EXP[i];
    const fixed = { ...r };
    for (const f of r.unverified ?? []) {
      const key = f === 'paid' ? 'amountTHB' : f;
      (fixed as unknown as Record<string, string>)[f === 'paid' ? 'paid' : f] = (exp as unknown as Record<string, string>)[key];
    }
    return { ...fixed, unverified: [] };
  });
}
function appWith(pending: Truth[]): AppData {
  const now = '2025-10-01T00:00:00.000Z';
  const txns: Txn[] = pending.map(e => ({ id: `pending-${e.ticker}`, datetime: `${e.date}T08:00`, type: e.side, status: 'PENDING', ticker: e.ticker, amount: Number(e.amountTHB), currency: 'THB', fees: 0, source: 'manual', createdAt: now, updatedAt: now }));
  return { version: 1, txns, meta: {}, prices: {}, snapshots: [], fx: { rate: 34.1, asOf: '2025-10-21', source: 'manual' }, settings: { theme: 'dark', maxDrawdownPct: 15, maxStockLossPct: 20, seeded: true } };
}

afterAll(() => closeOcr());

let parsed: ParseResult;
describe('synthetic completed-section screenshot', () => {
  it('finds all five transactions with the right values; unreadable values are flagged, never wrong-and-ok', async () => {
    parsed = await ocrPng(readPng(COMPLETED));
    expect(parsed.completedSectionFound).toBe(true);
    expect(parsed.ignored).toEqual([]);
    expect(parsed.rows.length).toBe(EXP.length);
    expect(parsed.rows.map(r => r.ticker.value)).toEqual(EXP.map(e => e.ticker));
    parsed.rows.forEach((r, i) => {
      for (const f of ['ticker', 'priceUSD', 'quantity', 'amountTHB', 'date', 'time'] as const) expect(r[f].value, `${EXP[i].ticker}.${f}`).toBe(EXP[i][f]);
      // the side word may be unreadable: then it must be empty and flagged, not assumed
      if (r.side.status === 'ok') expect(r.side.value).toBe(EXP[i].side); else expect(r.side.value).toBeNull();
    });
    expect(confidentlyWrong(parsed.rows)).toEqual([]);
  }, T);

  it('total THB matches the ground truth', () => {
    expect(parsed.rows.reduce((a, r) => a + Number(r.amountTHB.value), 0)).toBeCloseTo(Number(TRUTH.totalTHB), 10);
  });

  it('every flagged field has a reason, and flagged rows cannot be imported before review', () => {
    for (const r of parsed.rows) for (const f of FIELDS) if (r[f].status !== 'ok') expect(r[f].reason).toBeTruthy();
    const rows = toImportRows(parsed.rows).map(r => ({ ...r, link: 'separate' as const }));
    const checks = checkImportRows(appWith([]), rows);
    rows.forEach((r, i) => { if (r.unverified?.length) expect(checks[i].errors.join(' ')).toMatch(/ต้องตรวจสอบกับภาพ|ประเภท/); });
  });

  it('dates and times are "ok" only when both OCR passes agree', () => {
    for (const r of parsed.rows) {
      if (r.time.status === 'ok') expect(r.time.reason).toBeUndefined();
      if (r.date.status !== 'ok') expect(r.date.reason).toMatch(/โปรดตรวจ/);
    }
  });

  it('links to existing PENDING orders, preserves their ids, no duplicates, exact values after reload', () => {
    const pendingFor = EXP.filter(e => ['ZYXW', 'MNOP'].includes(e.ticker));
    const d = appWith(pendingFor);
    const rows = userReviews(toImportRows(parsed.rows)).map(r => ({ ...r, link: suggestedPending(d, r)?.id ?? 'separate' }));
    expect(rows.filter(r => r.link !== 'separate').map(r => r.link)).toEqual(['pending-ZYXW', 'pending-MNOP']);
    let n = 0;
    const after = migrate(JSON.parse(JSON.stringify(applyImport(d, rows, '2025-10-22T00:00:00.000Z', () => `new-${++n}`))));
    expect(after.txns.length).toBe(2 + 3); // 2 pending updated in place + 3 new
    expect(after.txns.filter(t => t.id.startsWith('pending-')).every(t => t.status === 'EXECUTED')).toBe(true);
    expect(new Set(after.txns.map(t => t.id)).size).toBe(after.txns.length);
    for (const e of EXP) {
      const t = after.txns.find(x => x.ticker === e.ticker && x.datetime === `${e.date}T${e.time}`)!;
      expect(t, e.ticker).toBeTruthy();
      expect(t.type).toBe(e.side);
      expect(t.quantity).toBe(Number(e.quantity));
      expect(t.priceUSD).toBe(Number(e.priceUSD));
      expect(t.amount).toBe(Number(e.amountTHB));
      expect(t.fxRate).toBe(Number(e.amountTHB) / (Number(e.quantity) * Number(e.priceUSD)));
    }
    const p = computePortfolio(after);
    expect(p.positions.find(x => x.ticker === 'QRST')!.quantity).toBeCloseTo(0.6369427 - 0.2, 12); // sell applied after the buy
  });

  it('importing the same screenshot again is blocked as duplicates until decided', () => {
    const d = appWith([]);
    const first = userReviews(toImportRows(parsed.rows)).map(r => ({ ...r, link: 'separate' as const }));
    const once = applyImport(d, first);
    const again = userReviews(toImportRows(parsed.rows)).map(r => ({ ...r, link: 'separate' as const }));
    const checks = checkImportRows(once, again);
    expect(checks.every(c => c.duplicateOf && c.duplicateOf !== 'batch')).toBe(true);
    expect(() => applyImport(once, again)).toThrow();
  });

  it('the same screenshot twice in one batch is flagged within the batch', () => {
    const one = userReviews(toImportRows(parsed.rows));
    const rows = [...one, ...one.map(r => ({ ...r, key: r.key + '-b' }))].map(r => ({ ...r, link: 'separate' as const }));
    const checks = checkImportRows(appWith([]), rows);
    expect(checks.slice(EXP.length).every(c => c.duplicateOf === 'batch')).toBe(true);
    expect(checks.slice(0, EXP.length).every(c => !c.duplicateOf)).toBe(true);
  });
});

describe('synthetic screenshot with pending, completed and cancelled sections', () => {
  it('imports only the completed rows; pending and cancelled rows are ignored with a reason', async () => {
    const r = await ocrPng(readPng(SECTIONS));
    expect(r.completedSectionFound).toBe(true);
    expect(r.rows.map(x => x.ticker.value)).toEqual(EXP.map(e => e.ticker));
    expect(r.rows.some(x => [TRUTH.ignored.pending.ticker, TRUTH.ignored.cancelled.ticker].includes(x.ticker.value ?? ''))).toBe(false);
    expect(r.ignored.length).toBe(2);
    expect(r.ignored[0].reason).toMatch(/รอดำเนินการ/);
    expect(r.ignored[1].reason).toMatch(/ยกเลิก/);
    expect(confidentlyWrong(r.rows)).toEqual([]);
  }, T);
});

describe('unclear and incomplete screenshots', () => {
  it('top cropped (no "เสร็จสิ้น" header) → nothing is imported', async () => {
    const png = readPng(COMPLETED);
    const r = await ocrPng(crop(png, 810, png.height));
    expect(r.completedSectionFound).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.notices.join(' ')).toMatch(/ไม่พบหัวข้อ “เสร็จสิ้น”/);
  }, T);

  it('last row cut through its quantity line → quantity missing, row blocked', async () => {
    const r = await ocrPng(crop(readPng(COMPLETED), 0, 2430));
    const last = r.rows.find(x => x.ticker.value === 'KLMN')!;
    expect(last).toBeTruthy();
    expect(last.quantity).toMatchObject({ value: null, status: 'missing' });
    const c = checkImportRows(appWith([]), toImportRows([last]).map(x => ({ ...x, link: 'separate' as const })))[0];
    expect(c.errors).toContain('จำนวนหุ้น');
    expect(confidentlyWrong(r.rows)).toEqual([]);
  }, T);

  it('blurred low-resolution screenshot → no field marked ok with a wrong value', async () => {
    const r = await ocrPng(degrade(readPng(COMPLETED), 0.33));
    expect(confidentlyWrong(r.rows)).toEqual([]);
  }, T);
});
