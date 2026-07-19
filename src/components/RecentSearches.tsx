"use client";

import type { RecentSearch } from "@/lib/useRecentSearches";
import { CONSOLE_OPTIONS } from "@/lib/types";

function consoleLabel(key: string): string {
  return CONSOLE_OPTIONS.find((c) => c.key === key)?.label ?? "Todas";
}

export function RecentSearches({
  items,
  onPick,
  onClear,
}: {
  items: RecentSearch[];
  onPick: (r: RecentSearch) => void;
  onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-texto-2">
          Búsquedas recientes
        </h2>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-texto-3 hover:text-texto-1"
        >
          Borrar
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((r, i) => (
          <button
            key={`${r.query}-${i}`}
            type="button"
            onClick={() => onPick(r)}
            className="group inline-flex items-center gap-1.5 rounded-full border border-borde-fuerte bg-carbon px-3 py-2 text-sm text-texto-2 transition hover:border-brand-500/60 hover:text-texto-1 min-h-[40px]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              className="text-texto-3 group-hover:text-brand-500"
              aria-hidden
            >
              <path
                d="M12 8v4l3 2M21 12a9 9 0 1 1-9-9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span className="font-medium">{r.query}</span>
            {r.console !== "todas" && (
              <span className="text-xs text-texto-3">
                · {consoleLabel(r.console)}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
