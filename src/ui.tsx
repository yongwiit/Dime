import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppData, Currency, Txn, TxnStatus, TxnType } from './types';
import { validateTxn, checkAgainstPortfolio } from './engine';
import { fmtMoney, fmtQty, TYPE_TH, STATUS_TH } from './format';
import { localISO } from './parser';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="sheet-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="ปิด">✕</button></div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export interface ConfirmReq { title: string; body: ReactNode; ok: string; danger?: boolean; onOk: () => void }
export function Confirm({ req, onClose }: { req: ConfirmReq; onClose: () => void }) {
  return (
    <Sheet title={req.title} onClose={onClose}>
      <div className="confirm-body">{req.body}</div>
      <div className="row gap">
        <button className="btn ghost grow" onClick={onClose}>ยกเลิก</button>
        <button className={`btn grow ${req.danger ? 'danger' : 'primary'}`} onClick={() => { req.onOk(); onClose(); }}>{req.ok}</button>
      </div>
    </Sheet>
  );
}

export function TxnPreview({ t }: { t: Partial<Txn> }) {
  const rows: [string, string][] = [
    ['ประเภท', TYPE_TH[t.type ?? ''] ?? '—'],
    ['สถานะ', STATUS_TH[t.status ?? ''] ?? '—'],
    ['วันที่', t.datetime?.replace('T', ' ') ?? '—'],
    ['หุ้น', t.ticker ?? '—'],
    ['จำนวนหุ้น', t.quantity ? fmtQty(t.quantity) : '—'],
    ['ราคาต่อหุ้น', t.price ? fmtMoney(t.price, t.currency ?? 'USD') : '—'],
    ['จำนวนเงิน', t.amount ? fmtMoney(t.amount, t.currency ?? 'THB') : '—'],
    ['อัตราแลกเปลี่ยน', t.fxRate ? `${t.fxRate} บาท/USD` : '—'],
    ['ค่าธรรมเนียม', t.fees ? fmtMoney(t.fees, t.currency ?? 'THB') : '0'],
  ];
  return <dl className="preview">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={v === '—' ? 'muted' : ''}>{v}</dd></div>)}</dl>;
}

const TYPES: TxnType[] = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT'];
const STATUSES: TxnStatus[] = ['EXECUTED', 'PENDING', 'CANCELLED'];

export function TxnForm({ initial, data, onSave, onCancel, title }: { initial: Partial<Txn>; data: AppData; onSave: (t: Partial<Txn>) => void; onCancel: () => void; title: string }) {
  const [t, setT] = useState<Partial<Txn>>(() => ({
    datetime: localISO(new Date()), status: 'EXECUTED', currency: 'USD', fees: 0, type: 'BUY',
    fxRate: initial.fxRate ?? (data.fx.rate > 0 ? data.fx.rate : undefined), ...initial,
  }));
  const [tried, setTried] = useState(false);
  const set = (k: keyof Txn, v: unknown) => setT(p => ({ ...p, [k]: v }));
  const numIn = (k: keyof Txn) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value === '' ? undefined : Number(e.target.value));
  const needsTicker = t.type === 'BUY' || t.type === 'SELL' || t.type === 'DIVIDEND';
  const trade = t.type === 'BUY' || t.type === 'SELL';
  const computed = useMemo(() => {
    const c = { ...t };
    if (trade && c.quantity && c.price && !c.amount) c.amount = +(c.quantity * c.price).toFixed(6);
    if (c.ticker) c.ticker = c.ticker.trim().toUpperCase();
    return c;
  }, [t, trade]);
  const errors = [...validateTxn(computed), ...checkAgainstPortfolio(data, computed)];
  const tickers = Object.keys(data.meta);
  return (
    <Sheet title={title} onClose={onCancel}>
      <form className="form" onSubmit={e => { e.preventDefault(); setTried(true); if (!errors.length) onSave(computed); }}>
        <label>ประเภท
          <select value={t.type} onChange={e => set('type', e.target.value)}>{TYPES.map(x => <option key={x} value={x}>{TYPE_TH[x]}</option>)}</select>
        </label>
        <label>สถานะ
          <select value={t.status} onChange={e => set('status', e.target.value)}>{STATUSES.map(x => <option key={x} value={x}>{STATUS_TH[x]}</option>)}</select>
        </label>
        {t.status === 'PENDING' && <p className="hint">คำสั่งรอดำเนินการจะไม่ถูกนับเป็นหุ้นที่ถือหรือหักเงินสด จนกว่าคุณจะยืนยันว่าทำรายการสำเร็จ</p>}
        <label>วันที่และเวลา<input type="datetime-local" value={t.datetime ?? ''} onChange={e => set('datetime', e.target.value)} /></label>
        {needsTicker && <label>หุ้น (Ticker)<input list="tickers" autoCapitalize="characters" value={t.ticker ?? ''} onChange={e => set('ticker', e.target.value.toUpperCase())} placeholder="เช่น VOO" /><datalist id="tickers">{tickers.map(x => <option key={x} value={x} />)}</datalist></label>}
        <label>สกุลเงินที่ชำระ/รับ
          <div className="seg">{(['USD', 'THB'] as Currency[]).map(c => <button type="button" key={c} className={t.currency === c ? 'on' : ''} onClick={() => set('currency', c)}>{c}</button>)}</div>
        </label>
        {trade && <div className="grid2">
          <label>จำนวนหุ้น<input inputMode="decimal" type="number" step="any" min="0" value={t.quantity ?? ''} onChange={numIn('quantity')} /></label>
          <label>ราคาต่อหุ้น ({t.currency})<input inputMode="decimal" type="number" step="any" min="0" value={t.price ?? ''} onChange={numIn('price')} /></label>
        </div>}
        <label>จำนวนเงิน ({t.currency}){trade && <span className="hint-inline"> เว้นว่างได้ = จำนวน × ราคา</span>}
          <input inputMode="decimal" type="number" step="any" value={t.amount ?? ''} onChange={numIn('amount')} placeholder={computed.amount ? String(computed.amount) : ''} />
        </label>
        <div className="grid2">
          <label>อัตราแลกเปลี่ยน (บาท/USD)<input inputMode="decimal" type="number" step="any" min="0" value={t.fxRate ?? ''} onChange={numIn('fxRate')} /></label>
          <label>ค่าธรรมเนียม ({t.currency})<input inputMode="decimal" type="number" step="any" min="0" value={t.fees ?? ''} onChange={numIn('fees')} /></label>
        </div>
        {t.type === 'DIVIDEND' && <p className="hint">ใส่จำนวนเงินปันผลก่อนหักภาษี และใส่ภาษีหัก ณ ที่จ่ายในช่องค่าธรรมเนียม</p>}
        <label>หมายเหตุ<textarea rows={2} value={t.notes ?? ''} onChange={e => set('notes', e.target.value)} /></label>
        {tried && errors.length > 0 && <div className="alert">กรุณากรอก/แก้ไข: {errors.join(', ')}</div>}
        <div className="row gap sticky-actions">
          <button type="button" className="btn ghost grow" onClick={onCancel}>ยกเลิก</button>
          <button type="submit" className="btn primary grow">บันทึก</button>
        </div>
      </form>
    </Sheet>
  );
}

export const PALETTE = ['#4f8cff', '#2ec4a6', '#f2b64c', '#e46b8a', '#9a7cf4', '#5cc8e8', '#f08a4b', '#8bc34a', '#b0b8c4'];

export function Donut({ items, center }: { items: { label: string; value: number }[]; center?: ReactNode }) {
  const total = items.reduce((a, x) => a + x.value, 0);
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="สัดส่วนพอร์ต">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--line)" strokeWidth="18" />
        {total > 0 && items.map((x, i) => {
          const len = (x.value / total) * C;
          const el = <circle key={x.label} cx="70" cy="70" r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="18" strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" />;
          off += len; return el;
        })}
      </svg>
      {center && <div className="donut-center">{center}</div>}
      <ul className="legend">{items.map((x, i) => <li key={x.label}><span className="dot" style={{ background: PALETTE[i % PALETTE.length] }} />{x.label}<b>{total ? ((x.value / total) * 100).toFixed(1) : 0}%</b></li>)}</ul>
    </div>
  );
}

export function LineChart({ series, labels }: { series: { name: string; values: number[]; color: string; dashed?: boolean }[]; labels: string[] }) {
  const W = 340, H = 150, P = 8;
  const all = series.flatMap(s => s.values);
  if (labels.length < 2) return <div className="empty small">ต้องมีข้อมูลอย่างน้อย 2 วันจึงจะแสดงกราฟ — ระบบบันทึกมูลค่าพอร์ตวันละ 1 ครั้งเมื่อเปิดแอป</div>;
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const x = (i: number) => P + (i / (labels.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="line" role="img" aria-label="กราฟผลการดำเนินงาน">
        {[0, 0.5, 1].map(f => <line key={f} x1={P} x2={W - P} y1={P + f * (H - 2 * P)} y2={P + f * (H - 2 * P)} stroke="var(--line)" strokeWidth="1" />)}
        {series.map(s => <polyline key={s.name} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 4' : undefined} strokeLinejoin="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />)}
      </svg>
      <div className="row between tiny muted"><span>{labels[0]}</span><span>{labels[labels.length - 1]}</span></div>
      <div className="row gap tiny">{series.map(s => <span key={s.name}><span className="dot" style={{ background: s.color }} /> {s.name}</span>)}</div>
    </div>
  );
}

export function Bars({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(...items.map(i => i.value), 0.0001);
  return <ul className="bars">{items.map((x, i) => <li key={x.label}><span className="bl">{x.label}</span><span className="bt"><span style={{ width: `${(x.value / max) * 100}%`, background: PALETTE[i % PALETTE.length] }} /></span><b>{x.value.toFixed(1)}%</b></li>)}</ul>;
}
