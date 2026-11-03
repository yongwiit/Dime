import { useMemo, useState } from 'react';
import type { AppData, Currency } from './types';
import { applyImport, checkImportRows, type ImportRow } from './importer';
import type { Portfolio } from './engine';
import { Sheet } from './ui';
import { localISO } from './parser';
import { fmtMoney, fmtQty, fmtDate, fmtFx } from './format';
export { deriveImport } from './importer';

// Logic (FX derivation, validation, applying to data) lives in ./importer and is unit-tested there.
type Row = ImportRow;
const blankRow = (ticker = ''): Row => ({ key: crypto.randomUUID(), ticker, quantity: '', priceUSD: '', paid: '', payCur: 'THB', fxRate: '', date: localISO(new Date()).slice(0, 10), time: '', link: '' });

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
  const checks = useMemo(() => checkImportRows(data, rows).map(c => ({ e: c.errors, w: c.warnings, d: c.derived })), [data, rows]);

  const allOk = rows.length > 0 && checks.every(c => c.e.length === 0);

  const [err, setErr] = useState('');
  const commit = () => {
    try {
      const now = new Date().toISOString();
      // validate against the current data first so a failure never leaves a partial import
      applyImport(data, rows, now);
      update(d => applyImport(d, rows, now));
      onClose();
    } catch (e) { setErr(String(e)); setStep('edit'); }
  };

  return (
    <Sheet title="นำเข้ายอดหุ้นที่ซื้อสำเร็จแล้ว" onClose={onClose}>
      {step === 'edit' ? (
        <div className="form">
          {err && <div className="alert">{err}</div>}
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
