import { useMemo, useState } from 'react';
import type { AppData, Txn, TickerMeta } from './types';
import type { Portfolio, Position } from './engine';
import { fmtTHB, fmtUSD, fmtPct, fmtQty, fmtDate, fmtMoney, tone, TYPE_TH, STATUS_TH } from './format';
import { Donut, LineChart, Bars, Sheet, type ConfirmReq } from './ui';

type Ctx = {
  data: AppData; p: Portfolio;
  update: (fn: (d: AppData) => AppData) => void;
  openTxn: (t: Partial<Txn>, title?: string) => void;
  confirm: (r: ConfirmReq) => void;
  go: (tab: string) => void;
};

export function Dashboard({ data, p, go, openTxn }: Ctx) {
  const [cur, setCur] = useState<'THB' | 'USD'>('THB');
  const v = (thb: number, s?: boolean) => cur === 'THB' ? fmtTHB(thb, s) : fmtUSD(data.fx.rate > 0 ? thb / data.fx.rate : 0, s);
  const sectors = useMemo(() => {
    const m = new Map<string, number>();
    p.positions.forEach(x => m.set(x.sector || 'ไม่ระบุ', (m.get(x.sector || 'ไม่ระบุ') ?? 0) + x.weight));
    return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [p]);
  const snaps = data.snapshots.slice(-180);
  const noFx = !(data.fx.rate > 0);
  return (
    <div className="page">
      {noFx && <div className="alert">ยังไม่มีอัตราแลกเปลี่ยน USD/THB — ไปที่ <button className="link" onClick={() => go('more')}>ตั้งค่า</button> เพื่อดึงอัตราล่าสุดหรือกรอกเอง</div>}
      <section className="hero card">
        <div className="row between"><span className="muted">มูลค่าพอร์ตรวม{p.estimated && ' (ประมาณการ)'}</span>
          <div className="seg small">{(['THB', 'USD'] as const).map(c => <button key={c} className={cur === c ? 'on' : ''} onClick={() => setCur(c)}>{c}</button>)}</div></div>
        <div className="big">{v(p.totalValueTHB)}</div>
        <div className="muted small">{cur === 'THB' ? fmtUSD(p.totalValueUSD || 0) : fmtTHB(p.totalValueTHB)} • {data.fx.rate > 0 ? `${data.fx.rate.toFixed(2)} ฿/$` : '—'}</div>
        <div className="kpis">
          <Kpi label="วันนี้" value={p.dayChangeTHB !== undefined ? v(p.dayChangeTHB, true) : '—'} t={p.dayChangeTHB ?? 0} />
          <Kpi label="ยังไม่รับรู้" value={v(p.unrealizedTHB, true)} sub={fmtPct(p.unrealizedPct, true)} t={p.unrealizedTHB} />
          <Kpi label="รับรู้แล้ว" value={v(p.realizedTHB, true)} t={p.realizedTHB} />
          <Kpi label="ผลตอบแทนรวม" value={v(p.totalReturnTHB, true)} sub={fmtPct(p.totalReturnPct, true)} t={p.totalReturnTHB} />
        </div>
      </section>

      <section className="card grid-kv">
        <div><span>ต้นทุนหุ้นที่ถือ</span><b>{v(p.investedTHB)}</b></div>
        <div><span>มูลค่าหุ้น</span><b>{v(p.holdingsValueTHB)}</b></div>
        <div><span>เงินสด</span><b>{v(p.cashTotalTHB)}</b><small className="muted">{fmtTHB(p.cashTHB)} + {fmtUSD(p.cashUSD)}</small></div>
        <div><span>เงินฝากสุทธิ</span><b>{v(p.netDepositsTHB)}</b></div>
        <div><span>ปันผลสุทธิ</span><b>{v(p.dividendsTHB)}</b></div>
        <div><span>ค่าธรรมเนียมรวม</span><b>{v(p.feesTHB)}</b></div>
      </section>

      <section className="card">
        <div className="row between"><h3>สถานะคำสั่ง</h3></div>
        <div className="status3">
          <button onClick={() => go('holdings')}><b>{p.positions.length}</b><span>หุ้นที่ถือจริง</span></button>
          <button onClick={() => go('txns:PENDING')} className="pending"><b>{p.pending.length}</b><span>รอดำเนินการ</span><small>{fmtTHB(p.pendingTHB)}</small></button>
          <button onClick={() => go('txns:CANCELLED')}><b>{p.cancelled.length}</b><span>ยกเลิก</span></button>
        </div>
        {p.pending.length > 0 && <p className="hint">คำสั่งรอดำเนินการไม่ถูกนับรวมในมูลค่าพอร์ต หุ้นที่ถือ หรือเงินสด</p>}
      </section>

      {p.positions.length === 0 ? (
        <section className="card empty">
          <p>ยังไม่มีหุ้นที่ซื้อสำเร็จ</p>
          <button className="btn primary" onClick={() => openTxn({ type: 'BUY' }, 'บันทึกการซื้อ')}>บันทึกการซื้อแรก</button>
          <p className="muted small">หรือนำเข้า CSV / พิมพ์คำสั่งในหน้า ผู้ช่วย</p>
        </section>
      ) : <>
        <section className="card"><h3>สัดส่วนตามหุ้น</h3>
          <Donut items={p.positions.map(x => ({ label: x.ticker, value: x.marketValueTHB }))} center={<><b>{p.positions.length}</b><span>ตัว</span></>} />
        </section>
        <section className="card"><h3>สัดส่วนตามกลุ่ม</h3><Bars items={sectors} /></section>
      </>}

      <section className="card"><h3>ผลการดำเนินงาน</h3>
        <LineChart labels={snaps.map(s => s.date)} series={[
          { name: 'มูลค่าหุ้น (฿)', values: snaps.map(s => s.holdingsTHB), color: '#4f8cff' },
          { name: 'ต้นทุน (฿)', values: snaps.map(s => s.investedTHB), color: '#8a94a6', dashed: true },
        ]} />
      </section>

      {p.warnings.length > 0 && <section className="card warn"><h3>ข้อควรตรวจสอบ</h3><ul>{p.warnings.map(w => <li key={w}>{w}</li>)}</ul></section>}
    </div>
  );
}

function Kpi({ label, value, sub, t }: { label: string; value: string; sub?: string; t: number }) {
  return <div className="kpi"><span>{label}</span><b className={tone(t)}>{value}</b>{sub && <small className={tone(t)}>{sub}</small>}</div>;
}

export function Holdings({ data, p, update, openTxn, confirm }: Ctx) {
  const [edit, setEdit] = useState<Position | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const list = showClosed ? p.closed : p.positions;
  return (
    <div className="page">
      <div className="row between">
        <div className="seg">
          <button className={!showClosed ? 'on' : ''} onClick={() => setShowClosed(false)}>ถืออยู่ ({p.positions.length})</button>
          <button className={showClosed ? 'on' : ''} onClick={() => setShowClosed(true)}>ขายหมดแล้ว ({p.closed.length})</button>
        </div>
        <button className="btn primary small" onClick={() => openTxn({ type: 'BUY' }, 'เพิ่มหุ้น / บันทึกการซื้อ')}>+ เพิ่ม</button>
      </div>
      {list.length === 0 && <div className="card empty">ไม่มีรายการ{p.pending.length > 0 && !showClosed && ` • มีคำสั่งรอดำเนินการ ${p.pending.length} รายการ (ดูในหน้า รายการ)`}</div>}
      {list.map(x => (
        <article key={x.ticker} className="card holding" onClick={() => setEdit(x)}>
          <div className="row between">
            <div><b className="tk">{x.ticker}</b>{x.horizon === 'trading' && <span className="tag">เทรด</span>}<div className="muted small ellip">{x.name || 'ยังไม่ระบุชื่อบริษัท'}</div></div>
            <div className="right"><b>{fmtTHB(x.marketValueTHB)}</b><div className={`small ${tone(x.unrealizedTHB)}`}>{x.hasPrice ? `${fmtTHB(x.unrealizedTHB, true)} (${fmtPct(x.unrealizedPct, true)})` : 'ยังไม่มีราคา'}</div></div>
          </div>
          <div className="hgrid">
            <div><span>จำนวน</span>{fmtQty(x.quantity)}</div>
            <div><span>ต้นทุนเฉลี่ย</span>{fmtUSD(x.avgCostUSD)}</div>
            <div><span>ราคาปัจจุบัน</span>{x.hasPrice ? fmtUSD(x.price!) : '—'}</div>
            <div><span>มูลค่า (USD)</span>{fmtUSD(x.marketValueUSD)}</div>
            <div><span>น้ำหนัก</span>{fmtPct(x.weight)}{x.targetWeight ? ` / เป้า ${x.targetWeight}%` : ''}</div>
            <div><span>สกุลเงิน</span>USD</div>
          </div>
          {x.hasPrice && <div className="tiny muted">ราคา: {x.priceSource === 'finnhub' ? 'Finnhub (อาจล่าช้า)' : 'กรอกเอง'} • {fmtDate(x.priceAsOf!)}</div>}
          {showClosed && <div className="small">กำไร/ขาดทุนรับรู้: <b className={tone(x.realizedTHB)}>{fmtTHB(x.realizedTHB, true)}</b></div>}
        </article>
      ))}
      {edit && <HoldingEditor pos={edit} data={data} onClose={() => setEdit(null)} update={update} openTxn={openTxn} confirm={confirm} />}
    </div>
  );
}

function HoldingEditor({ pos, data, onClose, update, openTxn, confirm }: { pos: Position; data: AppData; onClose: () => void } & Pick<Ctx, 'update' | 'openTxn' | 'confirm'>) {
  const [m, setM] = useState<TickerMeta>(data.meta[pos.ticker] ?? { ticker: pos.ticker });
  const [price, setPrice] = useState<string>(data.prices[pos.ticker]?.source === 'manual' ? String(data.prices[pos.ticker].price) : '');
  const related = data.txns.filter(t => t.ticker === pos.ticker);
  const save = () => {
    update(d => {
      const prices = { ...d.prices };
      const pv = Number(price);
      if (price !== '' && pv > 0) prices[pos.ticker] = { ticker: pos.ticker, price: pv, asOf: new Date().toISOString(), source: 'manual', prevClose: d.prices[pos.ticker]?.prevClose };
      return { ...d, meta: { ...d.meta, [pos.ticker]: { ...m, targetWeight: m.targetWeight || undefined } }, prices };
    });
    onClose();
  };
  return (
    <Sheet title={`แก้ไข ${pos.ticker}`} onClose={onClose}>
      <div className="form">
        <label>ชื่อบริษัท / กองทุน<input value={m.name ?? ''} onChange={e => setM({ ...m, name: e.target.value })} /></label>
        <label>กลุ่มอุตสาหกรรม<input value={m.sector ?? ''} onChange={e => setM({ ...m, sector: e.target.value })} placeholder="เช่น Technology, Broad ETF" /></label>
        <label>ประเภทการถือ
          <div className="seg"><button type="button" className={m.horizon !== 'trading' ? 'on' : ''} onClick={() => setM({ ...m, horizon: 'long' })}>ระยะยาว</button><button type="button" className={m.horizon === 'trading' ? 'on' : ''} onClick={() => setM({ ...m, horizon: 'trading' })}>เทรด</button></div>
        </label>
        <div className="grid2">
          <label>เป้าหมายสัดส่วน (%)<input type="number" inputMode="decimal" min="0" max="100" step="any" value={m.targetWeight ?? ''} onChange={e => setM({ ...m, targetWeight: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
          <label>ราคาปัจจุบัน (USD) กรอกเอง<input type="number" inputMode="decimal" min="0" step="any" value={price} onChange={e => setPrice(e.target.value)} placeholder={pos.price ? String(pos.price) : ''} /></label>
        </div>
        <div className="row gap"><button className="btn ghost grow" onClick={onClose}>ยกเลิก</button><button className="btn primary grow" onClick={save}>บันทึก</button></div>
        <hr />
        <div className="row gap wrap">
          <button className="btn small" onClick={() => { onClose(); openTxn({ type: 'BUY', ticker: pos.ticker }, `ซื้อ ${pos.ticker}`); }}>+ ซื้อ</button>
          <button className="btn small" onClick={() => { onClose(); openTxn({ type: 'SELL', ticker: pos.ticker }, `ขาย ${pos.ticker}`); }}>− ขาย</button>
          <button className="btn small" onClick={() => { onClose(); openTxn({ type: 'DIVIDEND', ticker: pos.ticker }, `ปันผล ${pos.ticker}`); }}>ปันผล</button>
          <button className="btn small danger" onClick={() => confirm({
            title: `ลบ ${pos.ticker} ทั้งหมด?`, danger: true, ok: 'ลบถาวร',
            body: <p>จะลบรายการที่เกี่ยวกับ {pos.ticker} ทั้งหมด {related.length} รายการ (รวมคำสั่งรอดำเนินการ) การลบนี้ย้อนกลับไม่ได้ ยกเว้นกู้คืนจากไฟล์สำรอง</p>,
            onOk: () => { update(d => ({ ...d, txns: d.txns.filter(t => t.ticker !== pos.ticker) })); onClose(); },
          })}>ลบหุ้นนี้</button>
        </div>
      </div>
    </Sheet>
  );
}

export function Transactions({ data, update, openTxn, confirm, initialStatus }: Ctx & { initialStatus?: string }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(initialStatus ?? 'ALL');
  const [type, setType] = useState('ALL');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...data.txns]
      .filter(t => status === 'ALL' || t.status === status)
      .filter(t => type === 'ALL' || t.type === type)
      .filter(t => !s || [t.ticker, t.notes, TYPE_TH[t.type], STATUS_TH[t.status], t.datetime].some(f => f?.toLowerCase().includes(s)))
      .sort((a, b) => b.datetime.localeCompare(a.datetime));
  }, [data.txns, q, status, type]);
  return (
    <div className="page">
      <div className="row gap"><input className="search grow" type="search" placeholder="ค้นหา ticker, หมายเหตุ, วันที่…" value={q} onChange={e => setQ(e.target.value)} /><button className="btn primary small" onClick={() => openTxn({}, 'เพิ่มรายการ')}>+ เพิ่ม</button></div>
      <div className="chips">
        {['ALL', 'EXECUTED', 'PENDING', 'CANCELLED'].map(s => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s === 'ALL' ? 'ทุกสถานะ' : STATUS_TH[s]}</button>)}
      </div>
      <div className="chips">
        {['ALL', 'BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'ADJUSTMENT'].map(s => <button key={s} className={type === s ? 'on' : ''} onClick={() => setType(s)}>{s === 'ALL' ? 'ทุกประเภท' : TYPE_TH[s]}</button>)}
      </div>
      <div className="muted small">{rows.length} รายการ</div>
      {rows.length === 0 && <div className="card empty">ไม่พบรายการ</div>}
      {rows.map(t => (
        <article key={t.id} className={`card txn st-${t.status}`}>
          <div className="row between">
            <div><span className={`badge t-${t.type}`}>{TYPE_TH[t.type]}</span> <b>{t.ticker ?? ''}</b> <span className={`badge s-${t.status}`}>{STATUS_TH[t.status]}</span></div>
            <b>{fmtMoney(t.amount, t.currency)}</b>
          </div>
          <div className="small muted">{fmtDate(t.datetime)}{t.quantity ? ` • ${fmtQty(t.quantity)} หุ้น` : ''}{t.price ? ` @ ${fmtMoney(t.price, t.currency)}` : ''}{t.fxRate ? ` • ${t.fxRate} ฿/$` : ''}{t.fees ? ` • ค่าธรรมเนียม ${fmtMoney(t.fees, t.currency)}` : ''}</div>
          {t.notes && <div className="small">{t.notes}</div>}
          <div className="row gap wrap actions">
            {t.status === 'PENDING' && <button className="btn small primary" onClick={() => openTxn({ ...t, status: 'EXECUTED' }, 'ยืนยันว่าทำรายการสำเร็จ')}>ยืนยันว่าสำเร็จ</button>}
            {t.status === 'PENDING' && <button className="btn small" onClick={() => confirm({ title: 'ยกเลิกคำสั่งนี้?', ok: 'ทำเครื่องหมายยกเลิก', body: <p>{TYPE_TH[t.type]} {t.ticker} {fmtMoney(t.amount, t.currency)} จะถูกเปลี่ยนสถานะเป็น “ยกเลิก”</p>, onOk: () => update(d => ({ ...d, txns: d.txns.map(x => x.id === t.id ? { ...x, status: 'CANCELLED', updatedAt: new Date().toISOString() } : x) })) })}>ยกเลิกคำสั่ง</button>}
            <button className="btn small ghost" onClick={() => openTxn(t, 'แก้ไขรายการ')}>แก้ไข</button>
            <button className="btn small ghost danger-text" onClick={() => confirm({ title: 'ลบรายการนี้?', danger: true, ok: 'ลบถาวร', body: <p>{TYPE_TH[t.type]} {t.ticker ?? ''} {fmtMoney(t.amount, t.currency)} ({STATUS_TH[t.status]}) วันที่ {fmtDate(t.datetime)}</p>, onOk: () => update(d => ({ ...d, txns: d.txns.filter(x => x.id !== t.id) })) })}>ลบ</button>
          </div>
        </article>
      ))}
    </div>
  );
}
