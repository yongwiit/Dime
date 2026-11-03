import type { AppData, Currency, Txn } from './types';

/* Import holdings the user confirms were actually bought, using the figures Dime shows in its
   order history: quantity, USD price per share, and the amount paid.
   - Paid in THB (default): FX is derived, never typed:  FX = THB paid ÷ (quantity × USD price).
     Stored as a THB-settled buy, so THB cost is exactly the amount paid and USD cost is exactly
     quantity × price. Nothing is rounded before storage.
   - Paid in USD: USD amount defaults to quantity × price; the user must enter the real FX.
   A row may be linked to an existing PENDING order only when the user explicitly chooses so; the
   pending record is then updated in place (same id), so no duplicate transaction is created.
   This module is pure (no React, no storage) so the exact logic used by the screen is unit-tested. */

export interface ImportRow {
  key: string;
  ticker: string;
  quantity: string;
  priceUSD: string;
  paid: string;
  payCur: Currency;
  fxRate: string; // only used when payCur is USD
  date: string; // YYYY-MM-DD
  time: string; // HH:MM or ''
  link: '' | 'separate' | string; // '' = not chosen yet, 'separate' = new buy, otherwise a PENDING txn id
}

export function deriveImport(r: Pick<ImportRow, 'quantity' | 'priceUSD' | 'paid' | 'payCur' | 'fxRate'>) {
  const q = Number(r.quantity), pu = Number(r.priceUSD), paid = Number(r.paid);
  const usd = q > 0 && pu > 0 ? q * pu : NaN;
  if (r.payCur === 'THB') return { usd, thb: paid, fx: paid > 0 && usd > 0 ? paid / usd : NaN };
  const f = Number(r.fxRate);
  const u = paid > 0 ? paid : usd;
  return { usd: u, thb: u * f, fx: f };
}

export interface RowCheck { errors: string[]; warnings: string[]; derived: ReturnType<typeof deriveImport> }

const fx6 = (v: number) => v.toFixed(6);

export function checkImportRows(data: AppData, rows: ImportRow[]): RowCheck[] {
  const pending = data.txns.filter(t => t.status === 'PENDING');
  const usedLinks = rows.map(r => r.link).filter(l => l && l !== 'separate');
  const refFx = data.fx.rate > 0 ? data.fx.rate : undefined;
  return rows.map(r => {
    const errors: string[] = [], warnings: string[] = [];
    const derived = deriveImport(r);
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(r.ticker)) errors.push('Ticker');
    if (!(Number(r.quantity) > 0)) errors.push('จำนวนหุ้น');
    if (!(Number(r.priceUSD) > 0)) errors.push('ราคาซื้อ (USD)');
    if (!(Number(r.paid) > 0)) errors.push(r.payCur === 'THB' ? 'ยอดที่จ่าย (THB)' : 'ยอดที่จ่าย (USD)');
    if (r.payCur === 'USD' && !(Number(r.fxRate) > 0)) errors.push('อัตราแลกเปลี่ยนจริง');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) errors.push('วันที่ซื้อ');
    if (r.time && !/^\d{2}:\d{2}$/.test(r.time)) errors.push('เวลา');
    const forTicker = pending.filter(t => t.ticker === r.ticker);
    if (forTicker.length && !r.link) errors.push('เลือกว่าเกี่ยวกับคำสั่งรอดำเนินการหรือไม่');
    if (r.link && r.link !== 'separate') {
      const pend = pending.find(t => t.id === r.link);
      if (!pend) errors.push('คำสั่งรอที่เลือกไม่มีอยู่หรือไม่ได้อยู่ในสถานะรอแล้ว');
      else if (pend.ticker !== r.ticker) errors.push('คำสั่งรอที่เลือกเป็นหุ้นคนละตัว');
      if (usedLinks.filter(l => l === r.link).length > 1) errors.push('เลือกคำสั่งรอเดียวกันซ้ำ');
      if (pend && pend.currency === 'THB' && r.payCur === 'THB' && Math.abs(Number(r.paid) - pend.amount) > 0.005) warnings.push(`ยอดที่จ่ายไม่ตรงกับคำสั่งรอ (฿${pend.amount})`);
    }
    if (derived.fx > 0 && refFx && Math.abs(derived.fx / refFx - 1) > 0.03) warnings.push(`FX ${fx6(derived.fx)} ต่างจากอัตราอ้างอิง ${fx6(refFx)} เกิน 3% — ตรวจตัวเลขอีกครั้ง`);
    if (r.payCur === 'USD' && Number(r.paid) > 0 && Number(r.quantity) > 0 && Number(r.priceUSD) > 0 && Math.abs(Number(r.paid) / (Number(r.quantity) * Number(r.priceUSD)) - 1) > 0.01) warnings.push('ยอด USD ไม่เท่ากับ จำนวน × ราคา (ต่างเกิน 1%)');
    return { errors, warnings, derived };
  });
}

/** Returns a new AppData with the rows applied. Throws if any row is invalid, so a partial import can never be saved. */
export function applyImport(data: AppData, rows: ImportRow[], now = new Date().toISOString(), newId: () => string = () => crypto.randomUUID()): AppData {
  const checks = checkImportRows(data, rows);
  const bad = checks.findIndex(c => c.errors.length);
  if (bad >= 0) throw new Error(`แถวที่ ${bad + 1}: ${checks[bad].errors.join(', ')}`);
  let txns = [...data.txns];
  rows.forEach((r, i) => {
    const q = Number(r.quantity), pu = Number(r.priceUSD), paid = Number(r.paid);
    const fx = checks[i].derived.fx;
    const money: Partial<Txn> = r.payCur === 'THB'
      ? { currency: 'THB', amount: paid, price: paid / q, priceUSD: pu, fxRate: fx }
      : { currency: 'USD', amount: paid, price: pu, priceUSD: pu, fxRate: fx };
    const fields: Partial<Txn> = { ...money, type: 'BUY', status: 'EXECUTED', ticker: r.ticker, quantity: q, fees: 0 };
    const pend = r.link && r.link !== 'separate' ? txns.find(t => t.id === r.link) : undefined;
    const datetime = `${r.date}T${r.time || (pend ? pend.datetime.slice(11, 16) : '09:00')}`;
    if (pend) {
      txns = txns.map(t => (t.id === pend.id ? {
        ...t, ...fields, datetime, updatedAt: now,
        notes: `${t.notes ? t.notes + ' • ' : ''}ผู้ใช้ยืนยันว่าทำรายการสำเร็จ (นำเข้ายอดหุ้น ${now.slice(0, 10)})`,
      } as Txn : t));
    } else {
      txns.push({ ...fields, id: newId(), datetime, source: 'import', notes: 'ยอดหุ้นที่ผู้ใช้ยืนยันว่าซื้อสำเร็จ (นำเข้ายอดหุ้น)', createdAt: now, updatedAt: now } as Txn);
    }
  });
  return { ...data, txns };
}
