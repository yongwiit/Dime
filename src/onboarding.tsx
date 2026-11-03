import { useMemo, useState } from 'react';
import type { AppData, Currency, Txn } from './types';
import type { Portfolio } from './engine';
import { Sheet } from './ui';
import { newTxn } from './store';
import { localISO } from './parser';
import { fmtMoney, fmtQty, fmtDate } from './format';

/* Import holdings the user confirms were actually bought.
   Each row needs real shares, real total cost and the real FX rate; nothing is guessed.
   A row may be linked to an existing PENDING order, but only when the user explicitly chooses so. */

interface Row { key: string; ticker: string; quantity: string; cost: string; currency: Currency; fxRate: string; date: string; link: '' | 'separate' | string }

const blankRow = (ticker = '', fx = ''): Row => ({ key: crypto.randomUUID(), ticker, quantity: '', cost: '', currency: 'USD', fxRate: fx, date: localISO(new Date()).slice(0, 10), link: '' });

export function ImportHoldings({ data, p, onClose, update }: { data: AppData; p: Portfolio; onClose: () => void; update: (fn: (d: AppData) => AppData) => void }) {
  const fx = data.fx.rate > 0 ? String(data.fx.rate) : '';
  const pendingTickers = [...new Set(p.pending.map(t => t.ticker).filter(Boolean))] as string[];
  const [rows, setRows] = useState<Row[]>(() => (pendingTickers.length ? pendingTickers.map(t => blankRow(t, '')) : [blankRow('', '')]));
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const set = (k: string, f: keyof Row, v: string) => setRows(rs => rs.map(r => (r.key === k ? { ...r, [f]: f === 'ticker' ? v.toUpperCase().trim() : v } : r)));

  const pendingFor = (tk: string) => p.pending.filter(t => t.ticker === tk);
  const usedLinks = rows.map(r => r.link).filter(l => l && l !== 'separate');

  const checks = useMemo(() => rows.map(r => {
    const e: string[] = [];
    const q = Number(r.quantity), c = Number(r.cost), f = Number(r.fxRate);
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(r.ticker)) e.push('Ticker');
    if (!(q > 0)) e.push('จำนวนหุ้น');
    if (!(c > 0)) e.push('ต้นทุนรวม');
    if (!(f > 0)) e.push('อัตราแลกเปลี่ยนจริง');
    if (!r.date) e.push('วันที่ซื้อ');
    if (pendingFor(r.ticker).length && !r.link) e.push('เลือกว่าเกี่ยวกับคำสั่งรอดำเนินการหรือไม่');
    if (r.link && r.link !== 'separate' && usedLinks.filter(l => l === r.link).length > 1) e.push('เลือกคำสั่งรอเดียวกันซ้ำ');
    return e;
  }), [rows, p.pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const allOk = rows.length > 0 && checks.every(c => c.length === 0);

  const commit = () => {
    const now = new Date().toISOString();
    update(d => {
      let txns = [...d.txns];
      for (const r of rows) {
        const q = Number(r.quantity), c = Number(r.cost), f = Number(r.fxRate);
        const fields: Partial<Txn> = {
          type: 'BUY', status: 'EXECUTED', ticker: r.ticker, quantity: q, price: +(c / q).toFixed(8), amount: c,
          currency: r.currency, fxRate: f, fees: 0, datetime: `${r.date}T09:00`,
        };
        if (r.link && r.link !== 'separate') {
          txns = txns.map(t => (t.id === r.link ? {
            ...t, ...fields, datetime: t.datetime, updatedAt: now,
            notes: `${t.notes ? t.notes + ' • ' : ''}ผู้ใช้ยืนยันว่าทำรายการสำเร็จ (นำเข้ายอดหุ้น ${fmtDate(now)})`,
          } as Txn : t));
        } else {
          txns.push(newTxn({ ...fields, source: 'import', notes: 'ยอดหุ้นที่ผู้ใช้ยืนยันว่าซื้อสำเร็จ (นำเข้ายอดหุ้น)' }));
        }
      }
      return { ...d, txns };
    });
    onClose();
  };

  return (
    <Sheet title="นำเข้ายอดหุ้นที่ซื้อสำเร็จแล้ว" onClose={onClose}>
      {step === 'edit' ? (
        <div className="form">
          <p className="small">กรอกจากหน้ารายละเอียดหุ้นใน Dime: <b>จำนวนหุ้น</b>, <b>ต้นทุนรวม</b> และ<b>อัตราแลกเปลี่ยนที่ใช้จริง</b> — ห้ามใช้ “มูลค่าปัจจุบัน” แทนต้นทุน</p>
          {rows.map((r, i) => {
            const pend = pendingFor(r.ticker);
            return (
              <fieldset key={r.key} className="card import-row">
                <legend>หุ้นที่ {i + 1}</legend>
                <div className="grid2">
                  <label>Ticker<input value={r.ticker} autoCapitalize="characters" onChange={e => set(r.key, 'ticker', e.target.value)} placeholder="VOO" /></label>
                  <label>วันที่ซื้อ<input type="date" value={r.date} onChange={e => set(r.key, 'date', e.target.value)} /></label>
                  <label>จำนวนหุ้น<input type="number" inputMode="decimal" step="any" min="0" value={r.quantity} onChange={e => set(r.key, 'quantity', e.target.value)} placeholder="0.0423" /></label>
                  <label>ต้นทุนรวม ({r.currency})<input type="number" inputMode="decimal" step="any" min="0" value={r.cost} onChange={e => set(r.key, 'cost', e.target.value)} /></label>
                </div>
                <div className="grid2">
                  <label>สกุลเงินของต้นทุน<div className="seg">{(['USD', 'THB'] as Currency[]).map(c => <button type="button" key={c} className={r.currency === c ? 'on' : ''} onClick={() => set(r.key, 'currency', c)}>{c}</button>)}</div></label>
                  <label>FX จริง (บาท/USD)<input type="number" inputMode="decimal" step="any" min="0" value={r.fxRate} onChange={e => set(r.key, 'fxRate', e.target.value)} placeholder={fx ? `อัตราวันนี้ ${fx}` : ''} /></label>
                </div>
                {pend.length > 0 && (
                  <label>หุ้นนี้มีคำสั่งรอดำเนินการ — รายการนี้คือ:
                    <select value={r.link} onChange={e => set(r.key, 'link', e.target.value)}>
                      <option value="">— กรุณาเลือก —</option>
                      {pend.map(t => <option key={t.id} value={t.id}>คำสั่งรอ {fmtMoney(t.amount, t.currency)} วันที่ {fmtDate(t.datetime)} ที่ทำรายการสำเร็จแล้ว</option>)}
                      <option value="separate">เป็นการซื้อแยกต่างหาก (คงคำสั่งรอไว้ตามเดิม)</option>
                    </select>
                  </label>
                )}
                {checks[i].length > 0 && <div className="hint">ยังขาด: {checks[i].join(', ')}</div>}
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
          <div className="table-wrap"><table>
            <thead><tr><th>หุ้น</th><th>จำนวน</th><th>ต้นทุน</th><th>ต้นทุน/หุ้น</th><th>FX</th></tr></thead>
            <tbody>{rows.map(r => <tr key={r.key}><td>{r.ticker}</td><td>{fmtQty(Number(r.quantity))}</td><td>{fmtMoney(Number(r.cost), r.currency)}</td><td>{fmtMoney(Number(r.cost) / Number(r.quantity), r.currency)}</td><td>{r.fxRate}</td></tr>)}</tbody>
          </table></div>
          <ul className="plain small">{rows.map(r => <li key={r.key}>{r.ticker}: {r.link && r.link !== 'separate' ? 'แทนที่คำสั่งรอดำเนินการที่เลือก (คำสั่งนั้นจะเปลี่ยนเป็นสำเร็จ ตามที่คุณยืนยัน)' : pendingFor(r.ticker).length ? 'บันทึกเป็นการซื้อใหม่ และคงคำสั่งรอเดิมไว้' : 'บันทึกเป็นการซื้อใหม่'}</li>)}</ul>
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
