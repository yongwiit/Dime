import { describe, it, expect } from 'vitest';
import { computePortfolio, validateTxn, maxDrawdownFromPeak } from './engine';
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
