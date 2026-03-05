from __future__ import annotations

import asyncio
import os
import json
from datetime import datetime, timedelta
from fastapi import FastAPI, Query, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Literal, List, Dict, Any, Tuple, Optional

import httpx
import numpy as np
import pandas as pd
import feedparser
import re

# ── Rate limiting (simple in-memory, per-IP) ─────────────────────────────────
from collections import defaultdict
import time as _time

_RATE_LIMIT_WINDOW = 60          # seconds
_RATE_LIMIT_MAX    = 10          # requests per window per IP
_rate_counters: Dict[str, List[float]] = defaultdict(list)

def _check_rate_limit(ip: str) -> None:
    now = _time.monotonic()
    window_start = now - _RATE_LIMIT_WINDOW
    hits = _rate_counters[ip]
    # Evict old hits
    _rate_counters[ip] = [t for t in hits if t > window_start]
    if len(_rate_counters[ip]) >= _RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Too many requests. Please wait a moment.")
    _rate_counters[ip].append(now)

# ── Concurrency guard: max 6 simultaneous Binance kline fetches ───────────────
_BINANCE_SEM = asyncio.Semaphore(6)

app = FastAPI()

# ============================================================
# .env loader (no dependency)
# - Fixes "Gemini worked before, now doesn't" when env isn't loaded
# - It ONLY sets vars that are currently missing.
# ============================================================
def _load_dotenv_simple(path: str = ".env") -> None:
    try:
        if not os.path.exists(path):
            return
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and (k not in os.environ or not os.environ.get(k)):
                    os.environ[k] = v
    except Exception:
        return


_load_dotenv_simple(".env")
_load_dotenv_simple("backend/.env")
_load_dotenv_simple("aicrypto/backend/.env")

# -----------------------------
# CORS (local + deploy-friendly)
# -----------------------------
_default_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
_env_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
ALLOWED_ORIGINS = _env_origins if _env_origins else _default_origins

if not _env_origins:
    import warnings as _warnings
    _warnings.warn(
        "CORS_ORIGINS env var is not set. Defaulting to localhost:5173. "
        "Set CORS_ORIGINS in your .env for production.",
        RuntimeWarning,
        stacklevel=1,
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Risk = Literal["low", "medium", "high"]
Timeframe = Literal["15m", "1h", "4h", "1d"]
Strategy = Literal["pullback", "breakout"]

# -----------------------------
# CONFIG
# -----------------------------
APP_VERSION = "0.2.11"

COIN_UNIVERSE = [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "DOTUSDT",
    "LTCUSDT",
    "TRXUSDT",
    "TONUSDT",
    "ARBUSDT",
    "OPUSDT",
    "APTUSDT",
    "INJUSDT",
    "ATOMUSDT",
]

BUY_SCORE = 75
WAIT_SCORE = 60
YELLOW_BUY_MIN_SCORE = 82
RED_BTC_ETH_STRONG_MIN_SCORE = 90

MAX_ENTRY_DISTANCE_PCT = 0.015
MIN_ATR_PCT = 0.0015
MAX_ATR_PCT = 0.08

RISK_BUDGET_PCT = {
    "low": 0.010,
    "medium": 0.020,
    "high": 0.035,
}

# -----------------------------
# Fib / Structure Confluence
# -----------------------------
FIB_PIVOT_L = int(os.getenv("FIB_PIVOT_L", "3"))
FIB_MIN_SWING_PCT_FLOOR = float(os.getenv("FIB_MIN_SWING_PCT_FLOOR", "0.01"))  # 1%
FIB_SWING_ATR_MULT = float(os.getenv("FIB_SWING_ATR_MULT", "1.5"))
FIB_NEAR_THRESH_BY_TF = {
    "15m": 0.0035,
    "1h": 0.0035,
    "4h": 0.0060,
    "1d": 0.0060,
}
FIB_BONUS_MAX = 12.0

# -----------------------------
# Gemini (macro judge)
# IMPORTANT: support multiple env var names to avoid "it worked before"
# -----------------------------
def _first_nonempty(*names: str) -> str:
    for n in names:
        v = (os.getenv(n, "") or "").strip()
        if v:
            return v
    return ""


GEMINI_API_KEY = _first_nonempty(
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GENAI_API_KEY",
)
GEMINI_MODEL = (os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite") or "").strip()

_GEMINI_MACRO_CACHE: Dict[str, Any] = {"ts": None, "out": None}
_GEMINI_MACRO_TTL = timedelta(minutes=8)
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

# ============================================================
# Models
# ============================================================
class AnalyzeRequest(BaseModel):
    budget: float = Field(gt=0)
    risk: Risk
    timeframe: Timeframe
    strategy: Strategy


class CoinLookupRequest(AnalyzeRequest):
    symbol: str = Field(min_length=2, max_length=24)


class CoinMetrics(BaseModel):
    close: float
    prev_close: float
    ema20: float
    ema50: float
    ema200: float
    rsi: float
    atr: float
    atr_pct: float
    support: float
    resistance: float
    trend_state: Literal["bull", "bear", "sideways"]

    fib_valid: bool = False
    fib_direction: Optional[Literal["up", "down"]] = None
    fib_swing_low: Optional[float] = None
    fib_swing_high: Optional[float] = None
    fib_levels: Optional[Dict[str, float]] = None


class CoinPlan(BaseModel):
    symbol: str
    allocation: float
    signal: Literal["BUY", "WAIT", "AVOID"]
    entry: float
    stop_loss: float
    take_profit: float
    reason: str

    tech_score: float
    entry_distance_pct: float
    position_usd: float
    max_loss_usd: float
    risk_pct_budget: float
    metrics: CoinMetrics


class AnalyzeResponse(BaseModel):
    risk_state: Literal["GREEN", "YELLOW", "RED"]
    risk_reason: str
    risk_multiplier: float
    budget: float
    timeframe: str
    strategy: str
    coins: List[CoinPlan]

    macro_risk: int
    macro_source: Literal["gdelt", "rss"]
    macro_cached: bool
    macro_updated_at: str
    warnings: List[str]


class CoinLookupResponse(BaseModel):
    coin: CoinPlan
    plan: Optional[CoinPlan] = None  # backward/forward compat

    risk_state: Literal["GREEN", "YELLOW", "RED"]
    risk_reason: str
    risk_multiplier: float

    macro_risk: int
    macro_source: Literal["gdelt", "rss"]
    macro_cached: bool
    macro_updated_at: str
    warnings: List[str]


# ============================================================
# Routes
# ============================================================
@app.get("/health")
def health():
    return {"ok": True, "version": APP_VERSION}


@app.get("/api/config")
def config():
    return {
        "version": APP_VERSION,
        "timeframes": ["15m", "1h", "4h", "1d"],
        "strategies": ["pullback", "breakout"],
        "universe": [s.replace("USDT", "") for s in COIN_UNIVERSE],
        "thresholds": {
            "BUY_SCORE": BUY_SCORE,
            "WAIT_SCORE": WAIT_SCORE,
            "YELLOW_BUY_MIN_SCORE": YELLOW_BUY_MIN_SCORE,
            "RED_BTC_ETH_STRONG_MIN_SCORE": RED_BTC_ETH_STRONG_MIN_SCORE,
        },
        "guards": {
            "MAX_ENTRY_DISTANCE_PCT": MAX_ENTRY_DISTANCE_PCT,
            "MIN_ATR_PCT": MIN_ATR_PCT,
            "MAX_ATR_PCT": MAX_ATR_PCT,
        },
        "risk_budget_pct": RISK_BUDGET_PCT,
        "macro_ai": {
            "enabled": bool(GEMINI_API_KEY),
            "model": GEMINI_MODEL,
            "key_present": bool(GEMINI_API_KEY),
        },
        "fib": {
            "enabled": True,
            "pivot_L": FIB_PIVOT_L,
            "min_swing_pct_floor": FIB_MIN_SWING_PCT_FLOOR,
            "swing_atr_mult": FIB_SWING_ATR_MULT,
            "near_threshold_by_tf": FIB_NEAR_THRESH_BY_TF,
        },
        "cors": {
            "allowed_origins": ALLOWED_ORIGINS,
        },
    }


# ============================================================
# Binance: symbols + klines (cached)
# ============================================================
BINANCE_BASE = "https://api.binance.com"
TF_MAP: Dict[str, str] = {"15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d"}

_KLINE_CACHE: Dict[Tuple[str, str, int], Dict[str, Any]] = {}
_KLINE_TTL = timedelta(seconds=45)

_SYMBOLS_CACHE: Dict[str, Any] = {"ts": None, "symbols": None}
_SYMBOLS_TTL = timedelta(hours=6)


def _normalize_symbol_input(s: str) -> str:
    s = (s or "").strip().upper()
    s = s.replace("/", "").replace("-", "").replace("_", "")
    if s.endswith("USDT"):
        return s
    return s + "USDT"


async def fetch_exchange_symbols_usdt() -> List[str]:
    now = datetime.utcnow()
    if (
        _SYMBOLS_CACHE["ts"]
        and (now - _SYMBOLS_CACHE["ts"]) < _SYMBOLS_TTL
        and _SYMBOLS_CACHE["symbols"]
    ):
        return list(_SYMBOLS_CACHE["symbols"])

    headers = {"User-Agent": "aicrypto/1.0"}
    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        r = await client.get(f"{BINANCE_BASE}/api/v3/exchangeInfo")
        r.raise_for_status()
        js = r.json()

    out: List[str] = []
    for item in js.get("symbols", []) or []:
        try:
            if item.get("status") != "TRADING":
                continue
            if item.get("quoteAsset") != "USDT":
                continue
            if item.get("isSpotTradingAllowed") is False:
                continue
            sym = item.get("symbol")
            if not sym or not sym.endswith("USDT"):
                continue
            out.append(sym)
        except Exception:
            continue

    out = sorted(set(out))
    _SYMBOLS_CACHE["ts"] = now
    _SYMBOLS_CACHE["symbols"] = out
    return out


async def fetch_klines(symbol: str, interval: str, limit: int = 300) -> pd.DataFrame:
    key = (symbol, interval, limit)
    now = datetime.utcnow()

    cached = _KLINE_CACHE.get(key)
    if cached and (now - cached["ts"]) < _KLINE_TTL:
        return cached["df"].copy()

    params = {"symbol": symbol, "interval": interval, "limit": limit}
    headers = {"User-Agent": "aicrypto/1.0"}

    async with _BINANCE_SEM:  # cap concurrent Binance requests
        async with httpx.AsyncClient(timeout=20, headers=headers) as client:
            r = await client.get(f"{BINANCE_BASE}/api/v3/klines", params=params)
            r.raise_for_status()
            data = r.json()

    df = pd.DataFrame(
        data,
        columns=[
            "open_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "close_time",
            "quote_asset_volume",
            "num_trades",
            "taker_buy_base",
            "taker_buy_quote",
            "ignore",
        ],
    )
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = df[c].astype(float)
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    df["close_time"] = pd.to_datetime(df["close_time"], unit="ms")

    _KLINE_CACHE[key] = {"ts": now, "df": df}
    return df.copy()


@app.get("/api/symbols")
async def symbols(query: str = Query(default=""), limit: int = Query(default=30, ge=1, le=200)):
    q = (query or "").strip().upper()
    syms = await fetch_exchange_symbols_usdt()
    bases = [s.replace("USDT", "") for s in syms]
    if q:
        bases = [b for b in bases if q in b]
    return {"items": bases[:limit]}


# ============================================================
# Indicators
# ============================================================
def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = (delta.where(delta > 0, 0.0)).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(period).mean()
    rs = gain / (loss.replace(0, np.nan))
    out = 100 - (100 / (1 + rs))
    return out.fillna(50.0)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high = df["high"]
    low = df["low"]
    close = df["close"]
    prev_close = close.shift(1)

    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)

    return tr.rolling(period).mean()


def support_resistance(close: pd.Series, lookback: int = 60) -> tuple[float, float]:
    window = close.tail(lookback)
    return float(window.min()), float(window.max())


def _trend_state(m: Dict[str, float]) -> Literal["bull", "bear", "sideways"]:
    if m["ema20"] > m["ema50"] > m["ema200"] and m["close"] > m["ema50"]:
        return "bull"
    if m["ema20"] < m["ema50"] < m["ema200"] and m["close"] < m["ema50"]:
        return "bear"
    return "sideways"


def compute_tech_metrics(df: pd.DataFrame) -> Dict[str, float]:
    df = df.copy()
    close = df["close"]

    df["ema20"] = ema(close, 20)
    df["ema50"] = ema(close, 50)
    df["ema200"] = ema(close, 200)
    df["rsi14"] = rsi(close, 14)
    df["atr14"] = atr(df, 14)

    last = df.iloc[-1]
    prev = df.iloc[-2]

    sup, res = support_resistance(close, 60)
    atr_last = float(last["atr14"]) if not np.isnan(last["atr14"]) else float(
        (df["high"] - df["low"]).tail(14).mean()
    )

    return {
        "close": float(last["close"]),
        "prev_close": float(prev["close"]),
        "ema20": float(last["ema20"]),
        "ema50": float(last["ema50"]),
        "ema200": float(last["ema200"]),
        "rsi": float(last["rsi14"]),
        "atr": float(atr_last),
        "support": sup,
        "resistance": res,
    }


def tech_score(m: Dict[str, float]) -> float:
    score = 0.0

    # Trend (max 60)
    if m["ema20"] > m["ema50"]:
        score += 20
    if m["ema50"] > m["ema200"]:
        score += 25
    if m["close"] > m["ema50"]:
        score += 15

    # Momentum (max 25)
    r = m["rsi"]
    if 45 <= r <= 70:
        score += 25
    elif 35 <= r < 45:
        score += 15
    elif r > 70:
        score += 10

    # Structure (max 15)
    if m["close"] > m["support"] * 1.03:
        score += 10
    if m["close"] >= m["resistance"] * 0.98:
        score += 5

    return float(min(100.0, score))


def make_trade_plan(symbol: str, m: Dict[str, float], score: float, strategy: str) -> Dict[str, Any]:
    close = m["close"]
    atrv = max(m["atr"], close * 0.002)

    if strategy == "breakout":
        entry = max(close, m["resistance"] * 1.002)
        why = "Breakout setup (trend + structure)."
    else:
        zone = min(m["ema20"], m["ema50"])
        entry = min(close, zone * 1.005)
        why = "Pullback-to-EMA setup (trend + RSI reset)."

    stop = entry - 1.8 * atrv
    tp = entry + 2.5 * atrv

    if score >= BUY_SCORE:
        signal = "BUY"
    elif score >= WAIT_SCORE:
        signal = "WAIT"
    else:
        signal = "AVOID"

    reason = f"{why} TechScore {score:.0f}, RSI {m['rsi']:.0f}."
    return {
        "symbol": symbol,
        "signal": signal,
        "entry": float(entry),
        "stop_loss": float(stop),
        "take_profit": float(tp),
        "reason": reason,
    }


# ============================================================
# Fib helpers
# ============================================================
def _pivot_high_idx(high: np.ndarray, i: int, L: int) -> bool:
    left = high[i - L : i]
    right = high[i + 1 : i + 1 + L]
    if left.size != L or right.size != L:
        return False
    v = high[i]
    return bool(v >= left.max() and v >= right.max())


def _pivot_low_idx(low: np.ndarray, i: int, L: int) -> bool:
    left = low[i - L : i]
    right = low[i + 1 : i + 1 + L]
    if left.size != L or right.size != L:
        return False
    v = low[i]
    return bool(v <= left.min() and v <= right.min())


def find_pivots(df: pd.DataFrame, L: int = 3) -> tuple[List[int], List[int]]:
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    n = len(df)
    ph: List[int] = []
    pl: List[int] = []
    if n < 2 * L + 5:
        return ph, pl

    for i in range(L, n - L):
        if _pivot_high_idx(high, i, L):
            ph.append(i)
        if _pivot_low_idx(low, i, L):
            pl.append(i)
    return ph, pl


def _swing_is_valid(swing_low: float, swing_high: float, close: float, atr_pct: float) -> bool:
    if close <= 0:
        return False
    rng = abs(swing_high - swing_low) / close
    min_req = max(FIB_MIN_SWING_PCT_FLOOR, FIB_SWING_ATR_MULT * max(atr_pct, 0.0))
    return rng >= min_req


def choose_latest_swing(
    df: pd.DataFrame,
    trend: Literal["bull", "bear", "sideways"],
    atr_pct: float,
    L: int = 3,
) -> Optional[Dict[str, Any]]:
    ph, pl = find_pivots(df, L=L)
    if not ph or not pl:
        return None

    close = float(df["close"].iloc[-1])

    if trend == "bull":
        for hi_i in reversed(ph):
            lo_candidates = [x for x in pl if x < hi_i]
            if not lo_candidates:
                continue
            lo_i = lo_candidates[-1]
            swing_low = float(df["low"].iloc[lo_i])
            swing_high = float(df["high"].iloc[hi_i])
            if swing_high <= swing_low:
                continue
            if _swing_is_valid(swing_low, swing_high, close, atr_pct):
                return {"direction": "up", "low": swing_low, "high": swing_high, "low_i": lo_i, "high_i": hi_i}
        return None

    if trend == "bear":
        for lo_i in reversed(pl):
            hi_candidates = [x for x in ph if x < lo_i]
            if not hi_candidates:
                continue
            hi_i = hi_candidates[-1]
            swing_high = float(df["high"].iloc[hi_i])
            swing_low = float(df["low"].iloc[lo_i])
            if swing_high <= swing_low:
                continue
            if _swing_is_valid(swing_low, swing_high, close, atr_pct):
                return {"direction": "down", "low": swing_low, "high": swing_high, "low_i": lo_i, "high_i": hi_i}
        return None

    best = None
    best_recency = -1

    for hi_i in reversed(ph[-10:]):
        lo_candidates = [x for x in pl if x < hi_i]
        if not lo_candidates:
            continue
        lo_i = lo_candidates[-1]
        swing_low = float(df["low"].iloc[lo_i])
        swing_high = float(df["high"].iloc[hi_i])
        if swing_high <= swing_low:
            continue
        if _swing_is_valid(swing_low, swing_high, close, atr_pct):
            best = {"direction": "up", "low": swing_low, "high": swing_high, "low_i": lo_i, "high_i": hi_i}
            best_recency = hi_i
            break

    for lo_i in reversed(pl[-10:]):
        hi_candidates = [x for x in ph if x < lo_i]
        if not hi_candidates:
            continue
        hi_i = hi_candidates[-1]
        swing_high = float(df["high"].iloc[hi_i])
        swing_low = float(df["low"].iloc[lo_i])
        if swing_high <= swing_low:
            continue
        if _swing_is_valid(swing_low, swing_high, close, atr_pct):
            if lo_i > best_recency:
                best = {"direction": "down", "low": swing_low, "high": swing_high, "low_i": lo_i, "high_i": hi_i}
            break

    return best


def compute_fib_levels(swing_low: float, swing_high: float, direction: Literal["up", "down"]) -> Dict[str, float]:
    rng = swing_high - swing_low
    if rng <= 0:
        return {}

    if direction == "up":
        return {
            "0.382": float(swing_high - 0.382 * rng),
            "0.5": float(swing_high - 0.5 * rng),
            "0.618": float(swing_high - 0.618 * rng),
            "0.786": float(swing_high - 0.786 * rng),
            "1.272": float(swing_high + 0.272 * rng),
            "1.618": float(swing_high + 0.618 * rng),
        }

    return {
        "0.382": float(swing_low + 0.382 * rng),
        "0.5": float(swing_low + 0.5 * rng),
        "0.618": float(swing_low + 0.618 * rng),
        "0.786": float(swing_low + 0.786 * rng),
        "1.272": float(swing_low - 0.272 * rng),
        "1.618": float(swing_low - 0.618 * rng),
    }


def _near(a: float, b: float, thresh_pct: float) -> bool:
    if b == 0:
        return False
    return abs(a - b) / abs(b) <= thresh_pct


def apply_fib_confluence(
    plan: Dict[str, Any],
    m: Dict[str, float],
    trend: Literal["bull", "bear", "sideways"],
    fib: Optional[Dict[str, Any]],
    timeframe: str,
    strategy: str,
) -> tuple[Dict[str, Any], float, Optional[Dict[str, float]]]:
    if not fib:
        return plan, 0.0, None

    direction = fib["direction"]
    swing_low = float(fib["low"])
    swing_high = float(fib["high"])
    levels = compute_fib_levels(swing_low, swing_high, direction)
    if not levels:
        return plan, 0.0, None

    close = float(m["close"])
    atrv = max(float(m["atr"]), close * 0.002)
    near_thr = float(FIB_NEAR_THRESH_BY_TF.get(timeframe, 0.005))

    if trend == "bull" and direction != "up":
        return plan, 0.0, levels
    if trend == "bear" and direction != "down":
        return plan, 0.0, levels

    zone = min(float(m["ema20"]), float(m["ema50"]))
    zone2 = max(float(m["ema20"]), float(m["ema50"]))
    in_zone = (min(zone, zone2) * 0.995) <= close <= (max(zone, zone2) * 1.005)

    bonus = 0.0

    if trend == "sideways":
        for k in ("0.5", "0.618", "0.382", "0.786"):
            if k in levels and _near(close, levels[k], near_thr):
                plan["reason"] += f" Fib nearby ({k})."
                return plan, 4.0, levels
        return plan, 0.0, levels

    if strategy == "pullback":
        candidates = [(k, levels[k]) for k in ("0.618", "0.5") if k in levels]
        if not candidates:
            return plan, 0.0, levels

        target_k, target_px = min(candidates, key=lambda kv: abs(kv[1] - zone))

        if _near(close, target_px, near_thr) or in_zone:
            if trend == "bull":
                new_entry = min(close, target_px * 1.002)
                stop_ref = min(levels.get("0.786", swing_low), swing_low)
                new_stop = min(float(plan["stop_loss"]), stop_ref - 0.35 * atrv)
                new_tp = max(float(plan["take_profit"]), levels.get("1.272", float(plan["take_profit"])))
            else:
                new_entry = max(close, target_px * 0.998)
                stop_ref = max(levels.get("0.786", swing_high), swing_high)
                new_stop = max(float(plan["stop_loss"]), stop_ref + 0.35 * atrv)
                new_tp = min(float(plan["take_profit"]), levels.get("1.272", float(plan["take_profit"])))

            plan["entry"] = float(new_entry)
            plan["stop_loss"] = float(new_stop)
            plan["take_profit"] = float(new_tp)

            bonus = 8.0
            if _near(zone, target_px, near_thr):
                bonus += 3.0
            if 45 <= float(m["rsi"]) <= 70:
                bonus += 1.0
            bonus = float(min(FIB_BONUS_MAX, bonus))

            plan["reason"] += f" Fib confluence: pullback near {target_k}."
        return plan, float(min(FIB_BONUS_MAX, bonus)), levels

    # breakout: mainly TP via extensions
    if trend == "bull":
        ext_tp = levels.get("1.272")
        ext_tp2 = levels.get("1.618")
        if ext_tp:
            plan["take_profit"] = float(max(float(plan["take_profit"]), ext_tp))
            bonus = 6.0
            if ext_tp2 and float(plan["take_profit"]) < ext_tp2:
                plan["reason"] += " Fib extensions suggest runner to 1.618."
                bonus += 2.0
            plan["reason"] += " Fib extension used for TP."
            return plan, float(min(FIB_BONUS_MAX, bonus)), levels

    if trend == "bear":
        ext_tp = levels.get("1.272")
        ext_tp2 = levels.get("1.618")
        if ext_tp:
            plan["take_profit"] = float(min(float(plan["take_profit"]), ext_tp))
            bonus = 6.0
            if ext_tp2 and float(plan["take_profit"]) > ext_tp2:
                plan["reason"] += " Fib extensions suggest runner to 1.618."
                bonus += 2.0
            plan["reason"] += " Fib extension used for TP."
            return plan, float(min(FIB_BONUS_MAX, bonus)), levels

    return plan, 0.0, levels


# ============================================================
# Macro: RSS + Gemini judge
# ============================================================
RSS_FEEDS = [
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
    "https://www.investing.com/rss/news_25.rss",
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://www.theguardian.com/world/rss",
    "https://rss.dw.com/rdf/rss-en-all",
]

RSS_KEYWORDS: Dict[str, int] = {
    "nuclear": 28,
    "missile": 24,
    "invasion": 24,
    "war": 18,
    "airstrike": 22,
    "bombing": 22,
    "bomb": 20,
    "strike": 14,
    "sanction": 12,
    "martial law": 22,
    "state of emergency": 18,
    "rate hike": 14,
    "interest rate": 12,
    "inflation": 10,
    "cpi": 10,
    "recession": 18,
    "bank failure": 28,
    "default": 22,
    "credit crisis": 22,
    "liquidity": 14,
    "exchange hack": 28,
    "stablecoin": 14,
    "depeg": 20,
    "de-peg": 20,
    "debt ceiling": 18,
    "shutdown": 14,
}

RSS_EXCLUDE_HINTS = [
    "sports", "celebrity", "movie", "music", "fashion", "recipe",
    "salary", "pay", "wage", "hospitality", "rent", "mortgage", "housing",
    "dating", "tiktok", "iphone", "review", "coupon",
]
RSS_FALSE_POSITIVE_PATTERNS = [re.compile(r"(?i)\bwarner\b")]

ESCALATION_HINT_PATTERNS = [
    re.compile(r"(?i)\b(israel|iran|russia|ukraine|china|taiwan)\b"),
    re.compile(r"(?i)\b(strait of hormuz|red sea|suez|shipping lane)\b"),
    re.compile(r"(?i)\bnuclear\b.*\b(alert|threat|crisis)\b"),
]

MACRO_RED_COOLDOWN = timedelta(hours=12)


def _kw_to_pattern(kw: str) -> re.Pattern:
    return re.compile(rf"(?i)\b{re.escape(kw.strip())}\b")


RSS_PATTERNS: Dict[str, re.Pattern] = {kw: _kw_to_pattern(kw) for kw in RSS_KEYWORDS}


def _parse_entry_time(entry: Dict[str, Any]) -> datetime | None:
    tp = entry.get("published_parsed") or entry.get("updated_parsed")
    if not tp:
        return None
    try:
        return datetime(*tp[:6])
    except Exception:
        return None


def _age_weight(hours_old: float) -> float:
    if hours_old <= 3:
        return 1.0
    if hours_old <= 6:
        return 0.9
    if hours_old <= 12:
        return 0.75
    if hours_old <= 24:
        return 0.55
    if hours_old <= 48:
        return 0.15
    return 0.05


def _state_from_risk(r: int) -> tuple[str, float]:
    if r >= 80:
        return "RED", 0.0
    if r >= 50:
        return "YELLOW", 0.6
    return "GREEN", 1.0


def _extract_json_loose(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        return None
    try:
        out = json.loads(m.group(0))
        return out if isinstance(out, dict) else None
    except Exception:
        return None


async def _gemini_generate_json(prompt: str) -> Optional[Dict[str, Any]]:
    if not GEMINI_API_KEY:
        return None

    now = datetime.utcnow()
    cached_ts = _GEMINI_MACRO_CACHE.get("ts")
    if cached_ts and (now - cached_ts) < _GEMINI_MACRO_TTL and _GEMINI_MACRO_CACHE.get("out"):
        out = dict(_GEMINI_MACRO_CACHE["out"])
        out["_cached"] = True
        return out

    url = f"{GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent"
    headers = {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "aicrypto/1.0 (macro-ai)",
    }
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 520,
            "responseMimeType": "application/json",
        },
    }

    try:
        async with httpx.AsyncClient(timeout=18, headers=headers) as client:
            r = await client.post(url, json=body)
            r.raise_for_status()
            js = r.json()

        text = (
            js.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )

        out = _extract_json_loose(text)
        if isinstance(out, dict):
            _GEMINI_MACRO_CACHE["ts"] = now
            _GEMINI_MACRO_CACHE["out"] = out
            out["_cached"] = False
            return out

        cand = js.get("candidates", [{}])[0]
        out2 = _extract_json_loose(json.dumps(cand))
        if isinstance(out2, dict):
            _GEMINI_MACRO_CACHE["ts"] = now
            _GEMINI_MACRO_CACHE["out"] = out2
            out2["_cached"] = False
            return out2

        return None
    except Exception:
        return None


def _ensure_examples_24h(examples: List[str]) -> List[str]:
    out: List[str] = []
    for e in examples:
        s = str(e).strip()
        m = re.search(r"\((\d+)\s*h\s*ago\)", s)
        if not m:
            continue
        try:
            h = int(m.group(1))
        except Exception:
            continue
        if 0 <= h <= 24:
            out.append(s[:180])
        if len(out) >= 3:
            break
    return out


async def rss_macro_risk(max_items_per_feed: int = 30) -> Dict[str, Any]:
    now = datetime.utcnow()

    scored_recent: List[Dict[str, Any]] = []
    seen_scored_titles = set()

    recent_headlines_for_ai: List[str] = []
    seen_ai_titles = set()

    total = 0.0
    severe_feeds = set()
    escalation_hint_feeds = set()

    for url in RSS_FEEDS:
        try:
            feed = feedparser.parse(url)
            feed_severe = False
            feed_hint = False

            for entry in feed.entries[:max_items_per_feed]:
                title_raw = (entry.get("title") or "").strip()
                if not title_raw:
                    continue

                title_l = title_raw.lower()
                if any(x in title_l for x in RSS_EXCLUDE_HINTS):
                    continue
                if any(p.search(title_raw) for p in RSS_FALSE_POSITIVE_PATTERNS):
                    continue

                t = _parse_entry_time(entry)
                if not t:
                    continue

                hours_old = max(0.0, (now - t).total_seconds() / 3600.0)
                if hours_old > 48:
                    continue

                w = _age_weight(hours_old)

                if hours_old <= 24:
                    k_ai = title_raw.lower()
                    if k_ai not in seen_ai_titles and len(recent_headlines_for_ai) < 80:
                        seen_ai_titles.add(k_ai)
                        recent_headlines_for_ai.append(f"- {title_raw} ({int(hours_old)}h ago)")

                if hours_old <= 24 and any(p.search(title_raw) for p in ESCALATION_HINT_PATTERNS):
                    feed_hint = True

                best_pts = 0
                best_kw = None
                for kw, pts in RSS_KEYWORDS.items():
                    if RSS_PATTERNS[kw].search(title_raw) and pts > best_pts:
                        best_pts = pts
                        best_kw = kw

                if best_pts > 0:
                    contrib = min(22.0, best_pts * w)
                    total += contrib

                    if hours_old <= 24:
                        k_sc = title_raw.lower()
                        if k_sc not in seen_scored_titles:
                            seen_scored_titles.add(k_sc)
                            scored_recent.append(
                                {
                                    "title": title_raw,
                                    "hours": int(hours_old),
                                    "pts": best_pts,
                                    "kw": best_kw,
                                    "contrib": float(contrib),
                                    "feed": url,
                                }
                            )

                    if best_pts >= 20 and hours_old <= 24:
                        feed_severe = True

            if feed_severe:
                severe_feeds.add(url)
            if feed_hint:
                escalation_hint_feeds.add(url)

        except Exception:
            continue

    heuristic_risk = int(max(0.0, min(100.0, total)))
    base_state, _ = _state_from_risk(heuristic_risk)

    scored_recent.sort(key=lambda x: (x["contrib"], x["pts"]), reverse=True)
    fallback_examples = [f"{x['title']} ({x['hours']}h ago)" for x in scored_recent[:8]]
    fallback_examples = _ensure_examples_24h(fallback_examples)

    ai_out = None
    if GEMINI_API_KEY and len(recent_headlines_for_ai) >= 6:
        hint_n = len(escalation_hint_feeds)
        prompt = f"""
You are a cautious macro risk monitor for a crypto allocation app.

You MUST use ONLY these headlines from the last 24 hours.
Decide overall market-wide risk (0-100), and set:
- GREEN: normal conditions
- YELLOW: elevated uncertainty / risk
- RED: severe escalation or systemic shock, supported by multiple independent headlines

Return STRICT JSON ONLY:
{{
  "macro_risk": <int 0-100>,
  "risk_state": "GREEN"|"YELLOW"|"RED",
  "risk_multiplier": 1.0|0.6|0.0,
  "risk_reason": "<1-2 sentences>",
  "examples": ["<headline (Nh ago)>", "... up to 3"]
}}

Hard rules:
- examples MUST be copied from input lines and contain "(Nh ago)" with N<=24.
- Do NOT set RED unless multiple independent items indicate severe escalation/systemic shock.
- If unsure, choose YELLOW.

Helpful context:
heuristic_score={heuristic_risk}/100, escalation_hint_sources={hint_n}

Headlines:
{chr(10).join(recent_headlines_for_ai[:80])}
""".strip()

        ai_out = await _gemini_generate_json(prompt)

    if isinstance(ai_out, dict):
        ai_cached = bool(ai_out.get("_cached", False))

        try:
            ai_risk = int(ai_out.get("macro_risk", heuristic_risk))
        except Exception:
            ai_risk = heuristic_risk
        ai_risk = max(0, min(100, ai_risk))

        ai_state = ai_out.get("risk_state", base_state)
        if ai_state not in ("GREEN", "YELLOW", "RED"):
            ai_state = base_state

        blended = int(round(0.70 * ai_risk + 0.30 * heuristic_risk))
        blended = max(0, min(100, blended))

        if ai_state == "RED":
            if blended >= 85 or heuristic_risk >= 65 or len(severe_feeds) >= 2:
                final_state = "RED"
            else:
                final_state = "YELLOW"
        elif ai_state == "GREEN":
            if heuristic_risk >= 55 or blended >= 55:
                final_state = "YELLOW"
            else:
                final_state = "GREEN"
        else:
            final_state = "YELLOW"

        final_state, final_mult = (
            ("GREEN", 1.0) if final_state == "GREEN" else
            ("YELLOW", 0.6) if final_state == "YELLOW" else
            ("RED", 0.0)
        )

        reason = str(ai_out.get("risk_reason") or "").strip() or "Macro headline risk assessed from recent headlines."
        examples = ai_out.get("examples") or []
        if not isinstance(examples, list):
            examples = []
        examples = _ensure_examples_24h([str(x) for x in examples][:6])
        if not examples:
            examples = fallback_examples
        if examples:
            reason += " Examples: " + " • ".join(examples)

        return {
            "macro_risk": blended,
            "risk_state": final_state,
            "risk_reason": reason,
            "risk_multiplier": final_mult,
            "updated_at": now.isoformat() + "Z",
            "_ai_used": True,
            "_ai_cached": ai_cached,
        }

    final_state, final_mult = _state_from_risk(heuristic_risk)
    if final_state == "GREEN" and len(escalation_hint_feeds) >= 4:
        final_state, final_mult = "YELLOW", 0.6

    reason = (
        "Macro headline risk looks normal right now."
        if final_state == "GREEN"
        else "Macro uncertainty is elevated based on recent headlines."
        if final_state == "YELLOW"
        else "High macro headline risk detected across multiple sources."
    )
    if fallback_examples:
        reason += " Examples: " + " • ".join(fallback_examples)

    return {
        "macro_risk": heuristic_risk,
        "risk_state": final_state,
        "risk_reason": reason,
        "risk_multiplier": final_mult,
        "updated_at": now.isoformat() + "Z",
        "_ai_used": False,
        "_ai_cached": False,
    }


# ============================================================
# GDELT (fallback/primary)
# ============================================================
GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc"

RISK_QUERY = (
    '(war OR invasion OR missile OR drone OR strike OR sanctions OR '
    'nuclear OR "state of emergency" OR coup OR protest OR riot OR '
    '"interest rate" OR "rate hike" OR inflation OR CPI OR recession OR '
    '"bank failure" OR default OR "debt ceiling" OR "exchange hack" OR '
    '"stablecoin" OR "depeg")'
)

_GDELT_CACHE: Dict[str, Any] = {"ts": None, "count": None, "macro": None, "last_red_ts": None}
_GDELT_TTL = timedelta(minutes=15)


async def gdelt_count_last_24h(query: str) -> int:
    start = (pd.Timestamp.utcnow() - pd.Timedelta(hours=24)).strftime("%Y%m%d%H%M%S")
    end = pd.Timestamp.utcnow().strftime("%Y%m%d%H%M%S")

    params = {
        "query": query,
        "mode": "ArtList",
        "format": "json",
        "maxrecords": 1,
        "startdatetime": start,
        "enddatetime": end,
        "sort": "HybridRel",
    }

    headers = {"User-Agent": "aicrypto/1.0"}
    async with httpx.AsyncClient(timeout=25, headers=headers) as client:
        r = await client.get(GDELT_DOC_API, params=params)
        if r.status_code == 429:
            raise httpx.HTTPStatusError("429 Too Many Requests", request=r.request, response=r)
        r.raise_for_status()
        js = r.json()

    return int(js.get("totalArticles", 0) or 0)


def macro_risk_from_count(count_24h: int) -> Dict[str, Any]:
    if count_24h <= 200:
        risk = 20
    elif count_24h <= 800:
        risk = 45
    elif count_24h <= 2000:
        risk = 70
    else:
        risk = 85

    if risk >= 80:
        return {"macro_risk": risk, "risk_state": "RED", "risk_reason": "High macro headline intensity (last 24h).", "risk_multiplier": 0.0}
    if risk >= 55:
        return {"macro_risk": risk, "risk_state": "YELLOW", "risk_reason": "Elevated macro headline intensity (last 24h).", "risk_multiplier": 0.6}
    return {"macro_risk": risk, "risk_state": "GREEN", "risk_reason": "Low-to-normal macro headline intensity (last 24h).", "risk_multiplier": 1.0}


def _cache_macro(now: datetime, macro: Dict[str, Any], count: Optional[int]) -> None:
    _GDELT_CACHE["ts"] = now
    _GDELT_CACHE["count"] = count
    _GDELT_CACHE["macro"] = macro
    if macro.get("risk_state") == "RED":
        _GDELT_CACHE["last_red_ts"] = now


def _apply_cooldown(now: datetime, macro: Dict[str, Any]) -> Dict[str, Any]:
    last_red = _GDELT_CACHE.get("last_red_ts")
    if not last_red:
        return macro
    if (now - last_red) <= MACRO_RED_COOLDOWN and macro.get("risk_state") == "GREEN":
        out = dict(macro)
        out["risk_state"] = "YELLOW"
        out["risk_multiplier"] = 0.6
        out["macro_risk"] = max(int(out.get("macro_risk", 55)), 55)
        out["risk_reason"] = (out.get("risk_reason") or "Macro signal.") + " (cooldown active)"
        return out
    return macro


async def get_macro_signal(now: datetime) -> Dict[str, Any]:
    if _GDELT_CACHE["ts"] and (now - _GDELT_CACHE["ts"]) < _GDELT_TTL and _GDELT_CACHE["macro"]:
        macro = dict(_GDELT_CACHE["macro"])
        macro["cached"] = True
        macro["articles_24h"] = _GDELT_CACHE["count"]
        return _apply_cooldown(now, macro)

    try:
        count = await gdelt_count_last_24h(RISK_QUERY)
        macro = macro_risk_from_count(count)
        macro_out = {
            "macro_risk": macro["macro_risk"],
            "risk_state": macro["risk_state"],
            "risk_reason": macro["risk_reason"],
            "risk_multiplier": macro["risk_multiplier"],
            "source": "gdelt",
            "cached": False,
            "articles_24h": count,
            "updated_at": now.isoformat() + "Z",
            "_ai_used": False,
        }
        macro_out = _apply_cooldown(now, macro_out)
        _cache_macro(now, macro_out, count)
        return macro_out
    except Exception:
        rss = await rss_macro_risk()
        macro_cached = bool(rss.get("_ai_cached", False))
        macro_out = {
            "macro_risk": rss["macro_risk"],
            "risk_state": rss["risk_state"],
            "risk_reason": rss["risk_reason"],
            "risk_multiplier": rss["risk_multiplier"],
            "source": "rss",
            "cached": macro_cached,
            "articles_24h": None,
            "updated_at": rss.get("updated_at") or (now.isoformat() + "Z"),
            "_ai_used": bool(rss.get("_ai_used", False)),
        }
        macro_out = _apply_cooldown(now, macro_out)
        _cache_macro(now, macro_out, None)
        return macro_out


# ============================================================
# Build a plan for ONE symbol (used by /api/coin)
# HARD FIX:
# - accepts timeframe
# - tolerates extra kwargs so this error never returns again
# ============================================================
async def build_single_coin_plan(
    symbol_input: str,
    interval: str,
    strategy: str,
    budget: float,
    risk: Risk,
    risk_state: str,
    risk_multiplier: float,
    timeframe: str,
    **_ignore: Any,  # <- prevents "unexpected keyword argument" forever
) -> Dict[str, Any]:
    sym_usdt = _normalize_symbol_input(symbol_input)

    syms = await fetch_exchange_symbols_usdt()
    if sym_usdt not in set(syms):
        base = sym_usdt.replace("USDT", "")
        raise ValueError(f"Symbol '{base}' is not a tradable USDT spot pair on Binance.")

    df = await fetch_klines(sym_usdt, interval, limit=300)
    m = compute_tech_metrics(df)
    score = tech_score(m)

    atr_pct = (m["atr"] / m["close"]) if m["close"] > 0 else 0.0
    if atr_pct < MIN_ATR_PCT:
        score = max(0.0, score - 8.0)
    elif atr_pct > MAX_ATR_PCT:
        score = max(0.0, score - 15.0)

    base_symbol = sym_usdt.replace("USDT", "")
    p = make_trade_plan(base_symbol, m, score, strategy)
    trend = _trend_state(m)

    fib_valid = False
    fib_dir = None
    fib_low = None
    fib_high = None
    fib_levels = None

    try:
        fib = choose_latest_swing(df, trend=trend, atr_pct=float(atr_pct), L=FIB_PIVOT_L)
        if fib:
            fib_valid = True
            fib_dir = fib["direction"]
            fib_low = float(fib["low"])
            fib_high = float(fib["high"])
            p, fib_bonus, fib_levels = apply_fib_confluence(
                plan=p, m=m, trend=trend, fib=fib, timeframe=timeframe, strategy=strategy
            )
            score = float(min(100.0, max(0.0, score + fib_bonus)))
            p["reason"] += f" (FibBonus +{fib_bonus:.0f}, TechScoreAdj {score:.0f})"
    except Exception:
        pass

    entry_dist = abs(p["entry"] - m["close"]) / max(m["close"], 1e-9)
    if entry_dist > MAX_ENTRY_DISTANCE_PCT and p["signal"] == "BUY":
        p["signal"] = "WAIT"
        p["reason"] += f" Entry too far from price ({entry_dist*100:.1f}%)."

    if risk_state == "RED":
        if p["symbol"] in ("BTC", "ETH"):
            if p["signal"] == "BUY" and float(score) < RED_BTC_ETH_STRONG_MIN_SCORE:
                p["signal"] = "WAIT"
                p["reason"] += " Macro filter (RED): only very strong BTC/ETH allowed."
        else:
            if p["signal"] == "BUY":
                p["signal"] = "WAIT"
                p["reason"] += " Macro veto (RED): defensive mode."
    elif risk_state == "YELLOW":
        if p["signal"] == "BUY" and float(score) < YELLOW_BUY_MIN_SCORE:
            p["signal"] = "WAIT"
            p["reason"] += " Macro filter (YELLOW): needs stronger confirmation."

    metrics: Dict[str, Any] = {
        "close": float(m["close"]),
        "prev_close": float(m["prev_close"]),
        "ema20": float(m["ema20"]),
        "ema50": float(m["ema50"]),
        "ema200": float(m["ema200"]),
        "rsi": float(m["rsi"]),
        "atr": float(m["atr"]),
        "atr_pct": float(atr_pct),
        "support": float(m["support"]),
        "resistance": float(m["resistance"]),
        "trend_state": trend,
        "fib_valid": bool(fib_valid),
        "fib_direction": fib_dir,
        "fib_swing_low": fib_low,
        "fib_swing_high": fib_high,
        "fib_levels": fib_levels,
    }

    allocation = 100.0
    position_usd = budget * (allocation / 100.0) * float(risk_multiplier)

    entry_price = float(p["entry"])
    stop_price = float(p["stop_loss"])
    per_unit_risk_pct = max(0.0, (entry_price - stop_price)) / max(entry_price, 1e-9)
    max_loss_usd = per_unit_risk_pct * max(position_usd, 0.0)

    base_risk_budget = budget * float(RISK_BUDGET_PCT[risk])
    allowed_risk_budget = base_risk_budget * float(risk_multiplier)

    if allowed_risk_budget > 0 and max_loss_usd > allowed_risk_budget and max_loss_usd > 0:
        scale = allowed_risk_budget / max_loss_usd
        position_usd *= scale
        max_loss_usd *= scale
        p["reason"] += " Position scaled down to fit risk budget."

    risk_pct_budget = (max_loss_usd / budget) if budget > 0 else 0.0

    return {
        "symbol": base_symbol,
        "allocation": float(allocation),
        "signal": p["signal"],
        "entry": float(p["entry"]),
        "stop_loss": float(p["stop_loss"]),
        "take_profit": float(p["take_profit"]),
        "reason": p["reason"],
        "tech_score": float(score),
        "entry_distance_pct": float(entry_dist),
        "position_usd": float(round(position_usd, 2)),
        "max_loss_usd": float(round(max_loss_usd, 2)),
        "risk_pct_budget": float(round(risk_pct_budget * 100, 3)),
        "metrics": metrics,
    }


# ============================================================
# Endpoints
# ============================================================
@app.post("/api/coin", response_model=CoinLookupResponse)
async def coin_lookup(req: CoinLookupRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)
    interval = TF_MAP[req.timeframe]
    now = datetime.utcnow()
    warnings: List[str] = []

    macro = await get_macro_signal(now)
    risk_state = macro["risk_state"]
    risk_reason = macro["risk_reason"]
    risk_multiplier = float(macro["risk_multiplier"])
    macro_risk = int(macro.get("macro_risk", 55))
    macro_source = macro.get("source", "rss")
    if macro_source not in ("gdelt", "rss"):
        macro_source = "rss"
    macro_cached = bool(macro.get("cached", False))
    macro_updated_at = str(macro.get("updated_at", now.isoformat() + "Z"))

    try:
        coin = await build_single_coin_plan(
            symbol_input=req.symbol,
            interval=interval,
            strategy=req.strategy,
            budget=req.budget,
            risk=req.risk,
            risk_state=risk_state,
            risk_multiplier=risk_multiplier,
            timeframe=req.timeframe,
        )
    except Exception as e:
        base = _normalize_symbol_input(req.symbol).replace("USDT", "")
        warnings.append(str(e))
        coin = {
            "symbol": base,
            "allocation": 100.0,
            "signal": "AVOID",
            "entry": 0.0,
            "stop_loss": 0.0,
            "take_profit": 0.0,
            "reason": "Could not generate a plan for this symbol.",
            "tech_score": 0.0,
            "entry_distance_pct": 0.0,
            "position_usd": 0.0,
            "max_loss_usd": 0.0,
            "risk_pct_budget": 0.0,
            "metrics": {
                "close": 0.0,
                "prev_close": 0.0,
                "ema20": 0.0,
                "ema50": 0.0,
                "ema200": 0.0,
                "rsi": 50.0,
                "atr": 0.0,
                "atr_pct": 0.0,
                "support": 0.0,
                "resistance": 0.0,
                "trend_state": "sideways",
                "fib_valid": False,
                "fib_direction": None,
                "fib_swing_low": None,
                "fib_swing_high": None,
                "fib_levels": None,
            },
        }

    if macro_source == "rss":
        if GEMINI_API_KEY and macro.get("_ai_used", False):
            warnings.append(f"Macro judge: Gemini enabled ({GEMINI_MODEL}).")
        elif GEMINI_API_KEY and not macro.get("_ai_used", False):
            warnings.append("Gemini key is present but macro judge did not run (Gemini request/parsing failed).")
        else:
            warnings.append("Gemini is OFF (no API key found in env/.env).")
    if macro_cached:
        warnings.append("Macro signal was served from cache to reduce refresh noise.")
    if risk_state == "RED":
        warnings.append("Extreme macro risk: the app will avoid new positions and prioritize capital protection.")

    return {
        "coin": coin,
        "plan": coin,
        "risk_state": risk_state,
        "risk_reason": risk_reason,
        "risk_multiplier": risk_multiplier,
        "macro_risk": macro_risk,
        "macro_source": macro_source,
        "macro_cached": macro_cached,
        "macro_updated_at": macro_updated_at,
        "warnings": warnings,
    }


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    interval = TF_MAP[req.timeframe]
    now = datetime.utcnow()
    warnings: List[str] = []

    macro = await get_macro_signal(now)
    risk_state = macro["risk_state"]
    risk_reason = macro["risk_reason"]
    risk_multiplier = float(macro["risk_multiplier"])
    macro_risk = int(macro.get("macro_risk", 55))
    macro_source = macro.get("source", "rss")
    if macro_source not in ("gdelt", "rss"):
        macro_source = "rss"
    macro_cached = bool(macro.get("cached", False))
    macro_updated_at = str(macro.get("updated_at", now.isoformat() + "Z"))

    # ── Fetch all coins concurrently ─────────────────────────────────────────
    async def _process_sym(sym: str) -> Optional[Dict[str, Any]]:
        try:
            df = await fetch_klines(sym, interval, limit=300)
            m = compute_tech_metrics(df)
            score = tech_score(m)

            atr_pct = (m["atr"] / m["close"]) if m["close"] > 0 else 0.0
            if atr_pct < MIN_ATR_PCT:
                score = max(0.0, score - 8.0)
            elif atr_pct > MAX_ATR_PCT:
                score = max(0.0, score - 15.0)

            p = make_trade_plan(sym.replace("USDT", ""), m, score, req.strategy)
            trend = _trend_state(m)

            fib_valid = False
            fib_dir = None
            fib_low = None
            fib_high = None
            fib_levels = None

            try:
                fib = choose_latest_swing(df, trend=trend, atr_pct=float(atr_pct), L=FIB_PIVOT_L)
                if fib:
                    fib_valid = True
                    fib_dir = fib["direction"]
                    fib_low = float(fib["low"])
                    fib_high = float(fib["high"])
                    p, fib_bonus, fib_levels = apply_fib_confluence(
                        plan=p, m=m, trend=trend, fib=fib, timeframe=req.timeframe, strategy=req.strategy
                    )
                    score = float(min(100.0, max(0.0, score + fib_bonus)))
                    p["reason"] += f" (FibBonus +{fib_bonus:.0f}, TechScoreAdj {score:.0f})"
            except Exception:
                pass

            entry_dist = abs(p["entry"] - m["close"]) / max(m["close"], 1e-9)
            if entry_dist > MAX_ENTRY_DISTANCE_PCT and p["signal"] == "BUY":
                p["signal"] = "WAIT"
                p["reason"] += f" Entry too far from price ({entry_dist*100:.1f}%)."

            p["_score"] = float(score)
            p["_metrics"] = {
                "close": float(m["close"]),
                "prev_close": float(m["prev_close"]),
                "ema20": float(m["ema20"]),
                "ema50": float(m["ema50"]),
                "ema200": float(m["ema200"]),
                "rsi": float(m["rsi"]),
                "atr": float(m["atr"]),
                "atr_pct": float(atr_pct),
                "support": float(m["support"]),
                "resistance": float(m["resistance"]),
                "trend_state": trend,
                "fib_valid": bool(fib_valid),
                "fib_direction": fib_dir,
                "fib_swing_low": fib_low,
                "fib_swing_high": fib_high,
                "fib_levels": fib_levels,
            }

            p["allocation"] = 0.0
            p["tech_score"] = float(score)
            p["entry_distance_pct"] = float(entry_dist)
            return p
        except Exception:
            return None

    results = await asyncio.gather(*[_process_sym(sym) for sym in COIN_UNIVERSE])
    plans: List[Dict[str, Any]] = [p for p in results if p is not None]

    if not plans:
        return {
            "risk_state": "YELLOW",
            "risk_reason": "Could not fetch Binance data. Try again.",
            "risk_multiplier": 0.5,
            "budget": req.budget,
            "timeframe": req.timeframe,
            "strategy": req.strategy,
            "coins": [],
            "macro_risk": macro_risk,
            "macro_source": macro_source,
            "macro_cached": macro_cached,
            "macro_updated_at": macro_updated_at,
            "warnings": ["Binance klines unavailable for all symbols."],
        }

    if risk_state == "RED":
        for p in plans:
            if p["symbol"] in ("BTC", "ETH"):
                if p["signal"] == "BUY" and p["_score"] < RED_BTC_ETH_STRONG_MIN_SCORE:
                    p["signal"] = "WAIT"
                    p["reason"] += " Macro filter (RED): only very strong BTC/ETH allowed."
            else:
                if p["signal"] == "BUY":
                    p["signal"] = "WAIT"
                    p["reason"] += " Macro veto (RED): defensive mode."
    elif risk_state == "YELLOW":
        for p in plans:
            if p["signal"] == "BUY" and p["_score"] < YELLOW_BUY_MIN_SCORE:
                p["signal"] = "WAIT"
                p["reason"] += " Macro filter (YELLOW): needs stronger confirmation."

    priority = {"BUY": 2, "WAIT": 1, "AVOID": 0}
    plans.sort(key=lambda x: (priority[x["signal"]], x["_score"]), reverse=True)
    plans = plans[:4]

    if risk_state == "GREEN":
        weights = [0.40, 0.25, 0.20, 0.15]
    elif risk_state == "YELLOW":
        weights = [0.50, 0.20, 0.15, 0.15]
    else:
        weights = [0.60, 0.25, 0.15, 0.00]

    base_risk_budget = req.budget * float(RISK_BUDGET_PCT[req.risk])
    allowed_risk_budget = base_risk_budget * float(risk_multiplier)

    for p, w in zip(plans, weights):
        alloc_pct = round(w * 100, 2)
        p["allocation"] = alloc_pct

        position_usd = req.budget * (alloc_pct / 100.0) * float(risk_multiplier)

        entry_price = float(p["entry"])
        stop_price = float(p["stop_loss"])
        per_unit_risk_pct = max(0.0, (entry_price - stop_price)) / max(entry_price, 1e-9)
        max_loss_usd = per_unit_risk_pct * max(position_usd, 0.0)

        if allowed_risk_budget > 0 and max_loss_usd > 0:
            per_coin_cap = allowed_risk_budget * (alloc_pct / 100.0)
            if max_loss_usd > per_coin_cap:
                scale = per_coin_cap / max_loss_usd
                position_usd *= scale
                max_loss_usd *= scale
                p["reason"] += " Position scaled down to fit risk budget."

        risk_pct_budget = (max_loss_usd / req.budget) if req.budget > 0 else 0.0

        p["position_usd"] = float(round(position_usd, 2))
        p["max_loss_usd"] = float(round(max_loss_usd, 2))
        p["risk_pct_budget"] = float(round(risk_pct_budget * 100, 3))
        p["metrics"] = p["_metrics"]

    for p in plans:
        p.pop("_score", None)
        p.pop("_metrics", None)

    if macro_source == "rss":
        if GEMINI_API_KEY and macro.get("_ai_used", False):
            warnings.append(f"Macro judge: Gemini enabled ({GEMINI_MODEL}).")
        elif GEMINI_API_KEY and not macro.get("_ai_used", False):
            warnings.append("Gemini key is present but macro judge did not run (Gemini request/parsing failed).")
        else:
            warnings.append("Gemini is OFF (no API key found in env/.env).")
    if macro_cached:
        warnings.append("Macro signal was served from cache to reduce refresh noise.")
    if risk_state == "RED":
        warnings.append("Extreme macro risk: the app will avoid new positions and prioritize capital protection.")

    return {
        "risk_state": risk_state,
        "risk_reason": risk_reason,
        "risk_multiplier": risk_multiplier,
        "budget": req.budget,
        "timeframe": req.timeframe,
        "strategy": req.strategy,
        "coins": plans,
        "macro_risk": macro_risk,
        "macro_source": macro_source,
        "macro_cached": macro_cached,
        "macro_updated_at": macro_updated_at,
        "warnings": warnings,
    }