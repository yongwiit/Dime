import { get, set } from 'idb-keyval';
import { useEffect, useState, useCallback } from 'react';
import type { AppData, Snapshot, Txn } from './types';
import { computePortfolio } from './engine';
import { localISO } from './parser';

const KEY = 'dime-portfolio-v1';

export function emptyData(): AppData {
  return {
    version: 1, txns: [], meta: {}, prices: {}, snapshots: [],
    fx: { rate: 0, asOf: '', source: 'manual' },
    settings: { theme: 'dark', maxDrawdownPct: 15, maxStockLossPct: 20 },
  };
}

// The four buy orders shown as PENDING in the user's Dime screenshot on 3 Nov 2026.
// Amounts only: quantity, execution price and FX are unknown until Dime executes them.
function seedPending(): Txn[] {
  const now = new Date().toISOString();
  return [
    ['GOOGL', 224.76], ['SGOV', 224.76], ['QQQM', 299.91], ['VOO', 749.78],
  ].map(([ticker, amount]) => ({
    id: crypto.randomUUID(), datetime: '2026-11-03T09:00', type: 'BUY', status: 'PENDING',
    ticker: ticker as string, amount: amount as number, currency: 'THB', fees: 0,
    notes: 'คำสั่งซื้อรอดำเนินการจากภาพหน้าจอ Dime 3 พ.ย. 2026 — ยังไม่ทราบจำนวนหุ้น/ราคาที่ได้จริง',
    source: 'seed', createdAt: now, updatedAt: now,
  } as Txn));
}

const DEFAULT_META: AppData['meta'] = {
  GOOGL: { ticker: 'GOOGL', name: 'Alphabet Inc. Class A', sector: 'Communication Services', horizon: 'long' },
  SGOV: { ticker: 'SGOV', name: 'iShares 0-3 Month Treasury Bond ETF', sector: 'Cash-like / T-Bills ETF', horizon: 'long' },
  QQQM: { ticker: 'QQQM', name: 'Invesco NASDAQ 100 ETF', sector: 'Broad ETF – Nasdaq-100', horizon: 'long' },
  VOO: { ticker: 'VOO', name: 'Vanguard S&P 500 ETF', sector: 'Broad ETF – S&P 500', horizon: 'long' },
};

export function migrate(raw: unknown): AppData {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  const d = raw as Partial<AppData>;
  if (!Array.isArray(d.txns)) throw new Error('ไฟล์สำรองไม่ถูกต้อง: ไม่พบรายการธุรกรรม');
  return {
    ...base, ...d, version: 1,
    settings: { ...base.settings, ...(d.settings ?? {}) },
    fx: { ...base.fx, ...(d.fx ?? {}) },
    meta: d.meta ?? {}, prices: d.prices ?? {}, snapshots: d.snapshots ?? [],
  };
}

export function withSnapshot(d: AppData): AppData {
  if (!(d.fx.rate > 0)) return d;
  const p = computePortfolio(d);
  if (p.positions.length === 0 && p.cashTotalTHB === 0) return d;
  const snap: Snapshot = {
    date: localISO(new Date()).slice(0, 10), valueTHB: p.totalValueTHB, holdingsTHB: p.holdingsValueTHB,
    investedTHB: p.investedTHB, netDepositsTHB: p.netDepositsTHB, estimated: p.estimated,
  };
  const snaps = d.snapshots.filter(s => s.date !== snap.date);
  snaps.push(snap);
  snaps.sort((a, b) => a.date.localeCompare(b.date));
  return { ...d, snapshots: snaps };
}

export function useStore() {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        let d = migrate(await get(KEY));
        if (!d.settings.seeded) {
          d = { ...d, txns: [...d.txns, ...seedPending()], meta: { ...DEFAULT_META, ...d.meta }, settings: { ...d.settings, seeded: true } };
          await set(KEY, d);
        }
        setData(d);
        try { await navigator.storage?.persist?.(); } catch { /* not critical */ }
      } catch (e) {
        setError(String(e));
        setData(emptyData());
      }
    })();
  }, []);

  const update = useCallback((fn: (d: AppData) => AppData) => {
    setData(prev => {
      if (!prev) return prev;
      const next = withSnapshot(fn(prev));
      set(KEY, next).catch(e => setError('บันทึกข้อมูลไม่สำเร็จ: ' + String(e)));
      return next;
    });
  }, []);

  return { data, update, error };
}

export function newTxn(p: Partial<Txn>): Txn {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), datetime: localISO(new Date()), type: 'BUY', status: 'EXECUTED', amount: 0,
    currency: 'USD', fees: 0, source: 'manual', ...p, createdAt: now, updatedAt: now,
  } as Txn;
}
