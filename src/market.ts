import type { FxQuote, PriceQuote } from './types';

// All market requests run from the user's own browser. The optional Finnhub key is the user's own
// free key, kept only in this device's storage — it is never in source code or in the repository.

async function getJSON(url: string) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchFx(): Promise<FxQuote> {
  const sources = [
    'https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB',
    'https://api.frankfurter.app/latest?from=USD&to=THB',
  ];
  let last: unknown;
  for (const u of sources) {
    try {
      const j = await getJSON(u);
      const rate = j?.rates?.THB;
      if (rate > 0) return { rate, asOf: j.date, source: 'frankfurter' };
    } catch (e) { last = e; }
  }
  throw new Error('ดึงอัตราแลกเปลี่ยนไม่สำเร็จ: ' + String(last));
}

const FH = 'https://finnhub.io/api/v1';

export async function fetchQuote(ticker: string, key: string): Promise<PriceQuote> {
  const j = await getJSON(`${FH}/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`);
  if (!(j?.c > 0)) throw new Error(`ไม่พบราคา ${ticker}`);
  return { ticker, price: j.c, prevClose: j.pc > 0 ? j.pc : undefined, asOf: new Date((j.t || Date.now() / 1000) * 1000).toISOString(), source: 'finnhub' };
}

export interface Research {
  ticker: string;
  fetchedAt: string;
  profile?: { name?: string; industry?: string; marketCap?: number; ipo?: string; weburl?: string };
  metrics?: Record<string, number | undefined>;
  news: { headline: string; source: string; url: string; datetime: number }[];
  errors: string[];
}

const METRIC_KEYS = [
  'peTTM', 'pbQuarterly', 'psTTM', 'epsTTM', 'epsGrowthTTMYoy', 'revenueGrowthTTMYoy', 'revenueGrowth5Y',
  'netProfitMarginTTM', 'operatingMarginTTM', 'roeTTM', 'totalDebt/totalEquityQuarterly', 'currentRatioQuarterly',
  'freeCashFlowPerShareTTM', 'pfcfShareTTM', 'dividendYieldIndicatedAnnual', 'beta',
  '52WeekHigh', '52WeekLow', '52WeekPriceReturnDaily', '13WeekPriceReturnDaily', '26WeekPriceReturnDaily',
];

export async function fetchResearch(ticker: string, key: string): Promise<Research> {
  const k = encodeURIComponent(key), s = encodeURIComponent(ticker);
  const res: Research = { ticker, fetchedAt: new Date().toISOString(), news: [], errors: [] };
  const to = new Date(), from = new Date(Date.now() - 14 * 864e5);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const [p, m, n] = await Promise.allSettled([
    getJSON(`${FH}/stock/profile2?symbol=${s}&token=${k}`),
    getJSON(`${FH}/stock/metric?symbol=${s}&metric=all&token=${k}`),
    getJSON(`${FH}/company-news?symbol=${s}&from=${ymd(from)}&to=${ymd(to)}&token=${k}`),
  ]);
  if (p.status === 'fulfilled' && p.value?.name) res.profile = { name: p.value.name, industry: p.value.finnhubIndustry, marketCap: p.value.marketCapitalization, ipo: p.value.ipo, weburl: p.value.weburl };
  else res.errors.push(p.status === 'rejected' ? 'ข้อมูลบริษัท: ' + String(p.reason) : 'ไม่มีข้อมูลบริษัท (ETF มักไม่มีข้อมูลนี้ในแผนฟรี)');
  if (m.status === 'fulfilled' && m.value?.metric) {
    res.metrics = Object.fromEntries(METRIC_KEYS.map(key => [key, m.value.metric[key] ?? undefined]));
  } else res.errors.push(m.status === 'rejected' ? 'ตัวชี้วัด: ' + String(m.reason) : 'ไม่มีตัวชี้วัดพื้นฐาน');
  if (n.status === 'fulfilled' && Array.isArray(n.value)) res.news = n.value.slice(0, 6).map((x: { headline: string; source: string; url: string; datetime: number }) => ({ headline: x.headline, source: x.source, url: x.url, datetime: x.datetime }));
  else if (n.status === 'rejected') res.errors.push('ข่าว: ' + String(n.reason));
  return res;
}
