import { describe, it, expect } from 'vitest';
import { computePortfolio, validateTxn, maxDrawdownFromPeak, checkAgainstPortfolio } from './engine';
import { parseCommand } from './parser';
import { txnsToCSV, csvToTxns } from './csv';
import type { AppData, Txn } from './types';

let n = 0;
const tx = (p: Partial<Txn>): Txn => ({
  id: String(++n), datetime: '2026-01-01T10:00', type: 'BUY', status: 'EXECUTED', amount: 0, currency: 'USD',
  fees: 0, source: 'manual', createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}`, updatedAt: '', ...p,
});
const data = (txns: Txn[], prices: AppData['prices'] = {}, rate = 35): AppData => ({
  version: 1, txns, meta: {}, prices, fx: { rate, asOf: '', source: 'manual' }, snapshots: [],
  settings: { theme: 'dark', maxDrawdownPct: 15, maxStockLossPct: 20 },
});

describe('portfolio engine', () => {
  it('weighted average cost with fees capitalised', () => {
    const p = computePortfolio(data([
      tx({ ticker: 'AAPL', quantity: 2, price: 100, amount: 200, fees: 2, fxRate: 34, datetime: '2026-01-01T10:00' }),
      tx({ ticker: 'AAPL', quantity: 2, price: 200, amount: 400, fees: 0, fxRate: 36, datetime: '2026-02-01T10:00' }),
    ], { AAPL: { ticker: 'AAPL', price: 250, asOf: '', source: 'manual' } }));
    const a = p.positions[0];
    expect(a.quantity).toBe(4);
    expect(a.costUSD).toBeCloseTo(602);
    expect(a.avgCostUSD).toBeCloseTo(150.5);
    expect(a.costTHB).toBeCloseTo(202 * 34 + 400 * 36);
    expect(a.marketValueUSD).toBeCloseTo(1000);
    expect(a.unrealizedUSD).toBeCloseTo(398);
    expect(a.unrealizedTHB).toBeCloseTo(1000 * 35 - (202 * 34 + 400 * 36));
  });

  it('realized P/L on sell uses average cost; THB includes FX effect', () => {
    const p = computePortfolio(data([
      tx({ ticker: 'X', quantity: 10, price: 10, amount: 100, fxRate: 30, datetime: '2026-01-01T10:00' }),
      tx({ type: 'SELL', ticker: 'X', quantity: 4, price: 15, amount: 60, fees: 1, fxRate: 32, datetime: '2026-03-01T10:00' }),
    ], { X: { ticker: 'X', price: 15, asOf: '', source: 'manual' } }));
    expect(p.positions[0].quantity).toBe(6);
    expect(p.realizedUSD).toBeCloseTo(59 - 40);
    expect(p.realizedTHB).toBeCloseTo(59 * 32 - 40 * 30);
    expect(p.positions[0].costUSD).toBeCloseTo(60);
    expect(p.cashUSD).toBeCloseTo(-100 + 59);
  });

  it('pending and cancelled orders never affect holdings or cash', () => {
    const p = computePortfolio(data([
      tx({ ticker: 'GOOGL', status: 'PENDING', amount: 224.76, currency: 'THB' }),
      tx({ ticker: 'VOO', status: 'CANCELLED', amount: 749.78, currency: 'THB' }),
    ]));
    expect(p.positions.length).toBe(0);
    expect(p.cashTHB).toBe(0);
    expect(p.pending.length).toBe(1);
    expect(p.pendingTHB).toBeCloseTo(224.76);
    expect(p.cancelled.length).toBe(1);
  });

  it('THB-settled buy reduces THB cash and records USD cost at the trade rate', () => {
    const p = computePortfolio(data([
      tx({ type: 'DEPOSIT', amount: 5000, currency: 'THB', fxRate: 35 }),
      tx({ ticker: 'VOO', quantity: 0.2, price: 500, amount: 3500, currency: 'THB', fxRate: 35, datetime: '2026-01-02T10:00' }),
    ]));
    expect(p.cashTHB).toBeCloseTo(1500);
    expect(p.positions[0].costUSD).toBeCloseTo(100);
    expect(p.estimated).toBe(true); // no price entered yet
    expect(p.netDepositsTHB).toBe(5000);
  });

  it('dividends net of withholding increase cash and total return', () => {
    const p = computePortfolio(data([
      tx({ ticker: 'X', quantity: 1, price: 100, amount: 100, fxRate: 35 }),
      tx({ type: 'DIVIDEND', ticker: 'X', amount: 1, fees: 0.15, fxRate: 35, datetime: '2026-02-01T10:00' }),
    ]));
    expect(p.dividendsTHB).toBeCloseTo(0.85 * 35);
  });

  it('caps oversell and warns', () => {
    const p = computePortfolio(data([
      tx({ ticker: 'X', quantity: 1, price: 10, amount: 10, fxRate: 35 }),
      tx({ type: 'SELL', ticker: 'X', quantity: 2, price: 10, amount: 20, fxRate: 35, datetime: '2026-02-01T10:00' }),
    ]));
    expect(p.warnings.some(w => w.includes('มากกว่าที่ถืออยู่'))).toBe(true);
    expect(p.positions.length).toBe(0);
  });

  it('oversell does not overstate cash: proceeds and fees scaled to shares held', () => {
    const p = computePortfolio(data([
      tx({ type: 'DEPOSIT', amount: 100, currency: 'USD', fxRate: 35 }),
      tx({ ticker: 'X', quantity: 1, price: 10, amount: 10, fxRate: 35, datetime: '2026-01-02T10:00' }),
      tx({ type: 'SELL', ticker: 'X', quantity: 2, price: 12, amount: 24, fees: 2, fxRate: 35, datetime: '2026-02-01T10:00' }),
    ]));
    // only 1 share existed: proceeds 12, fee 1
    expect(p.cashUSD).toBeCloseTo(100 - 10 + 12 - 1);
    expect(p.realizedUSD).toBeCloseTo(11 - 10);
    expect(p.feesTHB).toBeCloseTo(1 * 35);
  });

  it('repeated partial sells: average cost is unchanged by sells, realized sums correctly', () => {
    const p = computePortfolio(data([
      tx({ ticker: 'X', quantity: 10, price: 10, amount: 100, fees: 1, fxRate: 34, datetime: '2026-01-01T10:00' }),
      tx({ ticker: 'X', quantity: 10, price: 20, amount: 200, fees: 1, fxRate: 36, datetime: '2026-01-15T10:00' }),
      tx({ type: 'SELL', ticker: 'X', quantity: 5, price: 18, amount: 90, fees: 0.5, fxRate: 35, datetime: '2026-02-01T10:00' }),
      tx({ type: 'SELL', ticker: 'X', quantity: 7, price: 22, amount: 154, fees: 0.5, fxRate: 33, datetime: '2026-03-01T10:00' }),
    ], { X: { ticker: 'X', price: 25, asOf: '', source: 'manual' } }));
    const avg = 302 / 20;
    const x = p.positions[0];
    expect(x.quantity).toBeCloseTo(8);
    expect(x.avgCostUSD).toBeCloseTo(avg);
    expect(x.costUSD).toBeCloseTo(avg * 8);
    expect(p.realizedUSD).toBeCloseTo((89.5 - avg * 5) + (153.5 - avg * 7));
    const costTHB = 101 * 34 + 201 * 36, avgTHB = costTHB / 20;
    expect(p.realizedTHB).toBeCloseTo((89.5 * 35 - avgTHB * 5) + (153.5 * 33 - avgTHB * 7));
    expect(x.costTHB).toBeCloseTo(avgTHB * 8);
  });

  it('mixed THB and USD settlement with fees stays consistent in both currencies', () => {
    const p = computePortfolio(data([
      tx({ type: 'DEPOSIT', amount: 7000, currency: 'THB', fxRate: 35 }),
      tx({ type: 'DEPOSIT', amount: 100, currency: 'USD', fxRate: 35 }),
      tx({ ticker: 'X', quantity: 1, price: 3500, amount: 3500, fees: 35, currency: 'THB', fxRate: 35, datetime: '2026-01-02T10:00' }), // $101 cost
      tx({ ticker: 'X', quantity: 1, price: 98, amount: 98, fees: 1, currency: 'USD', fxRate: 34, datetime: '2026-01-03T10:00' }), // $99 cost, ฿3366
      tx({ type: 'SELL', ticker: 'X', quantity: 2, price: 110, amount: 220, fees: 2, currency: 'USD', fxRate: 36, datetime: '2026-02-01T10:00' }),
    ]));
    expect(p.positions.length).toBe(0);
    expect(p.cashTHB).toBeCloseTo(7000 - 3535);
    expect(p.cashUSD).toBeCloseTo(100 - 99 + 218);
    expect(p.realizedUSD).toBeCloseTo(218 - 200);
    expect(p.realizedTHB).toBeCloseTo(218 * 36 - (3535 + 99 * 34));
    expect(p.feesTHB).toBeCloseTo(35 + 34 + 72);
  });

  it('closing a position: realized + remaining cost equals all net cash flows', () => {
    const txns = [
      tx({ ticker: 'X', quantity: 3, price: 50, amount: 150, fees: 1, fxRate: 34, datetime: '2026-01-01T10:00' }),
      tx({ type: 'SELL', ticker: 'X', quantity: 1, price: 60, amount: 60, fees: 1, fxRate: 35, datetime: '2026-02-01T10:00' }),
      tx({ ticker: 'X', quantity: 2, price: 40, amount: 80, fees: 1, fxRate: 33, datetime: '2026-03-01T10:00' }),
      tx({ type: 'SELL', ticker: 'X', quantity: 4, price: 55, amount: 220, fees: 1, fxRate: 36, datetime: '2026-04-01T10:00' }),
    ];
    const p = computePortfolio(data(txns));
    expect(p.positions.length).toBe(0);
    expect(p.realizedUSD).toBeCloseTo((59 + 219) - (151 + 81));
    expect(p.realizedTHB).toBeCloseTo((59 * 35 + 219 * 36) - (151 * 34 + 81 * 33));
    expect(p.cashUSD).toBeCloseTo(p.realizedUSD);
  });

  it('entry check blocks selling more than held at that date', () => {
    const d = data([
      tx({ id: 'b1', ticker: 'X', quantity: 2, price: 10, amount: 20, fxRate: 35, datetime: '2026-01-01T10:00' }),
      tx({ id: 'b2', ticker: 'X', quantity: 5, price: 10, amount: 50, fxRate: 35, datetime: '2026-03-01T10:00' }),
    ]);
    const sell = { type: 'SELL' as const, status: 'EXECUTED' as const, ticker: 'X', quantity: 3, datetime: '2026-02-01T10:00' };
    expect(checkAgainstPortfolio(d, sell).length).toBe(1); // only 2 held in February
    expect(checkAgainstPortfolio(d, { ...sell, datetime: '2026-04-01T10:00' })).toEqual([]);
    expect(checkAgainstPortfolio(d, { ...sell, status: 'PENDING' })).toEqual([]);
  });

  it('validation requires execution details for executed trades only', () => {
    expect(validateTxn({ type: 'BUY', status: 'PENDING', ticker: 'A', amount: 100, currency: 'THB', datetime: '2026-01-01T00:00' })).toEqual([]);
    expect(validateTxn({ type: 'BUY', status: 'EXECUTED', ticker: 'A', amount: 100, currency: 'THB', datetime: '2026-01-01T00:00' }).length).toBe(3);
  });

  it('drawdown ignores new deposits', () => {
    const d = maxDrawdownFromPeak([
      { holdingsTHB: 1000, investedTHB: 1000 }, { holdingsTHB: 1200, investedTHB: 1000 }, { holdingsTHB: 2000, investedTHB: 2000 },
    ]);
    expect(d.current).toBeCloseTo((1 / 1.2 - 1) * 100);
  });
});

describe('command parser', () => {
  it('buy by THB amount → pending candidate with missing execution fields', () => {
    const r = parseCommand('ซื้อ AAPL 2,000 บาท');
    expect(r?.draft.type).toBe('BUY');
    expect(r?.draft.ticker).toBe('AAPL');
    expect(r?.draft.amount).toBe(2000);
    expect(r?.draft.currency).toBe('THB');
    expect(r?.missingForExecuted).toContain('จำนวนหุ้นที่ได้จริง');
  });
  it('buy shares with USD price', () => {
    const r = parseCommand('ซื้อ NVDA จำนวน 1 หุ้น ราคา 180 USD');
    expect(r?.draft).toMatchObject({ type: 'BUY', ticker: 'NVDA', quantity: 1, price: 180, amount: 180, currency: 'USD' });
  });
  it('deposit', () => {
    expect(parseCommand('เพิ่มเงินลงทุน 5,000 บาท')?.draft).toMatchObject({ type: 'DEPOSIT', amount: 5000, currency: 'THB' });
  });
  it('sell', () => {
    expect(parseCommand('ขาย TSLA 1,500 บาท')?.draft).toMatchObject({ type: 'SELL', ticker: 'TSLA', amount: 1500 });
  });
  it('english buy', () => {
    expect(parseCommand('buy 3 shares of msft at 410.5')?.draft).toMatchObject({ type: 'BUY', ticker: 'MSFT', quantity: 3, price: 410.5, currency: 'USD' });
  });
  it('questions are not commands', () => {
    expect(parseCommand('ช่วยวิเคราะห์พอร์ตปัจจุบัน')).toBeNull();
    expect(parseCommand('ถ้ามีเงินเพิ่ม 5,000 บาท ควร DCA ตัวไหน')).toBeNull();
  });
});

describe('csv', () => {
  it('round trips', () => {
    const t = [tx({ ticker: 'AAPL', quantity: 1.5, price: 100, amount: 150, fxRate: 35, notes: 'a, "b"' })];
    const back = csvToTxns(txnsToCSV(t));
    expect(back.errors).toEqual([]);
    expect(back.txns[0]).toMatchObject({ ticker: 'AAPL', quantity: 1.5, price: 100, amount: 150, fxRate: 35, notes: 'a, "b"' });
  });
});

describe('Dime order-history import (3 Nov 2026 rows)', () => {
  const ROWS: [string, number, number, number][] = [
    ['GOOGL', 0.0236388, 280.47, 224.76], ['SGOV', 0.0660161, 100.43, 224.76],
    ['QQQM', 0.0314253, 281.62, 299.91], ['VOO', 0.0320086, 692.0, 749.78],
  ];
  it('derives FX = THB paid ÷ (quantity × USD price) without rounding', async () => {
    const { deriveImport } = await import('./importer');
    const d = deriveImport({ quantity: '0.0236388', priceUSD: '280.47', paid: '224.76', payCur: 'THB', fxRate: '' });
    expect(d.usd).toBeCloseTo(6.629974236, 12);
    expect(d.fx).toBeCloseTo(224.76 / (0.0236388 * 280.47), 12);
    expect(d.fx.toFixed(4)).toBe('33.9006');
  });
  it('stores exact THB and USD cost at purchase FX; quantity and price unrounded', () => {
    const txns = ROWS.map(([tk, q, pu, thb], i) => tx({ id: 'p' + i, ticker: tk, quantity: q, price: thb / q, priceUSD: pu, amount: thb, currency: 'THB', fxRate: thb / (q * pu), datetime: '2026-11-03T09:00' }));
    const p = computePortfolio(data(txns, {}, 33.87));
    for (const [tk, q, pu, thb] of ROWS) {
      const x = p.positions.find(y => y.ticker === tk)!;
      expect(x.quantity).toBe(q);
      expect(x.costTHB).toBe(thb);
      expect(Math.abs(x.costUSD - q * pu)).toBeLessThan(1e-12);
      expect(Math.abs(x.avgCostUSD - pu)).toBeLessThan(1e-9);
    }
    expect(p.investedTHB).toBeCloseTo(1499.21, 10);
    expect(p.investedUSD).toBeCloseTo(6.629974236 + 6.629996923 + 8.849992986 + 22.1499512, 9);
    expect(p.cashTracked).toBe(false);
    expect(p.totalValueTHB).toBeCloseTo(p.holdingsValueTHB, 10); // no deposits recorded → cash not counted
    expect(p.warnings.filter(w => w.includes('ติดลบ'))).toEqual([]);
  });
});
