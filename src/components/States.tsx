"use client";

import { Mirilla } from "./Mirilla";

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="mx-auto max-w-md rounded-card border border-verdict-otherBorder bg-verdict-otherBg p-6 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-black/25 text-verdict-other">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 8v5M12 16h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <p className="text-texto-1">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-input bg-brand-600 px-5 py-2.5 font-semibold text-white transition hover:bg-brand-500"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M3 12a9 9 0 1 1 3 6.7M3 20v-5h5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Reintentar
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md rounded-card border border-borde bg-panel p-8 text-center">
      <div className="mx-auto mb-3 flex items-center justify-center">
        <Mirilla size={44} />
      </div>
      <p className="text-lg font-bold text-texto-1">{title}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function DemoBanner({ reason }: { reason: string | null }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-verdict-inconcBorder bg-verdict-inconcBg px-4 py-3 text-sm text-verdict-inconc">
      <span className="mt-0.5 shrink-0 rounded-md bg-black/30 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide">
        Demo
      </span>
      <p className="text-texto-2">
        Estás viendo datos de ejemplo (búsqueda “Pokémon Esmeralda”).{" "}
        {reason ? <span className="text-verdict-inconc">{reason} </span> : null}
        Añade tu clave gratuita de{" "}
        <code className="rounded bg-black/30 px-1 font-mono text-texto-1">
          GEMINI_API_KEY
        </code>{" "}
        y activa{" "}
        <code className="rounded bg-black/30 px-1 font-mono text-texto-1">
          ENABLE_VINTED=true
        </code>{" "}
        para buscar en Vinted, Wallapop y eBay de verdad.
      </p>
    </div>
  );
}
