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
import type { PriceAlert } from "../types";

interface AlertsContextValue {
  alerts: PriceAlert[];
  addAlert: (symbol: string, targetPrice: number, direction: "above" | "below") => void;
  removeAlert: (id: string) => void;
  clearTriggered: () => void;
  notificationsEnabled: boolean;
  requestNotifications: () => Promise<void>;
}

const AlertsContext = createContext<AlertsContextValue | null>(null);
const LS_KEY = "ai-crypto:alerts:v1";

function loadAlerts(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Simple price fetch via Binance public ticker
async function fetchPrice(symbol: string): Promise<number | null> {
  try {
    const sym = symbol.toUpperCase().endsWith("USDT")
      ? symbol.toUpperCase()
      : symbol.toUpperCase() + "USDT";
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const price = parseFloat(data.price);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

function fireNotification(alert: PriceAlert, currentPrice: number) {
  const msg = `${alert.symbol} hit $${currentPrice.toLocaleString()} (target: $${alert.targetPrice.toLocaleString()})`;
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(`🔔 Price Alert: ${alert.symbol}`, { body: msg });
  }
}

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<PriceAlert[]>(loadAlerts);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => "Notification" in window && Notification.permission === "granted"
  );
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Stable count of active alerts — avoids inline expression in dep array
  const activeAlertCount = useMemo(
    () => alerts.filter((a) => !a.triggered).length,
    [alerts]
  );

  // Persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(alerts));
    } catch {}
  }, [alerts]);

  // Keep ref so the interval always sees latest alerts without re-creating
  const alertsRef = useRef(alerts);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

  // Check prices every 30 seconds for active (non-triggered) alerts
  useEffect(() => {
    if (activeAlertCount === 0) {
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);
      return;
    }

    const check = async () => {
      const active = alertsRef.current.filter((a) => !a.triggered);
      if (active.length === 0) return;

      const symbols = [...new Set(active.map((a) => a.symbol))];
      const prices: Record<string, number> = {};

      await Promise.all(
        symbols.map(async (sym) => {
          const p = await fetchPrice(sym);
          if (p !== null) prices[sym] = p;
        })
      );

      if (!mountedRef.current) return;

      setAlerts((prev) =>
        prev.map((alert) => {
          if (alert.triggered) return alert;
          const price = prices[alert.symbol];
          if (price === undefined) return alert;

          const triggered =
            alert.direction === "above"
              ? price >= alert.targetPrice
              : price <= alert.targetPrice;

          if (triggered) {
            fireNotification(alert, price);
            return { ...alert, triggered: true };
          }
          return alert;
        })
      );
    };

    check();
    checkIntervalRef.current = setInterval(check, 30_000);

    return () => {
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);
    };
  }, [activeAlertCount]); // stable number, not an inline expression

  const addAlert = useCallback(
    (symbol: string, targetPrice: number, direction: "above" | "below") => {
      const newAlert: PriceAlert = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        symbol: symbol.toUpperCase().replace("USDT", ""),
        targetPrice,
        direction,
        createdAt: new Date().toISOString(),
        triggered: false,
      };
      setAlerts((prev) => [newAlert, ...prev].slice(0, 20)); // cap at 20
    },
    []
  );

  const removeAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearTriggered = useCallback(() => {
    setAlerts((prev) => prev.filter((a) => !a.triggered));
  }, []);

  const requestNotifications = useCallback(async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setNotificationsEnabled(result === "granted");
  }, []);

  const value = useMemo<AlertsContextValue>(
    () => ({
      alerts,
      addAlert,
      removeAlert,
      clearTriggered,
      notificationsEnabled,
      requestNotifications,
    }),
    [alerts, addAlert, removeAlert, clearTriggered, notificationsEnabled, requestNotifications]
  );

  return (
    <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>
  );
}

export function useAlerts() {
  const ctx = useContext(AlertsContext);
  if (!ctx) throw new Error("useAlerts must be used within AlertsProvider");
  return ctx;
}