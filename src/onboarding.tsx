import { useMemo, useState } from 'react';
import type { AppData, Currency, Txn } from './types';
import type { Portfolio } from './engine';
import { Sheet } from './ui';
import { newTxn } from './store';
import { localISO } from './parser';
import { fmtMoney, fmtQty, fmtDate, fmtFx } from './format';

/* Import holdings the user confirms were actually bought, using the figures Dime shows in its
   order history: quantity, USD price per share, and the amount paid.
   - Paid in THB (default): FX is derived, never typed:  FX = THB paid ÷ (quantity × USD price).
     Stored as a THB-settled buy, so THB cost is exactly the amount paid and USD cost is exactly
     quantity × price. Nothing is rounded before storage.
   - Paid in USD: USD amount defaults to quantity × price; the user must enter the real FX.
   A row may be linked to an existing PENDING order only when the user explicitly chooses so; the
   pending record is then updated in place (same id), so no duplicate transaction is created. */

interface Row { key: string; ticker: string; quantity: string; priceUSD: string; paid: string; payCur: Currency; fxRate: string; date: string; time: string; link: '' | 'separate' | string }

const blankRow = (ticker = ''): Row => ({ key: crypto.randomUUID(), ticker, quantity: '', priceUSD: '', paid: '', payCur: 'THB', fxRate: '', date: localISO(new Date()).slice(0, 10), time: '', link: '' });

export function deriveImport(r: { quantity: string; priceUSD: string; paid: string; payCur: Currency; fxRate: string }) {
  const q = Number(r.quantity), pu = Number(r.priceUSD), paid = Number(r.paid);
  const usd = q > 0 && pu > 0 ? q * pu : NaN;
  if (r.payCur === 'THB') return { usd, thb: paid, fx: paid > 0 && usd > 0 ? paid / usd : NaN };
  const f = Number(r.fxRate);
  return { usd: paid > 0 ? paid : usd, thb: (paid > 0 ? paid : usd) * f, fx: f };
}

export function ImportHoldings({ data, p, onClose, update }: { data: AppData; p: Portfolio; onClose: () => void; update: (fn: (d: AppData) => AppData) => void }) {
  const pendingTickers = [...new Set(p.pending.map(t => t.ticker).filter(Boolean))] as string[];
  const [rows, setRows] = useState<Row[]>(() => (pendingTickers.length ? pendingTickers.map(t => blankRow(t)) : [blankRow()]));
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const set = (k: string, f: keyof Row, v: string) => setRows(rs => rs.map(r => {
    if (r.key !== k) return r;
    const n = { ...r, [f]: f === 'ticker' ? v.toUpperCase().trim() : v };
    if (f === 'link') {
      const pend = p.pending.find(t => t.id === v);
      if (pend) { n.date = pend.datetime.slice(0, 10); if (pend.currency === 'THB' && !r.paid) { n.payCur = 'THB'; n.paid = String(pend.amount); } }
    }
    return n;
  }));
  const pendingFor = (tk: string) => p.pending.filter(t => t.ticker === tk);
  const usedLinks = rows.map(r => r.link).filter(l => l && l !== 'separate');
  const refFx = data.fx.rate > 0 ? data.fx.rate : undefined;

  const checks = useMemo(() => rows.map(r => {
    const e: string[] = [], w: string[] = [];
    const d = deriveImport(r);
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(r.ticker)) e.push('Ticker');
    if (!(Number(r.quantity) > 0)) e.push('จำนวนหุ้น');
    if (!(Number(r.priceUSD) > 0)) e.push('ราคาซื้อ (USD)');
    if (!(Number(r.paid) > 0)) e.push(r.payCur === 'THB' ? 'ยอดที่จ่าย (THB)' : 'ยอดที่จ่าย (USD)');
    if (r.payCur === 'USD' && !(Number(r.fxRate) > 0)) e.push('อัตราแลกเปลี่ยนจริง');
    if (!r.date) e.push('วันที่ซื้อ');
    if (pendingFor(r.ticker).length && !r.link) e.push('เลือกว่าเกี่ยวกับคำสั่งรอดำเนินการหรือไม่');
    if (r.link && r.link !== 'separate' && usedLinks.filter(l => l === r.link).length > 1) e.push('เลือกคำสั่งรอเดียวกันซ้ำ');
    if (d.fx > 0 && refFx && Math.abs(d.fx / refFx - 1) > 0.03) w.push(`FX ${fmtFx(d.fx)} ต่างจากอัตราอ้างอิง ${fmtFx(refFx)} เกิน 3% — ตรวจตัวเลขอีกครั้ง`);
    if (r.payCur === 'USD' && d.usd > 0 && Number(r.paid) > 0 && Math.abs(Number(r.paid) / (Number(r.quantity) * Number(r.priceUSD)) - 1) > 0.01) w.push('ยอด USD ไม่เท่ากับ จำนวน × ราคา (ต่างเกิน 1%)');
    const pend = p.pending.find(t => t.id === r.link);
    if (pend && pend.currency === 'THB' && r.payCur === 'THB' && Math.abs(Number(r.paid) - pend.amount) > 0.005) w.push(`ยอดที่จ่ายไม่ตรงกับคำสั่งรอ (${fmtMoney(pend.amount, 'THB')})`);
    return { e, w, d };
  }), [rows, p.pending, refFx]); // eslint-disable-line react-hooks/exhaustive-deps

  const allOk = rows.length > 0 && checks.every(c => c.e.length === 0);

  const commit = () => {
    const now = new Date().toISOString();
    update(d => {
      let txns = [...d.txns];
      rows.forEach((r, i) => {
        const q = Number(r.quantity), pu = Number(r.priceUSD), paid = Number(r.paid);
        const fx = checks[i].d.fx;
        const fields: Partial<Txn> = r.payCur === 'THB'
          ? { currency: 'THB', amount: paid, price: paid / q, priceUSD: pu, fxRate: fx }
          : { currency: 'USD', amount: paid, price: pu, priceUSD: pu, fxRate: fx };
        Object.assign(fields, { type: 'BUY', status: 'EXECUTED', ticker: r.ticker, quantity: q, fees: 0 });
        const pend = d.txns.find(t => t.id === r.link && t.status === 'PENDING');
        const dt = `${r.date}T${r.time || (pend ? pend.datetime.slice(11, 16) : '09:00')}`;
        if (pend) {
          txns = txns.map(t => (t.id === pend.id ? {
            ...t, ...fields, datetime: dt, updatedAt: now,
            notes: `${t.notes ? t.notes + ' • ' : ''}ผู้ใช้ยืนยันว่าทำรายการสำเร็จ (นำเข้ายอดหุ้น ${fmtDate(now)})`,
          } as Txn : t));
        } else {
          txns.push(newTxn({ ...fields, datetime: dt, source: 'import', notes: 'ยอดหุ้นที่ผู้ใช้ยืนยันว่าซื้อสำเร็จ (นำเข้ายอดหุ้น)' }));
        }
      });
      return { ...d, txns };
    });
    onClose();
  };

  return (
    <Sheet title="นำเข้ายอดหุ้นที่ซื้อสำเร็จแล้ว" onClose={onClose}>
      {step === 'edit' ? (
        <div className="form">
          <p className="small">กรอกจาก <b>ประวัติคำสั่งซื้อใน Dime</b>: จำนวนหุ้น, ราคาซื้อ (USD) และยอดที่จ่าย — ระบบคำนวณอัตราแลกเปลี่ยนให้เอง ห้ามใช้ “มูลค่าปัจจุบัน” แทนยอดที่จ่าย</p>
          {rows.map((r, i) => {
            const pend = pendingFor(r.ticker);
            const { d, e, w } = checks[i];
            return (
              <fieldset key={r.key} className="card import-row">
                <legend>หุ้นที่ {i + 1}</legend>
                <div className="grid2">
                  <label>Ticker<input value={r.ticker} autoCapitalize="characters" onChange={ev => set(r.key, 'ticker', ev.target.value)} placeholder="VOO" /></label>
                  <label>จ่ายเป็น<div className="seg">{(['THB', 'USD'] as Currency[]).map(c => <button type="button" key={c} className={r.payCur === c ? 'on' : ''} onClick={() => set(r.key, 'payCur', c)}>{c}</button>)}</div></label>
                </div>
                {pend.length > 0 && (
                  <label>หุ้นนี้มีคำสั่งรอดำเนินการ — รายการนี้คือ:
                    <select value={r.link} onChange={ev => set(r.key, 'link', ev.target.value)}>
                      <option value="">— กรุณาเลือก —</option>
                      {pend.map(t => <option key={t.id} value={t.id}>คำสั่งรอ {fmtMoney(t.amount, t.currency)} วันที่ {fmtDate(t.datetime)} ที่ทำรายการสำเร็จแล้ว</option>)}
                      <option value="separate">เป็นการซื้อแยกต่างหาก (คงคำสั่งรอไว้ตามเดิม)</option>
                    </select>
                  </label>
                )}
                <div className="grid2">
                  <label>จำนวนหุ้น<input type="number" inputMode="decimal" step="any" min="0" value={r.quantity} onChange={ev => set(r.key, 'quantity', ev.target.value)} placeholder="0.0236388" /></label>
                  <label>ราคาซื้อ (USD)<input type="number" inputMode="decimal" step="any" min="0" value={r.priceUSD} onChange={ev => set(r.key, 'priceUSD', ev.target.value)} placeholder="280.47" /></label>
                  <label>{r.payCur === 'THB' ? 'ยอดที่จ่าย (THB)' : 'ยอดที่จ่าย (USD)'}<input type="number" inputMode="decimal" step="any" min="0" value={r.paid} onChange={ev => set(r.key, 'paid', ev.target.value)} placeholder={r.payCur === 'USD' && d.usd > 0 ? String(+d.usd.toFixed(6)) : ''} /></label>
                  {r.payCur === 'USD'
                    ? <label>FX จริง (บาท/USD)<input type="number" inputMode="decimal" step="any" min="0" value={r.fxRate} onChange={ev => set(r.key, 'fxRate', ev.target.value)} /></label>
                    : <label>FX ที่คำนวณได้<input readOnly value={d.fx > 0 ? fmtFx(d.fx) : ''} placeholder="อัตโนมัติ" tabIndex={-1} /></label>}
                  <label>วันที่ซื้อ<input type="date" value={r.date} onChange={ev => set(r.key, 'date', ev.target.value)} /></label>
                  <label>เวลา (ถ้าทราบ)<input type="time" value={r.time} onChange={ev => set(r.key, 'time', ev.target.value)} /></label>
                </div>
                {d.usd > 0 && <div className="tiny muted">มูลค่าซื้อ USD = {fmtQty(Number(r.quantity))} × ${r.priceUSD} = ${fmtQty(+d.usd.toFixed(8))}{d.fx > 0 && ` • ต้นทุน THB ${fmtMoney(d.thb, 'THB')}`}</div>}
                {w.map(x => <div key={x} className="hint">⚠️ {x}</div>)}
                {e.length > 0 && <div className="hint">ยังขาด: {e.join(', ')}</div>}
                {rows.length > 1 && <button type="button" className="btn small ghost danger-text" onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))}>ลบแถวนี้</button>}
              </fieldset>
            );
          })}
          <button type="button" className="btn small" onClick={() => setRows(rs => [...rs, blankRow()])}>+ เพิ่มหุ้นอีกตัว</button>
          <div className="row gap sticky-actions">
            <button type="button" className="btn ghost grow" onClick={onClose}>ยกเลิก</button>
            <button type="button" className="btn primary grow" disabled={!allOk} onClick={() => setStep('review')}>ตรวจสอบก่อนบันทึก</button>
          </div>
        </div>
      ) : (
        <div className="form">
          <p className="small">ตรวจสอบรายการ ระบบจะบันทึกเป็น “ซื้อสำเร็จ” ตามข้อมูลที่คุณกรอกเท่านั้น</p>
          {rows.map((r, i) => { const d = checks[i].d; return (
            <dl key={r.key} className="card preview review-card">
              <div><dt>หุ้น</dt><dd><b>{r.ticker}</b></dd></div>
              <div><dt>จำนวนหุ้น</dt><dd>{fmtQty(Number(r.quantity))}</dd></div>
              <div><dt>ราคาซื้อ (USD)</dt><dd>${r.priceUSD}</dd></div>
              <div><dt>FX (บาท/USD)</dt><dd>{fmtFx(d.fx)}</dd></div>
              <div><dt>ต้นทุน USD</dt><dd>${fmtQty(+d.usd.toFixed(8))}</dd></div>
              <div><dt>ต้นทุน THB</dt><dd>{fmtMoney(d.thb, 'THB')}</dd></div>
            </dl>); })}
          <ul className="plain small">{rows.map(r => <li key={r.key}>{r.ticker}: {r.link && r.link !== 'separate' ? 'อัปเดตคำสั่งรอดำเนินการเดิมเป็น “สำเร็จ” (รายการเดิม ไม่สร้างใหม่)' : pendingFor(r.ticker).length ? 'บันทึกเป็นการซื้อใหม่ และคงคำสั่งรอเดิมไว้' : 'บันทึกเป็นการซื้อใหม่'}</li>)}</ul>
          {checks.some(c => c.w.length) && <div className="hint">มีคำเตือน — ตรวจสอบแถวที่มีเครื่องหมาย ⚠️ ก่อนยืนยัน</div>}
          <div className="row gap sticky-actions">
            <button type="button" className="btn ghost grow" onClick={() => setStep('edit')}>กลับไปแก้ไข</button>
            <button type="button" className="btn primary grow" onClick={commit}>ยืนยันบันทึก {rows.length} รายการ</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** Shown instead of zero-valued figures when there are no executed holdings yet. */
export function Onboarding({ p, onImport, onAdd, onPending, onCsv, context }: { p: Portfolio; onImport: () => void; onAdd: () => void; onPending: () => void; onCsv: () => void; context: string }) {
  return (
    <section className="card onboarding">
      <h3>ยังไม่มีหุ้นที่บันทึกว่าซื้อสำเร็จในแอปนี้</h3>
      <p className="small">ตัวเลขพอร์ตจะยังไม่แสดงจนกว่าจะบันทึกหุ้นที่ซื้อสำเร็จ — <b>ไม่ได้หมายความว่าพอร์ตจริงใน Dime มีมูลค่าเป็นศูนย์</b></p>
      {p.pending.length > 0 && <p className="small hint">มีคำสั่งรอดำเนินการ {p.pending.length} รายการ ระบบไม่เปลี่ยนเป็น “สำเร็จ” เอง หาก Dime แสดงว่าคุณถือหุ้นเหล่านี้แล้ว ให้ยืนยันพร้อมกรอกจำนวนหุ้น ต้นทุน และ FX จริง</p>}
      <div className="onb-actions">
        <button className="btn primary" onClick={onImport}>นำเข้ายอดหุ้นที่ถืออยู่</button>
        {p.pending.length > 0 && <button className="btn" onClick={onPending}>ดูคำสั่งรอดำเนินการ</button>}
        <button className="btn" onClick={onAdd}>บันทึกการซื้อทีละรายการ</button>
        <button className="btn ghost" onClick={onCsv}>นำเข้าจาก CSV</button>
      </div>
      <p className="tiny muted">ข้อมูลของหน้าต่างนี้ ({context}) แยกจากหน้าต่างอื่นบน iPhone — ดูหมายเหตุในหน้า ตั้งค่า</p>
    </section>
  );
}
