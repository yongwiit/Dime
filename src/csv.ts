import type { Txn, TxnStatus, TxnType, Currency } from './types';
import { validateTxn } from './engine';

export const CSV_COLUMNS = ['datetime', 'type', 'status', 'ticker', 'quantity', 'price', 'priceUSD', 'amount', 'currency', 'fxRate', 'fees', 'notes', 'id'] as const;

const esc = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(rows: Record<string, unknown>[], cols: readonly string[]) {
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n');
}

export function txnsToCSV(txns: Txn[]) {
  return toCSV(txns as unknown as Record<string, unknown>[], CSV_COLUMNS);
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

const TYPE_ALIASES: Record<string, TxnType> = { buy: 'BUY', ซื้อ: 'BUY', sell: 'SELL', ขาย: 'SELL', dividend: 'DIVIDEND', ปันผล: 'DIVIDEND', deposit: 'DEPOSIT', ฝาก: 'DEPOSIT', withdrawal: 'WITHDRAWAL', ถอน: 'WITHDRAWAL', fee: 'FEE', ค่าธรรมเนียม: 'FEE', adjustment: 'ADJUSTMENT', ปรับปรุง: 'ADJUSTMENT' };
const STATUS_ALIASES: Record<string, TxnStatus> = { executed: 'EXECUTED', สำเร็จ: 'EXECUTED', pending: 'PENDING', รอ: 'PENDING', cancelled: 'CANCELLED', canceled: 'CANCELLED', ยกเลิก: 'CANCELLED' };

export function csvToTxns(text: string): { txns: Txn[]; errors: string[] } {
  const rows = parseCSV(text);
  const errors: string[] = [];
  if (rows.length < 2) return { txns: [], errors: ['ไฟล์ไม่มีข้อมูล'] };
  const head = rows[0].map(h => h.trim());
  const idx = (c: string) => head.findIndex(h => h.toLowerCase() === c.toLowerCase());
  for (const c of ['datetime', 'type', 'amount', 'currency']) if (idx(c) < 0) errors.push(`ไม่พบคอลัมน์ ${c}`);
  if (errors.length) return { txns: [], errors };
  const now = new Date().toISOString();
  const txns: Txn[] = [];
  rows.slice(1).forEach((r, i) => {
    const g = (c: string) => { const k = idx(c); return k >= 0 ? (r[k] ?? '').trim() : ''; };
    const n = (c: string) => { const v = g(c).replace(/,/g, ''); return v === '' ? undefined : Number(v); };
    const rawType = g('type'), rawStatus = g('status');
    const t: Txn = {
      id: g('id') || crypto.randomUUID(),
      datetime: g('datetime'),
      type: (TYPE_ALIASES[rawType.toLowerCase()] ?? rawType.toUpperCase()) as TxnType,
      status: (rawStatus ? STATUS_ALIASES[rawStatus.toLowerCase()] ?? rawStatus.toUpperCase() : 'EXECUTED') as TxnStatus,
      ticker: g('ticker').toUpperCase() || undefined,
      quantity: n('quantity'), price: n('price'), priceUSD: n('priceUSD'), amount: n('amount') ?? 0,
      currency: g('currency').toUpperCase() as Currency,
      fxRate: n('fxRate'), fees: n('fees') ?? 0, notes: g('notes') || undefined,
      source: 'import', createdAt: now, updatedAt: now,
    };
    const bad = [...validateTxn(t)];
    if (!['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT'].includes(t.type)) bad.push('ประเภทไม่ถูกต้อง');
    if (!['EXECUTED', 'PENDING', 'CANCELLED'].includes(t.status)) bad.push('สถานะไม่ถูกต้อง');
    if (!['USD', 'THB'].includes(t.currency)) bad.push('สกุลเงินต้องเป็น USD หรือ THB');
    for (const k of ['quantity', 'price', 'priceUSD', 'amount', 'fxRate', 'fees'] as const) if (t[k] !== undefined && isNaN(t[k] as number)) bad.push(`${k} ไม่ใช่ตัวเลข`);
    if (bad.length) errors.push(`แถว ${i + 2}: ${[...new Set(bad)].join(', ')}`);
    else txns.push(t);
  });
  return { txns, errors };
}

export function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
