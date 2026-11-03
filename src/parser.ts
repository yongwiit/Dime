import type { Currency, Txn, TxnType } from './types';
import { validateTxn } from './engine';

export interface ParseResult {
  draft: Partial<Txn>;
  missingForExecuted: string[]; // fields needed before it can be saved as an executed transaction
  notes: string[]; // ambiguities the user should see
}

const QUESTION = /(ควร|ไหม|มั้ย|ตัวไหน|อะไร|ถ้า|ช่วย|วิเคราะห์|สรุป|ความเสี่ยง|แนะนำ|\?|\bshould\b|\bwhich\b|\bwhat\b|\bhow\b|\bif\b|analy)/i;
const TYPES: [RegExp, TxnType][] = [
  [/(ปันผล|dividend)/i, 'DIVIDEND'],
  [/(ถอนเงิน|ถอน|withdraw)/i, 'WITHDRAWAL'],
  [/(เพิ่มเงิน|ฝากเงิน|ฝาก|เติมเงิน|โอนเงินเข้า|deposit|top ?up)/i, 'DEPOSIT'],
  [/(ค่าธรรมเนียม|\bfee\b)/i, 'FEE'],
  [/(ขาย|\bsell\b|\bsold\b)/i, 'SELL'],
  [/(ซื้อ|\bbuy\b|\bbought\b)/i, 'BUY'],
];
const STOP = new Set(['USD', 'THB', 'BAHT', 'BUY', 'SELL', 'SHARE', 'SHARES', 'OF', 'AT', 'FOR', 'SH', 'FX', 'FEE', 'DEPOSIT', 'WITHDRAW', 'DIVIDEND', 'PENDING', 'TOPUP', 'TOP', 'UP', 'BOUGHT', 'SOLD', 'RATE']);
const num = (s: string) => parseFloat(s.replace(/,/g, ''));
const N = '(\\d[\\d,]*(?:\\.\\d+)?)';

export function parseCommand(input: string, now = new Date()): ParseResult | null {
  const text = input.trim();
  if (!text || QUESTION.test(text)) return null;
  const type = TYPES.find(([re]) => re.test(text))?.[1];
  if (!type) return null;
  const notes: string[] = [];
  const d: Partial<Txn> = { type, fees: 0, source: 'assistant' };

  // ticker: first latin token of 1–6 letters (allows BRK.B) that is not a stop word
  const tk = [...text.matchAll(/\b([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b/g)].map(m => m[1].toUpperCase()).find(w => !STOP.has(w));
  if (tk) d.ticker = tk;

  let rest = text;
  const take = (re: RegExp) => { const m = rest.match(re); if (m) rest = rest.replace(m[0], ' '); return m; };

  const fx = take(new RegExp(`(?:อัตรา(?:แลกเปลี่ยน)?|fx|rate)\\s*${N}`, 'i'));
  if (fx) d.fxRate = num(fx[1]);
  const fee = take(new RegExp(`(?:ค่าธรรมเนียม|fee)\\s*${N}\\s*(usd|\\$|ดอลลาร์|บาท|thb|฿)?`, 'i'));
  if (fee) d.fees = num(fee[1]);
  const qty = take(new RegExp(`(?:จำนวน\\s*)?${N}\\s*(?:หุ้น|shares?|sh\\b|units?)`, 'i')) || take(new RegExp(`จำนวน\\s*${N}`, 'i'));
  if (qty) d.quantity = num(qty[1]);
  const price = take(new RegExp(`(?:ราคา|@|\\bat\\b|price)\\s*\\$?\\s*${N}\\s*(usd|\\$|ดอลลาร์|บาท|thb|฿)?`, 'i'));
  let priceCur: Currency | undefined;
  if (price) { d.price = num(price[1]); priceCur = price[2] && /บาท|thb|฿/i.test(price[2]) ? 'THB' : 'USD'; }
  const amt = take(new RegExp(`(?:฿|\\$)?\\s*${N}\\s*(บาท|thb|฿|usd|ดอลลาร์|\\$)?`, 'i'));
  let amtCur: Currency | undefined;
  if (amt && amt[2]) amtCur = /บาท|thb|฿/i.test(amt[2]) ? 'THB' : 'USD';
  else if (amt && /\$/.test(amt[0])) amtCur = 'USD';

  if (d.quantity && d.price) {
    d.currency = priceCur ?? 'USD';
    d.amount = +(d.quantity * d.price).toFixed(6);
    if (amt) notes.push(`พบตัวเลข ${amt[1]} เพิ่มเติม ซึ่งยังไม่ได้ใช้ — โปรดตรวจสอบ`);
  } else if (amt) {
    d.amount = num(amt[1]);
    d.currency = amtCur ?? 'THB';
    if (!amtCur) notes.push('ไม่ได้ระบุสกุลเงิน จึงถือว่าเป็นเงินบาท');
    if (d.price && d.price > 0 && (type === 'BUY' || type === 'SELL') && (priceCur ?? 'USD') === d.currency) d.quantity = +(d.amount / d.price).toFixed(8);
  } else if (d.price && d.quantity === undefined) {
    d.currency = priceCur;
  }

  // date
  const dt = new Date(now);
  if (/เมื่อวาน|yesterday/i.test(text)) dt.setDate(dt.getDate() - 1);
  const dm = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dm) { let y = +dm[3]; if (y > 2400) y -= 543; dt.setFullYear(y, +dm[2] - 1, +dm[1]); }
  d.datetime = localISO(dt);

  d.status = /(รอ|pending|ยังไม่จับคู่|ยังไม่ได้)/i.test(text) ? 'PENDING' : 'EXECUTED';
  if ((type === 'BUY' || type === 'SELL') && !(d.quantity && d.price)) {
    notes.push('ยังไม่มีจำนวนหุ้นและราคาที่ได้จริง จึงบันทึกเป็นรายการสำเร็จไม่ได้ — ระบุเพิ่ม หรือบันทึกเป็น “คำสั่งรอดำเนินการ” ซึ่งจะไม่ถูกนับเป็นหุ้นที่ถือ');
    d.status = 'PENDING';
  }
  const missingForExecuted = validateTxn({ ...d, status: 'EXECUTED' });
  return { draft: d, missingForExecuted, notes };
}

export function localISO(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
