import type { AppData, Currency, Txn } from './types';
import { checkAgainstPortfolio } from './engine';

/* Import holdings the user confirms were actually bought, using the figures Dime shows in its
   order history: quantity, USD price per share, and the amount paid.
   - Paid in THB (default): FX is derived, never typed:  FX = THB paid ÷ (quantity × USD price).
     Stored as a THB-settled buy, so THB cost is exactly the amount paid and USD cost is exactly
     quantity × price. Nothing is rounded before storage.
   - Paid in USD: USD amount defaults to quantity × price; the user must enter the real FX.
   A row may be linked to an existing PENDING order only when the user explicitly chooses so; the
   pending record is then updated in place (same id), so no duplicate transaction is created.
   This module is pure (no React, no storage) so the exact logic used by the screen is unit-tested. */

export type ImportSide = 'BUY' | 'SELL';
export type ImportField = 'ticker' | 'side' | 'quantity' | 'priceUSD' | 'paid' | 'date' | 'time';

export interface ImportRow {
  key: string;
  ticker: string;
  quantity: string;
  priceUSD: string;
  paid: string; // BUY: amount paid; SELL: amount received
  payCur: Currency;
  fxRate: string; // only used when payCur is USD
  date: string; // YYYY-MM-DD
  time: string; // HH:MM, HH:MM:SS or ''
  link: '' | 'separate' | string; // '' = not chosen yet, 'separate' = new transaction, otherwise a PENDING txn id
  side?: ImportSide; // default BUY
  /** Fields a machine reader (OCR) was not sure about. Each must be corrected or confirmed by the user. */
  unverified?: ImportField[];
  /** Set only by an explicit user decision when a possible duplicate was detected. */
  allowDuplicate?: boolean;
  origin?: 'manual' | 'screenshot';
  /** UI bookkeeping: the user picked the link option themselves. */
  linkChosen?: boolean;
}

export const FIELD_TH: Record<ImportField, string> = {
  ticker: 'ชื่อหุ้น', side: 'ประเภท (ซื้อ/ขาย)', quantity: 'จำนวนหุ้น', priceUSD: 'ราคา (USD)', paid: 'ยอดเงินบาท', date: 'วันที่', time: 'เวลา',
};

export function deriveImport(r: Pick<ImportRow, 'quantity' | 'priceUSD' | 'paid' | 'payCur' | 'fxRate'>) {
  const q = Number(r.quantity), pu = Number(r.priceUSD), paid = Number(r.paid);
  const usd = q > 0 && pu > 0 ? q * pu : NaN;
  if (r.payCur === 'THB') return { usd, thb: paid, fx: paid > 0 && usd > 0 ? paid / usd : NaN };
  const f = Number(r.fxRate);
  const u = paid > 0 ? paid : usd;
  return { usd: u, thb: u * f, fx: f };
}

export interface RowCheck { errors: string[]; warnings: string[]; derived: ReturnType<typeof deriveImport>; duplicateOf?: Txn | 'batch' }

const fx6 = (v: number) => v.toFixed(6);
const sideOf = (r: ImportRow): ImportSide => r.side ?? 'BUY';

/** Pending orders a row may be linked to: same ticker and same side. */
export function pendingCandidates(data: AppData, r: Pick<ImportRow, 'ticker' | 'side'>) {
  return data.txns.filter(t => t.status === 'PENDING' && t.ticker === r.ticker && t.type === (r.side ?? 'BUY'));
}

/** Pending order whose THB amount equals the row's THB amount — offered as a one-tap suggestion, never applied automatically. */
export function suggestedPending(data: AppData, r: ImportRow) {
  if (r.payCur !== 'THB') return undefined;
  return pendingCandidates(data, r).find(t => t.currency === 'THB' && Math.abs(t.amount - Number(r.paid)) < 0.005);
}

/** An already EXECUTED transaction with the same economics (side, ticker, date, quantity, USD price, amount). */
export function findExistingDuplicate(data: AppData, r: ImportRow): Txn | undefined {
  const q = Number(r.quantity), pu = Number(r.priceUSD), paid = Number(r.paid);
  if (!(q > 0) || !(paid > 0)) return undefined;
  return data.txns.find(t => t.status === 'EXECUTED' && t.type === sideOf(r) && t.ticker === r.ticker
    && t.datetime.slice(0, 10) === r.date && t.quantity === q && t.currency === r.payCur && Math.abs(t.amount - paid) < 0.005
    && (t.priceUSD === undefined || !(pu > 0) || Math.abs(t.priceUSD - pu) < 1e-9)
    && (!r.time || r.time.length < 8 || t.datetime.length < 19 || t.datetime.slice(11, 19) === r.time));
}

const sameRow = (a: ImportRow, b: ImportRow) => a.ticker === b.ticker && sideOf(a) === sideOf(b) && a.date === b.date && a.time === b.time
  && Number(a.quantity) === Number(b.quantity) && Number(a.priceUSD) === Number(b.priceUSD) && Number(a.paid) === Number(b.paid) && a.payCur === b.payCur;

export function checkImportRows(data: AppData, rows: ImportRow[]): RowCheck[] {
  const usedLinks = rows.map(r => r.link).filter(l => l && l !== 'separate');
  const refFx = data.fx.rate > 0 ? data.fx.rate : undefined;
  const checks: RowCheck[] = rows.map((r, idx) => {
    const errors: string[] = [], warnings: string[] = [];
    const derived = deriveImport(r);
    const side = sideOf(r);
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(r.ticker)) errors.push('Ticker');
    if (r.origin === 'screenshot' && !r.side) errors.push('ประเภท (ซื้อ/ขาย)');
    if (!(Number(r.quantity) > 0)) errors.push('จำนวนหุ้น');
    if (!(Number(r.priceUSD) > 0)) errors.push(side === 'BUY' ? 'ราคาซื้อ (USD)' : 'ราคาขาย (USD)');
    if (!(Number(r.paid) > 0)) errors.push(side === 'BUY' ? (r.payCur === 'THB' ? 'ยอดที่จ่าย (THB)' : 'ยอดที่จ่าย (USD)') : (r.payCur === 'THB' ? 'ยอดที่ได้รับ (THB)' : 'ยอดที่ได้รับ (USD)'));
    if (r.payCur === 'USD' && !(Number(r.fxRate) > 0)) errors.push('อัตราแลกเปลี่ยนจริง');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errors.push('วันที่');
    if (r.time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(r.time)) errors.push('เวลา');
    if (r.unverified?.length) errors.push(`ต้องตรวจสอบกับภาพ: ${r.unverified.map(f => FIELD_TH[f]).join(', ')}`);
    const candidates = pendingCandidates(data, r);
    if (candidates.length && !r.link) errors.push('เลือกว่าเกี่ยวกับคำสั่งรอดำเนินการหรือไม่');
    if (r.link && r.link !== 'separate') {
      const pend = data.txns.find(t => t.id === r.link && t.status === 'PENDING');
      if (!pend) errors.push('คำสั่งรอที่เลือกไม่มีอยู่หรือไม่ได้อยู่ในสถานะรอแล้ว');
      else if (pend.ticker !== r.ticker) errors.push('คำสั่งรอที่เลือกเป็นหุ้นคนละตัว');
      else if (pend.type !== side) errors.push('คำสั่งรอที่เลือกเป็นคนละประเภท (ซื้อ/ขาย)');
      if (usedLinks.filter(l => l === r.link).length > 1) errors.push('เลือกคำสั่งรอเดียวกันซ้ำ');
      if (pend && pend.currency === 'THB' && r.payCur === 'THB' && Math.abs(Number(r.paid) - pend.amount) > 0.005) warnings.push(`ยอดเงินไม่ตรงกับคำสั่งรอ (฿${pend.amount})`);
    }
    // duplicates: an executed record already exists, or the same row appears earlier in this batch
    let duplicateOf: RowCheck['duplicateOf'];
    const linkedPending = r.link && r.link !== 'separate';
    if (!linkedPending) duplicateOf = findExistingDuplicate(data, r);
    if (!duplicateOf && rows.slice(0, idx).some(o => sameRow(o, r))) duplicateOf = 'batch';
    if (duplicateOf && !r.allowDuplicate) {
      errors.push(duplicateOf === 'batch'
        ? 'รายการเดียวกันปรากฏซ้ำในชุดนี้ — ลบแถวนี้ หรือยืนยันว่าเป็นอีกรายการ'
        : `อาจซ้ำกับรายการที่บันทึกแล้ว (${duplicateOf.ticker} ${duplicateOf.datetime.replace('T', ' ')}) — ลบแถวนี้ หรือยืนยันว่าเป็นรายการใหม่`);
    }
    if (derived.fx > 0 && refFx && Math.abs(derived.fx / refFx - 1) > 0.03) warnings.push(`FX ${fx6(derived.fx)} ต่างจากอัตราอ้างอิง ${fx6(refFx)} เกิน 3% — ตรวจตัวเลขอีกครั้ง`);
    if (r.payCur === 'USD' && Number(r.paid) > 0 && Number(r.quantity) > 0 && Number(r.priceUSD) > 0 && Math.abs(Number(r.paid) / (Number(r.quantity) * Number(r.priceUSD)) - 1) > 0.01) warnings.push('ยอด USD ไม่เท่ากับ จำนวน × ราคา (ต่างเกิน 1%)');
    return { errors, warnings, derived, duplicateOf };
  });
  // sells: never more than held at that time, taking the rest of this batch into account
  if (checks.every(c => c.errors.length === 0) && rows.some(r => sideOf(r) === 'SELL')) {
    const ids = rows.map((_, i) => `__import_${i}`);
    const built = buildTxns(data, rows, checks, new Date(0).toISOString(), (i) => ids[i]);
    rows.forEach((r, i) => {
      if (sideOf(r) !== 'SELL') return;
      const t = built.find(x => x.id === (r.link && r.link !== 'separate' ? r.link : ids[i]))!;
      checks[i].errors.push(...checkAgainstPortfolio({ ...data, txns: built }, t));
    });
  }
  return checks;
}

function buildTxns(data: AppData, rows: ImportRow[], checks: RowCheck[], now: string, newId: (i: number) => string): Txn[] {
  let txns = [...data.txns];
  rows.forEach((r, i) => {
    const q = Number(r.quantity), pu = Number(r.priceUSD), paid = Number(r.paid);
    const fx = checks[i].derived.fx;
    const side = sideOf(r);
    const money: Partial<Txn> = r.payCur === 'THB'
      ? { currency: 'THB', amount: paid, price: paid / q, priceUSD: pu, fxRate: fx }
      : { currency: 'USD', amount: paid, price: pu, priceUSD: pu, fxRate: fx };
    const fields: Partial<Txn> = { ...money, type: side, status: 'EXECUTED', ticker: r.ticker, quantity: q, fees: 0 };
    const pend = r.link && r.link !== 'separate' ? txns.find(t => t.id === r.link) : undefined;
    const datetime = `${r.date}T${r.time || (pend ? pend.datetime.slice(11, 16) : '09:00')}`;
    const via = r.origin === 'screenshot' ? 'นำเข้าจากภาพ Dime' : 'นำเข้ายอดหุ้น';
    if (pend) {
      txns = txns.map(t => (t.id === pend.id ? {
        ...t, ...fields, datetime, updatedAt: now,
        notes: `${t.notes ? t.notes + ' • ' : ''}ผู้ใช้ยืนยันว่าทำรายการสำเร็จ (${via} ${now.slice(0, 10)})`,
      } as Txn : t));
    } else {
      txns.push({ ...fields, id: newId(i), datetime, source: 'import', notes: `${side === 'BUY' ? 'ซื้อ' : 'ขาย'}สำเร็จตามที่ผู้ใช้ยืนยัน (${via})`, createdAt: now, updatedAt: now } as Txn);
    }
  });
  return txns;
}

/** Returns a new AppData with the rows applied. Throws if any row is invalid, so a partial import can never be saved. */
export function applyImport(data: AppData, rows: ImportRow[], now = new Date().toISOString(), newId: () => string = () => crypto.randomUUID()): AppData {
  const checks = checkImportRows(data, rows);
  const bad = checks.findIndex(c => c.errors.length);
  if (bad >= 0) throw new Error(`แถวที่ ${bad + 1}: ${checks[bad].errors.join(', ')}`);
  return { ...data, txns: buildTxns(data, rows, checks, now, () => newId()) };
}
