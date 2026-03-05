import { useId } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  name?: string;
  size?: "sm" | "md";
  helperText?: string;
  fullWidth?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  name,
  size = "md",
  helperText,
  fullWidth = true,
}: SegmentedControlProps<T>) {
  const id = useId();
  const controlName = name ?? `segmented-${id}`;

  const containerSize =
    size === "sm" ? "p-1" : "p-1.5";
  const optionSize =
    size === "sm" ? "px-3 py-2 text-sm" : "px-4 py-2.5 text-sm";

  return (
    <div role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
        {label}
      </span>

      <div
        className={`
          ${fullWidth ? "w-full" : "inline-flex"}
          ${containerSize}
          inline-flex
          gap-1
          rounded-xl
          border border-neutral-200 dark:border-neutral-700
          bg-white dark:bg-neutral-700/50
          shadow-sm
        `}
        role="radiogroup"
        aria-label={label}
      >
        {options.map((option) => {
          const selected = value === option.value;

          return (
            <label key={option.value} className="cursor-pointer flex-1 min-w-0">
              <input
                type="radio"
                name={controlName}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only peer"
              />

              <span
                className={`
                  ${optionSize}
                  block w-full
                  rounded-lg
                  text-center
                  font-semibold
                  transition-all duration-200
                  border
                  ${
                    selected
                      ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-neutral-900 dark:border-neutral-100 shadow-sm"
                      : "bg-transparent text-neutral-700 dark:text-neutral-300 border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-600/50 hover:text-neutral-900 dark:hover:text-neutral-100"
                  }
                  peer-focus-visible:outline-none
                  peer-focus-visible:ring-2
                  peer-focus-visible:ring-neutral-400/60
                  peer-focus-visible:ring-offset-2
                  peer-focus-visible:ring-offset-white
                `}
              >
                {option.label}
              </span>
            </label>
          );
        })}
      </div>

      {helperText ? (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{helperText}</p>
      ) : null}
    </div>
  );
}