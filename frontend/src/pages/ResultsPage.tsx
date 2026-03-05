import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { SkeletonLoader } from "../components/SkeletonLoader";
import { TradingViewChart } from "../components/TradingViewChart";
import { useAnalysis } from "../context/AnalysisContext";
import { useTheme } from "../context/ThemeContext";
import { useAlerts } from "../context/AlertsContext";
import { usePortfolio } from "../context/PortfolioContext";
import type { PortfolioEntryWithPnL } from "../context/PortfolioContext";
import { formatCurrency, formatPercent, formatPrice } from "../utils/format";
import type {
  Signal,
  MacroSource,
  TrendState,
  CoinRecommendation,
  CoinLookupResponse,
} from "../types";
import { analyzeCoin, searchSymbols } from "../lib/api";

function getSignalBadgeVariant(signal: Signal): "buy" | "wait" | "avoid" {
  switch (signal) {
    case "BUY":
      return "buy";
    case "WAIT":
      return "wait";
    case "AVOID":
      return "avoid";
    default:
      return "wait";
  }
}

function getRiskBannerStyles(riskState: string) {
  switch (riskState) {
    case "GREEN":
      return "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200";
    case "YELLOW":
      return "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200";
    case "RED":
      return "bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200";
    default:
      return "bg-neutral-50 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200";
  }
}

function prettySource(source?: MacroSource) {
  if (source === "gdelt") return "GDELT";
  if (source === "rss") return "RSS";
  return "Unknown";
}

function prettyTrend(t: TrendState) {
  if (t === "bull") return "Bull";
  if (t === "bear") return "Bear";
  return "Sideways";
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatLocalTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function truncate(s: string, max = 220) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max).trimEnd() + "…";
}

function RiskDot({ state }: { state: string }) {
  const cls =
    state === "GREEN"
      ? "bg-emerald-500"
      : state === "YELLOW"
      ? "bg-amber-500"
      : state === "RED"
      ? "bg-red-500"
      : "bg-neutral-400";
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} aria-hidden />
  );
}

/** Backend /api/symbols returns BASE symbols (BTC, ETH, ...) */
function normalizeSymbol(s: string) {
  const t = (s || "").trim().toUpperCase();
  if (!t) return "";
  const cleaned = t.replace("/", "").replace("-", "").replace("_", "");
  if (cleaned.endsWith("USDT")) return cleaned.replace("USDT", "");
  return cleaned;
}

type ModalMeta = Omit<CoinLookupResponse, "coin">;

function extractApiErrorMessage(e: unknown): string {
  const anyErr = e as any;
  const detail = anyErr?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;

  const msg = anyErr?.message;
  if (typeof msg === "string" && msg.trim()) return msg;

  return "Could not load that coin right now. Try again.";
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
        {children}
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${valueClassName ?? "text-neutral-900 dark:text-neutral-100"}`}>
        {value}
      </p>
    </div>
  );
}

/* =========================
   FAVORITES (localStorage)
========================= */
const FAVORITES_KEY = "ai_crypto_favorites_symbols_v1";

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => normalizeSymbol(String(x))).filter(Boolean);
  } catch {
    return [];
  }
}

function saveFavorites(items: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

/* =========================
   "WHY THIS SIGNAL" (fixed)
   - removes junk "(, )" leftovers
   - fixes punctuation like ").,."
   - keeps bullets for fib/techScore/etc
========================= */

type WhyExplained = {
  summary: string;
  bullets: string[];
};

function humanizeKey(key: string): string {
  const k = key.trim().toLowerCase();

  if (k.startsWith("fib")) return "Fibonacci";
  if (k.startsWith("fibo")) return "Fibonacci";
  if (k.includes("techscoreadj")) return "Adjusted tech score";
  if (k === "techscore") return "Tech score";
  if (k.includes("trend")) return "Trend";
  if (k.includes("rsi")) return "RSI";
  if (k.includes("atr")) return "Volatility (ATR)";
  if (k.includes("breakout")) return "Breakout setup";
  if (k.includes("pullback")) return "Pullback setup";
  if (k.includes("sr") || k.includes("support") || k.includes("resistance"))
    return "Support/Resistance";

  return key
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Extract parentheticals that contain known tokens (fib/techscore/rsi/atr/trend...) */
function extractTaggedParentheticals(text: string): { cleaned: string; tags: string[] } {
  const tags: string[] = [];
  const re = /\(([^)]*(?:fib|fibo|fibonacci|techscoreadj|techscore|trend|rsi|atr)[^)]*)\)/gi;

  let cleaned = (text || "").replace(re, (_m, inner) => {
    const t = String(inner || "").trim();
    if (t) tags.push(t);
    return " ";
  });

  // remove empty / junk parentheses left behind: (), (,), ( , ), (_, ), etc.
  cleaned = cleaned.replace(/\(\s*[,._-]?\s*\)/g, " ");

  return { cleaned, tags };
}

/** Turn tail tokens like "FibBonus +4, TechScoreAdj 79" into bullets */
function parseKeyValueTokens(tail: string): string[] {
  const parts = (tail || "")
    .split(/[;,]/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const bullets: string[] = [];

  for (const part of parts) {
    const m =
      part.match(/^([a-zA-Z0-9_\-]+)\s*[:=]\s*([+\-]?\d+(\.\d+)?)$/) ||
      part.match(/^([a-zA-Z0-9_\-]+)\s+([+\-]?\d+(\.\d+)?)$/);

    if (!m) continue;

    const key = m[1];
    const val = m[2];
    const label = humanizeKey(key);

    if (label === "Fibonacci") {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        const signed = num > 0 ? `+${num}` : `${num}`;
        bullets.push(`Fibonacci contributed ${signed} points`);
      } else {
        bullets.push(`${label}: ${val}`);
      }
      continue;
    }

    if (key.toLowerCase().includes("adj") || key.toLowerCase().includes("score")) {
      bullets.push(`${label}: ${val}`);
      continue;
    }

    if (val.startsWith("+") || val.startsWith("-")) {
      bullets.push(`${label} contributed ${val} points`);
      continue;
    }

    bullets.push(`${label}: ${val}`);
  }

  return bullets;
}

/** Also scan inline tokens anywhere (handles BTC "old format") */
function scanInlineTokens(text: string): string[] {
  const bullets: string[] = [];
  const seen = new Set<string>();

  const add = (b: string | null) => {
    if (!b) return;
    if (seen.has(b)) return;
    seen.add(b);
    bullets.push(b);
  };

  // Fibonacci bonus/score
  for (const m of text.matchAll(
    /\b(?:fib|fibo|fibonacci)(?:bonus|score)?\s*[:=]?\s*([+\-]?\d+(?:\.\d+)?)\b/gi
  )) {
    const v = Number(m[1]);
    if (Number.isNaN(v)) continue;
    const signed = v > 0 ? `+${v}` : `${v}`;
    add(`Fibonacci contributed ${signed} points`);
  }

  // TechScoreAdj
  for (const m of text.matchAll(/\btechscoreadj(?:usted)?\s*[:=]?\s*(\d+(?:\.\d+)?)\b/gi)) {
    add(`Adjusted tech score: ${Number(m[1]).toFixed(0)}`);
  }

  // TechScore (avoid double-counting techscoreadj)
  for (const m of text.matchAll(/\btechscore\s*[:=]?\s*(\d+(?:\.\d+)?)\b/gi)) {
    add(`Tech score: ${Number(m[1]).toFixed(0)}`);
  }

  // RSI
  for (const m of text.matchAll(/\brsi\s*[:=]?\s*(\d+(?:\.\d+)?)\b/gi)) {
    add(`RSI: ${Number(m[1]).toFixed(0)}`);
  }

  // ATR
  for (const m of text.matchAll(/\batr(?:pct|%)?\s*[:=]?\s*(\d+(?:\.\d+)?)\b/gi)) {
    add(`Volatility (ATR): ${Number(m[1]).toFixed(2)}`);
  }

  // Trend
  for (const m of text.matchAll(/\btrend\s*[:=]?\s*(bull|bear|sideways)\b/gi)) {
    const t = m[1].toLowerCase();
    if (t === "bull") add("Trend: Bullish (momentum favors continuation)");
    else if (t === "bear") add("Trend: Bearish (momentum against longs)");
    else add("Trend: Sideways (range-bound / mixed momentum)");
  }

  return bullets.slice(0, 6);
}

/** Final pass to clean punctuation/spacing after removals */
function tidySummary(text: string): string {
  let s = (text || "");

  s = s.replace(/\s{2,}/g, " "); // collapse spaces
  s = s.replace(/\s+([,.;:!?])/g, "$1"); // no space before punctuation

  // remove duplicated punctuation
  s = s
    .replace(/\.{2,}/g, ".")
    .replace(/,\s*,+/g, ",")
    .replace(/([,.;:])\s*([,.;:])+/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/\.\s*,/g, ".")
    .replace(/\)\s*[,.;:]+/g, ")");

  // remove leftover empty parentheses again (covers "(, )" etc after other ops)
  s = s.replace(/\(\s*[,._-]?\s*\)/g, " ");

  // normalize final whitespace
  s = s.replace(/\s{2,}/g, " ").trim();

  // If we end up with trailing punctuation like ".,", normalize
  s = s.replace(/[,\s]*\.$/, ".").replace(/[,\s]*$/, "");

  return s;
}

/** Remove tokens from summary but keep human text */
function stripInlineTokens(text: string): string {
  return (text || "")
    .replace(/\b(?:fib|fibo|fibonacci)(?:bonus|score)?\s*[:=]?\s*[+\-]?\d+(?:\.\d+)?\b/gi, "")
    .replace(/\btechscoreadj(?:usted)?\s*[:=]?\s*\d+(?:\.\d+)?\b/gi, "")
    .replace(/\btechscore\s*[:=]?\s*\d+(?:\.\d+)?\b/gi, "")
    .replace(/\btrend\s*[:=]?\s*(?:bull|bear|sideways)\b/gi, "")
    .replace(/\brsi\s*[:=]?\s*\d+(?:\.\d+)?\b/gi, "")
    .replace(/\batr(?:pct|%)?\s*[:=]?\s*\d+(?:\.\d+)?\b/gi, "");
}

function explainWhy(reasonRaw: string): WhyExplained {
  const raw = (reasonRaw || "").trim();
  if (!raw) return { summary: "", bullets: [] };

  // 1) pull tagged parentheticals (anywhere)
  const { cleaned, tags } = extractTaggedParentheticals(raw);

  // 2) bullets from tag groups + inline scan
  const bulletsFromTags = tags.flatMap(parseKeyValueTokens);
  const bulletsFromInline = scanInlineTokens(raw);

  const bullets: string[] = [];
  const seen = new Set<string>();
  for (const b of [...bulletsFromTags, ...bulletsFromInline]) {
    if (!b) continue;
    if (seen.has(b)) continue;
    seen.add(b);
    bullets.push(b);
    if (bullets.length >= 6) break;
  }

  // 3) summary: remove extracted groups + inline tokens
  const summary = tidySummary(stripInlineTokens(cleaned)) || tidySummary(cleaned) || tidySummary(raw);

  return { summary, bullets };
}

/* =========================
   RESULTS PAGE
========================= */

export function ResultsPage() {
  const navigate = useNavigate();
  const { result, lastRequest, isLoading, runAnalysis } = useAnalysis();
  const { isDark, toggleTheme } = useTheme();
  const { addAlert, notificationsEnabled, requestNotifications } = useAlerts();
  const { addEntry, removeEntry, entries: portfolioEntries } = usePortfolio();
  const typedPortfolioEntries = portfolioEntries as PortfolioEntryWithPnL[];

  const [openSymbol, setOpenSymbol] = useState<string | null>(null);
  const [showFullRiskReason, setShowFullRiskReason] = useState(false);

  // Auto-refresh
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [secondsSince, setSecondsSince] = useState(0);
  const AUTO_REFRESH_SECONDS = 300; // 5 min

  // Alert panel
  const [alertPanel, setAlertPanel] = useState<{ symbol: string; price: number } | null>(null);
  const [alertTarget, setAlertTarget] = useState("");
  const [alertDirection, setAlertDirection] = useState<"above" | "below">("above");

  // Search
  const [query, setQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [remoteSuggestions, setRemoteSuggestions] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchReqId = useRef(0);

  // Scroll-to-coin refs
  const coinRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [showScrollTop, setShowScrollTop] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Modal (lookup)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSymbol, setModalSymbol] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalCoin, setModalCoin] = useState<CoinRecommendation | null>(null);
  const [modalMeta, setModalMeta] = useState<ModalMeta | null>(null);

  // Favorites
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  useEffect(() => {
    if (!result) navigate("/", { replace: true });
  }, [result, navigate]);

  useEffect(() => {
    const onScroll = () => {
      const next = window.scrollY > 450;
      setShowScrollTop((prev) => (prev === next ? prev : next));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [modalOpen]);

  useEffect(() => {
    saveFavorites(favorites);
    // Auto-exit favorites-only view when last favorite is removed
    if (favorites.length === 0 && showFavoritesOnly) {
      setShowFavoritesOnly(false);
    }
  }, [favorites, showFavoritesOnly]);

  const sortedCoins = useMemo(() => {
    if (!result) return [];
    return [...result.coins].sort((a, b) => b.allocation - a.allocation);
  }, [result]);

  // These must all be declared before any early return to satisfy Rules of Hooks
  const favoritesSet = useMemo(() => new Set(favorites), [favorites]);

  const listToShow = useMemo(() => {
    if (!showFavoritesOnly) return sortedCoins;
    return sortedCoins.filter((c) => favoritesSet.has(normalizeSymbol(c.symbol)));
  }, [sortedCoins, showFavoritesOnly, favoritesSet]);

  const favoritesCountInList = useMemo(() => {
    return sortedCoins.reduce(
      (acc, c) => acc + (favoritesSet.has(normalizeSymbol(c.symbol)) ? 1 : 0),
      0
    );
  }, [sortedCoins, favoritesSet]);

  const queryUpper = query.trim().toUpperCase();

  // Debounced remote search
  useEffect(() => {
    const q = queryUpper;

    if (!q) {
      setRemoteSuggestions([]);
      setIsSearching(false);
      return;
    }

    const id = ++searchReqId.current;
    setIsSearching(true);

    const t = window.setTimeout(async () => {
      try {
        const items = await searchSymbols(q, 20);
        if (searchReqId.current === id) {
          const cleaned = (items ?? []).map(normalizeSymbol).filter(Boolean);
          setRemoteSuggestions(cleaned);
        }
      } catch {
        if (searchReqId.current === id) setRemoteSuggestions([]);
      } finally {
        if (searchReqId.current === id) setIsSearching(false);
      }
    }, 220);

    return () => window.clearTimeout(t);
  }, [queryUpper]);

  const suggestions = useMemo(() => {
    const local = sortedCoins.map((c) => c.symbol);

    const localFiltered = queryUpper
      ? local.filter((s) => s.toUpperCase().includes(queryUpper))
      : local.slice(0, 8);

    const merged = [...localFiltered, ...remoteSuggestions]
      .map((s) => normalizeSymbol(s))
      .filter(Boolean);

    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const s of merged) {
      if (!seen.has(s)) {
        seen.add(s);
        uniq.push(s);
      }
      if (uniq.length >= 10) break;
    }
    return uniq;
  }, [sortedCoins, queryUpper, remoteSuggestions]);

  const openAndScrollTo = (symbol: string) => {
    setOpenSymbol(symbol);
    setShowSuggestions(false);

    window.setTimeout(() => {
      const el = coinRefs.current[symbol];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const openCoinModal = async (symbol: string) => {
    const sym = normalizeSymbol(symbol);

    setShowSuggestions(false);
    setModalOpen(true);
    setModalSymbol(sym);
    setModalLoading(true);
    setModalError(null);
    setModalCoin(null);
    setModalMeta(null);

    try {
      if (!lastRequest) {
        throw new Error("Run an analysis first, then you can lookup additional coins.");
      }

      const res = await analyzeCoin({
        ...lastRequest,
        symbol: sym,
      });

      setModalCoin(res.coin);
      const { coin, ...meta } = res;
      setModalMeta(meta);
    } catch (e) {
      setModalError(extractApiErrorMessage(e));
    } finally {
      setModalLoading(false);
    }
  };

  const handleSuggestionClick = (s: string) => {
    const sym = normalizeSymbol(s);
    const isInTop = sortedCoins.some((c) => c.symbol.toUpperCase() === sym);
    if (isInTop) openAndScrollTo(sym);
    else openCoinModal(sym);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (suggestions.length === 0) return;
    handleSuggestionClick(suggestions[0]);
  };

  const clearSearch = () => {
    setQuery("");
    setRemoteSuggestions([]);
    setShowSuggestions(false);
  };

  const isFavorite = (sym: string) => favorites.includes(normalizeSymbol(sym));

  const toggleFavorite = (symRaw: string) => {
    const sym = normalizeSymbol(symRaw);
    if (!sym) return;

    setFavorites((prev) => {
      const has = prev.includes(sym);
      const next = has ? prev.filter((x) => x !== sym) : [...prev, sym];
      return next;
    });
  };

  // ── Auto-refresh countdown ───────────────────────────────────────────────
  useEffect(() => {
    if (!result) return;
    const interval = setInterval(() => {
      setSecondsSince((s) => {
        if (s + 1 >= AUTO_REFRESH_SECONDS) {
          handleRefresh();
          return 0;
        }
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, lastRequest]);

  const handleRefresh = useCallback(async () => {
    if (!lastRequest || isRefreshing) return;
    setIsRefreshing(true);
    setSecondsSince(0);
    try {
      await runAnalysis(lastRequest);
      if (mountedRef.current) setLastRefreshed(new Date());
    } catch {}
    finally {
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, [lastRequest, isRefreshing, runAnalysis]);

  // ── Portfolio helpers ────────────────────────────────────────────────────
  const isInPortfolio = (sym: string) =>
    typedPortfolioEntries.some((e) => e.symbol === normalizeSymbol(sym));

  const togglePortfolio = (coin: CoinRecommendation) => {
    const sym = normalizeSymbol(coin.symbol);
    if (isInPortfolio(sym)) {
      const entry = typedPortfolioEntries.find((e) => e.symbol === sym);
      if (entry) removeEntry(entry.id);
    } else {
      addEntry(coin, budget);
    }
  };

  // ── Alert helpers ────────────────────────────────────────────────────────
  const openAlertPanel = (symbol: string, price: number) => {
    setAlertPanel({ symbol, price });
    setAlertTarget(price.toFixed(2));
    setAlertDirection("above");
  };

  const submitAlert = () => {
    if (!alertPanel) return;
    const target = parseFloat(alertTarget);
    if (isNaN(target) || target <= 0) return;
    addAlert(alertPanel.symbol, target, alertDirection);
    setAlertPanel(null);
  };

  if (isLoading || !result) {
    return (
      <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 px-4 py-10 transition-colors">
        <div className="mx-auto max-w-2xl">
          <SkeletonLoader />
        </div>
      </div>
    );
  }

  const {
    risk_state,
    risk_reason,
    risk_multiplier,
    budget,
    coins,
    macro_risk,
    macro_source,
    macro_cached,
    macro_updated_at,
    warnings = [],   // ← safe default: never undefined
  } = result;

  const isDefensiveZero = Number(risk_multiplier ?? 1) === 0;
  const minutesUntilRefresh = Math.ceil((AUTO_REFRESH_SECONDS - secondsSince) / 60);

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 pb-24 transition-colors duration-200">
      <div className="mx-auto max-w-6xl px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate("/")}
              className="-ml-2"
              aria-label="Back to input"
              leftIcon={
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              }
            >
              Back
            </Button>

            {/* Dark mode toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-2.5 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
              aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            >
              {isDark ? (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-3xl font-semibold text-neutral-900 dark:text-neutral-50 tracking-tight">
                Portfolio Analysis
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  Macro-aware technical recommendations with risk-managed sizing.
                </p>
                {/* Refresh status */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {lastRefreshed ? `Updated ${lastRefreshed.toLocaleTimeString()}` : "Live"} · refreshes in {minutesUntilRefresh}m
                  </span>
                  <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                    title="Refresh now"
                  >
                    <svg className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {isRefreshing ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
              </div>
            </div>

            {/* Search */}
            <div className="relative w-full lg:w-[460px]">
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setShowSuggestions(true);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => window.setTimeout(() => setShowSuggestions(false), 120)}
                  placeholder="Search & open coin symbol (e.g., BTC, ETH, SOL)…"
                  className="w-full rounded-2xl border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-4 py-3 pr-24 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:border-neutral-500 dark:focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-500/20"
                  aria-label="Search coin"
                />

                {query.trim().length > 0 && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={clearSearch}
                    className="absolute right-14 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-neutral-400 hover:text-neutral-700"
                    aria-label="Clear search"
                    title="Clear"
                  >
                    ✕
                  </button>
                )}

                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-400">
                  {isSearching ? "Searching…" : ""}
                </div>
              </div>

              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute z-20 mt-2 w-full rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-sm overflow-hidden">
                  {suggestions.map((s) => {
                    const sym = normalizeSymbol(s);
                    const isTop = sortedCoins.some((c) => c.symbol.toUpperCase() === sym);

                    return (
                      <button
                        key={sym}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleSuggestionClick(sym)}
                        className="w-full text-left px-4 py-2.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700"
                      >
                        <span className="font-semibold text-neutral-900 dark:text-neutral-100">{sym}</span>
                        <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                          {isTop ? "Jump to recommended" : "Open coin overview"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowFavoritesOnly((v) => !v)}
                disabled={favorites.length === 0 && !showFavoritesOnly}
                title={favorites.length === 0 && !showFavoritesOnly ? "Favorite at least one coin to use this filter." : undefined}
              >
                {showFavoritesOnly
                  ? "Show All"
                  : `Show Favorites${favorites.length ? ` (${favorites.length})` : ""}`}
              </Button>

              <Button size="sm" variant="secondary" onClick={() => navigate("/")}>
                New analysis
              </Button>
            </div>
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Sidebar */}
          <aside className="lg:col-span-4 space-y-6">
            <div
              className={`rounded-3xl border px-5 py-4 ${getRiskBannerStyles(risk_state)}`}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide">Market Risk</p>
                  <div className="mt-1 flex items-center gap-2">
                    <RiskDot state={risk_state} />
                    <p className="text-base font-semibold">{risk_state}</p>
                  </div>
                </div>

                <div className="shrink-0 text-xs font-medium opacity-90">
                  x{Number(risk_multiplier ?? 1).toFixed(2)}
                </div>
              </div>

              <p className="mt-3 text-sm opacity-90 leading-relaxed">
                {showFullRiskReason ? risk_reason : truncate(risk_reason, 220)}
              </p>

              {risk_reason?.length > 220 && (
                <button
                  type="button"
                  className="mt-2 text-xs underline opacity-90 hover:opacity-100"
                  onClick={() => setShowFullRiskReason((v) => !v)}
                >
                  {showFullRiskReason ? "Show less" : "Show more"}
                </button>
              )}

              {isDefensiveZero && (
                <div className="mt-3 rounded-2xl border border-red-200 dark:border-red-800 bg-white/70 dark:bg-red-950/50 px-3 py-2 text-xs text-red-800 dark:text-red-200">
                  <span className="font-semibold">No positions allocated.</span>{" "}
                  Macro risk is <span className="font-semibold">RED</span>, so sizing is{" "}
                  <span className="font-semibold">$0</span> to protect capital.
                </div>
              )}
            </div>

            <Card className="relative">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Macro Signal</h2>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Source: {prettySource(macro_source)} • {macro_cached ? "cached" : "fresh"}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">Score</p>
                  <p className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    {clamp(macro_risk ?? 0, 0, 100)}/100
                  </p>
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Updated</p>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {formatLocalTime(macro_updated_at)}{" "}
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    ({macro_cached ? "cached" : "fresh"})
                  </span>
                </p>
              </div>

              {warnings?.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">Warnings</p>
                  <div className="flex flex-wrap gap-2">
                    {warnings.map((w, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1 text-xs text-neutral-700 dark:text-neutral-300"
                      >
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">Portfolio Summary</h2>

              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Budget</p>
                <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{formatCurrency(budget)}</p>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">Coins shown</p>
                  <p className="font-semibold text-neutral-900 dark:text-neutral-100">{coins.length}</p>
                </div>

                <div className="rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">Risk multiplier</p>
                  <p className="font-semibold text-neutral-900 dark:text-neutral-100">
                    {Number(risk_multiplier ?? 1).toFixed(2)}x
                  </p>
                </div>
              </div>
            </Card>

            {/* Tracked positions mini-summary */}
            {typedPortfolioEntries.length > 0 && (
              <Card>
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
                  Tracked Positions ({typedPortfolioEntries.length})
                </h2>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {typedPortfolioEntries.map((e) => (
                    <div key={e.id} className="flex items-center justify-between rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2">
                      <div className="min-w-0">
                        <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">{e.symbol}</span>
                        <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">{formatCurrency(e.positionUsd)}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {e.pnlUsd !== null ? (
                          <span className={`text-xs font-semibold ${e.pnlUsd >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                            {e.pnlUsd >= 0 ? "+" : ""}{formatCurrency(e.pnlUsd)}
                          </span>
                        ) : <span className="text-xs text-neutral-400">{isRefreshing ? "…" : "Unavailable"}</span>}
                        <button
                          type="button"
                          onClick={() => removeEntry(e.id)}
                          className="rounded-md p-1 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                          aria-label="Remove position"
                          title="Remove"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </aside>

          {/* Main */}
          <main className="lg:col-span-8">
            <div className="flex items-end justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {showFavoritesOnly ? "Favorite Coins" : "Recommended Coins"}
                </h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {showFavoritesOnly
                    ? "Only coins you favorited. Turn off to see the full list."
                    : "Sorted by allocation (highest first). Favorite coins to filter them later."}
                </p>
              </div>

              <div className="hidden sm:flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1 text-xs text-neutral-700 dark:text-neutral-300">
                <span className="font-semibold">{listToShow.length}</span> items
              </div>
            </div>

            {showFavoritesOnly && favorites.length > 0 && listToShow.length === 0 && (
              <div className="rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-sm text-neutral-700 dark:text-neutral-300">
                None of your favorite coins are in this recommendation set.
              </div>
            )}

            <div className="space-y-4">
              {listToShow.map((coin) => (
                <MemoCoinCard
                  key={coin.symbol}
                  coin={coin}
                  isFavorite={isFavorite(coin.symbol)}
                  toggleFavorite={toggleFavorite}
                  openSymbol={openSymbol}
                  setOpenSymbol={setOpenSymbol}
                  coinRefs={coinRefs}
                  timeframe={lastRequest?.timeframe}
                  onAddToPortfolio={() => togglePortfolio(coin)}
                  isInPortfolio={isInPortfolio(coin.symbol)}
                  onSetAlert={() => openAlertPanel(coin.symbol, coin.entry)}
                />
              ))}
            </div>
          </main>
        </div>
      </div>

      {showScrollTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-6 z-30 rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-900 dark:text-neutral-100 shadow-sm hover:bg-neutral-50 dark:hover:bg-neutral-700"
          aria-label="Scroll to top"
        >
          ↑ Top
        </button>
      )}

      {/* Disclaimer + copyright */}
      <footer className="mt-8 border-t border-neutral-200 dark:border-neutral-800 py-5 text-center">
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          Not financial advice. This tool is for educational purposes and structured decision support only. Always do your own research.
        </p>
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          &copy; {new Date().getFullYear()} Murad Abdullayev. All rights reserved.
        </p>
      </footer>

      {/* Price Alert Panel */}
      {alertPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setAlertPanel(null); }}>
          <div className="absolute inset-0 bg-neutral-900/40" />
          <div className="relative w-full max-w-sm">
            <Card className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  Set Price Alert — {alertPanel.symbol}
                </h3>
                <button type="button" onClick={() => setAlertPanel(null)}
                  className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700">✕</button>
              </div>
              {!notificationsEnabled && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  Browser notifications are off.{" "}
                  <button type="button" onClick={requestNotifications} className="underline font-semibold">Enable them</button>
                  {" "}to get notified when the price is hit.
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Target price (USD)</label>
                <input type="number" value={alertTarget} onChange={(e) => setAlertTarget(e.target.value)} step="any"
                  className="w-full rounded-xl border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-4 py-2.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-500/20" />
              </div>
              <div className="flex gap-2">
                {(["above", "below"] as const).map((dir) => (
                  <button key={dir} type="button" onClick={() => setAlertDirection(dir)}
                    className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                      alertDirection === dir
                        ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-neutral-900 dark:border-neutral-100"
                        : "bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                    }`}>
                    {dir === "above" ? "↑ Above" : "↓ Below"}
                  </button>
                ))}
              </div>
              <Button onClick={submitAlert} fullWidth>Set Alert</Button>
            </Card>
          </div>
        </div>
      )}

      {/* Lookup Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-neutral-900/40" />

          <div className="relative w-full max-w-2xl">
            <Card className="relative flex h-[88vh] flex-col overflow-hidden">
              <div className="sticky top-0 z-10 border-b border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 backdrop-blur px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">Coin overview</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
                        {modalSymbol ?? "—"}
                      </h3>

                      {modalCoin && (
                        <>
                          <Badge variant={getSignalBadgeVariant(modalCoin.signal)}>
                            {modalCoin.signal}
                          </Badge>
                          <Badge variant="neutral" size="sm" withDot={false}>
                            Trend: {prettyTrend(modalCoin.metrics?.trend_state ?? "sideways")}
                          </Badge>
                          <Badge variant="neutral" size="sm" withDot={false}>
                            TechScore: {Math.round(modalCoin.tech_score ?? 0)}
                          </Badge>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {modalSymbol && (
                      <button
                        type="button"
                        onClick={() => toggleFavorite(modalSymbol)}
                        className={`inline-flex items-center rounded-2xl border px-3 py-2 text-sm font-semibold ${
                          isFavorite(modalSymbol)
                            ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-neutral-900 dark:border-neutral-100"
                            : "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-700 border-neutral-200 dark:border-neutral-700"
                        }`}
                        aria-label={isFavorite(modalSymbol) ? "Unfavorite coin" : "Favorite coin"}
                        title={isFavorite(modalSymbol) ? "Favorited" : "Favorite"}
                      >
                        {isFavorite(modalSymbol) ? "Favorited" : "Favorite"}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setModalOpen(false)}
                      className="rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4 pb-10 overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]">
                {modalLoading && <SkeletonLoader />}

                {!modalLoading && modalError && (
                  <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-200">
                    {modalError}
                  </div>
                )}

                {!modalLoading && !modalError && modalCoin && (
                  <div className="space-y-5">
                    <div>
                      <SectionTitle>Live chart</SectionTitle>
                      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                        BINANCE {lastRequest?.timeframe ? `• ${lastRequest.timeframe}` : ""}
                      </p>

                      <div className="mt-3 relative h-[320px] w-full overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900">
                        <TradingViewChart
                          symbol={modalCoin.symbol}
                          timeframe={lastRequest?.timeframe}
                          height={320}
                          theme="light"
                        />
                      </div>
                    </div>

                    {modalMeta && (
                      <div className={`rounded-3xl border px-4 py-3 ${getRiskBannerStyles(modalMeta.risk_state)}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold uppercase tracking-wide">
                              Market Risk
                            </p>
                            <div className="mt-1 flex items-center gap-2">
                              <RiskDot state={modalMeta.risk_state} />
                              <p className="text-sm font-semibold">{modalMeta.risk_state}</p>
                            </div>
                          </div>

                          <div className="shrink-0 text-xs font-medium opacity-90">
                            x{Number(modalMeta.risk_multiplier ?? 1).toFixed(2)}
                          </div>
                        </div>

                        <p className="mt-2 text-sm opacity-90 leading-relaxed">{modalMeta.risk_reason}</p>

                        <p className="mt-2 text-xs opacity-80">
                          Source: {prettySource(modalMeta.macro_source)} • Score:{" "}
                          {clamp(modalMeta.macro_risk ?? 0, 0, 100)}/100 • Updated:{" "}
                          {formatLocalTime(modalMeta.macro_updated_at)}
                        </p>

                        {modalMeta.warnings?.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {modalMeta.warnings.slice(0, 6).map((w, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center rounded-full border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1 text-xs text-neutral-700 dark:text-neutral-300"
                              >
                                {w}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <SectionTitle>Key levels</SectionTitle>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
                        <StatCard label="Entry" value={formatPrice(modalCoin.entry)} />
                        <StatCard
                          label="Stop Loss"
                          value={formatPrice(modalCoin.stop_loss)}
                          valueClassName="text-red-600"
                        />
                        <StatCard
                          label="Take Profit"
                          value={formatPrice(modalCoin.take_profit)}
                          valueClassName="text-emerald-600"
                        />
                      </div>
                    </div>

                    <div>
                      <SectionTitle>Position & risk</SectionTitle>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
                        <StatCard label="Position size" value={formatCurrency(modalCoin.position_usd ?? 0)} />
                        <StatCard label="Max loss (est.)" value={formatCurrency(modalCoin.max_loss_usd ?? 0)} />
                        <StatCard label="Risk (% of budget)" value={`${(modalCoin.risk_pct_budget ?? 0).toFixed(3)}%`} />
                        <StatCard label="Entry distance" value={`${((modalCoin.entry_distance_pct ?? 0) * 100).toFixed(2)}%`} />
                      </div>
                    </div>

                    {modalCoin.metrics && (
                      <div>
                        <SectionTitle>Market structure</SectionTitle>
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
                          <StatCard
                            label="Support / Resistance"
                            value={`${formatPrice(modalCoin.metrics.support)} / ${formatPrice(modalCoin.metrics.resistance)}`}
                          />
                          <StatCard
                            label="Close (prev)"
                            value={`${formatPrice(modalCoin.metrics.close)} (${formatPrice(modalCoin.metrics.prev_close)})`}
                          />
                          <div className="sm:col-span-2">
                            <StatCard
                              label="EMAs (20 / 50 / 200)"
                              value={`${formatPrice(modalCoin.metrics.ema20)} / ${formatPrice(modalCoin.metrics.ema50)} / ${formatPrice(modalCoin.metrics.ema200)}`}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {modalCoin.reason && (
                      <div className="rounded-3xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3">
                        <SectionTitle>Why this signal</SectionTitle>

                        {(() => {
                          const explained = explainWhy(modalCoin.reason);
                          return (
                            <>
                              <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
                                {explained.summary}
                              </p>

                              {explained.bullets.length > 0 && (
                                <ul className="mt-3 space-y-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                                  {explained.bullets.map((b, i) => (
                                    <li key={i} className="flex gap-2">
                                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400" />
                                      <span>{b}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================
   COIN CARD (TOP-LEVEL!)
========================= */

type CoinCardProps = {
  coin: CoinRecommendation;
  isFavorite: boolean;
  toggleFavorite: (sym: string) => void;
  openSymbol: string | null;
  setOpenSymbol: (sym: string | null) => void;
  coinRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  timeframe?: string;
  onAddToPortfolio: () => void;
  isInPortfolio: boolean;
  onSetAlert: () => void;
};

function CoinCard({
  coin,
  isFavorite,
  toggleFavorite,
  openSymbol,
  setOpenSymbol,
  coinRefs,
  timeframe,
  onAddToPortfolio,
  isInPortfolio,
  onSetAlert,
}: CoinCardProps) {
  const isOpen = openSymbol === coin.symbol;

  const entryDistPct = (coin.entry_distance_pct ?? 0) * 100;
  const entryDistWarn = entryDistPct >= 1.5;
  const entryDistClass = entryDistWarn ? "text-amber-700 dark:text-amber-400" : "text-neutral-900 dark:text-neutral-100";

  const trendState = coin.metrics?.trend_state ?? "sideways";
  const rsi = coin.metrics?.rsi;
  const atrPct = coin.metrics?.atr_pct;

  const explained = useMemo(() => explainWhy(coin.reason || ""), [coin.reason]);

  return (
    <div
      ref={(el) => {
        coinRefs.current[coin.symbol] = el;
      }}
    >
      <Card className={`${isOpen ? "ring-1 ring-neutral-200" : ""}`}>
        <div className="w-full text-left">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{coin.symbol}</span>

                <Badge variant={getSignalBadgeVariant(coin.signal)}>{coin.signal}</Badge>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="neutral" size="sm" withDot={false}>
                    Trend: {prettyTrend(trendState)}
                  </Badge>
                  <Badge variant="neutral" size="sm" withDot={false}>
                    TechScore: {Math.round(coin.tech_score ?? 0)}
                  </Badge>
                </div>
              </div>

              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                RSI: {rsi !== undefined ? Math.round(rsi) : "—"} • ATR%:{" "}
                {atrPct !== undefined ? (atrPct * 100).toFixed(2) : "—"}% • Entry distance:{" "}
                <span className={entryDistClass}>
                  {entryDistPct.toFixed(2)}%{entryDistWarn ? " (high)" : ""}
                </span>
              </p>
            </div>

            <div className="shrink-0 sm:text-right">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Allocation</p>
              <p className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                {formatPercent(coin.allocation)}
              </p>

              <div className="mt-2 flex flex-wrap gap-2 sm:justify-end">
                <button
                  type="button"
                  onClick={() => toggleFavorite(coin.symbol)}
                  className={`inline-flex items-center rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                    isFavorite
                      ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-neutral-900 dark:border-neutral-100"
                      : "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-700 border-neutral-200 dark:border-neutral-700"
                  }`}
                  aria-label={isFavorite ? "Unfavorite coin" : "Favorite coin"}
                >
                  {isFavorite ? "Favorited" : "Favorite"}
                </button>
                <button
                  type="button"
                  onClick={onAddToPortfolio}
                  className={`inline-flex items-center rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                    isInPortfolio
                      ? "bg-emerald-600 text-white border-emerald-600"
                      : "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-700 border-neutral-200 dark:border-neutral-700"
                  }`}
                  aria-label="Track position"
                >
                  {isInPortfolio ? "✓ Tracked" : "+ Track"}
                </button>
                <button
                  type="button"
                  onClick={onSetAlert}
                  className="inline-flex items-center rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-900 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition"
                  aria-label="Set price alert"
                  title="Set price alert"
                >
                  🔔
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
            <StatCard label="Entry" value={formatPrice(coin.entry)} />
            <StatCard label="Stop Loss" value={formatPrice(coin.stop_loss)} valueClassName="text-red-600" />
            <StatCard label="Take Profit" value={formatPrice(coin.take_profit)} valueClassName="text-emerald-600" />
          </div>

          {coin.reason && (
            <div className="mt-4 rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3">
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">Why this signal</p>
              <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">{explained.summary}</p>

              {explained.bullets.length > 0 && (
                <ul className="mt-3 space-y-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                  {explained.bullets.map((b, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Details include sizing, max loss, indicators — plus a live chart.
            </p>

            <button
              type="button"
              onClick={() => setOpenSymbol(isOpen ? null : coin.symbol)}
              className="inline-flex items-center gap-2 rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-900 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-700"
              aria-expanded={isOpen}
            >
              {isOpen ? "Hide details" : "Show details"}
              <svg
                className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        {isOpen && (
          <div className="mt-4 border-t border-neutral-200 dark:border-neutral-700 pt-4 space-y-4">
            <div>
              <p className="mb-2 text-xs font-semibold text-neutral-700 dark:text-neutral-300">
                Live chart (BINANCE)
                <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                  {timeframe ? `• ${timeframe}` : ""}
                </span>
              </p>

              <div className="relative h-[320px] w-full overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900">
                <TradingViewChart symbol={coin.symbol} timeframe={timeframe} height={320} theme="light" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
              <StatCard label="Position size" value={formatCurrency(coin.position_usd ?? 0)} />
              <StatCard label="Max loss (est.)" value={formatCurrency(coin.max_loss_usd ?? 0)} />
              <StatCard label="Risk (% of budget)" value={`${(coin.risk_pct_budget ?? 0).toFixed(3)}%`} />
              <StatCard
                label="Entry distance"
                value={`${entryDistPct.toFixed(2)}%${entryDistWarn ? " (high)" : ""}`}
                valueClassName={entryDistWarn ? "text-amber-700 dark:text-amber-400" : "text-neutral-900 dark:text-neutral-100"}
              />
            </div>

            {coin.metrics && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
                <StatCard
                  label="Support / Resistance"
                  value={`${formatPrice(coin.metrics.support)} / ${formatPrice(coin.metrics.resistance)}`}
                />
                <StatCard
                  label="Close (prev)"
                  value={`${formatPrice(coin.metrics.close)} (${formatPrice(coin.metrics.prev_close)})`}
                />
                <div className="sm:col-span-2">
                  <StatCard
                    label="EMAs (20 / 50 / 200)"
                    value={`${formatPrice(coin.metrics.ema20)} / ${formatPrice(coin.metrics.ema50)} / ${formatPrice(
                      coin.metrics.ema200
                    )}`}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

const MemoCoinCard = React.memo(CoinCard);