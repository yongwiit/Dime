# Accounting methodology

The calculation engine is `src/engine.ts`; its tests are in `src/engine.test.ts`.

## Which records count
- Only transactions with status **EXECUTED** affect holdings, cash, cost basis and P/L.
- **PENDING** orders are listed separately (count and THB amount) and are never added to holdings or deducted from cash.
- **CANCELLED** orders are kept for history only.
- A pending buy becomes a holding only when the user presses "ยืนยันว่าสำเร็จ" and enters the actual executed quantity, price per share and FX rate.

## Exchange rates
- Every executed transaction stores the rate Dime actually used, as **THB per 1 USD** (`fxRate`). It is mandatory for executed transactions.
- The **current** rate (Settings, fetched from the ECB reference rate via Frankfurter or entered manually) is used only to value current USD positions and USD cash in THB.

## Cost basis — weighted average
- Each buy adds `amount + fees` to cost, so fees are capitalised.
- Cost is kept twice: in **USD** (`amount ÷ fxRate` when paid in THB) and in **THB at the historical rate** (`amount × fxRate` when paid in USD).
- Average cost per share = USD cost ÷ shares held.

## Sells — realized P/L
- Net proceeds = gross proceeds − fees.
- Cost removed = (shares sold ÷ shares held) × cost basis, in USD and THB.
- Realized P/L (USD) = net proceeds in USD − USD cost removed.
- Realized P/L (THB) = net proceeds × sell-date rate − THB cost removed. **It therefore includes FX gain/loss.**
- A sell larger than the shares held cannot be saved from the form or the assistant. If one arrives through CSV import or a later edit of an earlier buy, it is capped at the shares held: quantity, proceeds **and** fees are all scaled by (shares held ÷ shares sold), so cash is not overstated, and a warning asks the user to correct it.

## Unrealized P/L
- Market value (USD) = shares × latest price. Prices are either entered manually or fetched from Finnhub; each price shows its source and timestamp.
- Unrealized (USD) = market value USD − USD cost.
- Unrealized (THB) = market value USD × current rate − THB cost (includes FX effect).
- If a holding has no price, its cost is used as a placeholder market value, it shows "ยังไม่มีราคา", and portfolio totals are labelled **ประมาณการ (estimate)**.

## Cash
- Cash is tracked separately in THB and USD, in the currency each record was settled in.
  Deposit +, withdrawal −, buy −(amount + fees), sell +(amount − fees), dividend +(amount − withholding), fee −, adjustment ± (signed).
- If cash goes negative (for example, buys entered without the deposits that funded them), the app shows a warning instead of inventing a balance.

### When cash is counted in portfolio value
- Cash is **excluded** from total portfolio value by default.
- It is included only after the user explicitly confirms, in Settings → "การนับเงินสดในพอร์ต", that the recorded deposits, withdrawals, fees and opening-balance adjustments are complete and the computed balance matches the Dime account (`settings.cashTracking.confirmedAt`).
- Recording a deposit or withdrawal never turns this on by itself. Confirmation is refused while the computed balance is negative. The user can turn it off at any time; the cash records are kept.

## Importing from Dime order history
- Inputs per order: quantity, USD price per share, amount paid (THB).
- FX = THB paid ÷ (quantity × USD price), computed at full precision; the user does not type it.
- Stored as a THB-settled BUY: `amount` = THB paid, `fxRate` = derived FX, `priceUSD` = Dime's USD price, `price` = THB per share. Hence THB cost = amount paid exactly, USD cost = quantity × USD price.
- Linking to a PENDING order updates that record in place (same id); otherwise a new BUY is added. All rows are validated before anything is saved (all-or-nothing). Logic: `src/importer.ts`; tests: `src/importer.test.ts`, `tests/e2e/import.e2e.mjs`.
- The derived FX may include Dime's FX spread or fees, which cannot be separated without Dime's fee detail.

## Dividends
- Enter the gross dividend as the amount and the withholding tax in fees. Net dividends increase cash and total return.

## Returns
- Total return = unrealized + realized + net dividends (THB).
- Total return % = total return ÷ net deposits (falls back to cost basis when no deposits are recorded).
- Daily change uses the previous close returned by Finnhub; it is shown as "—" when unavailable.
- Drawdown is measured on holdings value ÷ cost basis, from daily snapshots, so new deposits do not look like gains.
