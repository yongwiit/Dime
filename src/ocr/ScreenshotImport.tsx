import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../types';
import { Sheet } from '../ui';
import { applyImport, checkImportRows, deriveImport, pendingCandidates, suggestedPending, FIELD_TH, type ImportField, type ImportRow } from '../importer';
import { toImportRows, fieldReasons } from './toImportRows';
import type { ExtractedRow, IgnoredRow, OcrBox } from './dimeParser';
import { fmtMoney, fmtFx, fmtDate } from '../format';

/* Screenshot → transactions. Flow: pick images → read on device (OCR) → review and correct every row →
   summary → "ยืนยันและนำเข้า". Saving goes through the existing importer (checkImportRows / applyImport):
   same validation, same pending-order linking by id, all-or-nothing. Nothing is saved before the last tap. */

interface Pic { id: string; file: File; url: string }
interface Extracted { picId: string; row: ImportRow; reasons: string[]; band: OcrBox; imgW: number }
interface ImageReport { picId: string; index: number; notices: string[]; ignored: IgnoredRow[]; rows: number; seconds: number }

type Step = 'pick' | 'reading' | 'review' | 'confirm';
const val = (r: ImportRow, f: ImportField) => (r as unknown as Record<string, string | undefined>)[f] ?? '';

/** Link state follows the row: no pending candidates → new transaction; a stale link is cleared so the user must choose again. */
function normaliseLink(data: AppData, r: ImportRow): ImportRow {
  const cand = pendingCandidates(data, r);
  if (!cand.length) return { ...r, link: 'separate' };
  if (r.link && r.link !== 'separate' && !cand.some(t => t.id === r.link)) return { ...r, link: '' };
  if (r.link === 'separate' && r.origin === 'screenshot' && !r.linkChosen) return { ...r, link: '' };
  return r;
}

export function ScreenshotImport({ data, update, onClose }: { data: AppData; update: (fn: (d: AppData) => AppData) => void; onClose: () => void }) {
  const [pics, setPics] = useState<Pic[]>([]);
  const [step, setStep] = useState<Step>('pick');
  const [progress, setProgress] = useState({ text: '', value: 0 });
  const [items, setItems] = useState<Extracted[]>([]);
  const [reports, setReports] = useState<ImageReport[]>([]);
  const [error, setError] = useState('');
  const pickRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceId = useRef('');
  useEffect(() => () => pics.forEach(p => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (files: FileList | null) => {
    if (!files) return;
    const next = [...files].filter(f => f.type.startsWith('image/')).map(file => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
    setPics(p => [...p, ...next]);
  };
  const replace = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setPics(p => p.map(x => (x.id === replaceId.current ? (URL.revokeObjectURL(x.url), { ...x, file: f, url: URL.createObjectURL(f) }) : x)));
  };

  const read = async () => {
    setStep('reading'); setError('');
    const out: Extracted[] = [], reps: ImageReport[] = [];
    try {
      const t0 = performance.now();
      const { DimeOcr } = await import('./ocr');
      const ocr = new DimeOcr();
      for (const [i, p] of pics.entries()) {
        const ti = i === 0 ? t0 : performance.now(); // first image includes loading the OCR engine
        const r = await ocr.recognize(p.file, (stage, f) => setProgress({ text: `ภาพ ${i + 1}/${pics.length}: ${stage}`, value: (i + f) / pics.length }));
        const rows = toImportRows(r.parse.rows, `img${i}`).map(x => normaliseLink(data, x));
        r.parse.rows.forEach((x: ExtractedRow, k) => out.push({ picId: p.id, row: rows[k], reasons: fieldReasons(x), band: x.band, imgW: r.width }));
        reps.push({ picId: p.id, index: i + 1, notices: r.parse.notices, ignored: r.parse.ignored, rows: r.parse.rows.length, seconds: (performance.now() - ti) / 1000 });
      }
      await ocr.dispose();
      setItems(out); setReports(reps); setStep('review');
    } catch (e) {
      setError('อ่านภาพไม่สำเร็จ: ' + String(e) + ' — ตรวจการเชื่อมต่ออินเทอร์เน็ต (ครั้งแรกต้องดาวน์โหลดตัวอ่านภาพ ~11 MB)');
      setStep('pick');
    }
  };

  const rows = items.map(x => x.row);
  const checks = useMemo(() => checkImportRows(data, rows), [data, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const allOk = rows.length > 0 && checks.every(c => c.errors.length === 0);
  const totalTHB = rows.reduce((a, r) => a + (Number(r.paid) || 0), 0);

  const setRow = (key: string, patch: Partial<ImportRow>, edited?: ImportField) => setItems(xs => xs.map(x => x.row.key !== key ? x : {
    ...x, row: normaliseLink(data, { ...x.row, ...patch, unverified: edited ? (x.row.unverified ?? []).filter(f => f !== edited) : x.row.unverified }),
  }));
  const confirmField = (key: string, f: ImportField) => setItems(xs => xs.map(x => x.row.key !== key ? x : { ...x, row: { ...x.row, unverified: (x.row.unverified ?? []).filter(u => u !== f) } }));
  const remove = (key: string) => setItems(xs => xs.filter(x => x.row.key !== key));
  const suggestions = rows.filter(r => !r.link && suggestedPending(data, r) && !rows.some(o => o !== r && o.link === suggestedPending(data, r)!.id));
  const linkSuggested = () => setItems(xs => {
    const used = new Set(xs.map(x => x.row.link).filter(Boolean));
    return xs.map(x => {
      if (x.row.link) return x;
      const s = suggestedPending(data, x.row);
      if (!s || used.has(s.id)) return x;
      used.add(s.id);
      return { ...x, row: { ...x.row, link: s.id, linkChosen: true } };
    });
  });

  const commit = () => {
    try {
      const now = new Date().toISOString();
      applyImport(data, rows, now); // validate first; throws without saving anything
      update(d => applyImport(d, rows, now));
      onClose();
    } catch (e) { setError(String(e)); setStep('review'); }
  };

  return (
    <Sheet title="นำเข้าจากภาพ Dime" onClose={onClose}>
      {error && <div className="alert">{error}</div>}

      {step === 'pick' && (
        <div className="form">
          <p className="small">ใช้ภาพหน้าจอจาก Dime: <b>รายการ → ลงทุน → หุ้นสหรัฐฯ</b> ส่วน <b>“เสร็จสิ้น”</b> ระบบอ่านเฉพาะรายการที่ทำสำเร็จแล้ว และ<b>อ่านภาพในเครื่องนี้เท่านั้น</b> ไม่ส่งภาพไปที่ใด</p>
          <div className="row gap wrap">
            <button className="btn primary" onClick={() => pickRef.current?.click()}>เลือกจากรูปภาพ</button>
            <button className="btn" onClick={() => camRef.current?.click()}>ถ่ายภาพ</button>
          </div>
          <input ref={pickRef} type="file" accept="image/*" multiple hidden data-testid="pick-images" onChange={e => { add(e.target.files); e.target.value = ''; }} />
          <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={e => { add(e.target.files); e.target.value = ''; }} />
          <input ref={replaceRef} type="file" accept="image/*" hidden onChange={e => { replace(e.target.files); e.target.value = ''; }} />
          {pics.length > 0 && <div className="shots">{pics.map((p, i) => (
            <figure key={p.id} className="shot">
              <img src={p.url} alt={`ภาพที่ ${i + 1}`} />
              <figcaption className="row gap">
                <span className="tiny">ภาพ {i + 1}</span>
                <button className="btn small ghost" onClick={() => { replaceId.current = p.id; replaceRef.current?.click(); }}>เปลี่ยน</button>
                <button className="btn small ghost danger-text" onClick={() => setPics(ps => ps.filter(x => x.id !== p.id))}>ลบ</button>
              </figcaption>
            </figure>))}</div>}
          <div className="row gap sticky-actions">
            <button className="btn ghost grow" onClick={onClose}>ยกเลิก</button>
            <button className="btn primary grow" disabled={!pics.length} onClick={read}>อ่านข้อมูลจากภาพ{pics.length ? ` (${pics.length})` : ''}</button>
          </div>
        </div>
      )}

      {step === 'reading' && (
        <div className="form center">
          <p>{progress.text || 'กำลังเตรียมตัวอ่านภาพ…'}</p>
          <progress max={1} value={progress.value} style={{ width: '100%' }} />
          <p className="tiny muted">ประมวลผลในเครื่องนี้ อาจใช้เวลา 5–15 วินาทีต่อภาพ</p>
        </div>
      )}

      {step === 'review' && (
        <div className="form">
          <p className="tiny muted" data-testid="ocr-timing">เวลาอ่านภาพ: {reports.map(r => `ภาพ ${r.index} ${r.seconds.toFixed(1)} วินาที`).join(' • ')}{reports.length ? ' (ภาพแรกรวมเวลาโหลดตัวอ่านภาพ)' : ''}</p>
          {reports.map(r => (r.notices.length > 0 || r.ignored.length > 0) && (
            <div key={r.picId} className="alert info small">
              <b>ภาพ {r.index}</b> — อ่านได้ {r.rows} รายการ{r.notices.map(n => <div key={n}>• {n}</div>)}
              {r.ignored.length > 0 && <details><summary>รายการที่ไม่ได้นำเข้า ({r.ignored.length})</summary>{r.ignored.map((g, i) => <div key={i} className="tiny">{g.reason}: {g.text}</div>)}</details>}
            </div>
          ))}
          {items.length === 0 ? <p className="small">ไม่มีรายการที่นำเข้าได้</p> : <>
            <p className="small">ตรวจทุกแถวเทียบกับภาพ ช่องที่มีกรอบสีเหลืองคือค่าที่ระบบไม่แน่ใจ — แก้ไข หรือกด “ค่าถูกต้อง” ระบบจะไม่บันทึกจนกว่าจะครบ</p>
            {suggestions.length > 0 && <button className="btn small" onClick={linkSuggested}>เชื่อมกับคำสั่งรอดำเนินการที่ยอดเงินตรงกัน ({suggestions.length})</button>}
          </>}
          {items.map((x, i) => {
            const r = x.row, c = checks[i];
            const pic = pics.find(p => p.id === x.picId);
            const flag = (f: ImportField) => r.unverified?.includes(f);
            const cand = pendingCandidates(data, r);
            const d = deriveImport(r);
            const field = (f: ImportField, label: string, input: React.ReactNode) => (
              <label className={flag(f) ? 'flag' : ''}>{label}{input}
                {flag(f) && <span className="row gap"><span className="tiny">ต้องตรวจ</span>{val(r, f) ? <button type="button" className="btn small" onClick={() => confirmField(r.key, f)}>ค่าถูกต้อง</button> : null}</span>}
              </label>
            );
            const txt = (f: Exclude<ImportField, 'side'>, mode: 'text' | 'decimal' = 'decimal') => (
              <input inputMode={mode} value={val(r, f)} onChange={e => setRow(r.key, { [f]: f === 'ticker' ? e.target.value.toUpperCase().trim() : e.target.value.trim() } as Partial<ImportRow>, f)} />
            );
            return (
              <fieldset key={r.key} className="card import-row" data-testid="ocr-row">
                <legend>รายการ {i + 1}</legend>
                {pic && <RowCrop url={pic.url} band={x.band} imgW={x.imgW} />}
                <div className="grid2">
                  {field('side', 'ประเภท', <select value={r.side ?? ''} onChange={e => setRow(r.key, { side: (e.target.value || undefined) as ImportRow['side'], link: '' }, 'side')}>
                    <option value="">— เลือก —</option><option value="BUY">ซื้อ</option><option value="SELL">ขาย</option></select>)}
                  {field('ticker', 'ชื่อหุ้น', txt('ticker', 'text'))}
                  {field('quantity', 'จำนวนหุ้น', txt('quantity'))}
                  {field('priceUSD', 'ราคาที่ได้จริง (USD)', txt('priceUSD'))}
                  {field('paid', r.side === 'SELL' ? 'ยอดที่ได้รับ (THB)' : 'ยอดที่จ่าย (THB)', txt('paid'))}
                  <label>FX ที่คำนวณได้<input readOnly tabIndex={-1} value={d.fx > 0 ? fmtFx(d.fx) : ''} /></label>
                  {field('date', 'วันที่', <input type="date" value={r.date} onChange={e => setRow(r.key, { date: e.target.value }, 'date')} />)}
                  {field('time', 'เวลา', <input type="time" step={1} value={r.time} onChange={e => setRow(r.key, { time: e.target.value }, 'time')} />)}
                </div>
                {cand.length > 0 && (
                  <label>มีคำสั่งรอดำเนินการของ {r.ticker} — รายการนี้คือ:
                    <select value={r.link} onChange={e => setRow(r.key, { link: e.target.value, linkChosen: true })}>
                      <option value="">— กรุณาเลือก —</option>
                      {cand.map(t => <option key={t.id} value={t.id}>คำสั่งรอ {fmtMoney(t.amount, t.currency)} {fmtDate(t.datetime)} ที่ทำสำเร็จแล้ว (อัปเดตรายการเดิม)</option>)}
                      <option value="separate">รายการใหม่แยกต่างหาก (คงคำสั่งรอไว้)</option>
                    </select>
                  </label>
                )}
                {c.duplicateOf && (
                  <label className="row gap small dup"><input type="checkbox" style={{ width: 'auto' }} checked={!!r.allowDuplicate} onChange={e => setRow(r.key, { allowDuplicate: e.target.checked })} />
                    {c.duplicateOf === 'batch' ? 'รายการนี้ซ้ำกับแถวก่อนหน้าในชุดนี้' : `อาจซ้ำกับรายการที่บันทึกแล้ว (${c.duplicateOf.datetime.replace('T', ' ')})`} — ติ๊กเฉพาะเมื่อแน่ใจว่าเป็นรายการใหม่ (ปกติให้ลบแถวนี้)</label>
                )}
                {x.reasons.length > 0 && <div className="tiny muted">{x.reasons.map(t => <div key={t}>• {t}</div>)}</div>}
                {c.warnings.map(w => <div key={w} className="hint">⚠️ {w}</div>)}
                {c.errors.length > 0 && <div className="hint">ยังนำเข้าไม่ได้: {c.errors.join(', ')}</div>}
                <button type="button" className="btn small ghost danger-text" onClick={() => remove(r.key)}>ลบแถวนี้</button>
              </fieldset>
            );
          })}
          <div className="sticky-actions">
            <div className="tiny muted">{rows.length} รายการ • รวม {fmtMoney(totalTHB, 'THB')} • ไม่พบค่าธรรมเนียมแยกในภาพ จึงไม่บันทึกค่าธรรมเนียม (ยอดบาทคือยอดที่ Dime แสดง)</div>
            <div className="row gap">
              <button className="btn ghost grow" onClick={() => setStep('pick')}>กลับไปเลือกภาพ</button>
              <button className="btn primary grow" disabled={!allOk} onClick={() => setStep('confirm')}>ตรวจสอบสรุปก่อนนำเข้า</button>
            </div>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="form">
          <p className="small">จะบันทึก {rows.length} รายการเป็น “สำเร็จ” ตามค่าที่คุณตรวจแล้ว:</p>
          {rows.map((r, i) => { const d = checks[i].derived; return (
            <dl key={r.key} className="card preview review-card">
              <div><dt>รายการ</dt><dd><b>{r.side === 'SELL' ? 'ขาย' : 'ซื้อ'} {r.ticker}</b></dd></div>
              <div><dt>วันเวลา</dt><dd>{r.date} {r.time}</dd></div>
              <div><dt>จำนวนหุ้น</dt><dd>{r.quantity}</dd></div>
              <div><dt>ราคา (USD)</dt><dd>${r.priceUSD}</dd></div>
              <div><dt>ยอดเงิน (THB)</dt><dd>{fmtMoney(Number(r.paid), 'THB')}</dd></div>
              <div><dt>FX</dt><dd>{fmtFx(d.fx)}</dd></div>
              <div style={{ gridColumn: '1 / -1' }}><dt>การบันทึก</dt><dd>{r.link && r.link !== 'separate' ? 'อัปเดตคำสั่งรอดำเนินการเดิม (รหัสรายการเดิม ไม่สร้างใหม่)' : r.allowDuplicate ? 'รายการใหม่ (คุณยืนยันว่าไม่ซ้ำ)' : 'รายการใหม่'}</dd></div>
            </dl>); })}
          <p className="tiny muted">รวม {fmtMoney(totalTHB, 'THB')} • {FIELD_TH.paid}เป็นยอดตามภาพ ไม่มีการแยกค่าธรรมเนียม</p>
          <div className="row gap sticky-actions">
            <button className="btn ghost grow" onClick={() => setStep('review')}>กลับไปแก้ไข</button>
            <button className="btn primary grow" onClick={commit}>ยืนยันและนำเข้า (Confirm and Import)</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** Shows the part of the screenshot a row was read from, so each value can be checked against the image. */
function RowCrop({ url, band, imgW }: { url: string; band: OcrBox; imgW: number }) {
  const pad = 12, h = band.y1 - band.y0 + pad * 2;
  return (
    <div className="row-crop" style={{ aspectRatio: `${imgW} / ${h}` }} aria-label="ภาพส่วนที่อ่าน">
      <img src={url} alt="" style={{ top: `${(-(band.y0 - pad) / h) * 100}%`, width: '100%' }} />
    </div>
  );
}

