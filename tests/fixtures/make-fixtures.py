"""Generates FULLY SYNTHETIC test screenshots for the Dime screenshot importer.

Everything is drawn from scratch with a Thai font (TLWG Loma): no pixels and no transaction values from any
real screenshot are used. Tickers (ZYXW, QRST, MNOP, KLMN, PNDG, CNCL) are fictional, as are all dates,
quantities, prices and amounts. The layout only imitates the structure of Dime's Thai "รายการทั้งหมด" screen
(dark mode, section header, month headers, three lines per transaction).

Outputs (tests/fixtures/):
  synthetic-completed.png   completed section only: 5 transactions over two months, including a SELL
  synthetic-sections.png    pending + completed + cancelled sections (the pending and cancelled rows must be ignored)
  synthetic-expected.json   ground truth for the tests

Run: python3 tests/fixtures/make-fixtures.py      (THAI_FONT_DIR to override the font folder)
"""
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.environ.get('THAI_FONT_DIR', '/usr/share/fonts/opentype/tlwg')
REG = os.path.join(FONT_DIR, 'Loma.otf')
BOLD = os.path.join(FONT_DIR, 'Loma-Bold.otf')
W = 1320
BG, TEXT, GREY, GREEN, RED, LINE = (18, 18, 18), (236, 236, 236), (150, 150, 150), (84, 196, 96), (230, 90, 90), (48, 48, 48)
f = lambda path, size: ImageFont.truetype(path, size)
F_TITLE, F_HEAD, F_MONTH, F_TICK, F_BODY, F_DATE, F_NAV = f(BOLD, 74), f(BOLD, 60), f(BOLD, 50), f(BOLD, 54), f(REG, 46), f(REG, 44), f(REG, 36)
TH_MONTH_ABBR = {9: 'ก.ย.', 10: 'ต.ค.', 11: 'พ.ย.'}
TH_MONTH_FULL = {9: 'กันยายน', 10: 'ตุลาคม', 11: 'พฤศจิกายน'}

# Fictional transactions, newest first as Dime lists them. FX values are only used to make plausible THB amounts.
COMPLETED = [
    # side, ticker, y, m, d, hh:mm:ss, price, quantity, fx
    ('SELL', 'QRST', 2025, 10, 21, '15:42:07', '51.24', '0.2000000', 34.12),
    ('BUY', 'ZYXW', 2025, 10, 14, '10:05:33', '152.38', '0.1312507', 34.21),
    ('BUY', 'MNOP', 2025, 10, 9, '21:30:18', '9.87', '2.5329281', 34.05),
    ('BUY', 'QRST', 2025, 10, 9, '21:28:54', '47.10', '0.6369427', 34.05),
    ('BUY', 'KLMN', 2025, 9, 30, '09:41:12', '233.15', '0.0428911', 33.98),
]
PENDING_ROW = ('BUY', 'PNDG', 2025, 10, 22, '11:02:45', '88.40', '0.3393665', 34.10)
CANCELLED_ROW = ('BUY', 'CNCL', 2025, 10, 3, '14:17:50', '61.75', '0.4858300', 34.00)

def amount(row):
    _, _, _, _, _, _, price, qty, fx = row
    return f'{float(price) * float(qty) * fx:.2f}'

def fmt_thb(a):
    return f'{float(a):,.2f}'

class Canvas:
    def __init__(self):
        self.parts = []
    def band(self, h, draw):
        im = Image.new('RGB', (W, h), BG)
        draw(ImageDraw.Draw(im))
        self.parts.append(im)
    def save(self, name):
        out = Image.new('RGB', (W, sum(p.height for p in self.parts)), BG)
        y = 0
        for p in self.parts:
            out.paste(p, (0, y)); y += p.height
        out.save(os.path.join(HERE, name))
        return out.size

def top(c):
    c.band(150, lambda d: d.text((110, 50), '10:30', font=F_NAV, fill=TEXT))
    def title(d):
        d.text((60, 40), 'รายการทั้งหมด', font=F_TITLE, fill=TEXT)
        d.rounded_rectangle((760, 40, 1260, 130), 40, fill=(34, 34, 34))
        d.text((800, 62), 'รายการล่วงหน้า (DCA) >', font=F_NAV, fill=TEXT)
    c.band(180, title)
    def tabs(d):
        d.text((230, 30), 'ลงทุน', font=F_BODY, fill=TEXT)
        d.text((800, 30), 'เงินสด', font=F_BODY, fill=GREY)
        d.line((0, 110, 560, 110), fill=TEXT, width=4)
    c.band(130, tabs)
    def search(d):
        d.rounded_rectangle((60, 40, 1100, 130), 45, fill=(52, 52, 52))
        d.text((140, 62), 'ระบุชื่อย่อหุ้น เพื่อค้นหารายการคำสั่ง', font=F_NAV, fill=GREY)
    c.band(190, search)

def header(c, text):
    c.band(150, lambda d: d.text((60, 50), text, font=F_HEAD, fill=TEXT))

def month(c, m, y):
    c.band(120, lambda d: d.text((60, 35), f'{TH_MONTH_FULL[m]} {y + 543}', font=F_MONTH, fill=GREY))

def txn(c, row, last=False):
    side, tk, y, m, d_, t, price, qty, _ = row
    def draw(d):
        word, colour = ('ขาย', RED) if side == 'SELL' else ('ซื้อ', GREEN)
        d.text((60, 30), word, font=F_TICK, fill=colour)
        d.text((60 + d.textlength(word + ' ', font=F_TICK), 30), tk, font=F_TICK, fill=TEXT)
        a = f'{fmt_thb(amount(row))} บาท'
        d.text((W - 60 - d.textlength(a, font=F_TICK), 30), a, font=F_TICK, fill=colour)
        d.text((60, 120), f'ราคาที่ได้จริง {price}', font=F_BODY, fill=TEXT)
        dt = f'{d_} {TH_MONTH_ABBR[m]} {str(y + 543)[2:]} - {t} น.'
        d.text((W - 60 - d.textlength(dt, font=F_DATE), 122), dt, font=F_DATE, fill=GREY)
        d.text((60, 200), f'จำนวนหุ้น {qty}', font=F_BODY, fill=TEXT)
        if not last:
            d.line((60, 296, W - 60, 296), fill=LINE, width=2)
    c.band(300, draw)

def bottom(c):
    def nav(d):
        d.rectangle((0, 0, W, 260), fill=(30, 30, 30))
        for i, label in enumerate(['หน้าหลัก', 'ค้นหา', 'เงินสด', 'สินทรัพย์', 'รายการ', 'ฉัน']):
            d.text((40 + i * 215, 120), label, font=F_NAV, fill=GREY)
    c.band(260, nav)

def completed_section(c):
    header(c, 'เสร็จสิ้น')
    current = None
    for i, row in enumerate(COMPLETED):
        if row[3] != current:
            current = row[3]
            month(c, row[3], row[2])
        txn(c, row, last=i == len(COMPLETED) - 1)

def expected(row):
    side, tk, y, m, d_, t, price, qty, _ = row
    return {'side': side, 'ticker': tk, 'date': f'{y}-{m:02d}-{d_:02d}', 'time': t, 'priceUSD': price, 'quantity': qty, 'amountTHB': amount(row)}

c = Canvas(); top(c); completed_section(c); bottom(c)
s1 = c.save('synthetic-completed.png')

c = Canvas(); top(c)
header(c, 'รอดำเนินการ'); txn(c, PENDING_ROW, last=True)
completed_section(c)
header(c, 'ยกเลิก'); txn(c, CANCELLED_ROW, last=True)
bottom(c)
s2 = c.save('synthetic-sections.png')

truth = {
    'note': 'Fully synthetic data. Not from any real account.',
    'completed': [expected(r) for r in COMPLETED],
    'ignored': {'pending': expected(PENDING_ROW), 'cancelled': expected(CANCELLED_ROW)},
    'totalTHB': f'{sum(float(amount(r)) for r in COMPLETED):.2f}',
}
with open(os.path.join(HERE, 'synthetic-expected.json'), 'w', encoding='utf-8') as fh:
    json.dump(truth, fh, ensure_ascii=False, indent=2)
print(s1, s2, truth['totalTHB'])
