import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CoinRecommendation,
} from "../types";
import { analyzeInvestment, analyzeCoin } from "../lib/api";

type UiPrefs = {
  compactCards: boolean;
  expandChartsByDefault: boolean;
  showPinnedFirst: boolean;
};

interface AnalysisContextValue {
  result: AnalyzeResponse | null;
  setResult: (result: AnalyzeResponse | null) => void;

  lastRequest: AnalyzeRequest | null;
  setLastRequest: (req: AnalyzeRequest | null) => void;

  isLoading: boolean;
  runAnalysis: (req: AnalyzeRequest) => Promise<AnalyzeResponse>;

  lookupCoin: (symbol: string) => Promise<CoinRecommendation>;

  // ⭐ Pinned coins
  pinnedSymbols: string[];
  isPinned: (symbol: string) => boolean;
  togglePinned: (symbol: string) => void;
  clearPinned: () => void;

  // UI prefs (small “premium feel”)
  uiPrefs: UiPrefs;
  setUiPref: <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => void;

  // Helpers
  resetAll: () => void;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

const LS_KEYS = {
  result: "ai-crypto:result:v1",
  lastRequest: "ai-crypto:lastRequest:v1",
  pinned: "ai-crypto:pinned:v1",
  ui: "ai-crypto:ui:v1",
} as const;

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeSymbol(s: string) {
  const t = (s || "").trim().toUpperCase();
  if (!t) return "";
  const cleaned = t.replace("/", "").replace("-", "").replace("_", "");
  if (cleaned.endsWith("USDT")) return cleaned.replace("USDT", "");
  return cleaned;
}

const DEFAULT_UI: UiPrefs = {
  compactCards: false,
  expandChartsByDefault: false,
  showPinnedFirst: true,
};

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [result, setResultState] = useState<AnalyzeResponse | null>(null);
  const [lastRequest, setLastRequestState] = useState<AnalyzeRequest | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);

  const [pinnedSymbols, setPinnedSymbols] = useState<string[]>([]);
  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(DEFAULT_UI);

  // restore from localStorage on mount
  useEffect(() => {
    const restoredResult = safeJsonParse<AnalyzeResponse>(
      localStorage.getItem(LS_KEYS.result)
    );
    const restoredLast = safeJsonParse<AnalyzeRequest>(
      localStorage.getItem(LS_KEYS.lastRequest)
    );
    const restoredPinned = safeJsonParse<string[]>(
      localStorage.getItem(LS_KEYS.pinned)
    );
    const restoredUi = safeJsonParse<Partial<UiPrefs>>(
      localStorage.getItem(LS_KEYS.ui)
    );

    if (restoredResult) setResultState(restoredResult);
    if (restoredLast) setLastRequestState(restoredLast);

    if (Array.isArray(restoredPinned)) {
      const cleaned = restoredPinned.map(normalizeSymbol).filter(Boolean);
      setPinnedSymbols(Array.from(new Set(cleaned)));
    }

    if (restoredUi) {
      setUiPrefs((prev) => ({
        ...prev,
        ...restoredUi,
      }));
    }
  }, []);

  // persist to localStorage
  useEffect(() => {
    try {
      if (result) localStorage.setItem(LS_KEYS.result, JSON.stringify(result));
      else localStorage.removeItem(LS_KEYS.result);
    } catch {}
  }, [result]);

  useEffect(() => {
    try {
      if (lastRequest)
        localStorage.setItem(LS_KEYS.lastRequest, JSON.stringify(lastRequest));
      else localStorage.removeItem(LS_KEYS.lastRequest);
    } catch {}
  }, [lastRequest]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEYS.pinned, JSON.stringify(pinnedSymbols));
    } catch {}
  }, [pinnedSymbols]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEYS.ui, JSON.stringify(uiPrefs));
    } catch {}
  }, [uiPrefs]);

  const setResult = useCallback((value: AnalyzeResponse | null) => {
    setResultState(value);
  }, []);

  const setLastRequest = useCallback((req: AnalyzeRequest | null) => {
    setLastRequestState(req);
  }, []);

  const runAnalysis = useCallback(async (req: AnalyzeRequest) => {
    setIsLoading(true);
    try {
      const data = await analyzeInvestment(req);
      setLastRequestState(req);
      setResultState(data);
      return data;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const lookupCoin = useCallback(
    async (symbol: string) => {
      const sym = normalizeSymbol(symbol);
      if (!sym) throw new Error("Please enter a coin symbol.");

      if (!lastRequest) {
        throw new Error(
          "Run an analysis first, then you can lookup additional coins."
        );
      }

      const res = await analyzeCoin({
        ...lastRequest,
        symbol: sym,
      });

      return res.coin;
    },
    [lastRequest]
  );

  const isPinned = useCallback(
    (symbol: string) => {
      const sym = normalizeSymbol(symbol);
      return pinnedSymbols.includes(sym);
    },
    [pinnedSymbols]
  );

  const togglePinned = useCallback((symbol: string) => {
    const sym = normalizeSymbol(symbol);
    if (!sym) return;

    setPinnedSymbols((prev) => {
      const has = prev.includes(sym);
      if (has) return prev.filter((x) => x !== sym);
      return [sym, ...prev].slice(0, 50); // cap just in case
    });
  }, []);

  const clearPinned = useCallback(() => setPinnedSymbols([]), []);

  const setUiPref = useCallback(
    <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => {
      setUiPrefs((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const resetAll = useCallback(() => {
    setResultState(null);
    setLastRequestState(null);
    setPinnedSymbols([]);
    setUiPrefs(DEFAULT_UI);
    try {
      localStorage.removeItem(LS_KEYS.result);
      localStorage.removeItem(LS_KEYS.lastRequest);
      localStorage.removeItem(LS_KEYS.pinned);
      localStorage.removeItem(LS_KEYS.ui);
    } catch {}
  }, []);

  const value = useMemo<AnalysisContextValue>(
    () => ({
      result,
      setResult,
      lastRequest,
      setLastRequest,
      isLoading,
      runAnalysis,
      lookupCoin,

      pinnedSymbols,
      isPinned,
      togglePinned,
      clearPinned,

      uiPrefs,
      setUiPref,

      resetAll,
    }),
    [
      result,
      setResult,
      lastRequest,
      setLastRequest,
      isLoading,
      runAnalysis,
      lookupCoin,
      pinnedSymbols,
      isPinned,
      togglePinned,
      clearPinned,
      uiPrefs,
      setUiPref,
      resetAll,
    ]
  );

  return (
    <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>
  );
}

export function useAnalysis() {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error("useAnalysis must be used within AnalysisProvider");
  return ctx;
}