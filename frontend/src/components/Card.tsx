import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md" | "lg";
  variant?: "default" | "outline" | "ghost";
  hover?: boolean; // kept for compatibility, but no longer changes layout
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      padding = "md",
      variant = "default",
      className = "",
      children,
      ...props
    },
    ref
  ) => {
    const paddingClasses = {
      none: "",
      sm: "p-4",
      md: "p-5",
      lg: "p-6",
    };

    const variantClasses = {
      default: "bg-white dark:bg-neutral-800 border border-neutral-200/70 dark:border-neutral-700/60 shadow-sm",
      outline: "bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 shadow-none",
      ghost: "bg-transparent border border-transparent shadow-none",
    };

    return (
      <div
        ref={ref}
        className={`
          rounded-2xl
          ${paddingClasses[padding]}
          ${variantClasses[variant]}
          transition-colors duration-150
          ${className}
        `}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = "Card";