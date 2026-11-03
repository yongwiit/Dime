import { useEffect, useRef, useState } from 'react';
import type { AppData, Txn } from './types';
import type { Portfolio } from './engine';
import { monthlySummary, validateTxn, checkAgainstPortfolio } from './engine';
import { parseCommand, type ParseResult } from './parser';
import { answer } from './assistant';
import { fetchFx, fetchQuote, fetchResearch, type Research } from './market';
import { txnsToCSV, csvToTxns, download, toCSV } from './csv';
import { migrate, newTxn } from './store';
import { fmtTHB, fmtPct, fmtDate, fmtMoney, fmtNum, TYPE_TH, STATUS_TH } from './format';
import { TxnPreview, type ConfirmReq } from './ui';

type Ctx = {
  data: AppData; p: Portfolio;
  update: (fn: (d: AppData) => AppData) => void;
  openTxn: (t: Partial<Txn>, title?: string, onSaved?: () => void) => void;
  confirm: (r: ConfirmReq) => void;
  go: (tab: string) => void;
};

interface Msg { id: string; role: 'user' | 'bot'; text?: string; proposal?: ParseResult; state?: 'open' | 'saved' | 'discarded' }

const SUGGEST = ['ช่วยวิเคราะห์พอร์ตปัจจุบัน', 'หุ้นตัวไหนมีความเสี่ยงสูงที่สุด', 'ถ้ามีเงินเพิ่ม 5,000 บาท ควร DCA ตัวไหน', 'ควรลดสัดส่วนหุ้นตัวไหนหรือไม่', 'สรุปผลประกอบการของหุ้นที่ถืออยู่', 'ซื้อ NVDA จำนวน 1 หุ้น ราคา 180 USD'];

export function Assistant({ data, update, openTxn }: Ctx) {
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 'hi', role: 'bot', text: 'สวัสดีครับ ถามเกี่ยวกับพอร์ต หรือพิมพ์คำสั่งบันทึกรายการได้เลย\nทุกรายการจะแสดงตัวอย่างให้ตรวจก่อน และจะบันทึกก็ต่อเมื่อคุณกด “ยืนยันบันทึก” เท่านั้น' }]);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const send = (q: string) => {
    const v = q.trim(); if (!v) return;
    const user: Msg = { id: crypto.randomUUID(), role: 'user', text: v };
    const parsed = parseCommand(v);
    if (parsed) {
      if (!parsed.draft.fxRate && data.fx.rate > 0 && parsed.draft.status === 'EXECUTED') {
        parsed.draft.fxRate = data.fx.rate;
        parsed.notes.push(`ไม่ได้ระบุอัตราแลกเปลี่ยน จึงใส่อัตราปัจจุบัน ${data.fx.rate.toFixed(4)} ให้ก่อน — แก้เป็นอัตราจริงที่ Dime ใช้ได้`);
        parsed.missingForExecuted = validateTxn({ ...parsed.draft, status: 'EXECUTED' });
      }
      setMsgs(m => [...m, user, { id: crypto.randomUUID(), role: 'bot', proposal: parsed, state: 'open' }]);
    } else {
      setMsgs(m => [...m, user, { id: crypto.randomUUID(), role: 'bot', text: answer(v, data) }]);
    }
    setText('');
  };
  const setState = (id: string, state: Msg['state']) => setMsgs(m => m.map(x => x.id === id ? { ...x, state } : x));
  const save = (id: string, draft: Partial<Txn>) => {
    update(d => ({ ...d, txns: [...d.txns, newTxn({ ...draft, source: 'assistant' })] }));
    setState(id, 'saved');
  };

  return (
    <div className="page chat">
      <div className="msgs">
        {msgs.map(m => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.text && <div className="bubble">{m.text}</div>}
            {m.proposal && <Proposal m={m} data={data} onSave={d => save(m.id, d)} onDiscard={() => setState(m.id, 'discarded')} onEdit={() => openTxn(m.proposal!.draft, 'แก้ไขก่อนบันทึก', () => setState(m.id, 'saved'))} />}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chips scroll">{SUGGEST.map(s => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>
      <form className="composer" onSubmit={e => { e.preventDefault(); send(text); }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="พิมพ์คำถาม หรือ “ซื้อ VOO 0.5 หุ้น ราคา 520 USD”" aria-label="ข้อความ" />
        <button className="btn primary" type="submit" disabled={!text.trim()}>ส่ง</button>
      </form>
      <p className="tiny muted center">ผู้ช่วยนี้คำนวณจากข้อมูลในแอป (ไม่ได้ใช้ LLM) • ไม่ส่งคำสั่งซื้อขายไปที่ Dime</p>
    </div>
  );
}

function Proposal({ m, data, onSave, onDiscard, onEdit }: { m: Msg; data: AppData; onSave: (d: Partial<Txn>) => void; onDiscard: () => void; onEdit: () => void }) {
  const r = m.proposal!;
  const [asPending, setAsPending] = useState(r.draft.status === 'PENDING');
  const draft = { ...r.draft, status: asPending ? 'PENDING' : 'EXECUTED' } as Partial<Txn>;
  const errs = [...validateTxn(draft), ...checkAgainstPortfolio(data, draft)];
  const canExec = r.missingForExecuted.length === 0;
  return (
    <div className="bubble proposal">
      <b>ตัวอย่างรายการ (ยังไม่ได้บันทึก)</b>
      <TxnPreview t={draft} />
      {r.notes.map(n => <div key={n} className="hint">• {n}</div>)}
      {!canExec && <div className="hint">ข้อมูลที่ยังขาดสำหรับรายการที่สำเร็จแล้ว: {r.missingForExecuted.join(', ')}</div>}
      {(draft.type === 'BUY' || draft.type === 'SELL') && (
        <div className="seg small">
          <button className={!asPending ? 'on' : ''} disabled={!canExec} onClick={() => setAsPending(false)}>ทำรายการสำเร็จแล้ว</button>
          <button className={asPending ? 'on' : ''} onClick={() => setAsPending(true)}>คำสั่งรอดำเนินการ</button>
        </div>
      )}
      {m.state === 'open' ? (
        <div className="row gap wrap">
          <button className="btn primary small" disabled={errs.length > 0} onClick={() => onSave(draft)}>ยืนยันบันทึก</button>
          <button className="btn small" onClick={onEdit}>แก้ไข/เพิ่มข้อมูล</button>
          <button className="btn small ghost" onClick={onDiscard}>ไม่บันทึก</button>
        </div>
      ) : <div className={m.state === 'saved' ? 'pos small' : 'muted small'}>{m.state === 'saved' ? '✓ บันทึกแล้ว และคำนวณพอร์ตใหม่แล้ว' : 'ไม่ได้บันทึก'}</div>}
      {m.state === 'open' && errs.length > 0 && <div className="hint">ยังบันทึกไม่ได้: {errs.join(', ')}</div>}
    </div>
  );
}

export function More({ go, ...ctx }: Ctx) {
  const [sec, setSec] = useState<'research' | 'reports' | 'settings'>('research');
  return (
    <div className="page">
      <div className="seg full">
        <button className={sec === 'research' ? 'on' : ''} onClick={() => setSec('research')}>วิจัย</button>
        <button className={sec === 'reports' ? 'on' : ''} onClick={() => setSec('reports')}>รายงาน</button>
        <button className={sec === 'settings' ? 'on' : ''} onClick={() => setSec('settings')}>ตั้งค่า & สำรอง</button>
      </div>
      {sec === 'research' && <ResearchView {...ctx} go={go} />}
      {sec === 'reports' && <Reports {...ctx} go={go} />}
      {sec === 'settings' && <SettingsView {...ctx} go={go} />}
    </div>
  );
}

const METRIC_TH: Record<string, string> = {
  peTTM: 'P/E (TTM)', pbQuarterly: 'P/BV', psTTM: 'P/S (TTM)', epsTTM: 'EPS (TTM, USD)', epsGrowthTTMYoy: 'EPS โต YoY %', revenueGrowthTTMYoy: 'รายได้โต YoY %', revenueGrowth5Y: 'รายได้โต 5 ปี %/ปี',
  netProfitMarginTTM: 'อัตรากำไรสุทธิ %', operatingMarginTTM: 'อัตรากำไรจากการดำเนินงาน %', roeTTM: 'ROE %', 'totalDebt/totalEquityQuarterly': 'หนี้สิน/ทุน', currentRatioQuarterly: 'Current ratio',
  freeCashFlowPerShareTTM: 'FCF/หุ้น (USD)', pfcfShareTTM: 'P/FCF', dividendYieldIndicatedAnnual: 'ปันผล %', beta: 'Beta', '52WeekHigh': 'สูงสุด 52 สัปดาห์', '52WeekLow': 'ต่ำสุด 52 สัปดาห์',
  '13WeekPriceReturnDaily': 'ผลตอบแทนราคา 13 สัปดาห์ %', '26WeekPriceReturnDaily': 'ผลตอบแทนราคา 26 สัปดาห์ %', '52WeekPriceReturnDaily': 'ผลตอบแทนราคา 52 สัปดาห์ %',
};

function ResearchView({ data, p, update, go }: Ctx) {
  const tickers = [...new Set([...p.positions.map(x => x.ticker), ...p.pending.map(x => x.ticker!).filter(Boolean)])];
  const [tk, setTk] = useState(tickers[0] ?? '');
  const [res, setRes] = useState<Research | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const key = data.settings.finnhubKey;
  const load = async () => {
    if (!key || !tk) return;
    setBusy(true); setErr(''); setRes(null);
    try {
      const r = await fetchResearch(tk.toUpperCase(), key);
      setRes(r);
      if (r.profile?.name) update(d => ({ ...d, meta: { ...d.meta, [tk]: { ...d.meta[tk], ticker: tk, name: d.meta[tk]?.name || r.profile!.name, sector: d.meta[tk]?.sector || r.profile!.industry } } }));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const pos = p.positions.find(x => x.ticker === tk);
  const hi = res?.metrics?.['52WeekHigh'], lo = res?.metrics?.['52WeekLow'];
  return (
    <>
      <section className="card">
        <h3>ความเสี่ยงระดับพอร์ต</h3>
        <ul className="plain small">
          <li>ตัวใหญ่สุด: {p.positions[0] ? `${p.positions[0].ticker} ${fmtPct(p.positions[0].weight)}` : '—'}</li>
          <li>กระจุกตัว 3 อันดับแรก: {fmtPct(p.positions.slice(0, 3).reduce((a, x) => a + x.weight, 0))}</li>
          <li>เกณฑ์ขาดทุนรายตัว {data.settings.maxStockLossPct}%: {p.positions.filter(x => x.hasPrice && x.unrealizedPct <= -data.settings.maxStockLossPct).map(x => x.ticker).join(', ') || 'ไม่มีตัวเกินเกณฑ์'}</li>
          <li className="muted">ค่าสหสัมพันธ์ (correlation) และอินดิเคเตอร์ทางเทคนิคต้องใช้ราคาย้อนหลัง ซึ่งแหล่งข้อมูลฟรีที่ใช้อยู่ไม่มีให้ — ยังไม่เปิดใช้</li>
        </ul>
        <button className="btn small" onClick={() => go('assistant')}>ถามผู้ช่วยเรื่องความเสี่ยง / DCA →</button>
      </section>
      <section className="card">
        <h3>ข้อมูลพื้นฐานรายตัว</h3>
        {!key ? <p className="small">ต้องใส่ Finnhub API key (สมัครฟรีที่ finnhub.io) ในแท็บ “ตั้งค่า & สำรอง” ก่อน ระบบจะไม่แสดงตัวเลขที่ไม่มีแหล่งที่มา</p> : <>
          <div className="row gap">
            <input className="grow" list="rtk" value={tk} onChange={e => setTk(e.target.value.toUpperCase())} placeholder="Ticker" />
            <datalist id="rtk">{tickers.map(t => <option key={t} value={t} />)}</datalist>
            <button className="btn primary" onClick={load} disabled={busy || !tk}>{busy ? 'กำลังโหลด…' : 'โหลด'}</button>
          </div>
          {err && <div className="alert">{err}</div>}
          {res && <div className="research">
            <div className="tiny muted">แหล่งที่มา: Finnhub.io • ดึงข้อมูลเมื่อ {fmtDate(res.fetchedAt)} • ตัวเลขงบเป็นข้อมูลล่าสุดที่ Finnhub มี (TTM/รายไตรมาส)</div>
            {res.profile && <p><b>{res.profile.name}</b> — {res.profile.industry}{res.profile.marketCap ? ` • มูลค่าตลาด ~${fmtNum(res.profile.marketCap / 1000)} พันล้าน USD` : ''}</p>}
            {res.metrics && <dl className="metrics">{Object.entries(res.metrics).map(([k, v]) => <div key={k}><dt>{METRIC_TH[k] ?? k}</dt><dd>{v === undefined || v === null ? '—' : fmtNum(v as number)}</dd></div>)}</dl>}
            {hi && lo && pos?.price && <p className="small">ราคาปัจจุบันอยู่ที่ {fmtPct(((pos.price - lo) / (hi - lo)) * 100)} ของช่วง 52 สัปดาห์ และต่ำกว่าจุดสูงสุด {fmtPct((1 - pos.price / hi) * 100)}</p>}
            {res.news.length > 0 && <><h4>ข่าว 14 วันล่าสุด</h4><ul className="plain news">{res.news.map(n => <li key={n.url}><a href={n.url} target="_blank" rel="noreferrer noopener">{n.headline}</a><div className="tiny muted">{n.source} • {fmtDate(new Date(n.datetime * 1000).toISOString())}</div></li>)}</ul></>}
            {res.errors.map(e => <div key={e} className="hint">{e}</div>)}
          </div>}
        </>}
      </section>
    </>
  );
}

function Reports({ data, p }: Ctx) {
  const months = monthlySummary(data);
  const divs = data.txns.filter(t => t.type === 'DIVIDEND' && t.status === 'EXECUTED').sort((a, b) => b.datetime.localeCompare(a.datetime));
  const exportSnaps = () => download(`dime-performance-${today()}.csv`, toCSV(data.snapshots as unknown as Record<string, unknown>[], ['date', 'valueTHB', 'holdingsTHB', 'investedTHB', 'netDepositsTHB', 'estimated']), 'text/csv;charset=utf-8');
  const exportHoldings = () => download(`dime-holdings-${today()}.csv`, toCSV(p.positions.map(x => ({ ...x, priceAsOf: x.priceAsOf ?? '' })) as unknown as Record<string, unknown>[], ['ticker', 'name', 'sector', 'quantity', 'avgCostUSD', 'costUSD', 'costTHB', 'price', 'priceAsOf', 'marketValueUSD', 'marketValueTHB', 'unrealizedTHB', 'unrealizedPct', 'weight']), 'text/csv;charset=utf-8');
  return (
    <>
      <section className="card">
        <h3>ส่งออก CSV</h3>
        <div className="row gap wrap">
          <button className="btn small" onClick={() => download(`dime-transactions-${today()}.csv`, txnsToCSV(data.txns), 'text/csv;charset=utf-8')}>รายการทั้งหมด</button>
          <button className="btn small" onClick={exportHoldings}>หุ้นที่ถือ</button>
          <button className="btn small" onClick={exportSnaps}>ประวัติมูลค่าพอร์ต</button>
        </div>
      </section>
      <section className="card">
        <h3>สรุปรายเดือน (บาท, เฉพาะรายการสำเร็จ)</h3>
        {months.length === 0 ? <p className="muted small">ยังไม่มีรายการสำเร็จ</p> :
          <div className="table-wrap"><table><thead><tr><th>เดือน</th><th>ฝาก</th><th>ซื้อ</th><th>ขาย</th><th>ปันผล</th><th>ค่าธรรมเนียม</th></tr></thead>
            <tbody>{months.map(m => <tr key={m.month}><td>{m.month}</td><td>{fmtNum(m.deposits - m.withdrawals)}</td><td>{fmtNum(m.buys)}</td><td>{fmtNum(m.sells)}</td><td>{fmtNum(m.dividends)}</td><td>{fmtNum(m.fees)}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="card">
        <h3>ประวัติปันผล</h3>
        {divs.length === 0 ? <p className="muted small">ยังไม่มีรายการปันผล</p> : <ul className="plain">{divs.map(t => <li key={t.id} className="row between"><span>{t.ticker} <span className="muted tiny">{fmtDate(t.datetime)}</span></span><span>{fmtMoney(t.amount - (t.fees || 0), t.currency)} สุทธิ</span></li>)}</ul>}
        <p className="small">รวมปันผลสุทธิ {fmtTHB(p.dividendsTHB)}</p>
      </section>
      <section className="card">
        <h3>ประวัติมูลค่าพอร์ต</h3>
        {data.snapshots.length === 0 ? <p className="muted small">ยังไม่มีข้อมูล</p> :
          <div className="table-wrap"><table><thead><tr><th>วันที่</th><th>มูลค่าหุ้น</th><th>ต้นทุน</th><th>รวมเงินสด</th></tr></thead>
            <tbody>{[...data.snapshots].reverse().slice(0, 60).map(s => <tr key={s.date}><td>{s.date}{s.estimated ? '*' : ''}</td><td>{fmtNum(s.holdingsTHB)}</td><td>{fmtNum(s.investedTHB)}</td><td>{fmtNum(s.valueTHB)}</td></tr>)}</tbody></table></div>}
        <p className="tiny muted">* ประมาณการ (มีบางตัวยังไม่มีราคา)</p>
      </section>
    </>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function SettingsView({ data, p, update, confirm }: Ctx) {
  const [fx, setFx] = useState(data.fx.rate > 0 ? String(data.fx.rate) : '');
  const [key, setKey] = useState(data.settings.finnhubKey ?? '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const csvFile = useRef<HTMLInputElement>(null);

  const autoFx = async () => {
    setBusy(true); setMsg('');
    try { const q = await fetchFx(); update(d => ({ ...d, fx: q })); setFx(String(q.rate)); setMsg(`อัปเดตอัตรา ${q.rate} บาท/USD (ECB ผ่าน Frankfurter, วันที่ ${q.asOf})`); }
    catch (e) { setMsg(String(e) + ' — กรอกอัตราเองได้'); } finally { setBusy(false); }
  };
  const refreshPrices = async () => {
    if (!data.settings.finnhubKey) { setMsg('ต้องใส่ Finnhub API key ก่อน'); return; }
    setBusy(true); setMsg('');
    const out: string[] = [];
    const prices = { ...data.prices };
    for (const x of p.positions) {
      try { prices[x.ticker] = await fetchQuote(x.ticker, data.settings.finnhubKey); out.push(`${x.ticker} ✓`); }
      catch (e) { out.push(`${x.ticker} ✗ ${String(e)}`); }
    }
    update(d => ({ ...d, prices }));
    setMsg(out.join(' • ') || 'ยังไม่มีหุ้นที่ถือ'); setBusy(false);
  };
  const backup = () => {
    // the Finnhub key is deliberately excluded so the backup file can be stored or shared without exposing it
    const { finnhubKey: _omit, ...settings } = data.settings;
    download(`dime-backup-${today()}.json`, JSON.stringify({ ...data, settings }, null, 2), 'application/json');
  };
  const restore = async (f: File) => {
    try {
      const d = migrate(JSON.parse(await f.text()));
      confirm({ title: 'กู้คืนข้อมูล?', danger: true, ok: 'แทนที่ข้อมูลปัจจุบัน', body: <p>ไฟล์มี {d.txns.length} รายการ ข้อมูลปัจจุบัน ({data.txns.length} รายการ) จะถูกแทนที่ทั้งหมด แนะนำให้สำรองข้อมูลปัจจุบันก่อน</p>, onOk: () => { update(cur => ({ ...d, settings: { ...d.settings, finnhubKey: cur.settings.finnhubKey ?? d.settings.finnhubKey } })); setMsg('กู้คืนข้อมูลแล้ว'); } });
    } catch (e) { setMsg('อ่านไฟล์ไม่สำเร็จ: ' + String(e)); }
  };
  const importCsv = async (f: File) => {
    const r = csvToTxns(await f.text());
    const ids = new Set(data.txns.map(t => t.id));
    const fresh = r.txns.filter(t => !ids.has(t.id));
    confirm({
      title: 'นำเข้า CSV?', ok: `นำเข้า ${fresh.length} รายการ`,
      body: <div className="small"><p>อ่านได้ {r.txns.length} รายการ • ซ้ำ (ข้าม) {r.txns.length - fresh.length} • ผิดพลาด {r.errors.length}</p>
        <p>สำเร็จ {fresh.filter(t => t.status === 'EXECUTED').length} • รอดำเนินการ {fresh.filter(t => t.status === 'PENDING').length} • ยกเลิก {fresh.filter(t => t.status === 'CANCELLED').length}</p>
        {fresh.slice(0, 5).map(t => <div key={t.id} className="tiny">{t.datetime} {TYPE_TH[t.type]} {t.ticker ?? ''} {fmtMoney(t.amount, t.currency)} ({STATUS_TH[t.status]})</div>)}
        {r.errors.slice(0, 8).map(e => <div key={e} className="hint">{e}</div>)}</div>,
      onOk: () => { update(d => ({ ...d, txns: [...d.txns, ...fresh] })); setMsg(`นำเข้า ${fresh.length} รายการแล้ว`); },
    });
  };
  const template = 'datetime,type,status,ticker,quantity,price,amount,currency,fxRate,fees,notes\n2026-11-04T21:35,BUY,EXECUTED,VOO,0.04,520.10,20.80,USD,33.50,0,ตัวอย่าง\n2026-11-01T10:00,DEPOSIT,EXECUTED,,,,5000,THB,33.50,0,\n';

  return (
    <>
      {msg && <div className="alert info">{msg}</div>}
      <section className="card form">
        <h3>อัตราแลกเปลี่ยนและราคา</h3>
        <label>USD/THB (บาทต่อ 1 ดอลลาร์)
          <div className="row gap"><input className="grow" type="number" inputMode="decimal" step="any" value={fx} onChange={e => setFx(e.target.value)} />
            <button className="btn" onClick={() => { const r = Number(fx); if (r > 0) { update(d => ({ ...d, fx: { rate: r, asOf: new Date().toISOString(), source: 'manual' } })); setMsg('บันทึกอัตราแลกเปลี่ยนแล้ว'); } }}>บันทึก</button></div>
        </label>
        <div className="tiny muted">ปัจจุบัน: {data.fx.rate > 0 ? `${data.fx.rate} (${data.fx.source === 'manual' ? 'กรอกเอง' : 'Frankfurter/ECB'} ${data.fx.asOf.slice(0, 10)})` : 'ยังไม่ตั้ง'}</div>
        <button className="btn small" disabled={busy} onClick={autoFx}>ดึงอัตราล่าสุดอัตโนมัติ</button>
        <label>Finnhub API key (ไม่บังคับ — ใช้ดึงราคาและข้อมูลวิจัย)
          <div className="row gap"><input className="grow" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value.trim())} placeholder="สมัครฟรีที่ finnhub.io" />
            <button className="btn" onClick={() => { update(d => ({ ...d, settings: { ...d.settings, finnhubKey: key || undefined } })); setMsg(key ? 'บันทึก key ในเครื่องนี้แล้ว' : 'ลบ key แล้ว'); }}>บันทึก</button></div>
        </label>
        <p className="tiny muted">key เก็บเฉพาะในเครื่องนี้ ไม่ถูกส่งขึ้น GitHub และไม่รวมในไฟล์ CSV หรือไฟล์สำรอง JSON (หลังกู้คืนในเครื่องใหม่ต้องใส่ key อีกครั้ง)</p>
        <button className="btn small" disabled={busy || !data.settings.finnhubKey} onClick={refreshPrices}>อัปเดตราคาหุ้นที่ถือ</button>
      </section>
      <section className="card form">
        <h3>เกณฑ์ความเสี่ยง</h3>
        <div className="grid2">
          <label>Drawdown พอร์ตที่รับได้ (%)<input type="number" value={data.settings.maxDrawdownPct} onChange={e => update(d => ({ ...d, settings: { ...d.settings, maxDrawdownPct: Number(e.target.value) || 0 } }))} /></label>
          <label>ขาดทุนรายตัวสูงสุด (%)<input type="number" value={data.settings.maxStockLossPct} onChange={e => update(d => ({ ...d, settings: { ...d.settings, maxStockLossPct: Number(e.target.value) || 0 } }))} /></label>
        </div>
        <label>ธีม<div className="seg"><button className={data.settings.theme === 'dark' ? 'on' : ''} onClick={() => update(d => ({ ...d, settings: { ...d.settings, theme: 'dark' } }))}>มืด</button><button className={data.settings.theme === 'light' ? 'on' : ''} onClick={() => update(d => ({ ...d, settings: { ...d.settings, theme: 'light' } }))}>สว่าง</button></div></label>
      </section>
      <section className="card form">
        <h3>สำรองและกู้คืน</h3>
        <p className="small">ข้อมูลเก็บในเครื่องนี้เท่านั้น ควรสำรองไฟล์ JSON ไว้ใน iCloud Drive / Google Drive เป็นประจำ</p>
        <div className="row gap wrap">
          <button className="btn primary small" onClick={backup}>สำรองข้อมูล (JSON)</button>
          <button className="btn small" onClick={() => file.current?.click()}>กู้คืนจากไฟล์</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = ''; }} />
        </div>
        <h3>นำเข้ารายการจาก CSV</h3>
        <p className="small">ไม่มี API ทางการจาก Dime จึงใช้การกรอกเอง หรือคัดลอกจาก Statement ลงไฟล์ CSV ตามแม่แบบ</p>
        <div className="row gap wrap">
          <button className="btn small" onClick={() => csvFile.current?.click()}>เลือกไฟล์ CSV</button>
          <button className="btn small ghost" onClick={() => download('dime-import-template.csv', '﻿' + template, 'text/csv;charset=utf-8')}>ดาวน์โหลดแม่แบบ</button>
          <input ref={csvFile} type="file" accept=".csv,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ''; }} />
        </div>
      </section>
      <section className="card form">
        <h3>ข้อมูลระบบ</h3>
        <p className="tiny muted">รายการ {data.txns.length} • หุ้น {p.positions.length} • ประวัติ {data.snapshots.length} วัน • เวอร์ชัน {__APP_VERSION__}</p>
        <button className="btn small danger" onClick={() => confirm({ title: 'ล้างข้อมูลทั้งหมด?', danger: true, ok: 'ล้างข้อมูล', body: <p>ลบทุกรายการในเครื่องนี้ ย้อนกลับไม่ได้ — โปรดสำรองข้อมูลก่อน</p>, onOk: () => update(d => ({ ...d, txns: [], prices: {}, snapshots: [], meta: {} })) })}>ล้างข้อมูลทั้งหมด</button>
      </section>
    </>
  );
}
