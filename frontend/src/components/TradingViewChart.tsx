import { useEffect, useRef } from "react";

type Timeframe = "15m" | "1h" | "4h" | "1d";

function toTradingViewInterval(tf?: string): string {
  // TradingView widget interval format:
  // minutes as string numbers; daily is "D"
  switch (tf as Timeframe) {
    case "15m":
      return "15";
    case "1h":
      return "60";
    case "4h":
      return "240";
    case "1d":
      return "D";
    default:
      return "60";
  }
}

export function TradingViewChart({
  symbol, // e.g. "BTC" or "BTCUSDT" or "BTC/USDT"
  timeframe,
  height = 320,
  theme = "light",
}: {
  symbol: string;
  timeframe?: string;
  height?: number;
  theme?: "light" | "dark";
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string>(
    `tv_${Math.random().toString(36).slice(2)}`
  );

  // Normalize to BINANCE:BTCUSDT
  const normalized = (symbol || "")
    .trim()
    .toUpperCase()
    .replace("/", "")
    .replace("-", "")
    .replace("_", "");
  const tvSymbol = normalized.endsWith("USDT")
    ? `BINANCE:${normalized}`
    : `BINANCE:${normalized}USDT`;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Clear previous widget (important when switching symbol/timeframe)
    el.innerHTML = "";

    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;

    const interval = toTradingViewInterval(timeframe);

    // NOTE: This widget reads config from the script's innerHTML JSON
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval,
      timezone: "Etc/UTC",
      theme,
      style: "1",
      locale: "en",
      allow_symbol_change: false,
      hide_top_toolbar: true,
      hide_legend: false,
      withdateranges: true,
      details: false,
      hotlist: false,
      calendar: false,
      studies: ["RSI@tv-basicstudies", "EMA@tv-basicstudies"],
      container_id: widgetIdRef.current,
    });

    el.appendChild(script);

    return () => {
      // Clean up DOM on unmount
      if (el) el.innerHTML = "";
    };
  }, [tvSymbol, timeframe, theme]);

  return (
    <div
      className="w-full overflow-hidden rounded-2xl border bg-white"
      style={{ height }}
    >
      <div
        ref={containerRef}
        id={widgetIdRef.current}
        style={{ height: "100%", width: "100%" }}
      />
    </div>
  );
}