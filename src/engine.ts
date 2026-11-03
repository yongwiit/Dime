import type { AppData, Currency, Txn } from './types';

/*
 * Accounting methodology (see ACCOUNTING.md for the full write-up)
 * - Only EXECUTED transactions affect positions, cash and P/L. PENDING and CANCELLED never do.
 * - Average cost = weighted average, fees on buys are capitalised into cost.
 * - Every executed transaction carries the THB-per-USD rate on its date (fxRate).
 *   Cost basis is kept twice: in USD and in THB at the historical rate.
 * - Realized P/L on a sell = net proceeds − (average cost × quantity sold), in USD and in THB
 *   (THB realized P/L therefore includes the FX gain/loss since purchase).
 * - Unrealized P/L (USD) = market value USD − cost USD.
 *   Unrealized P/L (THB) = market value USD × current rate − cost THB (includes FX effect).
 * - Cash is tracked separately in THB and USD, in the currency each transaction was settled in.
 */

export const EPS = 1e-9;

export function toUSD(amount: number, cur: Currency, fx: number) {
  return cur === 'USD' ? amount : amount / fx;
}
export function toTHB(amount: number, cur: Currency, fx: number) {
  return cur === 'THB' ? amount : amount * fx;
}

export interface Position {
  ticker: string;
  quantity: number;
  costUSD: number;
  costTHB: number;
  avgCostUSD: number;
  realizedUSD: number;
  realizedTHB: number;
  dividendsUSD: number;
  dividendsTHB: number;
  price?: number;
  priceAsOf?: string;
  priceSource?: string;
  prevClose?: number;
  marketValueUSD: number;
  marketValueTHB: number;
  hasPrice: boolean;
  unrealizedUSD: number;
  unrealizedTHB: number;
  unrealizedPct: number;
  dayChangeUSD?: number;
  weight: number;
  name?: string;
  sector?: string;
  horizon?: 'long' | 'trading';
  targetWeight?: number;
}

export interface Portfolio {
  positions: Position[]; // open positions only (quantity > 0)
  closed: Position[];
  cashTHB: number;
  cashUSD: number;
  cashTotalTHB: number;
  holdingsValueUSD: number;
  holdingsValueTHB: number;
  totalValueTHB: number;
  totalValueUSD: number;
  investedTHB: number; // cost basis of open positions
  investedUSD: number;
  netDepositsTHB: number;
  unrealizedTHB: number;
  unrealizedUSD: number;
  unrealizedPct: number;
  realizedTHB: number;
  realizedUSD: number;
  dividendsTHB: number;
  feesTHB: number;
  dayChangeUSD?: number;
  dayChangeTHB?: number;
  totalReturnTHB: number;
  totalReturnPct: number;
  pending: Txn[];
  cancelled: Txn[];
  pendingTHB: number;
  estimated: boolean; // true when some position has no price and cost is used instead
  warnings: string[];
  fx: number;
}

export function validateTxn(t: Partial<Txn>): string[] {
  const e: string[] = [];
  if (!t.type) e.push('ประเภทรายการ');
  if (!t.datetime || isNaN(Date.parse(t.datetime))) e.push('วันที่และเวลา');
  if (!t.currency) e.push('สกุลเงิน');
  const needsTicker = t.type === 'BUY' || t.type === 'SELL' || t.type === 'DIVIDEND';
  if (needsTicker && !t.ticker) e.push('ชื่อหุ้น (Ticker)');
  if (t.status === 'EXECUTED') {
    if (t.type === 'BUY' || t.type === 'SELL') {
      if (!(t.quantity! > 0)) e.push('จำนวนหุ้นที่ได้จริง');
      if (!(t.price! > 0)) e.push('ราคาต่อหุ้นที่ได้จริง');
    }
    if (!(t.fxRate! > 0)) e.push('อัตราแลกเปลี่ยน (บาท/USD)');
  }
  if (t.type !== 'ADJUSTMENT' && !(t.amount! > 0)) e.push('จำนวนเงิน');
  if (t.type === 'ADJUSTMENT' && !t.amount) e.push('จำนวนเงิน (ใส่ค่าติดลบได้)');
  if ((t.fees ?? 0) < 0) e.push('ค่าธรรมเนียมต้องไม่ติดลบ');
  return e;
}

export function sortTxns(txns: Txn[]) {
  return [...txns].sort((a, b) => a.datetime.localeCompare(b.datetime) || a.createdAt.localeCompare(b.createdAt));
}

export function computePortfolio(data: AppData): Portfolio {
  const fx = data.fx.rate;
  const warnings: string[] = [];
  const pos = new Map<string, Position>();
  const get = (tk: string) => {
    let p = pos.get(tk);
    if (!p) {
      p = { ticker: tk, quantity: 0, costUSD: 0, costTHB: 0, avgCostUSD: 0, realizedUSD: 0, realizedTHB: 0, dividendsUSD: 0, dividendsTHB: 0, marketValueUSD: 0, marketValueTHB: 0, hasPrice: false, unrealizedUSD: 0, unrealizedTHB: 0, unrealizedPct: 0, weight: 0 };
      pos.set(tk, p);
    }
    return p;
  };
  const cash: Record<Currency, number> = { THB: 0, USD: 0 };
  let netDepositsTHB = 0, feesTHB = 0;

  for (const t of sortTxns(data.txns)) {
    if (t.status !== 'EXECUTED') continue;
    const r = t.fxRate && t.fxRate > 0 ? t.fxRate : fx;
    if (!t.fxRate) warnings.push(`รายการ ${t.type} ${t.ticker ?? ''} วันที่ ${t.datetime.slice(0, 10)} ไม่มีอัตราแลกเปลี่ยน ใช้อัตราปัจจุบันแทน`);
    const fees = t.fees || 0;
    feesTHB += toTHB(fees, t.currency, r);
    switch (t.type) {
      case 'DEPOSIT':
        cash[t.currency] += t.amount - fees;
        netDepositsTHB += toTHB(t.amount, t.currency, r);
        break;
      case 'WITHDRAWAL':
        cash[t.currency] -= t.amount + fees;
        netDepositsTHB -= toTHB(t.amount, t.currency, r);
        break;
      case 'FEE':
        cash[t.currency] -= t.amount;
        feesTHB += toTHB(t.amount, t.currency, r);
        break;
      case 'ADJUSTMENT':
        cash[t.currency] += t.amount - fees;
        break;
      case 'DIVIDEND': {
        const p = get(t.ticker!);
        const net = t.amount - fees;
        cash[t.currency] += net;
        p.dividendsUSD += toUSD(net, t.currency, r);
        p.dividendsTHB += toTHB(net, t.currency, r);
        break;
      }
      case 'BUY': {
        const p = get(t.ticker!);
        const gross = t.amount || (t.quantity! * t.price!);
        cash[t.currency] -= gross + fees;
        p.quantity += t.quantity!;
        p.costUSD += toUSD(gross + fees, t.currency, r);
        p.costTHB += toTHB(gross + fees, t.currency, r);
        break;
      }
      case 'SELL': {
        const p = get(t.ticker!);
        let q = t.quantity!;
        if (q > p.quantity + EPS) {
          warnings.push(`ขาย ${t.ticker} ${q} หุ้น มากกว่าที่ถืออยู่ (${round(p.quantity, 6)}) วันที่ ${t.datetime.slice(0, 10)} — นับเฉพาะส่วนที่ถืออยู่จริง ทั้งจำนวนหุ้น เงินที่ได้รับ และค่าธรรมเนียม โปรดแก้ไขรายการนี้`);
          q = p.quantity;
        }
        // scale proceeds and fees to the shares actually held, so cash is never overstated by an oversell
        const f = t.quantity! > 0 ? q / t.quantity! : 0;
        if (f < 1) feesTHB -= toTHB(fees * (1 - f), t.currency, r);
        const gross = (t.amount || (t.quantity! * t.price!)) * f;
        const net = gross - fees * f;
        cash[t.currency] += net;
        if (p.quantity <= EPS) break;
        const portion = q / p.quantity;
        const cUSD = p.costUSD * portion, cTHB = p.costTHB * portion;
        p.realizedUSD += toUSD(net, t.currency, r) - cUSD;
        p.realizedTHB += toTHB(net, t.currency, r) - cTHB;
        p.costUSD -= cUSD; p.costTHB -= cTHB; p.quantity -= q;
        if (p.quantity < EPS) { p.quantity = 0; p.costUSD = 0; p.costTHB = 0; }
        break;
      }
    }
  }

  let estimated = false;
  const all = [...pos.values()];
  for (const p of all) {
    const m = data.meta[p.ticker];
    if (m) { p.name = m.name; p.sector = m.sector; p.horizon = m.horizon; p.targetWeight = m.targetWeight; }
    p.avgCostUSD = p.quantity > 0 ? p.costUSD / p.quantity : 0;
    const q = data.prices[p.ticker];
    if (q && q.price > 0) {
      p.hasPrice = true; p.price = q.price; p.priceAsOf = q.asOf; p.priceSource = q.source; p.prevClose = q.prevClose;
      p.marketValueUSD = p.quantity * q.price;
      if (q.prevClose) p.dayChangeUSD = p.quantity * (q.price - q.prevClose);
    } else if (p.quantity > 0) {
      estimated = true;
      p.marketValueUSD = p.costUSD; // placeholder: cost used as estimate until a price is entered
    }
    p.marketValueTHB = p.marketValueUSD * fx;
    p.unrealizedUSD = p.hasPrice ? p.marketValueUSD - p.costUSD : 0;
    p.unrealizedTHB = p.hasPrice ? p.marketValueTHB - p.costTHB : 0;
    p.unrealizedPct = p.costTHB > 0 && p.hasPrice ? (p.unrealizedTHB / p.costTHB) * 100 : 0;
  }
  const positions = all.filter(p => p.quantity > EPS).sort((a, b) => b.marketValueTHB - a.marketValueTHB);
  const closed = all.filter(p => p.quantity <= EPS);
  const holdingsValueUSD = sum(positions.map(p => p.marketValueUSD));
  const holdingsValueTHB = holdingsValueUSD * fx;
  for (const p of positions) p.weight = holdingsValueUSD > 0 ? (p.marketValueUSD / holdingsValueUSD) * 100 : 0;

  const cashTotalTHB = cash.THB + cash.USD * fx;
  const investedTHB = sum(positions.map(p => p.costTHB));
  const investedUSD = sum(positions.map(p => p.costUSD));
  const unrealizedTHB = sum(positions.map(p => p.unrealizedTHB));
  const unrealizedUSD = sum(positions.map(p => p.unrealizedUSD));
  const realizedTHB = sum(all.map(p => p.realizedTHB));
  const realizedUSD = sum(all.map(p => p.realizedUSD));
  const dividendsTHB = sum(all.map(p => p.dividendsTHB));
  const withDay = positions.filter(p => p.dayChangeUSD !== undefined);
  const dayChangeUSD = withDay.length ? sum(withDay.map(p => p.dayChangeUSD!)) : undefined;
  const pending = data.txns.filter(t => t.status === 'PENDING').sort((a, b) => b.datetime.localeCompare(a.datetime));
  const cancelled = data.txns.filter(t => t.status === 'CANCELLED');
  const pendingTHB = sum(pending.map(t => toTHB(t.amount, t.currency, t.fxRate || fx)));
  const totalValueTHB = holdingsValueTHB + cashTotalTHB;
  const totalReturnTHB = unrealizedTHB + realizedTHB + dividendsTHB;
  if (cash.THB < -0.01 || cash.USD < -0.01) warnings.push('ยอดเงินสดติดลบ — อาจยังไม่ได้บันทึกรายการฝากเงิน (Deposit) จึงแสดงเงินสดตามที่บันทึกไว้เท่านั้น');
  return {
    positions, closed, cashTHB: cash.THB, cashUSD: cash.USD, cashTotalTHB,
    holdingsValueUSD, holdingsValueTHB, totalValueTHB, totalValueUSD: totalValueTHB / fx,
    investedTHB, investedUSD, netDepositsTHB, unrealizedTHB, unrealizedUSD,
    unrealizedPct: investedTHB > 0 ? (unrealizedTHB / investedTHB) * 100 : 0,
    realizedTHB, realizedUSD, dividendsTHB, feesTHB,
    dayChangeUSD, dayChangeTHB: dayChangeUSD !== undefined ? dayChangeUSD * fx : undefined,
    totalReturnTHB, totalReturnPct: netDepositsTHB > 0 ? (totalReturnTHB / netDepositsTHB) * 100 : investedTHB > 0 ? (totalReturnTHB / investedTHB) * 100 : 0,
    pending, cancelled, pendingTHB, estimated, warnings: [...new Set(warnings)], fx,
  };
}

/** Shares of `ticker` held just before `datetime`, ignoring transaction `excludeId` (the one being edited). */
export function heldQuantity(data: AppData, ticker: string, datetime: string, excludeId?: string) {
  const txns = data.txns.filter(t => t.id !== excludeId && t.datetime <= datetime);
  const p = computePortfolio({ ...data, txns, fx: { ...data.fx, rate: data.fx.rate > 0 ? data.fx.rate : 1 } });
  return p.positions.find(x => x.ticker === ticker)?.quantity ?? 0;
}

/** Extra checks that need the rest of the portfolio. Returns error messages (Thai). */
export function checkAgainstPortfolio(data: AppData, t: Partial<Txn>): string[] {
  if (t.type === 'SELL' && t.status === 'EXECUTED' && t.ticker && t.quantity && t.datetime) {
    const held = heldQuantity(data, t.ticker, t.datetime, t.id);
    if (t.quantity > held + EPS) return [`ขายได้ไม่เกินจำนวนที่ถือ ณ วันที่ขาย (${round(held, 6)} หุ้น)`];
  }
  return [];
}

export function sum(a: number[]) { return a.reduce((s, x) => s + x, 0); }
export function round(n: number, d = 2) { const f = 10 ** d; return Math.round(n * f) / f; }

export interface MonthRow { month: string; deposits: number; withdrawals: number; buys: number; sells: number; dividends: number; fees: number; count: number }
export function monthlySummary(data: AppData): MonthRow[] {
  const fx = data.fx.rate;
  const m = new Map<string, MonthRow>();
  for (const t of data.txns) {
    if (t.status !== 'EXECUTED') continue;
    const k = t.datetime.slice(0, 7);
    const row = m.get(k) ?? { month: k, deposits: 0, withdrawals: 0, buys: 0, sells: 0, dividends: 0, fees: 0, count: 0 };
    const v = toTHB(t.amount, t.currency, t.fxRate || fx);
    row.count++;
    row.fees += toTHB(t.fees || 0, t.currency, t.fxRate || fx);
    if (t.type === 'DEPOSIT') row.deposits += v;
    if (t.type === 'WITHDRAWAL') row.withdrawals += v;
    if (t.type === 'BUY') row.buys += v;
    if (t.type === 'SELL') row.sells += v;
    if (t.type === 'DIVIDEND') row.dividends += v;
    if (t.type === 'FEE') row.fees += v;
    m.set(k, row);
  }
  return [...m.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export function maxDrawdownFromPeak(snaps: { holdingsTHB: number; investedTHB: number }[]) {
  // drawdown measured on value / invested ratio to remove the effect of new deposits
  let peak = -Infinity, cur = 0, worst = 0;
  for (const s of snaps) {
    if (s.investedTHB <= 0) continue;
    const r = s.holdingsTHB / s.investedTHB;
    peak = Math.max(peak, r);
    cur = (r / peak - 1) * 100;
    worst = Math.min(worst, cur);
  }
  return { current: cur, worst };
}
