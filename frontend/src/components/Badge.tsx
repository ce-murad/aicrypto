import type { HTMLAttributes } from "react";

type BadgeVariant = "buy" | "wait" | "avoid" | "neutral";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: "sm" | "md";
  withDot?: boolean;
  children: React.ReactNode;

  /** Optional: slightly stronger emphasis */
  emphasis?: "soft" | "solid";
}

export function Badge({
  variant = "neutral",
  size = "md",
  withDot = true,
  emphasis = "soft",
  className = "",
  children,
  ...props
}: BadgeProps) {
  // “soft” = premium subtle chip, “solid” = stronger for key signals
  const variantsSoft: Record<BadgeVariant, string> = {
    buy: "bg-emerald-50 text-emerald-800 border-emerald-200/70 ring-1 ring-emerald-200/40",
    wait: "bg-amber-50 text-amber-800 border-amber-200/70 ring-1 ring-amber-200/40",
    avoid: "bg-red-50 text-red-800 border-red-200/70 ring-1 ring-red-200/40",
    neutral: "bg-neutral-50 text-neutral-700 border-neutral-200/70 ring-1 ring-neutral-200/50",
  };

  const variantsSolid: Record<BadgeVariant, string> = {
    buy: "bg-emerald-600 text-white border-emerald-700/60 ring-1 ring-emerald-500/30",
    wait: "bg-amber-600 text-white border-amber-700/60 ring-1 ring-amber-500/30",
    avoid: "bg-red-600 text-white border-red-700/60 ring-1 ring-red-500/30",
    neutral: "bg-neutral-700 text-white border-neutral-800/60 ring-1 ring-neutral-500/30",
  };

  const dotColorsSoft: Record<BadgeVariant, string> = {
    buy: "bg-emerald-500",
    wait: "bg-amber-500",
    avoid: "bg-red-500",
    neutral: "bg-neutral-400",
  };

  const dotColorsSolid: Record<BadgeVariant, string> = {
    buy: "bg-white/90",
    wait: "bg-white/90",
    avoid: "bg-white/90",
    neutral: "bg-white/85",
  };

  const sizeStyles = {
    sm: "text-[11px] px-2 py-0.5 h-5",
    md: "text-xs px-2.5 py-0.5 h-6",
  };

  const base =
    "inline-flex items-center gap-1.5 rounded-full border font-semibold leading-none select-none whitespace-nowrap";

  const style = emphasis === "solid" ? variantsSolid[variant] : variantsSoft[variant];
  const dotColor = emphasis === "solid" ? dotColorsSolid[variant] : dotColorsSoft[variant];

  return (
    <span
      className={[base, style, sizeStyles[size], className].join(" ")}
      {...props}
    >
      {withDot && (
        <span className="relative flex h-2 w-2 items-center justify-center" aria-hidden>
          <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
          {/* subtle “glow” */}
          <span className={`absolute inset-0 rounded-full ${dotColor} opacity-20 blur-[1px]`} />
        </span>
      )}
      {children}
    </span>
  );
}