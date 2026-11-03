import type { ImportField, ImportRow } from '../importer';
import type { ExtractedRow } from './dimeParser';

/**
 * Turns OCR rows into ordinary ImportRows for the existing importer. Values are copied exactly as read
 * (digit strings, so no rounding). Every field that was not read with certainty is listed in `unverified`,
 * which the importer treats as an error until the user corrects or confirms it.
 */
export function toImportRows(rows: ExtractedRow[], keyPrefix = 'ocr'): ImportRow[] {
  return rows.map((r, i) => {
    const unverified: ImportField[] = [];
    const pick = <T,>(f: { value: T | null; status: string }, name: ImportField): T | '' => {
      if (f.status !== 'ok') unverified.push(name);
      return f.value ?? '';
    };
    const side = pick(r.side, 'side');
    const row: ImportRow = {
      key: `${keyPrefix}-${i}`,
      side: side || undefined, // unreadable side stays empty: the user must choose, it is never assumed
      ticker: pick(r.ticker, 'ticker'),
      quantity: pick(r.quantity, 'quantity'),
      priceUSD: pick(r.priceUSD, 'priceUSD'),
      paid: pick(r.amountTHB, 'paid'),
      payCur: 'THB',
      fxRate: '',
      date: pick(r.date, 'date'),
      time: r.time.status === 'missing' ? '' : pick(r.time, 'time'), // time is optional; a misread one must be checked
      link: '',
      unverified,
      origin: 'screenshot',
    };
    return row;
  });
}

export const fieldReasons = (r: ExtractedRow) =>
  [r.side, r.ticker, r.quantity, r.priceUSD, r.amountTHB, r.date, r.time].filter(f => f.status !== 'ok' && f.reason).map(f => f.reason!);
