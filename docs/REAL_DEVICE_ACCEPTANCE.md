# Screenshot import — real-device acceptance checklist (iPhone)

Automated tests run real OCR in Node and in desktop Chromium at an iPhone 13 viewport. That is **not**
iPhone Safari: WebKit, iOS memory limits, the Photos picker, the camera and the Home Screen web-app
storage cannot be reproduced in CI. These checks must be done on a real iPhone before the feature is
considered accepted. Record results in the table at the end (or in the PR).

## Setup
- Device model, iOS version, free storage.
- The live site after an approved merge (there is no separate preview site; creating one would itself be a deployment and needs the owner's approval).
- Two contexts: (A) Safari tab, (B) app opened from the Home Screen icon. iOS keeps their data separate.
- **Back up first**: Settings → "สำรองข้อมูล (JSON)" in each context you test.
- Use a real Dime screenshot of รายการ → ลงทุน → หุ้นสหรัฐฯ (completed section). Real screenshots stay on the
  phone; never add them to the repository.

## Checks

| # | Check | How | Pass criteria |
|---|---|---|---|
| 1 | First OCR load time | Fresh install (or after clearing site data), Wi-Fi, import one screenshot. Read "เวลาอ่านภาพ" on the review screen. | Completes; first image (includes ~11 MB engine download) time recorded. Target ≤ 30 s on Wi-Fi. |
| 2 | Repeat OCR time | Import the same screenshot again (cancel before saving). | Faster than #1 (engine cached). Target ≤ 15 s per image. |
| 3 | Offline OCR | After #1, turn on Airplane Mode, import a screenshot. | Works offline (engine served from the "ocr-engine" cache), no network error. |
| 4 | Memory | Select 3–5 long screenshots at once and read them. Watch for a page reload or a blank screen. | No reload or crash; all images processed. If Safari reloads the page, note the number and size of images at which it happens. |
| 5 | Photos picker | "เลือกจากรูปภาพ" → choose 1, then several screenshots; use "เปลี่ยน" and "ลบ" on a preview. | Picker opens; previews show; replace/remove work. HEIC screenshots are accepted. |
| 6 | Camera capture | "ถ่ายภาพ" → photograph another screen showing a Dime list. | Camera opens; photo previews; values that cannot be read reliably are flagged, never silently accepted. |
| 7 | Extraction vs Dime | Compare every row against the Dime screen. | Ticker, side, quantity, USD price, THB amount, date and time match exactly, or the field is highlighted (ต้องตรวจ). No highlighted-free wrong value. |
| 8 | Pending linking | With matching pending orders in the app, use "เชื่อมกับคำสั่งรอดำเนินการที่ยอดเงินตรงกัน". | Summary says "อัปเดตคำสั่งรอดำเนินการเดิม"; after import the pending orders become completed with no extra records. |
| 9 | Duplicate protection | Import the same screenshot a second time. | Every row warns "อาจซ้ำ"; the confirm button stays disabled. |
| 10 | Persistence (Home Screen) | After a successful import in context B: swipe the app away, reopen from the icon; also restart the phone. | Imported holdings and transactions are still there. |
| 11 | Persistence (Safari) | Repeat #10 in context A. | Same. Note that A and B do not share data. |
| 12 | Layout | Portrait, largest Dynamic Type you use, light and dark theme. | No horizontal scrolling; buttons reachable above the home indicator; keyboard does not hide the active field. |
| 13 | No upload | Optional: Settings → Safari → Advanced → Web Inspector with a Mac, Network tab during import. | Only requests to the app's own `/Dime/` origin (no image upload, no third-party OCR). |

## Results

| # | Date | Device / iOS | Context | Result | Notes (times, image count, issues) |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| … | | | | | |

Open issues found here should be reported on the PR before approval.
