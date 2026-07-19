"use client";

import { forwardRef } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  loading?: boolean;
  size?: "hero" | "compact";
}

export const SearchBox = forwardRef<HTMLInputElement, Props>(function SearchBox(
  { value, onChange, onSubmit, loading, size = "hero" },
  ref
) {
  const hero = size === "hero";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className={[
        "flex w-full items-stretch gap-2",
        hero ? "flex-col sm:flex-row" : "flex-row",
      ].join(" ")}
    >
      <div className="relative flex-1">
        <span
          className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-texto-3"
          aria-hidden
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path
              d="m20 20-3-3"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <input
          ref={ref}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="¿Qué juego buscas?"
          aria-label="¿Qué juego buscas?"
          className={[
            "w-full rounded-input border border-borde-fuerte bg-carbon pl-12 pr-4",
            "text-texto-1 placeholder:text-texto-3",
            "focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/25",
            hero ? "h-[52px] text-lg" : "h-12 text-base",
          ].join(" ")}
        />
      </div>
      <button
        type="submit"
        disabled={loading || !value.trim()}
        className={[
          "inline-flex items-center justify-center gap-2 rounded-input bg-brand-600 px-6 font-semibold text-white",
          "transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50",
          hero ? "h-[52px] text-lg" : "h-12 text-base",
        ].join(" ")}
      >
        {loading ? (
          <>
            <Spinner /> Buscando…
          </>
        ) : (
          "Buscar"
        )}
      </button>
    </form>
  );
});

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
