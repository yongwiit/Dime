/*
 * Parser for Dime "รายการทั้งหมด → ลงทุน → หุ้นสหรัฐฯ" screenshots (Thai UI).
 *
 * Input: two OCR passes of the same (preprocessed) image
 *   - `tha`: Thai+English — reads the Thai labels, section headers, numbers, dates and times
 *   - `eng`: English only — reads the Latin tickers, and gives a second reading of every number
 * Output: candidate rows with a per-field status. Nothing here is saved; rows go to the review screen
 * and then through the normal importer (checkImportRows / applyImport).
 *
 * Rules
 *   - Only rows below a "เสร็จสิ้น" (completed) header are taken. Rows above it, or after any other
 *     section header (รอ…, กำลัง…, ยกเลิก…, ไม่สำเร็จ…), are reported as ignored, never imported.
 *   - A field is "ok" only when both passes agree, or one pass is unreadable and the other is confident.
 *     Disagreement, low confidence or a fallback makes it "uncertain" — the user must check it.
 *   - Nothing is guessed: a value that cannot be read is "missing" and left empty.
 *   - The THB amount is taken as shown ("… บาท"). Fees are not shown on this screen, so none are read.
 */

export interface OcrBox { x0: number; y0: number; x1: number; y1: number }
export interface OcrWord { text: string; confidence: number; bbox: OcrBox }
export interface OcrLine { text: string; confidence: number; bbox: OcrBox; words: OcrWord[] }
export interface OcrPass { lines: OcrLine[] }

export type FieldStatus = 'ok' | 'uncertain' | 'missing';
export interface Field<T> { value: T | null; status: FieldStatus; reason?: string }

export interface ExtractedRow {
  side: Field<'BUY' | 'SELL'>;
  ticker: Field<string>;
  priceUSD: Field<string>; // kept as the digit string read, so no float rounding is introduced
  quantity: Field<string>;
  amountTHB: Field<string>;
  date: Field<string>; // YYYY-MM-DD (Gregorian)
  time: Field<string>; // HH:MM:SS
  band: OcrBox; // area of the screenshot this row came from (for the review thumbnail)
}

export interface IgnoredRow { reason: string; text: string; band: OcrBox }

export interface ParseResult {
  completedSectionFound: boolean;
  rows: ExtractedRow[];
  ignored: IgnoredRow[];
  notices: string[];
}

const MONTHS_ABBR: Record<string, number> = {
  'มค': 1, 'กพ': 2, 'มีค': 3, 'เมย': 4, 'พค': 5, 'มิย': 6, 'กค': 7, 'สค': 8, 'กย': 9, 'ตค': 10, 'พย': 11, 'ธค': 12,
};
const MONTHS_FULL: Record<string, number> = {
  'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4, 'พฤษภาคม': 5, 'มิถุนายน': 6,
  'กรกฎาคม': 7, 'สิงหาคม': 8, 'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12,
};
const TICKER_STOP = new Set(['THB', 'USD', 'DCA', 'BUY', 'SELL', 'US', 'ETF']);

const CONF_OK = 85; // a single readable pass must be at least this confident
const CONF_TICKER = 75;

// OCR often emits SARA AM (ำ) as NIKHAHIT + SARA AA (ํ + า); fold it so keywords and displayed names match
const thaiFold = (s: string) => s.normalize('NFC').replace(/\u0E4D\u0E32/g, '\u0E33');
const squash = (s: string) => thaiFold(s).replace(/\s+/g, '');
const midY = (b: OcrBox) => (b.y0 + b.y1) / 2;
const height = (b: OcrBox) => b.y1 - b.y0;

const isCompletedHeader = (l: OcrLine) => {
  const t = squash(l.text);
  return t.length <= 14 && !/\d/.test(t) && (/^เสร็จส/.test(t) || /^completed$/i.test(t));
};
const isOtherSectionHeader = (l: OcrLine) => {
  const t = squash(l.text);
  return t.length <= 18 && !/\d/.test(t) && (/^(รอ|กำลัง|ยกเลิก|ไม่สำเร็จ|ล้มเหลว|หมดอายุ)/.test(t) || /^(pending|processing|cancel+ed|failed|expired)$/i.test(t));
};
const isBottomNav = (l: OcrLine) => /หน้าหลัก/.test(l.text) && /รายการ/.test(l.text);
const SIDE_WORD = /^(ซื้?อ|ขาย)/;
// A row starts at its first line: "<side> <ticker> … <amount> บาท". The side word is not required to start a row,
// because OCR can misread it (e.g. "ซื้อ" → "#2"); a row is never dropped just because that word is unreadable.
const isAnchor = (l: OcrLine) => /บาท/.test(l.text) && (SIDE_WORD.test(squash(l.text)) || /\d\.\d{2}\s*บาท/.test(l.text));
const isPriceLine = (l: OcrLine) => /ราคา/.test(squash(l.text));
const isQtyLine = (l: OcrLine) => /^จ.?.?นวน/.test(squash(l.text)) || /หุ้น\d/.test(squash(l.text));
const sectionMonth = (l: OcrLine) => {
  const m = squash(l.text).match(/^([ก-๙]+)(\d{4})$/);
  return m && MONTHS_FULL[m[1]] ? { month: MONTHS_FULL[m[1]], yearBE: Number(m[2]) } : null;
};

/** Number tokens on a line with the confidence of the word they came from. */
function numbers(l: OcrLine | undefined, re = /^\d[\d,]*\.\d+$/): { text: string; conf: number }[] {
  if (!l) return [];
  return l.words.map(w => ({ text: w.text.replace(/,/g, ''), conf: w.confidence })).filter(w => re.test(w.text));
}

/** Combine two independent readings of one number. */
function combine(tha: { text: string; conf: number } | undefined, eng: { text: string; conf: number } | undefined, label: string): Field<string> {
  if (tha && eng) {
    if (Number(tha.text) === Number(eng.text)) return { value: tha.text, status: 'ok' };
    const pick = tha.conf >= eng.conf ? tha : eng;
    return { value: pick.text, status: 'uncertain', reason: `${label}: อ่านได้ 2 ค่าไม่ตรงกัน (${tha.text} / ${eng.text})` };
  }
  const one = tha ?? eng;
  if (!one) return { value: null, status: 'missing', reason: `${label}: อ่านไม่ได้` };
  return one.conf >= CONF_OK ? { value: one.text, status: 'ok' } : { value: one.text, status: 'uncertain', reason: `${label}: ความมั่นใจต่ำ (${Math.round(one.conf)}%)` };
}

function engLineAt(eng: OcrPass, ref: OcrLine): OcrLine | undefined {
  const tol = height(ref.bbox) * 0.6;
  return eng.lines.find(l => Math.abs(midY(l.bbox) - midY(ref.bbox)) <= tol);
}

/*
 * Date/time verification rule (no single OCR reading is ever enough on its own):
 *   time  "ok" only if the Thai and English passes read the SAME HH:MM:SS. One reading only, or two
 *         different readings → "uncertain" (both readings shown). Neither → "missing".
 *   date  "ok" only if ALL of these hold:
 *           - Thai pass reads day, Thai month abbreviation and 2-digit BE year ("3 พ.ย. 69"), forming a valid date;
 *           - English pass independently reads the same day and the same 2-digit year (it cannot read the Thai month);
 *           - the month and year agree with the section's month header ("พฤศจิกายน 2569"), an independent line.
 *         Any missing or disagreeing part → "uncertain" with the reason. A date is assembled from the header month
 *         only as an uncertain suggestion, never as "ok".
 */
interface DateParts { day?: number; monthAbbr?: number; yy?: number; time?: string }

function readDateParts(l: OcrLine | undefined): DateParts {
  if (!l) return {};
  const text = thaiFold(l.text);
  const out: DateParts = {};
  const tm = text.match(/(\d{1,2})[:.](\d{2})[:.](\d{2})/);
  let before = text;
  if (tm && Number(tm[1]) < 24 && Number(tm[2]) < 60 && Number(tm[3]) < 60) {
    out.time = `${tm[1].padStart(2, '0')}:${tm[2]}:${tm[3]}`;
    before = text.slice(0, tm.index);
  }
  // "<day> <month token> <yy> -" immediately before the time (month token may be Thai or OCR noise)
  // the month token is one run of non-space characters; in the English pass it is OCR noise and may contain digits ("§1.@.")
  const dm = before.match(/(?:^|\s)(\d{1,2})\s*(\S{1,8}?)\s*(\d{2})\s*[-–]?\s*$/);
  if (dm) {
    out.day = Number(dm[1]);
    out.yy = Number(dm[3]);
    out.monthAbbr = MONTHS_ABBR[dm[2].replace(/[.\s]/g, '')];
  }
  return out;
}

function parseDateTime(thaLine: OcrLine | undefined, engLine: OcrLine | undefined, month: { month: number; yearBE: number } | null): { date: Field<string>; time: Field<string> } {
  const t = readDateParts(thaLine), e = readDateParts(engLine);

  let time: Field<string>;
  if (t.time && e.time) time = t.time === e.time ? { value: t.time, status: 'ok' } : { value: t.time, status: 'uncertain', reason: `เวลา: อ่านได้ 2 ค่าไม่ตรงกัน (${t.time} / ${e.time})` };
  else if (t.time || e.time) time = { value: (t.time ?? e.time)!, status: 'uncertain', reason: 'เวลา: อ่านได้เพียงรอบเดียว ยืนยันไม่ได้ — โปรดตรวจ' };
  else time = { value: null, status: 'missing', reason: 'เวลา: อ่านไม่ได้' };

  const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate();
  const headerYearCE = month ? month.yearBE - 543 : undefined;
  let date: Field<string> = { value: null, status: 'missing', reason: 'วันที่: อ่านไม่ได้' };
  if (t.day !== undefined && t.monthAbbr && t.yy !== undefined && valid(2500 + t.yy - 543, t.monthAbbr, t.day)) {
    const yearCE = 2500 + t.yy - 543;
    const problems: string[] = [];
    if (e.day === undefined || e.yy === undefined) problems.push('รอบภาษาอังกฤษอ่านวัน/ปีไม่ได้');
    else if (e.day !== t.day || e.yy !== t.yy) problems.push(`วัน/ปีอ่านได้ไม่ตรงกัน (${t.day}/${t.yy} และ ${e.day}/${e.yy})`);
    if (!month) problems.push('ไม่พบหัวข้อเดือนสำหรับเทียบ');
    else if (month.month !== t.monthAbbr || headerYearCE !== yearCE) problems.push('ไม่ตรงกับหัวข้อเดือน');
    date = problems.length
      ? { value: iso(yearCE, t.monthAbbr, t.day), status: 'uncertain', reason: `วันที่: ${problems.join(', ')} — โปรดตรวจ` }
      : { value: iso(yearCE, t.monthAbbr, t.day), status: 'ok' };
  } else if (month && headerYearCE) {
    const day = t.day ?? e.day;
    if (day !== undefined && valid(headerYearCE, month.month, day)) {
      date = { value: iso(headerYearCE, month.month, day), status: 'uncertain', reason: 'วันที่: อ่านเดือนในบรรทัดไม่ได้ จึงใช้เดือนจากหัวข้อ — โปรดตรวจ' };
    }
  }
  return { date, time };
}

export function parseDimeScreenshot(tha: OcrPass, eng: OcrPass): ParseResult {
  const lines = [...tha.lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const result: ParseResult = { completedSectionFound: false, rows: [], ignored: [], notices: [] };
  let inCompleted = false;
  let month: { month: number; yearBE: number } | null = null;
  let otherSection = '';
  const consumed = new Set<OcrLine>();
  const orphanLines: OcrLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBottomNav(l)) break;
    if (isCompletedHeader(l)) { inCompleted = true; result.completedSectionFound = true; otherSection = ''; continue; }
    if (isOtherSectionHeader(l)) { inCompleted = false; otherSection = squash(l.text); continue; }
    const sm = sectionMonth(l);
    if (sm) { month = sm; continue; }
    if (!isAnchor(l)) {
      // safety net: a price/quantity line in the completed section that belongs to no row means a row start was not
      // recognised — report it instead of silently losing a transaction
      if (inCompleted && (isPriceLine(l) || isQtyLine(l)) && !consumed.has(l)) orphanLines.push(l);
      continue;
    }

    // collect the row's lines: anchor, then price and quantity lines until the next anchor/header
    const rowLines: OcrLine[] = [l];
    consumed.add(l);
    for (let j = i + 1; j < lines.length && rowLines.length < 4; j++) {
      const n = lines[j];
      if (isAnchor(n) || isCompletedHeader(n) || isOtherSectionHeader(n) || isBottomNav(n) || sectionMonth(n)) break;
      rowLines.push(n);
      consumed.add(n);
    }
    const band: OcrBox = {
      x0: Math.min(...rowLines.map(x => x.bbox.x0)), y0: Math.min(...rowLines.map(x => x.bbox.y0)),
      x1: Math.max(...rowLines.map(x => x.bbox.x1)), y1: Math.max(...rowLines.map(x => x.bbox.y1)),
    };
    if (!inCompleted) {
      result.ignored.push({ reason: otherSection ? `อยู่ในส่วน “${otherSection}” ไม่ใช่ “เสร็จสิ้น”` : 'อยู่นอกส่วน “เสร็จสิ้น”', text: rowLines.map(x => x.text.trim()).join(' / '), band });
      continue;
    }
    const priceLine = rowLines.find(isPriceLine);
    const qtyLine = rowLines.find(isQtyLine);

    const sideText = squash(l.text);
    const side: Field<'BUY' | 'SELL'> = /^ขาย/.test(sideText) ? { value: 'SELL', status: 'ok' }
      : /^ซื้?อ/.test(sideText) ? { value: 'BUY', status: 'ok' }
      : { value: null, status: 'missing', reason: 'ประเภท (ซื้อ/ขาย): อ่านไม่ได้ — โปรดเลือก' };

    // ticker from the English pass on the same visual line
    const engAnchor = engLineAt(eng, l);
    const tk = engAnchor?.words.find(w => /^[A-Z]{1,5}(\.[A-Z])?$/.test(w.text) && !TICKER_STOP.has(w.text));
    const tkInTha = tk && squash(l.text).includes(tk.text);
    const ticker: Field<string> = !tk
      ? { value: null, status: 'missing', reason: 'ชื่อหุ้น: อ่านไม่ได้' }
      : tk.confidence >= CONF_TICKER || tkInTha ? { value: tk.text, status: 'ok' } : { value: tk.text, status: 'uncertain', reason: `ชื่อหุ้น: ความมั่นใจต่ำ (${Math.round(tk.confidence)}%)` };

    // amount: the number right before "บาท" in the Thai pass; second reading from the English pass
    const thaAmountWord = (() => {
      const idx = l.words.findIndex(w => /บาท|^บ$/.test(w.text));
      const before = l.words.slice(0, idx < 0 ? undefined : idx).reverse().find(w => /^\d[\d,]*\.\d{2}$/.test(w.text.replace(/,/g, '')));
      return before ? { text: before.text.replace(/,/g, ''), conf: before.confidence } : undefined;
    })();
    const engAmount = numbers(engAnchor, /^\d[\d,]*\.\d{2}$/).pop();
    const amountTHB = combine(thaAmountWord, engAmount, 'ยอดเงินบาท');

    const engPrice = priceLine ? engLineAt(eng, priceLine) : undefined;
    const priceUSD = priceLine ? combine(numbers(priceLine)[0], numbers(engPrice)[0], 'ราคา (USD)') : { value: null, status: 'missing' as const, reason: 'ราคา (USD): ไม่พบบรรทัด “ราคาที่ได้จริง”' };

    const engQty = qtyLine ? engLineAt(eng, qtyLine) : undefined;
    const quantity = qtyLine ? combine(numbers(qtyLine)[0], numbers(engQty)[0], 'จำนวนหุ้น') : { value: null, status: 'missing' as const, reason: 'จำนวนหุ้น: ไม่พบบรรทัด “จำนวนหุ้น”' };

    const { date, time } = parseDateTime(priceLine, engPrice, month);

    // sanity: effective FX far outside a plausible THB/USD range means some digit was misread
    const q = Number(quantity.value), p = Number(priceUSD.value), a = Number(amountTHB.value);
    if (q > 0 && p > 0 && a > 0) {
      const fx = a / (q * p);
      if (fx < 20 || fx > 50) for (const f of [quantity, priceUSD, amountTHB]) if (f.status === 'ok') { f.status = 'uncertain'; f.reason = `อัตราแลกเปลี่ยนที่คำนวณได้ (${fx.toFixed(2)}) ผิดปกติ — ตรวจตัวเลข`; }
    }

    result.rows.push({ side, ticker, priceUSD, quantity, amountTHB, date, time, band });
  }

  if (orphanLines.length) {
    result.notices.push(`มีข้อมูล ${orphanLines.length} บรรทัดในส่วน “เสร็จสิ้น” ที่ไม่สามารถจับคู่กับรายการได้ — ตรวจภาพว่ามีรายการตกหล่นหรือไม่`);
    for (const o of orphanLines) result.ignored.push({ reason: 'อ่านหัวรายการไม่ได้ (ไม่ได้นำเข้า — โปรดเพิ่มเองถ้าเป็นรายการจริง)', text: o.text.trim(), band: o.bbox });
  }
  if (!result.completedSectionFound) result.notices.push('ไม่พบหัวข้อ “เสร็จสิ้น” ในภาพ จึงไม่นำเข้ารายการใด — กรุณาใช้ภาพหน้าจอรายการที่ทำสำเร็จแล้วจาก Dime');
  if (result.ignored.length) result.notices.push(`ข้ามรายการที่ไม่ได้อยู่ในส่วน “เสร็จสิ้น” ${result.ignored.length} รายการ (เช่น รอดำเนินการ/ยกเลิก)`);
  if (result.completedSectionFound && !result.rows.length) result.notices.push('พบหัวข้อ “เสร็จสิ้น” แต่อ่านรายการซื้อขายไม่ได้ — ลองใช้ภาพที่คมชัดขึ้น');
  return result;
}
