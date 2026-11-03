// End-to-end test of the real import workflow in a real browser at iPhone size.
// Builds nothing itself: run `npm run build` first. Starts `vite preview`, drives the UI, reads
// IndexedDB directly to verify what was stored, reloads, and checks Dashboard and Holdings.
//   npm run test:e2e            (uses Playwright's Chromium; CI installs it)
//   CHROME_PATH=/usr/bin/google-chrome npm run test:e2e
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 4179;
const BASE = `http://localhost:${PORT}/Dime/`;
const DIME = [
  ['GOOGL', '0.0236388', '280.47', '224.76', '33.900584'],
  ['SGOV', '0.0660161', '100.43', '224.76', '33.900468'],
  ['QQQM', '0.0314253', '281.62', '299.91', '33.888162'],
  ['VOO', '0.0320086', '692.00', '749.78', '33.850187'],
];

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info && !ok ? ' — ' + info : ''}`); };

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', env: { ...process.env, BASE_PATH: '/Dime/' } });
const stop = () => { try { server.kill(); } catch { /* ignore */ } };
process.on('exit', stop);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 500));
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {});
const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
await ctx.route(/frankfurter|fonts\.g|finnhub/, r => r.abort()); // deterministic: no network data
const errors = [];
let page = await ctx.newPage();
page.on('pageerror', e => errors.push(String(e)));

const readRaw = () => page.evaluate(() => new Promise((res, rej) => {
  const o = indexedDB.open('keyval-store');
  o.onsuccess = () => { const g = o.result.transaction('keyval').objectStore('keyval').get('dime-portfolio-v1'); g.onsuccess = () => res(g.result ?? null); g.onerror = rej; };
  o.onerror = rej;
}));
// Wait until IndexedDB actually contains the expected state (writes are async), failing after 5 s.
const waitStored = async (pred, label) => {
  for (let i = 0; i < 50; i++) { if (pred(await readRaw())) return true; await page.waitForTimeout(100); }
  check(`Write reached IndexedDB: ${label}`, false, 'timed out after 5 s');
  return false;
};
const tab = n => page.locator('.tabbar button', { hasText: n }).click();
const settings = async () => { await tab('เพิ่มเติม'); await page.locator('.seg.full button', { hasText: 'ตั้งค่า' }).click(); };
const statusCounts = async () => ({
  held: await page.locator('.status3 button').first().locator('b').innerText(),
  pending: await page.locator('.status3 .pending b').innerText(),
});

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  const before = await readRaw();
  check('Seed: 4 PENDING buys, none executed', before?.txns.length === 4 && before.txns.every(t => t.status === 'PENDING'));
  const pendingIds = Object.fromEntries(before.txns.map(t => [t.ticker, t.id]));

  await settings();
  await page.locator('label:has-text("USD/THB") input').fill('33.87');
  await page.locator('label:has-text("USD/THB") button').click();
  await tab('ภาพรวม');

  // --- import the four Dime orders through the UI ---
  await page.locator('.onboarding button', { hasText: 'นำเข้ายอดหุ้นที่ถืออยู่' }).click();
  check('Import screen pre-fills one row per pending ticker', (await page.locator('.import-row').count()) === 4);
  const row = tk => page.locator('.import-row', { has: page.locator(`input[value="${tk}"]`) });
  for (const [tk, q, pu, thb, fx] of DIME) {
    const r = row(tk);
    // choose the matching pending order explicitly (the option whose value is that pending id)
    await r.locator('select').selectOption(pendingIds[tk]);
    await r.locator('label:has-text("จำนวนหุ้น") input').fill(q);
    await r.locator('label:has-text("ราคาซื้อ (USD)") input').fill(pu);
    await r.locator('label:has-text("ยอดที่จ่าย (THB)") input').fill(thb);
    const shown = await r.locator('label:has-text("FX ที่คำนวณได้") input').inputValue();
    check(`${tk}: FX shown on screen = THB ÷ (qty × USD price)`, shown.replace(/,/g, '') === fx, shown);
  }
  await page.locator('button', { hasText: 'ตรวจสอบก่อนบันทึก' }).click();
  const review = await page.locator('.sheet-body').innerText();
  check('Review step states pending orders are updated, not duplicated', (review.match(/อัปเดตคำสั่งรอดำเนินการเดิม/g) || []).length === 4);
  const afterReviewRaw = await readRaw();
  check('Nothing saved before final confirmation', afterReviewRaw.txns.every(t => t.status === 'PENDING'));
  await page.locator('button', { hasText: 'ยืนยันบันทึก 4 รายการ' }).click();
  await waitStored(d => d.txns.every(t => t.status === 'EXECUTED'), 'import');

  // --- reload and verify storage ---
  await page.reload({ waitUntil: 'networkidle' });
  const after = await readRaw();
  check('No duplicate: still exactly 4 transactions', after.txns.length === 4 && new Set(after.txns.map(t => t.id)).size === 4);
  check('Original transaction IDs preserved', DIME.every(([tk]) => after.txns.find(t => t.ticker === tk)?.id === pendingIds[tk]));
  check('All four EXECUTED, none PENDING', after.txns.every(t => t.status === 'EXECUTED'));
  for (const [tk, q, pu, thb, fx] of DIME) {
    const t = after.txns.find(x => x.ticker === tk);
    check(`${tk}: stored qty/price/THB/FX exact after reload`,
      t.quantity === Number(q) && t.priceUSD === Number(pu) && t.amount === Number(thb) && t.currency === 'THB' &&
      t.fxRate === Number(thb) / (Number(q) * Number(pu)) && t.fxRate.toFixed(6) === fx,
      JSON.stringify({ q: t.quantity, p: t.priceUSD, a: t.amount, fx: t.fxRate }));
  }

  // --- dashboard and holdings after reload ---
  const s1 = await statusCounts();
  check('Dashboard: 4 holdings, 0 pending', s1.held === '4' && s1.pending === '0', JSON.stringify(s1));
  const kv = await page.locator('.grid-kv').innerText();
  check('Dashboard: cost ฿1,499.21 and cash not counted', kv.includes('฿1,499.21') && kv.includes('ไม่ได้นับรวม'), kv.replace(/\n/g, ' | '));
  await tab('หุ้นที่ถือ');
  for (const [tk, q, pu] of DIME) {
    const h = await page.locator('.holding', { hasText: tk }).innerText();
    check(`${tk}: Holdings shows full quantity and Dime price as average cost`, h.includes(q) && h.includes(`$${Number(pu).toLocaleString('th-TH', { minimumFractionDigits: 2 })}`), h.replace(/\n/g, ' | '));
  }

  // --- close and reopen ---
  await page.close();
  page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  const s2 = await statusCounts();
  check('Close & reopen: 4 holdings, 0 pending', s2.held === '4' && s2.pending === '0');

  // --- cash tracking stays off after a deposit, until explicitly confirmed ---
  await tab('รายการ');
  await page.locator('button', { hasText: '+ เพิ่ม' }).click();
  await page.locator('.sheet select').first().selectOption('DEPOSIT');
  await page.locator('.sheet .seg button', { hasText: 'THB' }).click();
  await page.locator('.sheet label:has-text("จำนวนเงิน") input').fill('2000');
  await page.locator('.sheet button[type=submit]').click();
  await waitStored(d => d.txns.some(t => t.type === 'DEPOSIT'), 'deposit');
  await tab('ภาพรวม');
  check('One deposit does not start counting cash', (await page.locator('.grid-kv').innerText()).includes('ไม่ได้นับรวม'));
  await settings();
  await page.locator('#cash-tracking button', { hasText: 'ยืนยันว่ารายการเงินสดครบถ้วน' }).click();
  await page.locator('.sheet button', { hasText: 'ยืนยัน ยอดตรงกับ Dime' }).click();
  await waitStored(d => !!d.settings.cashTracking?.confirmedAt, 'cash-tracking confirmation');
  await page.reload({ waitUntil: 'networkidle' });
  const kv2 = await page.locator('.grid-kv').innerText();
  check('After explicit confirmation cash is counted (฿2,000 − ฿1,499.21 = ฿500.79)', kv2.includes('฿500.79'), kv2.replace(/\n/g, ' | '));
  check('Confirmation persisted', !!(await readRaw()).settings.cashTracking?.confirmedAt);

  check('No JavaScript errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('Test run completed', false, String(e));
} finally {
  await browser.close();
  stop();
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
