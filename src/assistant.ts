import type { AppData } from './types';
import { computePortfolio, maxDrawdownFromPeak, type Portfolio } from './engine';
import { fmtTHB, fmtPct, fmtDate } from './format';

// Rule-based portfolio assistant. It only reads figures computed from the user's own records and
// stored price data. It does not call a language model, and it never invents prices or results.

const isETF = (p: { sector?: string; ticker: string }) => /ETF/i.test(p.sector ?? '') || ['VOO', 'QQQM', 'SGOV', 'SPY', 'QQQ', 'VTI', 'IVV', 'SCHD', 'BND', 'VT'].includes(p.ticker);

function dataLine(d: AppData, p: Portfolio) {
  const priced = p.positions.filter(x => x.hasPrice);
  const latest = priced.map(x => x.priceAsOf!).sort().pop();
  const src = [...new Set(priced.map(x => x.priceSource === 'finnhub' ? 'Finnhub (อาจล่าช้า)' : 'ราคาที่ผู้ใช้กรอก'))].join(', ') || 'ไม่มีราคา';
  return `แหล่งข้อมูล: รายการที่ผู้ใช้บันทึก • ราคา: ${src}${latest ? ` ล่าสุด ${fmtDate(latest)}` : ''} • อัตราแลกเปลี่ยน ${d.fx.rate > 0 ? d.fx.rate.toFixed(4) : '—'} บาท/USD (${d.fx.source === 'manual' ? 'กรอกเอง' : 'Frankfurter/ECB'}${d.fx.asOf ? ' ' + d.fx.asOf.slice(0, 10) : ''})` +
    (p.estimated ? '\n⚠️ บางตัวยังไม่มีราคา ระบบใช้ต้นทุนแทนมูลค่า (เป็นค่าประมาณ)' : '');
}

const DISCLAIMER = 'ข้อมูลนี้เป็นการคำนวณจากข้อมูลของคุณเพื่อประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุนเฉพาะบุคคล และไม่รับประกันผลตอบแทน';

export function answer(q: string, d: AppData): string {
  const p = computePortfolio(d);
  const s = q.toLowerCase();
  if (p.positions.length === 0) {
    return `ยังไม่มีหุ้นที่ซื้อสำเร็จในระบบ จึงยังวิเคราะห์พอร์ตไม่ได้\n` +
      (p.pending.length ? `มีคำสั่งรอดำเนินการ ${p.pending.length} รายการ รวม ${fmtTHB(p.pendingTHB)} (ยังไม่นับเป็นหุ้นที่ถือ)\nเมื่อ Dime ทำรายการสำเร็จ ให้กด “ยืนยันว่าสำเร็จ” ในหน้า รายการ แล้วกรอกจำนวนหุ้น ราคา และอัตราแลกเปลี่ยนจริง\n` : '') +
      `หรือพิมพ์คำสั่ง เช่น “ซื้อ VOO จำนวน 0.5 หุ้น ราคา 520 USD อัตรา 33.5”`;
  }
  if (/(dca|เงินเพิ่ม|ลงทุนเพิ่ม|มีเงิน)/i.test(s)) return dca(q, d, p);
  if (/(เสี่ยง|risk)/i.test(s)) return risk(d, p);
  if (/(ลดสัดส่วน|rebalanc|ปรับพอร์ต|สัดส่วน)/i.test(s)) return rebalance(d, p);
  if (/(ผลประกอบการ|งบ|earning|fundamental|รายได้|กำไรบริษัท)/i.test(s)) return fundamentals(d, p);
  if (/(วิเคราะห์|analy|สรุปพอร์ต|ภาพรวม|overview|พอร์ต|portfolio)/i.test(s)) return analyze(d, p);
  return `ผมช่วยได้ดังนี้ (ทำงานจากข้อมูลพอร์ตของคุณ ไม่ได้ใช้ AI แบบ LLM):\n• “วิเคราะห์พอร์ตปัจจุบัน”\n• “หุ้นตัวไหนมีความเสี่ยงสูงที่สุด”\n• “ถ้ามีเงินเพิ่ม 5,000 บาท ควร DCA ตัวไหน”\n• “ควรลดสัดส่วนหุ้นตัวไหนหรือไม่”\n• “สรุปผลประกอบการของหุ้นที่ถืออยู่”\n• บันทึกรายการ: “ซื้อ NVDA จำนวน 1 หุ้น ราคา 180 USD อัตรา 33.4” (จะแสดงตัวอย่างให้ยืนยันก่อนบันทึกเสมอ)`;
}

function analyze(d: AppData, p: Portfolio) {
  const top = p.positions[0];
  const hhi = p.positions.reduce((a, x) => a + (x.weight / 100) ** 2, 0);
  const eff = hhi > 0 ? 1 / hhi : 0;
  const etfW = p.positions.filter(isETF).reduce((a, x) => a + x.weight, 0);
  const sectors = new Map<string, number>();
  p.positions.forEach(x => sectors.set(x.sector || 'ไม่ระบุ', (sectors.get(x.sector || 'ไม่ระบุ') ?? 0) + x.weight));
  const dd = maxDrawdownFromPeak(d.snapshots);
  const losers = p.positions.filter(x => x.hasPrice && x.unrealizedPct <= -d.settings.maxStockLossPct);
  const lines = [
    `📊 ภาพรวมพอร์ต`,
    `มูลค่ารวม ${fmtTHB(p.totalValueTHB)} (หุ้น ${fmtTHB(p.holdingsValueTHB)} + เงินสด ${fmtTHB(p.cashTotalTHB)})`,
    `ต้นทุนหุ้นที่ถือ ${fmtTHB(p.investedTHB)} • กำไร/ขาดทุนยังไม่รับรู้ ${fmtTHB(p.unrealizedTHB, true)} (${fmtPct(p.unrealizedPct, true)})`,
    `กำไรที่รับรู้แล้ว ${fmtTHB(p.realizedTHB, true)} • ปันผลสุทธิ ${fmtTHB(p.dividendsTHB)}`,
    ...p.positions.map(x => `• ${x.ticker} ${fmtPct(x.weight)} — ${x.hasPrice ? `${fmtTHB(x.unrealizedTHB, true)} (${fmtPct(x.unrealizedPct, true)})` : 'ยังไม่มีราคาตลาด (ใช้ต้นทุนแทน)'}`),
    ``,
    `🧩 การกระจายตัว`,
    `ถือ ${p.positions.length} ตัว • ตัวใหญ่สุด ${top.ticker} ${fmtPct(top.weight)} • เทียบเท่าการถือเท่ากัน ~${eff.toFixed(1)} ตัว (ดัชนี HHI)`,
    `สัดส่วน ETF ${fmtPct(etfW)} • หุ้นรายตัว ${fmtPct(100 - etfW)}`,
    `กลุ่มอุตสาหกรรม: ${[...sectors].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmtPct(v)}`).join(', ')}`,
    ``,
    `🛡️ เทียบกับเกณฑ์ความเสี่ยงของคุณ`,
    `ขาดทุนต่อหุ้นรายตัวไม่เกิน ${d.settings.maxStockLossPct}%: ${losers.length ? '⚠️ เกินเกณฑ์ ' + losers.map(x => `${x.ticker} ${fmtPct(x.unrealizedPct, true)}`).join(', ') : '✅ ยังไม่มีตัวที่เกินเกณฑ์'}`,
    `Drawdown พอร์ต (เทียบจุดสูงสุดที่บันทึก): ปัจจุบัน ${fmtPct(dd.current)} / แย่สุด ${fmtPct(dd.worst)} — เกณฑ์ ${d.settings.maxDrawdownPct}% ${-dd.worst >= d.settings.maxDrawdownPct ? '⚠️ เคยถึงเกณฑ์' : '✅'}`,
    d.snapshots.length < 20 ? `หมายเหตุ: มีประวัติมูลค่าเพียง ${d.snapshots.length} วัน ค่า Drawdown ยังไม่น่าเชื่อถือ` : '',
    p.pending.length ? `\n⏳ คำสั่งรอดำเนินการ ${p.pending.length} รายการ ${fmtTHB(p.pendingTHB)} — ไม่ได้นับรวมในพอร์ต` : '',
    ``, dataLine(d, p), DISCLAIMER,
  ];
  return lines.filter(l => l !== '').join('\n').replace(/\n(?=📊|🧩|🛡️)/g, '\n\n');
}

function risk(d: AppData, p: Portfolio) {
  const rows = p.positions.map(x => {
    const reasons: string[] = [];
    let score = 0;
    if (!isETF(x)) { score += 2; reasons.push('หุ้นรายตัว (ไม่กระจายในตัวเอง)'); }
    if (x.weight > 25) { score += 2; reasons.push(`น้ำหนักสูง ${fmtPct(x.weight)}`); } else if (x.weight > 15) { score += 1; reasons.push(`น้ำหนัก ${fmtPct(x.weight)}`); }
    if (x.hasPrice && x.unrealizedPct < -10) { score += x.unrealizedPct <= -d.settings.maxStockLossPct ? 3 : 1; reasons.push(`ขาดทุน ${fmtPct(x.unrealizedPct, true)}`); }
    if (x.horizon === 'trading') { score += 1; reasons.push('เป็นสถานะเทรดระยะสั้น'); }
    if (/T-?Bill|Treasury|Cash/i.test(x.sector ?? '')) { score -= 2; reasons.push('ตราสารหนี้ระยะสั้นมาก ความผันผวนต่ำ'); }
    if (!x.hasPrice) reasons.push('ยังไม่มีราคาตลาด');
    return { x, score, reasons };
  }).sort((a, b) => b.score - a.score);
  return [
    `⚠️ จัดอันดับความเสี่ยงตามข้อมูลที่มี (สูง → ต่ำ)`,
    ...rows.map((r, i) => `${i + 1}. ${r.x.ticker} — คะแนน ${r.score} • ${r.reasons.join(' • ') || 'ไม่มีปัจจัยเด่น'}`),
    ``,
    `วิธีให้คะแนน: หุ้นรายตัว +2, น้ำหนัก >25% +2 (>15% +1), ขาดทุน >10% +1 (ถึงเกณฑ์ ${d.settings.maxStockLossPct}% +3), สถานะเทรด +1, กองทุนพันธบัตรระยะสั้น −2`,
    `ข้อจำกัด: ยังไม่มีข้อมูลความผันผวนย้อนหลังและค่า Beta จริง — ดูค่า Beta ได้ในหน้า วิจัย เมื่อใส่ Finnhub API key`,
    ``, dataLine(d, p), DISCLAIMER,
  ].join('\n');
}

function dca(q: string, d: AppData, p: Portfolio) {
  const m = q.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  const budget = m ? parseFloat(m[1]) : NaN;
  if (!(budget > 0)) return 'กรุณาระบุจำนวนเงิน เช่น “ถ้ามีเงินเพิ่ม 5,000 บาท ควร DCA ตัวไหน”';
  const withTarget = p.positions.filter(x => (x.targetWeight ?? 0) > 0);
  const lines: string[] = [`💡 แนวทางแบ่งเงิน ${fmtTHB(budget)} (เป็นทางเลือกประกอบการตัดสินใจ ระบบไม่ส่งคำสั่งซื้อ)`];
  const after = p.holdingsValueTHB + budget;
  if (withTarget.length) {
    const tw = withTarget.reduce((a, x) => a + x.targetWeight!, 0);
    const gaps = withTarget.map(x => ({ x, gap: Math.max(0, (x.targetWeight! / tw) * after - x.marketValueTHB) }));
    const g = gaps.reduce((a, y) => a + y.gap, 0);
    lines.push(`วิธีที่ 1 — เติมตัวที่ต่ำกว่าเป้าหมาย (ตามเป้าหมายสัดส่วนที่คุณตั้งไว้):`);
    gaps.filter(y => y.gap > 0).forEach(y => lines.push(`• ${y.x.ticker}: ${fmtTHB(g > 0 ? (y.gap / g) * budget : 0)} (ปัจจุบัน ${fmtPct(y.x.weight)} / เป้า ${fmtPct((y.x.targetWeight! / tw) * 100)})`));
    if (g === 0) lines.push('• ทุกตัวอยู่ที่หรือสูงกว่าเป้าแล้ว — แบ่งตามเป้าหมายตรงๆ: ' + withTarget.map(x => `${x.ticker} ${fmtTHB((x.targetWeight! / tw) * budget)}`).join(', '));
  } else {
    lines.push('ยังไม่ได้ตั้ง “เป้าหมายสัดส่วน” ของแต่ละตัว (ตั้งได้ที่หน้า หุ้นที่ถือ → แก้ไข) จึงแสดงเพียงทางเลือกกลาง:');
    lines.push('วิธีที่ 1 — แบ่งตามสัดส่วนปัจจุบัน (คงโครงสร้างพอร์ตเดิม):');
    p.positions.forEach(x => lines.push(`• ${x.ticker}: ${fmtTHB(budget * x.weight / 100)} (${fmtPct(x.weight)})`));
  }
  const losers = p.positions.filter(x => x.hasPrice && x.unrealizedPct <= -d.settings.maxStockLossPct);
  lines.push('', 'เหตุผล: การ DCA ตามเป้าหมายสัดส่วนช่วยคุมการกระจุกตัวโดยไม่ต้องขายหุ้น และไม่ต้องคาดเดาจังหวะตลาด');
  lines.push('ความเสี่ยงสำคัญ: ราคาอาจลดลงต่อหลังซื้อ • ค่าเงินบาทแข็งค่าทำให้มูลค่าเป็นบาทลดลง • หุ้นรายตัวผันผวนกว่า ETF กว้าง');
  if (losers.length) lines.push(`⚠️ ${losers.map(x => x.ticker).join(', ')} ขาดทุนเกินเกณฑ์ ${d.settings.maxStockLossPct}% ของคุณ — ควรทบทวนเหตุผลการถือก่อนเติมเงิน`);
  lines.push('', dataLine(d, p), DISCLAIMER);
  return lines.join('\n');
}

function rebalance(d: AppData, p: Portfolio) {
  const out: string[] = ['⚖️ ตรวจสัดส่วนพอร์ต'];
  let any = false;
  for (const x of p.positions) {
    if (x.targetWeight && x.weight - x.targetWeight > 5) { any = true; out.push(`• ${x.ticker} ${fmtPct(x.weight)} สูงกว่าเป้า ${fmtPct(x.targetWeight)} เกิน 5 จุด`); }
    else if (!isETF(x) && x.weight > 25) { any = true; out.push(`• ${x.ticker} เป็นหุ้นรายตัวแต่มีน้ำหนัก ${fmtPct(x.weight)} (> 25%) — ความเสี่ยงกระจุกตัว`); }
  }
  if (!any) out.push('ยังไม่พบตัวที่เกินเกณฑ์ (เกณฑ์: เกินเป้าหมาย 5 จุด หรือหุ้นรายตัว > 25%)');
  out.push('', 'ทางเลือกที่ไม่ต้องขาย: ลด/หยุด DCA ตัวที่เกินเป้า แล้วนำเงินใหม่ไปเติมตัวที่ต่ำกว่าเป้า — หลีกเลี่ยงค่าธรรมเนียมและการรับรู้กำไร/ขาดทุน');
  out.push('', dataLine(d, p), DISCLAIMER);
  return out.join('\n');
}

function fundamentals(d: AppData, p: Portfolio) {
  if (!d.settings.finnhubKey) return 'ยังไม่มีแหล่งข้อมูลงบการเงิน — ใส่ Finnhub API key (ฟรี) ในหน้า ตั้งค่า แล้วเปิดหน้า วิจัย เพื่อดูตัวชี้วัดของแต่ละตัวพร้อมแหล่งที่มาและวันที่ข้อมูล\nผมจะไม่สรุปผลประกอบการจากความจำ เพราะอาจไม่ถูกต้องหรือไม่เป็นปัจจุบัน';
  return `เปิดหน้า “วิจัย” แล้วเลือก ${p.positions.map(x => x.ticker).join(', ')} เพื่อโหลดตัวชี้วัดล่าสุดจาก Finnhub (รายได้/กำไรเติบโต, P/E, หนี้สิน, กระแสเงินสด, ข่าว) พร้อมเวลาที่ดึงข้อมูล`;
}
