import axios from "axios";
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CoinLookupRequest,
  CoinLookupResponse,
  SymbolsResponse,
} from "../types";

const baseURL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export const api = axios.create({
  baseURL,
  headers: {
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// Retry once for cold starts / flaky gateways / timeouts
function shouldRetry(err: unknown) {
  if (!axios.isAxiosError(err)) return false;

  const status = err.response?.status;

  // Common transient cases:
  // - No response at all (network / CORS / DNS hiccup)
  // - Timeout (ECONNABORTED)
  // - Temporary upstream errors (502/503/504)
  return (
    err.code === "ECONNABORTED" ||
    !err.response ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Portfolio analysis (top 4) */
export async function analyzeInvestment(
  data: AnalyzeRequest
): Promise<AnalyzeResponse> {
  try {
    const response = await api.post<AnalyzeResponse>("/api/analyze", data);
    return response.data;
  } catch (err) {
    if (shouldRetry(err)) {
      await sleep(1200);
      const response = await api.post<AnalyzeResponse>("/api/analyze", data);
      return response.data;
    }
    throw err;
  }
}

/** Server-side symbol search (Binance spot USDT pairs) */
export async function searchSymbols(query: string, limit = 30): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];

  const response = await api.get<SymbolsResponse>("/api/symbols", {
    params: { query: q, limit },
  });

  return response.data.items ?? [];
}

/** Single-coin plan */
export async function analyzeCoin(
  data: CoinLookupRequest
): Promise<CoinLookupResponse> {
  try {
    const response = await api.post<CoinLookupResponse>("/api/coin", data);
    return response.data;
  } catch (err) {
    if (shouldRetry(err)) {
      await sleep(900);
      const response = await api.post<CoinLookupResponse>("/api/coin", data);
      return response.data;
    }
    throw err;
  }
}