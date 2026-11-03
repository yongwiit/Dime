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

// ---- Storage diagnostics -------------------------------------------------------------
// idb-keyval default database: name "keyval-store", object store "keyval", IndexedDB version 1.
// The whole portfolio is one record under KEY; AppData.version is the app schema version.
export const DB_INFO = { database: 'keyval-store', objectStore: 'keyval', idbVersion: 1, key: KEY, schemaVersion: 1 };
const MARKER = 'dime-port-marker'; // localStorage: {count, savedAt} of the last successful save

export type StorageContext = 'home-screen' | 'safari' | 'in-app' | 'browser';
export function storageContext(): StorageContext {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone || matchMedia('(display-mode: standalone)').matches) return 'home-screen';
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|Instagram|Line\/|LINE|Twitter|MicroMessenger|GSA\/|; wv\)/i.test(ua)) return 'in-app';
  if (/iPhone|iPad|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) return 'safari';
  return 'browser';
}
export const CONTEXT_TH: Record<StorageContext, string> = {
  'home-screen': 'แอปบนหน้าจอโฮม', safari: 'Safari', 'in-app': 'เบราว์เซอร์ในแอปอื่น (เช่น LINE)', browser: 'เบราว์เซอร์',
};

export type LoadStatus =
  | { kind: 'loading' }
  | { kind: 'ok'; fresh: boolean; lostSuspected?: { count: number; savedAt: string } }
  | { kind: 'unreadable'; reason: string; raw?: unknown } // read failed or record is corrupt: NOTHING is written
;

function readMarker(): { count: number; savedAt: string } | null {
  try { const v = localStorage.getItem(MARKER); return v ? JSON.parse(v) : null; } catch { return null; }
}
function writeMarker(d: AppData) {
  try { localStorage.setItem(MARKER, JSON.stringify({ count: d.txns.length, savedAt: new Date().toISOString() })); } catch { /* optional */ }
}

export function useStore() {
  const [data, setData] = useState<AppData | null>(null);
  const [status, setStatus] = useState<LoadStatus>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    (async () => {
      let raw: unknown;
      try {
        raw = await get(KEY);
      } catch (e) {
        setStatus({ kind: 'unreadable', reason: 'เปิดฐานข้อมูล IndexedDB ไม่สำเร็จ: ' + String(e) });
        return;
      }
      let d: AppData;
      try {
        d = migrate(raw);
      } catch (e) {
        setStatus({ kind: 'unreadable', reason: String(e), raw });
        return;
      }
      const fresh = raw === undefined;
      const marker = readMarker();
      if (fresh && marker && marker.count > 0) {
        // the database is empty although this browser previously saved data: do not seed, ask the user
        setData(d);
        setStatus({ kind: 'ok', fresh, lostSuspected: marker });
        return;
      }
      if (fresh && !d.settings.seeded) {
        d = { ...d, txns: seedPending(), meta: { ...DEFAULT_META }, settings: { ...d.settings, seeded: true } };
        try { await set(KEY, d); writeMarker(d); } catch (e) { setError('บันทึกข้อมูลเริ่มต้นไม่สำเร็จ: ' + String(e)); }
      }
      setData(d);
      setStatus({ kind: 'ok', fresh });
      try {
        const s = navigator.storage;
        if (s?.persisted) setPersisted((await s.persisted()) || (s.persist ? await s.persist() : false));
      } catch { /* not supported */ }
    })();
  }, [attempt]);

  const update = useCallback((fn: (d: AppData) => AppData) => {
    setData(prev => {
      if (!prev) return prev; // never write while the stored record is unreadable or still loading
      const next = withSnapshot(fn(prev));
      set(KEY, next).then(() => writeMarker(next)).catch(e => setError('บันทึกข้อมูลไม่สำเร็จ: ' + String(e)));
      return next;
    });
  }, []);

  const retry = useCallback(() => { setStatus({ kind: 'loading' }); setAttempt(a => a + 1); }, []);
  const dismissLost = useCallback(() => setStatus(s => (s.kind === 'ok' ? { ...s, lostSuspected: undefined } : s)), []);
  /** Only called after the user explicitly confirms replacing an unreadable record. */
  const resetAfterConsent = useCallback(async () => {
    const d = emptyData();
    d.settings.seeded = true;
    await set(KEY, d); writeMarker(d);
    setData(d); setStatus({ kind: 'ok', fresh: false });
  }, []);

  return { data, update, error, status, persisted, retry, dismissLost, resetAfterConsent };
}

export function newTxn(p: Partial<Txn>): Txn {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), datetime: localISO(new Date()), type: 'BUY', status: 'EXECUTED', amount: 0,
    currency: 'USD', fees: 0, source: 'manual', ...p, createdAt: now, updatedAt: now,
  } as Txn;
}
