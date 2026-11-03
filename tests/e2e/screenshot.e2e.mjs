// End-to-end test of "นำเข้าจากภาพ Dime" in a real browser at iPhone 13 size, using FULLY SYNTHETIC screenshots
// (tests/fixtures/make-fixtures.py). Real OCR runs in the page (Tesseract.js served by the app itself).
// Run after `npm run build`:  npm run test:e2e   (CHROME_PATH=/path/to/chrome to use a local Chrome)
import { chromium, webkit, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PORT = 4180;
const BASE = `http://localhost:${PORT}/Dime/`;
const COMPLETED = path.resolve('tests/fixtures/synthetic-completed.png');
const SECTIONS = path.resolve('tests/fixtures/synthetic-sections.png');
const TRUTH = JSON.parse(readFileSync('tests/fixtures/synthetic-expected.json', 'utf8'));
const EXP = TRUTH.completed;
const LINKED = ['ZYXW', 'MNOP']; // fictional pending orders injected into the app before import
const OCR_TIMEOUT = 180_000;
const thb = v => `฿${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let failed = 0, passed = 0;
const check = (name, ok, info = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info && !ok ? ' — ' + info : ''}`); };

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { /* ignore */ } };
process.on('exit', stop);
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 500)); }

// BROWSER=webkit runs the same test in WebKit (Safari's engine); default Chromium. CHROME_PATH: local Chrome binary.
const ENGINE = process.env.BROWSER === 'webkit' ? webkit : chromium;
console.log(`engine: ${process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium'}`);
const browser = await ENGINE.launch(ENGINE === chromium && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {});
const errors = [], external = [];
async function newPage() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  await ctx.route(/frankfurter|fonts\.g|finnhub/, r => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { const u = r.url(); if (!u.startsWith(`http://localhost:${PORT}`) && !u.startsWith('data:') && !u.startsWith('blob:') && !/frankfurter|fonts\.g/.test(u)) external.push(u); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  return { ctx, page };
}
const readRaw = page => page.evaluate(() => new Promise((res, rej) => {
  const o = indexedDB.open('keyval-store');
  o.onsuccess = () => { const g = o.result.transaction('keyval').objectStore('keyval').get('dime-portfolio-v1'); g.onsuccess = () => res(g.result ?? null); g.onerror = rej; };
  o.onerror = rej;
}));
const writeRaw = (page, d) => page.evaluate(d => new Promise(res => { const o = indexedDB.open('keyval-store'); o.onsuccess = () => { const tx = o.result.transaction('keyval', 'readwrite'); tx.objectStore('keyval').put(d, 'dime-portfolio-v1'); tx.oncomplete = res; }; }), d);
const waitStored = async (page, pred, label) => {
  for (let i = 0; i < 50; i++) { if (pred(await readRaw(page))) return; await page.waitForTimeout(100); }
  check(`Write reached IndexedDB: ${label}`, false, 'timed out');
};
async function readScreenshot(page, file) {
  await page.locator('[data-testid=pick-images]').setInputFiles(file);
  await page.locator('.shot img').first().waitFor();
  await page.locator('button', { hasText: /^อ่านข้อมูลจากภาพ/ }).click();
  await page.locator('.sticky-actions button.primary').waitFor({ timeout: OCR_TIMEOUT });
}
const rowValues = page => page.locator('[data-testid=ocr-row]').evaluateAll(rows => rows.map(r => {
  const v = l => [...r.querySelectorAll('.field')].find(x => x.querySelector('label')?.textContent?.startsWith(l))?.querySelector('input,select')?.value;
  const flagged = [...r.querySelectorAll('.field.flag')].map(x => x.querySelector('label').textContent);
  return { ticker: v('ชื่อหุ้น'), quantity: v('จำนวนหุ้น'), price: v('ราคาที่ได้จริง'), thb: v('ยอดที่'), date: v('วันที่'), time: v('เวลา'), side: v('ประเภท'), flagged };
}));

try {
  // ---------- 1. synthetic completed screenshot; two rows match pending orders in the app ----------
  let { ctx, page } = await newPage();
  const seeded = await readRaw(page);
  const now = new Date().toISOString();
  const injected = LINKED.map(tk => { const e = EXP.find(x => x.ticker === tk); return { id: `pending-${tk}`, datetime: `${e.date}T08:00`, type: e.side, status: 'PENDING', ticker: tk, amount: Number(e.amountTHB), currency: 'THB', fees: 0, source: 'manual', createdAt: now, updatedAt: now }; });
  await writeRaw(page, { ...seeded, txns: [...seeded.txns, ...injected] });
  await page.reload({ waitUntil: 'networkidle' });
  const before = await readRaw(page);
  check('Start: app has pending orders (incl. 2 fictional ones to link)', before.txns.length === seeded.txns.length + 2 && before.txns.every(t => t.status === 'PENDING'));

  await page.locator('.onboarding button', { hasText: 'นำเข้าจากภาพ Dime' }).click();
  await readScreenshot(page, COMPLETED);
  let vals = await rowValues(page);
  check(`OCR in the browser found ${EXP.length} rows`, vals.length === EXP.length, JSON.stringify(vals.map(v => v.ticker)));
  EXP.forEach((e, i) => {
    const v = vals[i] ?? {};
    const sideOk = v.side === e.side || (v.side === '' && v.flagged.includes('ประเภท'));
    check(`${e.ticker} ${e.side}: extracted values (side either correct or flagged empty)`, v.ticker === e.ticker && v.quantity === e.quantity && v.price === e.priceUSD && v.thb === e.amountTHB && v.date === e.date && v.time === e.time && sideOk, JSON.stringify(v));
  });
  const totalLine = await page.locator('.sticky-actions .tiny').innerText();
  check(`Review shows total ${thb(TRUTH.totalTHB)}`, totalLine.replace(/\s/g, '').includes(thb(TRUTH.totalTHB)), totalLine);
  const nextBtn = page.locator('.sticky-actions button.primary');
  check('While fields are flagged: button reads "ไปยังรายการที่ต้องแก้" and is not ready', (await nextBtn.getAttribute('data-ready')) === 'no' && (await nextBtn.innerText()).includes('ไปยังรายการที่ต้องแก้'));
  check('Footer explains how many rows still need attention', (await page.locator('[data-testid=pending-issues]').count()) === 1);
  await nextBtn.tap();
  check('Tapping it highlights the first row that needs attention (no summary yet)', (await page.locator('.import-row.attention').count()) === 1 && (await page.locator('button', { hasText: 'ยืนยันและนำเข้า' }).count()) === 0);
  const overflow = await page.evaluate(() => { const b = document.querySelector('.sheet-body'); return b.scrollWidth - b.clientWidth; });
  check('iPhone width: review screen has no horizontal overflow', overflow <= 1, `overflow ${overflow}px`);

  // the "user" compares each flagged value with the image: selects a missing side, confirms values that match
  for (const [i, v] of vals.entries()) {
    const row = page.locator('[data-testid=ocr-row]').nth(i);
    if (v.side === '') await row.locator('.field[data-field=side] select').selectOption(EXP[i].side);
    // touch taps, as on a phone; the button must not be swallowed by focusing an input
    while (await row.locator('button', { hasText: 'ค่าถูกต้อง' }).count()) {
      const before = await row.locator('.field.flag').count();
      await row.locator('button', { hasText: 'ค่าถูกต้อง' }).first().tap();
      const after = await row.locator('.field.flag').count();
      if (after >= before) { check(`Row ${i + 1}: tapping "ค่าถูกต้อง" clears the flag`, false, `${before} → ${after}`); break; }
    }
  }
  await page.locator('button', { hasText: /เชื่อมกับคำสั่งรอดำเนินการที่ยอดเงินตรงกัน \(2\)/ }).tap();
  vals = await rowValues(page);
  check('After review: no flagged fields left', vals.every(v => v.flagged.length === 0), JSON.stringify(vals.map(v => v.flagged)));
  check('Time field keeps seconds (text field, not an iOS time picker)', vals.every((v, i) => v.time === EXP[i].time), JSON.stringify(vals.map(v => v.time)));
  check('After review the button is ready', (await nextBtn.getAttribute('data-ready')) === 'yes');
  const fieldOverflow = await page.evaluate(() => [...document.querySelectorAll('.import-row input, .import-row select')].filter(el => el.getBoundingClientRect().right > el.closest('.import-row').getBoundingClientRect().right + 1).length);
  check('No input or select sticks out of its card (date/time width)', fieldOverflow === 0, `${fieldOverflow} overflowing`);
  const crops = await page.locator('.row-crop-img').evaluateAll(imgs => imgs.map(i => i.naturalHeight > 40 && i.src.startsWith('data:image/jpeg')));
  check('Each row shows its own image crop', crops.length === EXP.length && crops.every(Boolean), JSON.stringify(crops));
  await nextBtn.tap();
  const summary = await page.locator('.sheet-body').innerText();
  check('Summary: 2 rows update their pending order, 3 are new', (summary.match(/อัปเดตคำสั่งรอดำเนินการเดิม/g) || []).length === 2 && (summary.match(/รายการใหม่/g) || []).length === 3);
  check('Nothing saved before "ยืนยันและนำเข้า"', (await readRaw(page)).txns.length === before.txns.length && (await readRaw(page)).txns.every(t => t.status === 'PENDING'));
  await page.locator('button', { hasText: 'ยืนยันและนำเข้า (Confirm and Import)' }).tap();
  await waitStored(page, d => d.txns.length === before.txns.length + 3, 'screenshot import');

  await page.reload({ waitUntil: 'networkidle' });
  const after = await readRaw(page);
  check('After reload: +3 new transactions only (no duplicates)', after.txns.length === before.txns.length + 3);
  check('After reload: linked pending orders keep their ids and are EXECUTED', LINKED.every(tk => after.txns.find(t => t.id === `pending-${tk}`)?.status === 'EXECUTED'));
  check('After reload: unrelated pending orders untouched', seeded.txns.every(s => after.txns.find(t => t.id === s.id)?.status === 'PENDING'));
  for (const e of EXP) {
    const t = after.txns.find(x => x.ticker === e.ticker && x.datetime === `${e.date}T${e.time}`);
    check(`${e.ticker} ${e.side}: stored EXECUTED with exact values, FX and time`, !!t && t.type === e.side && t.status === 'EXECUTED' && t.quantity === Number(e.quantity) && t.priceUSD === Number(e.priceUSD)
      && t.amount === Number(e.amountTHB) && t.fxRate === Number(e.amountTHB) / (Number(e.quantity) * Number(e.priceUSD)) && t.fees === 0, JSON.stringify(t));
  }
  check('Dashboard: 4 holdings (QRST net of the sell)', (await page.locator('.status3 button').first().locator('b').innerText()) === '4');

  // ---------- 2. importing the same screenshot again ----------
  await page.locator('.tabbar button', { hasText: 'หุ้นที่ถือ' }).click();
  await page.locator('button', { hasText: 'นำเข้าจากภาพ' }).click();
  await readScreenshot(page, COMPLETED);
  const dup = await page.locator('.dup').count();
  check(`Re-import: rows flagged as possible duplicates (${EXP.length})`, dup === EXP.length, `flagged ${dup}`);
  check('Re-import: confirmation blocked', (await page.locator('.sticky-actions button.primary').getAttribute('data-ready')) === 'no');
  await page.locator('.sticky-actions button.primary').tap();
  check('Re-import: tapping does not open the summary', (await page.locator('button', { hasText: 'ยืนยันและนำเข้า' }).count()) === 0);
  await page.locator('.sheet-head button').click();
  check('Re-import cancelled: data unchanged', (await readRaw(page)).txns.length === after.txns.length);

  // ---------- 3. close & reopen ----------
  await page.close();
  page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar');
  check('Close & reopen: holdings persist', (await page.locator('.status3 button').first().locator('b').innerText()) === '4');
  await ctx.close();

  // ---------- 4. pending + completed + cancelled sections ----------
  ({ ctx, page } = await newPage());
  await page.locator('.onboarding button', { hasText: 'นำเข้าจากภาพ Dime' }).click();
  await readScreenshot(page, SECTIONS);
  const sv = await rowValues(page);
  check('Sections: only the completed rows are offered', sv.map(v => v.ticker).join() === EXP.map(e => e.ticker).join(), JSON.stringify(sv.map(v => v.ticker)));
  const notice = await page.locator('.alert.info').innerText().catch(() => '');
  check('Sections: notice says pending/cancelled rows were skipped', /ข้ามรายการที่ไม่ได้อยู่ในส่วน/.test(notice), notice);
  await ctx.close();

  check('No requests to external hosts (image and OCR stay on device)', external.length === 0, external.slice(0, 3).join(' '));
  check('No JavaScript errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('Test run completed', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  stop();
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
