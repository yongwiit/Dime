import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore, newTxn } from './store';
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
  const { data, update, error } = useStore();
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
  if (!data || !p) return <div className="splash">กำลังโหลด…</div>;

  const go = (t: string) => {
    const [id, st] = t.split(':');
    setTxnStatus(st); setTab(id); window.scrollTo(0, 0);
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
  const ctx = { data, p, update, openTxn, confirm: setConfirmReq, go };

  return (
    <div className="app">
      <header className="top">
        <h1>{TITLES[tab]}</h1>
        {!online && <span className="tag warn-tag">ออฟไลน์</span>}
      </header>
      {error && <div className="alert">{error}</div>}
      <main>
        {tab === 'dash' && <Dashboard {...ctx} />}
        {tab === 'holdings' && <Holdings {...ctx} />}
        {tab === 'txns' && <Transactions key={txnStatus ?? 'all'} {...ctx} initialStatus={txnStatus} />}
        {tab === 'assistant' && <Assistant {...ctx} />}
        {tab === 'more' && <More {...ctx} />}
      </main>
      <nav className="tabbar" aria-label="เมนูหลัก">
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => go(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{t.icon}</svg><span>{t.label}</span>
          </button>
        ))}
      </nav>
      {form && <TxnForm initial={form.t} data={data} title={form.title} onSave={saveTxn} onCancel={() => setForm(null)} />}
      {confirmReq && <Confirm req={confirmReq} onClose={() => setConfirmReq(null)} />}
    </div>
  );
}
