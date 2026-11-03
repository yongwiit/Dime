const nf = (min: number, max: number) => new Intl.NumberFormat('th-TH', { minimumFractionDigits: min, maximumFractionDigits: max });
const n2 = nf(2, 2), n4 = nf(0, 8);
const sign = (v: number, s?: boolean) => (s && v > 0 ? '+' : '');

const neg = (v: number) => (v < -0.0049 ? '-' : '');
export const fmtTHB = (v: number, s?: boolean) => `${neg(v) || sign(v, s)}฿${n2.format(Math.abs(v))}`;
export const fmtUSD = (v: number, s?: boolean) => `${neg(v) || sign(v, s)}$${n2.format(Math.abs(v))}`;
export const fmtNum = (v: number) => n2.format(v);
export const fmtQty = (v: number) => n4.format(v);
export const fmtFx = (v: number) => nf(4, 6).format(v);
export const fmtPct = (v: number, s?: boolean) => `${sign(v, s)}${n2.format(v)}%`;
export const fmtMoney = (v: number, c: 'USD' | 'THB', s?: boolean) => (c === 'USD' ? fmtUSD(v, s) : fmtTHB(v, s));
export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(+d)) return iso;
  return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};
export const tone = (v: number) => (v > 0.0049 ? 'pos' : v < -0.0049 ? 'neg' : '');

export const TYPE_TH: Record<string, string> = { BUY: 'ซื้อ', SELL: 'ขาย', DIVIDEND: 'ปันผล', DEPOSIT: 'ฝากเงิน', WITHDRAWAL: 'ถอนเงิน', FEE: 'ค่าธรรมเนียม', ADJUSTMENT: 'ปรับปรุง' };
export const STATUS_TH: Record<string, string> = { EXECUTED: 'สำเร็จ', PENDING: 'รอดำเนินการ', CANCELLED: 'ยกเลิก' };
