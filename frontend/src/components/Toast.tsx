import { useEffect } from "react";

interface ToastProps {
  message: string;
  type?: "error" | "success" | "info";
  onClose: () => void;
  duration?: number;
}

export function Toast({
  message,
  type = "error",
  onClose,
  duration = 5000,
}: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [onClose, duration]);

  const typeStyles = {
    error: "bg-red-50 border-red-200 text-red-800",
    success: "bg-emerald-50 border-emerald-200 text-emerald-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`fixed bottom-6 left-4 right-4 z-50 rounded-xl border px-4 py-3 shadow-lg ${typeStyles[type]} md:left-auto md:right-6 md:max-w-sm`}
    >
      <div className="flex items-start gap-3">
        <p className="flex-1 text-sm font-medium">{message}</p>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg p-1 hover:bg-black/5 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-neutral-400"
          aria-label="Dismiss"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
