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
- A sell larger than the shares held is capped at the shares held and flagged as a warning.

## Unrealized P/L
- Market value (USD) = shares × latest price. Prices are either entered manually or fetched from Finnhub; each price shows its source and timestamp.
- Unrealized (USD) = market value USD − USD cost.
- Unrealized (THB) = market value USD × current rate − THB cost (includes FX effect).
- If a holding has no price, its cost is used as a placeholder market value, it shows "ยังไม่มีราคา", and portfolio totals are labelled **ประมาณการ (estimate)**.

## Cash
- Cash is tracked separately in THB and USD, in the currency each record was settled in.
  Deposit +, withdrawal −, buy −(amount + fees), sell +(amount − fees), dividend +(amount − withholding), fee −, adjustment ± (signed).
- If cash goes negative (for example, buys entered without the deposits that funded them), the app shows a warning instead of inventing a balance.

## Dividends
- Enter the gross dividend as the amount and the withholding tax in fees. Net dividends increase cash and total return.

## Returns
- Total return = unrealized + realized + net dividends (THB).
- Total return % = total return ÷ net deposits (falls back to cost basis when no deposits are recorded).
- Daily change uses the previous close returned by Finnhub; it is shown as "—" when unavailable.
- Drawdown is measured on holdings value ÷ cost basis, from daily snapshots, so new deposits do not look like gains.
