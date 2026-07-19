"use client";

import { CONSOLE_OPTIONS, type ConsoleKey } from "@/lib/types";

export function ConsoleChips({
  value,
  onChange,
}: {
  value: ConsoleKey;
  onChange: (key: ConsoleKey) => void;
}) {
  return (
    <div
      className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0"
      role="radiogroup"
      aria-label="Consola"
    >
      {CONSOLE_OPTIONS.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.key)}
            className={[
              "shrink-0 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium transition min-h-[40px]",
              "border",
              active
                ? "bg-brand-600 text-white border-brand-600"
                : "bg-carbon text-texto-2 border-borde-fuerte hover:border-brand-500/60 hover:text-texto-1",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
