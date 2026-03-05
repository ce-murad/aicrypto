import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  isLoading?: boolean;
  loadingText?: string;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;

  /** Optional: makes primary feel like a “CTA” */
  tone?: "default" | "success" | "danger";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      tone = "default",
      size = "md",
      isLoading = false,
      loadingText,
      fullWidth = false,
      leftIcon,
      rightIcon,
      className = "",
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const base =
      "inline-flex items-center justify-center gap-2 rounded-2xl font-semibold " +
      "transition-all duration-200 select-none " +
      "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
      "disabled:opacity-50 disabled:cursor-not-allowed " +
      "active:translate-y-[0.5px]";

    const sizeStyles = {
      sm: "min-h-[40px] px-4 text-sm",
      md: "min-h-[48px] px-6 text-sm",
    };

    // Subtle "premium" feel: gradient + ring + shadow tweaks
    const primaryTone: Record<NonNullable<ButtonProps["tone"]>, string> = {
      default:
        "text-white border border-neutral-900/20 " +
        "bg-gradient-to-b from-neutral-900 to-neutral-800 " +
        "shadow-[0_10px_24px_rgba(0,0,0,0.12)] " +
        "hover:shadow-[0_14px_30px_rgba(0,0,0,0.16)] hover:brightness-[1.02] " +
        "focus-visible:ring-neutral-500/40",
      success:
        "text-white border border-emerald-700/25 " +
        "bg-gradient-to-b from-emerald-600 to-emerald-700 " +
        "shadow-[0_10px_24px_rgba(16,185,129,0.18)] " +
        "hover:shadow-[0_14px_30px_rgba(16,185,129,0.22)] hover:brightness-[1.02] " +
        "focus-visible:ring-emerald-500/40",
      danger:
        "text-white border border-red-700/25 " +
        "bg-gradient-to-b from-red-600 to-red-700 " +
        "shadow-[0_10px_24px_rgba(239,68,68,0.18)] " +
        "hover:shadow-[0_14px_30px_rgba(239,68,68,0.22)] hover:brightness-[1.02] " +
        "focus-visible:ring-red-500/40",
    };

    const variants = {
      primary: primaryTone[tone],
      secondary:
        "bg-white text-neutral-900 border border-neutral-200/80 " +
        "shadow-[0_8px_18px_rgba(0,0,0,0.06)] " +
        "hover:bg-neutral-50 hover:border-neutral-300 hover:shadow-[0_10px_22px_rgba(0,0,0,0.08)] " +
        "focus-visible:ring-neutral-400/40",
      ghost:
        "bg-transparent text-neutral-700 border border-transparent " +
        "hover:bg-neutral-100/70 " +
        "focus-visible:ring-neutral-400/40",
    };

    const iconWrap = "inline-flex items-center justify-center shrink-0";
    const iconSize = size === "sm" ? "h-4 w-4" : "h-4.5 w-4.5";

    const content = (
      <>
        {/* Left icon / spinner */}
        <span className={`${iconWrap} ${iconSize}`}>
          {isLoading ? (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
          ) : (
            leftIcon
          )}
        </span>

        {/* Label */}
        <span className="inline-flex items-center">
          {isLoading ? loadingText ?? children : children}
        </span>

        {/* Right icon */}
        {(!isLoading && rightIcon) ? (
          <span className={`${iconWrap} ${iconSize}`}>{rightIcon}</span>
        ) : (
          <span className={`${iconWrap} ${iconSize}`} aria-hidden />
        )}
      </>
    );

    return (
      <button
        ref={ref}
        className={[
          base,
          sizeStyles[size],
          variants[variant],
          fullWidth ? "w-full" : "",
          // subtle disabled polish (keeps gradients from looking weird)
          disabled || isLoading ? "hover:shadow-none hover:brightness-100 active:translate-y-0" : "",
          className,
        ].join(" ")}
        disabled={disabled || isLoading}
        {...props}
      >
        {content}
      </button>
    );
  }
);

Button.displayName = "Button";