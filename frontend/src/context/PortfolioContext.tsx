import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { PortfolioEntry, CoinRecommendation } from "../types";

export interface PortfolioEntryWithPnL extends PortfolioEntry {
  currentPrice: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  status: "open" | "hit_tp" | "hit_sl" | "unknown";
}

interface PortfolioContextValue {
  entries: PortfolioEntryWithPnL[];
  addEntry: (coin: CoinRecommendation, budget: number) => void;
  removeEntry: (id: string) => void;
  clearAll: () => void;
  totalPnlUsd: number;
  isRefreshing: boolean;
  refreshPrices: () => Promise<void>;
  lastRefreshed: Date | null;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);
const LS_KEY = "ai-crypto:portfolio:v1";

function loadEntries(): PortfolioEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const s = sym.toUpperCase().endsWith("USDT") ? sym.toUpperCase() : sym.toUpperCase() + "USDT";
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`, {
          signal: AbortSignal.timeout(5000), // 5s timeout — don't hang forever
        });
        if (!res.ok) return;
        const data = await res.json();
        const price = parseFloat(data.price);
        if (!isNaN(price)) prices[sym.toUpperCase().replace("USDT", "")] = price;
      } catch {
        // CORS, network error, or timeout — silently skip, UI shows "Unavailable"
      }
    })
  );
  return prices;
}

function computeStatus(
  entry: PortfolioEntry,
  currentPrice: number | null
): PortfolioEntryWithPnL["status"] {
  if (currentPrice === null) return "unknown";
  if (currentPrice >= entry.takeProfit) return "hit_tp";
  if (currentPrice <= entry.stopLoss) return "hit_sl";
  return "open";
}

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const [rawEntries, setRawEntries] = useState<PortfolioEntry[]>(loadEntries);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Persist base entries
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(rawEntries));
    } catch {}
  }, [rawEntries]);

  // Keep a ref to rawEntries so the interval always sees the latest value
  const rawEntriesRef = useRef(rawEntries);
  useEffect(() => { rawEntriesRef.current = rawEntries; }, [rawEntries]);

  const refreshPrices = useCallback(async () => {
    const current = rawEntriesRef.current;
    if (current.length === 0) return;
    if (!mountedRef.current) return;
    setIsRefreshing(true);
    try {
      const symbols = [...new Set(current.map((e) => e.symbol))];
      const newPrices = await fetchPrices(symbols);
      if (!mountedRef.current) return;
      setPrices((prev) => ({ ...prev, ...newPrices }));
      setLastRefreshed(new Date());
    } finally {
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, []); // no deps needed — reads from ref

  // Auto-refresh every 30s when entries exist
  useEffect(() => {
    if (rawEntries.length === 0) {
      if (refreshRef.current) clearInterval(refreshRef.current);
      return;
    }
    refreshPrices();
    refreshRef.current = setInterval(refreshPrices, 30_000);
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current);
    };
  }, [rawEntries.length, refreshPrices]);

  const entries = useMemo<PortfolioEntryWithPnL[]>(() => {
    return rawEntries.map((entry) => {
      const currentPrice = prices[entry.symbol] ?? null;
      const pnlUsd =
        currentPrice !== null
          ? ((currentPrice - entry.entryPrice) / entry.entryPrice) * entry.positionUsd
          : null;
      const pnlPct =
        currentPrice !== null
          ? ((currentPrice - entry.entryPrice) / entry.entryPrice) * 100
          : null;
      return {
        ...entry,
        currentPrice,
        pnlUsd,
        pnlPct,
        status: computeStatus(entry, currentPrice),
      };
    });
  }, [rawEntries, prices]);

  const totalPnlUsd = useMemo(
    () => entries.reduce((sum, e) => sum + (e.pnlUsd ?? 0), 0),
    [entries]
  );

  const addEntry = useCallback((coin: CoinRecommendation, budget: number) => {
    const entry: PortfolioEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      symbol: coin.symbol,
      entryPrice: coin.entry,
      positionUsd: coin.position_usd > 0 ? coin.position_usd : budget * (coin.allocation / 100),
      stopLoss: coin.stop_loss,
      takeProfit: coin.take_profit,
      enteredAt: new Date().toISOString(),
      signal: coin.signal,
    };
    setRawEntries((prev) => [entry, ...prev].slice(0, 50));
  }, []);

  const removeEntry = useCallback((id: string) => {
    setRawEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clearAll = useCallback(() => setRawEntries([]), []);

  const value = useMemo<PortfolioContextValue>(
    () => ({
      entries,
      addEntry,
      removeEntry,
      clearAll,
      totalPnlUsd,
      isRefreshing,
      refreshPrices,
      lastRefreshed,
    }),
    [entries, addEntry, removeEntry, clearAll, totalPnlUsd, isRefreshing, refreshPrices, lastRefreshed]
  );

  return (
    <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>
  );
}

export function usePortfolio() {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error("usePortfolio must be used within PortfolioProvider");
  return ctx;
}