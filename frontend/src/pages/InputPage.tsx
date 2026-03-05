import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { SegmentedControl } from "../components/SegmentedControl";
import { Toast } from "../components/Toast";
import { useAnalysis } from "../context/AnalysisContext";
import { useTheme } from "../context/ThemeContext";
import axios from "axios";
import type { RiskLevel, Timeframe, Strategy } from "../types";

const RISK_OPTIONS = [
  { value: "low" as RiskLevel, label: "Low" },
  { value: "medium" as RiskLevel, label: "Medium" },
  { value: "high" as RiskLevel, label: "High" },
];

const TIMEFRAME_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

const STRATEGY_OPTIONS: { value: Strategy; label: string }[] = [
  { value: "pullback", label: "Pullback" },
  { value: "breakout", label: "Breakout" },
];

const BUDGET_PRESETS = [250, 500, 1000, 2500, 5000];

export function InputPage() {
  const navigate = useNavigate();
  const { runAnalysis } = useAnalysis(); // ✅ use context runner (sets result + lastRequest)
  const { isDark, toggleTheme } = useTheme();

  const [budget, setBudget] = useState(500);
  const [risk, setRisk] = useState<RiskLevel>("medium");
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const [strategy, setStrategy] = useState<Strategy>("pullback");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const budgetHint = useMemo(() => {
    if (budget <= 0) return "Enter a valid budget to continue.";
    if (budget < 50) return "Small budget: allocations may focus on fewer coins.";
    if (budget > 10000)
      return "Large budget: risk sizing will stay conservative in high volatility.";
    return "Enter your total investment amount in USD.";
  }, [budget]);

  const handleSubmit = async () => {
    setError(null);

    if (budget <= 0) {
      setError("Budget must be greater than 0");
      return;
    }

    setIsLoading(true);
    try {
      await runAnalysis({ budget, risk, timeframe, strategy });
      navigate("/results");
    } catch (err) {
      let message = "Failed to generate plan. Please try again.";
      if (axios.isAxiosError(err)) {
        message =
          (err.response?.data as any)?.detail ??
          (err.response?.data as any)?.message ??
          err.message;
      } else if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 flex flex-col transition-colors duration-200">
      <div className="mx-auto max-w-6xl px-4 py-10 flex-1 w-full">
        {/* Page header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              AI Crypto Investment Assistant
            </h1>
            <p className="mt-2 text-sm sm:text-base text-neutral-600 dark:text-neutral-400 max-w-2xl">
              Macro-aware crypto recommendations that combine technical analysis with real-time news risk
              filtering—then size positions based on your risk tolerance.
            </p>
          </div>

          {/* Dark mode toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className="shrink-0 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-2.5 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark ? "Light mode" : "Dark mode"}
          >
            {isDark ? (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* Left: value + info */}
          <section className="lg:col-span-6">
            <div className="space-y-6">
              <Card className="dark:bg-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
                  What you get
                </h2>

                <ul className="space-y-3 text-sm text-neutral-700 dark:text-neutral-300">
                  <li className="flex gap-3">
                    <span className="mt-0.5 h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-600 shrink-0" />
                    <span>
                      <span className="font-medium">Coin picks + allocation</span>{" "}
                      ranked by a technical score and filtered by macro conditions.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-0.5 h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-600 shrink-0" />
                    <span>
                      <span className="font-medium">Entry / SL / TP</span> with clear
                      signal labels (BUY / WAIT / AVOID).
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-0.5 h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-600 shrink-0" />
                    <span>
                      <span className="font-medium">Macro risk banner</span> (GREEN /
                      YELLOW / RED) powered by news data with cooldown logic to avoid
                      flip-flopping.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-0.5 h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-600 shrink-0" />
                    <span>
                      <span className="font-medium">Risk-managed sizing</span> estimating
                      max loss and budget risk per position.
                    </span>
                  </li>
                </ul>
              </Card>

              <Card className="dark:bg-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
                  How it works
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-700/50 px-4 py-3">
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">Step 1</p>
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">Inputs</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                      Budget, risk, timeframe, strategy
                    </p>
                  </div>
                  <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-700/50 px-4 py-3">
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">Step 2</p>
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">Scoring</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                      Indicators + support/resistance
                    </p>
                  </div>
                  <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-700/50 px-4 py-3">
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">Step 3</p>
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">Risk filter</p>
                    <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                      News-driven macro state
                    </p>
                  </div>
                </div>

                <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                  Not financial advice. This tool is for educational purposes and structured decision support.
                </p>
              </Card>
            </div>
          </section>

          {/* Right: form */}
          <section className="lg:col-span-6">
            <Card className="dark:bg-neutral-800">
              <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    Create your plan
                  </h2>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
                    Set your parameters and generate recommendations.
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                {/* Budget */}
                <div>
                  <label
                    htmlFor="budget"
                    className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2"
                  >
                    Budget (USD)
                  </label>

                  <div className="flex flex-col gap-3">
                    <input
                      id="budget"
                      type="number"
                      min={1}
                      step={1}
                      value={budget}
                      onChange={(e) => setBudget(Number(e.target.value) || 0)}
                      className="w-full rounded-xl border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700/50 px-4 py-3 text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:border-neutral-500 dark:focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-500/20"
                      aria-describedby="budget-hint"
                    />

                    {/* Presets */}
                    <div className="flex flex-wrap gap-2">
                      {BUDGET_PRESETS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setBudget(p)}
                          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                            budget === p
                              ? "border-neutral-900 dark:border-neutral-100 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                              : "border-neutral-200 dark:border-neutral-600 bg-white dark:bg-neutral-700/50 text-neutral-700 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                          }`}
                        >
                          ${p.toLocaleString()}
                        </button>
                      ))}
                    </div>
                  </div>

                  <p id="budget-hint" className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {budgetHint}
                  </p>
                </div>

                {/* Risk */}
                <SegmentedControl
                  options={RISK_OPTIONS}
                  value={risk}
                  onChange={setRisk}
                  label="Risk Tolerance"
                  helperText="Higher risk increases position sizing and allows more aggressive setups."
                />

                {/* Timeframe */}
                <SegmentedControl
                  options={TIMEFRAME_OPTIONS}
                  value={timeframe}
                  onChange={setTimeframe}
                  label="Timeframe"
                  helperText="Shorter timeframes update faster but can be noisier."
                />

                {/* Strategy */}
                <SegmentedControl
                  options={STRATEGY_OPTIONS}
                  value={strategy}
                  onChange={setStrategy}
                  label="Strategy"
                  helperText="Pullback favors entries near support. Breakout favors momentum above resistance."
                />

                {/* CTA */}
                <div className="pt-2">
                  <Button
                    onClick={handleSubmit}
                    isLoading={isLoading}
                    fullWidth
                    className="text-base"
                  >
                    Generate Plan
                  </Button>
                </div>
              </div>
            </Card>
          </section>
        </div>
      </div>

      {/* Copyright footer */}
      <footer className="mt-auto py-4 text-center">
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          &copy; {new Date().getFullYear()} Murad Abdullayev. All rights reserved.
        </p>
      </footer>

      {error && <Toast message={error} type="error" onClose={() => setError(null)} />}
    </div>
  );
}