// Request types
export type RiskLevel = "low" | "medium" | "high";
export type Timeframe = "15m" | "1h" | "4h" | "1d";
export type Strategy = "pullback" | "breakout";

export interface AnalyzeRequest {
  budget: number;
  risk: RiskLevel;
  timeframe: Timeframe;
  strategy: Strategy;
}

// Response types
export type RiskState = "GREEN" | "YELLOW" | "RED";
export type Signal = "BUY" | "WAIT" | "AVOID";

export type MacroSource = "gdelt" | "rss";
export type TrendState = "bull" | "bear" | "sideways";

export interface CoinMetrics {
  close: number;
  prev_close: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi: number;
  atr: number;
  atr_pct: number;
  support: number;
  resistance: number;
  trend_state: TrendState;

  // Fibonacci fields (optional — only present when fib is valid)
  fib_valid?: boolean;
  fib_direction?: "up" | "down" | null;
  fib_swing_low?: number | null;
  fib_swing_high?: number | null;
  fib_levels?: Record<string, number> | null;
}

export interface CoinRecommendation {
  symbol: string;
  allocation: number; // percent
  signal: Signal;
  entry: number;
  stop_loss: number;
  take_profit: number;
  reason: string;

  tech_score: number;
  entry_distance_pct: number;
  position_usd: number;
  max_loss_usd: number;
  risk_pct_budget: number;
  metrics: CoinMetrics;
}

export type CoinPlan = CoinRecommendation;

export interface AnalyzeResponse {
  risk_state: RiskState;
  risk_reason: string;
  risk_multiplier: number;
  budget: number;
  timeframe: string;
  strategy: string;
  coins: CoinRecommendation[];

  macro_risk: number;
  macro_source: MacroSource;
  macro_cached: boolean;
  macro_updated_at: string;
  warnings: string[];
}

// --- Coin lookup (single coin modal / mini page) ---

export interface CoinLookupRequest extends AnalyzeRequest {
  // accepts "btc", "BTCUSDT", "btc/usdt", etc.
  symbol: string;
}

export interface CoinLookupResponse {
  coin: CoinRecommendation;

  risk_state: RiskState;
  risk_reason: string;
  risk_multiplier: number;

  macro_risk: number;
  macro_source: MacroSource;
  macro_cached: boolean;
  macro_updated_at: string;
  warnings: string[];
}

// --- Symbols search (/api/symbols) ---
export type SymbolsResponse = { items: string[] };

// --- Price Alerts ---
export interface PriceAlert {
  id: string;
  symbol: string;
  targetPrice: number;
  direction: "above" | "below";
  createdAt: string;
  triggered: boolean;
}

// --- Portfolio tracker ---
export interface PortfolioEntry {
  id: string;
  symbol: string;
  entryPrice: number;
  positionUsd: number;
  stopLoss: number;
  takeProfit: number;
  enteredAt: string;
  signal: Signal;
}