export type TxnType = 'BUY' | 'SELL' | 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL' | 'FEE' | 'ADJUSTMENT';
export type TxnStatus = 'EXECUTED' | 'PENDING' | 'CANCELLED';
export type Currency = 'USD' | 'THB';
export type TxnSource = 'manual' | 'assistant' | 'import' | 'seed';

export interface Txn {
  id: string;
  datetime: string; // ISO 8601, local time of the trade as entered
  type: TxnType;
  status: TxnStatus;
  ticker?: string;
  quantity?: number;
  price?: number; // per share, in `currency`
  priceUSD?: number; // per-share price in USD as shown by the broker (kept for THB-settled trades; audit/display only)
  amount: number; // gross amount in `currency` (BUY: cost before fees; SELL: proceeds before fees; ADJUSTMENT: signed)
  currency: Currency;
  fxRate?: number; // THB per 1 USD at the time of the transaction
  fees: number; // in `currency`
  notes?: string;
  source: TxnSource;
  createdAt: string;
  updatedAt: string;
}

export interface TickerMeta {
  ticker: string;
  name?: string;
  sector?: string;
  horizon?: 'long' | 'trading';
  targetWeight?: number; // percent of holdings value
}

export interface PriceQuote {
  ticker: string;
  price: number; // USD
  prevClose?: number;
  asOf: string; // ISO
  source: 'manual' | 'finnhub';
}

export interface FxQuote {
  rate: number; // THB per USD
  asOf: string;
  source: 'manual' | 'frankfurter';
}

export interface Snapshot {
  date: string; // YYYY-MM-DD
  valueTHB: number; // holdings + cash
  holdingsTHB: number;
  investedTHB: number; // cost basis of open positions
  netDepositsTHB: number;
  estimated: boolean;
}

export interface Settings {
  theme: 'dark' | 'light';
  finnhubKey?: string;
  maxDrawdownPct: number;
  maxStockLossPct: number;
  seeded?: boolean;
}

export interface AppData {
  version: 1;
  txns: Txn[];
  meta: Record<string, TickerMeta>;
  prices: Record<string, PriceQuote>;
  fx: FxQuote;
  snapshots: Snapshot[];
  settings: Settings;
}
