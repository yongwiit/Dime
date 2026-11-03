// Pure parser tests on hand-built OCR passes. All tickers and values are fictional.
import { describe, it, expect } from 'vitest';
import { parseDimeScreenshot, type OcrLine, type OcrPass } from './dimeParser';

let y = 0;
const line = (text: string, conf = 92): OcrLine => {
  const bbox = { x0: 0, y0: y, x1: 1000, y1: y + 50 }; y += 80;
  return { text, confidence: conf, bbox, words: text.split(/\s+/).filter(Boolean).map(t => ({ text: t, confidence: conf, bbox })) };
};
function build(rows: [string, string, string][], opts: { header?: string; engQty?: string; engTicker?: string; side?: string; engDate?: string; thaDate?: string; noMonth?: boolean } = {}) {
  y = 0;
  const tha: OcrLine[] = [], eng: OcrLine[] = [];
  const push = (t: string, e: string) => { const l = line(t); tha.push(l); eng.push({ ...l, text: e, words: e.split(/\s+/).map(w => ({ text: w, confidence: 90, bbox: l.bbox })) }); };
  push(opts.header ?? 'เสร็จสิ้น', 'lasaau');
  if (!opts.noMonth) push('ตุลาคม 2568', 'x 2568');
  for (const [tk, qty, price] of rows) {
    push(`${opts.side ?? 'ซื้อ'}xx 684.20 บาท`, `iio ${opts.engTicker ?? tk} 684.20 un`);
    push(`ราคาที่ได้จริง ${price} ${opts.thaDate ?? '14 ต.ค. 68 - 10:05:33'} น.`, `s1 ${price} ${opts.engDate ?? '14 w.a. 68 - 10:05:33'} u.`);
    push(`จํานวนหุ้น ${qty}`, `91 ${opts.engQty ?? qty}`);
  }
  return { tha: { lines: tha } as OcrPass, eng: { lines: eng } as OcrPass };
}

describe('dime parser', () => {
  it('both passes agree → ok', () => {
    const { tha, eng } = build([['ZYXW', '0.1312507', '152.38']]);
    const r = parseDimeScreenshot(tha, eng).rows[0];
    expect([r.ticker.status, r.quantity.status, r.priceUSD.status, r.amountTHB.status, r.date.status, r.time.status]).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(r.date.value).toBe('2025-10-14');
  });
  it('passes disagree on a number → uncertain with both readings in the reason', () => {
    const { tha, eng } = build([['ZYXW', '0.1312507', '152.38']], { engQty: '0.1312501' });
    const q = parseDimeScreenshot(tha, eng).rows[0].quantity;
    expect(q.status).toBe('uncertain');
    expect(q.reason).toContain('0.1312501');
  });
  it('implausible effective FX flags quantity, price and amount', () => {
    const { tha, eng } = build([['ZYXW', '1.312507', '152.38']]); // one digit shifted → FX ≈ 3.4
    const r = parseDimeScreenshot(tha, eng).rows[0];
    expect([r.quantity.status, r.priceUSD.status, r.amountTHB.status]).toEqual(['uncertain', 'uncertain', 'uncertain']);
  });
  it('no ticker readable → missing, never invented', () => {
    const { tha, eng } = build([['ZYXW', '0.1312507', '152.38']], { engTicker: 'zyxw0' });
    const t = parseDimeScreenshot(tha, eng).rows[0].ticker;
    expect(t.status).toBe('missing');
    expect(t.value).toBeNull();
  });
  it('unreadable side word → row kept, side missing', () => {
    const { tha, eng } = build([['MNOP', '2.5329281', '9.87']], { side: '#2' });
    const r = parseDimeScreenshot(tha, eng).rows;
    expect(r.length).toBe(1);
    expect(r[0].side).toMatchObject({ value: null, status: 'missing' });
  });
  it('sell rows are read as SELL', () => {
    const { tha, eng } = build([['QRST', '0.2000000', '51.24']], { side: 'ขาย' });
    expect(parseDimeScreenshot(tha, eng).rows[0].side.value).toBe('SELL');
  });
  it('rows under a pending header are ignored', () => {
    const { tha, eng } = build([['ZYXW', '0.1312507', '152.38']], { header: 'รอดำเนินการ' });
    const r = parseDimeScreenshot(tha, eng);
    expect(r.rows).toEqual([]);
    expect(r.ignored.length).toBe(1);
    expect(r.completedSectionFound).toBe(false);
  });

  describe('date and time need both passes to agree', () => {
    const r = (o: Parameters<typeof build>[1]) => { const { tha, eng } = build([['ZYXW', '0.1312507', '152.38']], o); return parseDimeScreenshot(tha, eng).rows[0]; };
    it('agreeing passes + month header → date and time ok', () => {
      const x = r({});
      expect([x.date.status, x.time.status, x.date.value, x.time.value]).toEqual(['ok', 'ok', '2025-10-14', '10:05:33']);
    });
    it('different time in the English pass → time uncertain, both readings shown', () => {
      const x = r({ engDate: '14 w.a. 68 - 10:08:33' });
      expect(x.time.status).toBe('uncertain');
      expect(x.time.reason).toContain('10:08:33');
    });
    it('time read by one pass only → uncertain, not ok', () => {
      expect(r({ engDate: '14 w.a. 68 - u' }).time.status).toBe('uncertain');
    });
    it('different day in the English pass → date uncertain', () => {
      const x = r({ engDate: '18 w.a. 68 - 10:05:33' });
      expect(x.date.status).toBe('uncertain');
      expect(x.date.reason).toMatch(/ไม่ตรงกัน/);
    });
    it('English pass cannot read the day → date uncertain', () => {
      expect(r({ engDate: 'w.a. - 10:05:33' }).date.status).toBe('uncertain');
    });
    it('no month header to compare against → date uncertain', () => {
      expect(r({ noMonth: true }).date.status).toBe('uncertain');
    });
    it('row month differs from the month header → date uncertain', () => {
      expect(r({ thaDate: '14 พ.ย. 68 - 10:05:33' }).date.status).toBe('uncertain');
    });
    it('Thai month unreadable → date only suggested from the header, uncertain', () => {
      const x = r({ thaDate: '14 w.a. 68 - 10:05:33' });
      expect([x.date.status, x.date.value]).toEqual(['uncertain', '2025-10-14']);
    });
  });
});
