import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore, newTxn, storageContext, CONTEXT_TH, DB_INFO } from './store';
import { ImportHoldings } from './onboarding';
import { ScreenshotImport } from './ocr/ScreenshotImport';
import { computePortfolio } from './engine';
import type { Txn } from './types';
import { Dashboard, Holdings, Transactions } from './views';
import { Assistant, More } from './views2';
import { TxnForm, Confirm, type ConfirmReq } from './ui';
import { fetchFx } from './market';

const TABS: { id: string; label: string; icon: ReactNode }[] = [
  { id: 'dash', label: 'ภาพรวม', icon: <path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z" /> },
  { id: 'holdings', label: 'หุ้นที่ถือ', icon: <path d="M4 19h16v2H4zM6 10h3v7H6zm5-4h3v11h-3zm5 7h3v4h-3z" /> },
  { id: 'txns', label: 'รายการ', icon: <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z" /> },
  { id: 'assistant', label: 'ผู้ช่วย', icon: <path d="M4 4h16v12H7l-3 3zm4 5h2v2H8zm4 0h2v2h-2zm4 0h2v2h-2z" /> },
  { id: 'more', label: 'เพิ่มเติม', icon: <path d="M5 10a2 2 0 100 4 2 2 0 000-4zm7 0a2 2 0 100 4 2 2 0 000-4zm7 0a2 2 0 100 4 2 2 0 000-4z" /> },
];
const TITLES: Record<string, string> = { dash: 'พอร์ต Dime US', holdings: 'หุ้นที่ถือ', txns: 'รายการธุรกรรม', assistant: 'ผู้ช่วยพอร์ต', more: 'วิจัย • รายงาน • ตั้งค่า' };

export default function App() {
  const { data, update, error, status, persisted, retry, dismissLost, resetAfterConsent } = useStore();
  const [importing, setImporting] = useState(false);
  const [shotImport, setShotImport] = useState(false);
  const [moreSec, setMoreSec] = useState<string | undefined>();
  const context = CONTEXT_TH[storageContext()];
  const [tab, setTab] = useState('dash');
  const [txnStatus, setTxnStatus] = useState<string | undefined>();
  const [form, setForm] = useState<{ t: Partial<Txn>; title: string; onSaved?: () => void } | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const loaded = !!data;
  useEffect(() => {
    if (!loaded || !navigator.onLine) return;
    const fx = data!.fx;
    const stale = !(fx.rate > 0) || (fx.source !== 'manual' && Date.now() - Date.parse(fx.asOf || '0') > 12 * 3600e3);
    if (stale) fetchFx().then(q => update(d => (d.fx.source === 'manual' && d.fx.rate > 0 ? d : { ...d, fx: q }))).catch(() => { /* user can set manually */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  useEffect(() => {
    const theme = data?.settings.theme ?? 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0f17' : '#f5f7fb');
  }, [data?.settings.theme]);

  const p = useMemo(() => (data ? computePortfolio(data.fx.rate > 0 ? data : { ...data, fx: { ...data.fx, rate: 1 } }) : null), [data]);
  if (status.kind === 'unreadable') return <Unreadable reason={status.reason} raw={status.raw} retry={retry} reset={resetAfterConsent} context={context} />;
  if (!data || !p) return <div className="splash">กำลังโหลดข้อมูลจากเครื่อง…</div>;

  const go = (t: string) => {
    const [id, st] = t.split(':');
    if (id === 'txns') setTxnStatus(st);
    if (id === 'more') setMoreSec(st);
    setTab(id); window.scrollTo(0, 0);
  };
  const openTxn = (t: Partial<Txn>, title = 'รายการ', onSaved?: () => void) => setForm({ t, title, onSaved });
  const saveTxn = (t: Partial<Txn>) => {
    update(d => {
      if (t.id && d.txns.some(x => x.id === t.id)) {
        return { ...d, txns: d.txns.map(x => x.id === t.id ? { ...x, ...t, updatedAt: new Date().toISOString() } as Txn : x) };
      }
      return { ...d, txns: [...d.txns, newTxn({ ...t, source: t.source ?? 'manual' })] };
    });
    form?.onSaved?.();
    setForm(null);
  };
  const storage = { context, persisted, db: DB_INFO };
  const ctx = { data, p, update, openTxn, confirm: setConfirmReq, go, openImport: () => setImporting(true), openScreenshot: () => setShotImport(true), context, storage };

  return (
    <div className="app">
      <header className="top">
        <h1>{TITLES[tab]}</h1>
        {!online && <span className="tag warn-tag">ออฟไลน์</span>}
      </header>
      {error && <div className="alert">{error}</div>}
      {status.kind === 'ok' && status.lostSuspected && (
        <div className="alert">
          <b>ไม่พบข้อมูลเดิมในหน้าต่างนี้</b> — ครั้งล่าสุด ({new Date(status.lostSuspected.savedAt).toLocaleString('th-TH')}) หน้าต่างนี้เคยบันทึกไว้ {status.lostSuspected.count} รายการ ข้อมูลอาจถูกล้างโดย iOS หรือการตั้งค่า Safari ระบบจึงไม่ได้สร้างข้อมูลใหม่ทับ
          <div className="row gap wrap" style={{ marginTop: 8 }}>
            <button className="btn small primary" onClick={() => go('more:settings')}>กู้คืนจากไฟล์สำรอง</button>
            <button className="btn small ghost" onClick={dismissLost}>เริ่มใช้ต่อแบบว่าง</button>
          </div>
        </div>
      )}
      <main>
        {tab === 'dash' && <Dashboard {...ctx} />}
        {tab === 'holdings' && <Holdings {...ctx} />}
        {tab === 'txns' && <Transactions key={txnStatus ?? 'all'} {...ctx} initialStatus={txnStatus} />}
        {tab === 'assistant' && <Assistant {...ctx} />}
        {tab === 'more' && <More key={moreSec ?? 'm'} {...ctx} initialSection={moreSec} />}
      </main>
      <nav className="tabbar" aria-label="เมนูหลัก">
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => go(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{t.icon}</svg><span>{t.label}</span>
          </button>
        ))}
      </nav>
      {form && <TxnForm initial={form.t} data={data} title={form.title} onSave={saveTxn} onCancel={() => setForm(null)} />}
      {shotImport && <ScreenshotImport data={data} update={update} onClose={() => setShotImport(false)} />}
      {importing && <ImportHoldings data={data} p={p} update={update} onClose={() => setImporting(false)} />}
      {confirmReq && <Confirm req={confirmReq} onClose={() => setConfirmReq(null)} />}
    </div>
  );
}

function Unreadable({ reason, raw, retry, reset, context }: { reason: string; raw?: unknown; retry: () => void; reset: () => Promise<void>; context: string }) {
  const [sure, setSure] = useState(false);
  const save = () => {
    const blob = new Blob([JSON.stringify(raw ?? null, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dime-unreadable-${Date.now()}.json`; a.click();
  };
  return (
    <div className="app"><div className="page" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 24px)' }}>
      <section className="card">
        <h3>อ่านข้อมูลพอร์ตในเครื่องไม่ได้</h3>
        <p className="small">{reason}</p>
        <p className="small">ระบบ<b>ยังไม่ได้แก้ไขหรือลบ</b>ข้อมูลเดิม และจะไม่บันทึกอะไรจนกว่าคุณจะเลือก ({context})</p>
        <div className="row gap wrap">
          <button className="btn primary" onClick={retry}>ลองอ่านอีกครั้ง</button>
          {raw !== undefined && <button className="btn" onClick={save}>ดาวน์โหลดข้อมูลดิบไว้ก่อน</button>}
        </div>
        <hr />
        <label className="small row gap"><input type="checkbox" style={{ width: 'auto' }} checked={sure} onChange={e => setSure(e.target.checked)} /> ฉันเข้าใจว่าการเริ่มใหม่จะแทนที่ข้อมูลที่อ่านไม่ได้นี้</label>
        <button className="btn danger small" disabled={!sure} onClick={() => reset()}>เริ่มฐานข้อมูลใหม่</button>
      </section>
    </div></div>
  );
}
