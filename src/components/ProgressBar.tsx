"use client";

export function ProgressBar({
  label,
  analyzed,
  total,
  error,
}: {
  label?: string;
  analyzed: number;
  total: number;
  error?: string | null;
}) {
  const pct = total > 0 ? Math.round((analyzed / total) * 100) : 0;
  const done = total > 0 && analyzed >= total;

  const status = error
    ? error
    : total === 0
      ? "Sin resultados"
      : done
        ? "Análisis completado"
        : "Analizando anuncios…";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          {label && (
            <span className="shrink-0 rounded-full bg-panel2 px-2 py-0.5 text-xs font-semibold text-texto-2">
              {label}
            </span>
          )}
          <span
            className={[
              "truncate font-medium",
              error ? "text-verdict-other" : "text-texto-2",
            ].join(" ")}
          >
            {status}
          </span>
        </span>
        {!error && total > 0 && (
          <span className="shrink-0 font-mono tabular-nums text-texto-3">
            {analyzed} de {total}
          </span>
        )}
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-borde"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={Math.max(total, 1)}
        aria-valuenow={analyzed}
        aria-label={label}
      >
        <div
          className={[
            "h-full rounded-full transition-all duration-500",
            error
              ? "bg-verdict-other/50"
              : done
                ? "bg-verdict-es"
                : "bg-brand-500",
          ].join(" ")}
          style={{ width: error ? "100%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}
