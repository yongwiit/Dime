import { describe, it, expect } from 'vitest';
import { applyImport, checkImportRows, deriveImport, type ImportRow } from './importer';
import { computePortfolio } from './engine';
import { migrate } from './store';
import type { AppData, Txn } from './types';

// The four buy orders from the user's Dime order history, 3 Nov 2026.
const DIME: [string, string, string, string][] = [
  ['GOOGL', '0.0236388', '280.47', '224.76'],
  ['SGOV', '0.0660161', '100.43', '224.76'],
  ['QQQM', '0.0314253', '281.62', '299.91'],
  ['VOO', '0.0320086', '692.00', '749.78'],
];
const EXPECTED_FX: Record<string, string> = { GOOGL: '33.900584', SGOV: '33.900468', QQQM: '33.888162', VOO: '33.850187' };

// Same shape as the app's first-run seed: four PENDING THB buys with unknown quantity/price/FX.
function seeded(): AppData {
  const now = '2026-11-03T02:00:00.000Z';
  const txns: Txn[] = DIME.map(([tk, , , thb], i) => ({
    id: `pending-${tk}-${i}`, datetime: '2026-11-03T09:00', type: 'BUY', status: 'PENDING', ticker: tk,
    amount: Number(thb), currency: 'THB', fees: 0, notes: 'seed', source: 'seed', createdAt: now, updatedAt: now,
  }));
  return {
    version: 1, txns, meta: {}, prices: {}, snapshots: [], fx: { rate: 33.87, asOf: '2026-11-03', source: 'manual' },
    settings: { theme: 'dark', maxDrawdownPct: 15, maxStockLossPct: 20, seeded: true },
  };
}
const rowsFor = (d: AppData, link: 'pending' | 'separate' | '' = 'pending'): ImportRow[] => DIME.map(([tk, q, pu, thb], i) => ({
  key: String(i), ticker: tk, quantity: q, priceUSD: pu, paid: thb, payCur: 'THB', fxRate: '', date: '2026-11-03', time: '',
  link: link === 'pending' ? d.txns.find(t => t.ticker === tk && t.status === 'PENDING')!.id : link,
}));
// "Reload": what IndexedDB returns is a structured clone; JSON round trip + migrate is the same path the app uses to load.
const reload = (d: AppData) => migrate(JSON.parse(JSON.stringify(d)));

describe('import workflow: four Dime orders linked to their PENDING transactions', () => {
  const before = seeded();
  const ids = before.txns.map(t => t.id);
  const after = reload(applyImport(before, rowsFor(before), '2026-11-03T15:00:00.000Z', () => { throw new Error('must not create new ids'); }));

  it('creates no duplicate and no new transaction', () => {
    expect(after.txns.length).toBe(4);
    expect(new Set(after.txns.map(t => t.id)).size).toBe(4);
  });
  it('preserves the original transaction IDs', () => {
    expect(after.txns.map(t => t.id).sort()).toEqual([...ids].sort());
  });
  it('leaves no PENDING order; all four are EXECUTED buys', () => {
    expect(after.txns.filter(t => t.status === 'PENDING')).toEqual([]);
    expect(after.txns.every(t => t.status === 'EXECUTED' && t.type === 'BUY')).toBe(true);
  });
  it('stores exact quantity, USD price, THB amount and derived FX after reload', () => {
    for (const [tk, q, pu, thb] of DIME) {
      const t = after.txns.find(x => x.ticker === tk)!;
      expect(t.quantity).toBe(Number(q));
      expect(t.priceUSD).toBe(Number(pu));
      expect(t.amount).toBe(Number(thb));
      expect(t.currency).toBe('THB');
      expect(t.fxRate).toBe(Number(thb) / (Number(q) * Number(pu)));
      expect(t.fxRate!.toFixed(6)).toBe(EXPECTED_FX[tk]);
      expect(t.datetime).toBe('2026-11-03T09:00');
      expect(t.createdAt).toBe(before.txns.find(x => x.id === t.id)!.createdAt);
    }
  });
  it('portfolio after reload: THB cost = amount paid, USD cost = qty × price, avg cost = Dime price', () => {
    const p = computePortfolio(after);
    expect(p.positions.length).toBe(4);
    expect(p.pending.length).toBe(0);
    for (const [tk, q, pu, thb] of DIME) {
      const x = p.positions.find(y => y.ticker === tk)!;
      expect(x.quantity).toBe(Number(q));
      expect(x.costTHB).toBe(Number(thb));
      expect(Math.abs(x.costUSD - Number(q) * Number(pu))).toBeLessThan(1e-12);
      expect(Math.abs(x.avgCostUSD - Number(pu))).toBeLessThan(1e-9);
    }
    expect(p.investedTHB).toBeCloseTo(1499.21, 10);
    expect(p.investedUSD).toBeCloseTo(6.629974236 + 6.629996923 + 8.849992986 + 22.1499512, 9);
  });
  it('does not mutate the input data', () => {
    expect(before.txns.every(t => t.status === 'PENDING')).toBe(true);
  });
});

describe('import safeguards', () => {
  it('requires an explicit link choice when a PENDING order exists for the ticker', () => {
    const d = seeded();
    const checks = checkImportRows(d, rowsFor(d, ''));
    expect(checks.every(c => c.errors.includes('เลือกว่าเกี่ยวกับคำสั่งรอดำเนินการหรือไม่'))).toBe(true);
    expect(() => applyImport(d, rowsFor(d, ''))).toThrow();
  });
  it('rejects the same pending order linked twice and a link to another ticker', () => {
    const d = seeded();
    const rows = rowsFor(d);
    rows[1].link = rows[0].link; // SGOV row pointing at GOOGL's pending order
    const c = checkImportRows(d, rows);
    expect(c[1].errors).toContain('คำสั่งรอที่เลือกเป็นหุ้นคนละตัว');
    expect(c[0].errors).toContain('เลือกคำสั่งรอเดียวกันซ้ำ');
    expect(() => applyImport(d, rows)).toThrow();
  });
  it('a failing row saves nothing (all-or-nothing)', () => {
    const d = seeded();
    const rows = rowsFor(d);
    rows[3].quantity = '';
    expect(() => applyImport(d, rows)).toThrow(/แถวที่ 4/);
    expect(d.txns.every(t => t.status === 'PENDING')).toBe(true);
  });
  it('"separate" keeps the pending order and adds a new executed buy', () => {
    const d = seeded();
    const rows = rowsFor(d).slice(0, 1).map(r => ({ ...r, link: 'separate' }));
    let n = 0;
    const out = applyImport(d, rows, '2026-11-03T15:00:00.000Z', () => `new-${++n}`);
    expect(out.txns.length).toBe(5);
    expect(out.txns.filter(t => t.ticker === 'GOOGL').map(t => t.status).sort()).toEqual(['EXECUTED', 'PENDING']);
  });
  it('warns when the paid amount differs from the linked pending order', () => {
    const d = seeded();
    const rows = rowsFor(d);
    rows[0].paid = '230';
    expect(checkImportRows(d, rows)[0].warnings.some(w => w.includes('ไม่ตรงกับคำสั่งรอ'))).toBe(true);
  });
  it('USD-paid rows use the entered FX', () => {
    expect(deriveImport({ quantity: '1', priceUSD: '100', paid: '100', payCur: 'USD', fxRate: '34' })).toEqual({ usd: 100, thb: 3400, fx: 34 });
  });
});

describe('cash tracking is explicit, never inferred', () => {
  const base = () => {
    const d = reload(applyImport(seeded(), rowsFor(seeded())));
    const now = '2026-11-03T15:00:00.000Z';
    d.txns.push({ id: 'dep1', datetime: '2026-11-01T10:00', type: 'DEPOSIT', status: 'EXECUTED', amount: 1000, currency: 'THB', fxRate: 33.9, fees: 0, source: 'manual', createdAt: now, updatedAt: now });
    return d;
  };
  it('one recorded deposit does not turn cash tracking on', () => {
    const p = computePortfolio(base());
    expect(p.cashTracked).toBe(false);
    expect(p.cashTxnCount).toBe(1);
    expect(p.totalValueTHB).toBeCloseTo(p.holdingsValueTHB, 10);
  });
  it('cash is included only after the user confirms', () => {
    const d = base();
    d.settings.cashTracking = { confirmedAt: '2026-11-03T15:05:00.000Z' };
    const p = computePortfolio(reload(d));
    expect(p.cashTracked).toBe(true);
    expect(p.cashTHB).toBeCloseTo(1000 - 1499.21, 10);
    expect(p.totalValueTHB).toBeCloseTo(p.holdingsValueTHB + p.cashTotalTHB, 10);
  });
  it('turning tracking off excludes cash again', () => {
    const d = base();
    d.settings.cashTracking = null;
    expect(computePortfolio(d).cashTracked).toBe(false);
  });
});
