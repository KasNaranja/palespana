"use client";

// "Hallazgos": live dashboard of the rare tear-strip hunter running on the
// owner's PC (worker/strip-hunter.mjs → /api/hallazgos). Rare strips (PSP,
// Blu-ray Disc… on a PS4 game) are factory errors worth a lot to collectors.

import { useQuery } from "@tanstack/react-query";
import { formatPrice } from "@/lib/format";
import { MARKET_LABELS, type HuntFind, type HuntItem, type HuntSnapshot } from "@/lib/types";

interface HuntResponse {
  enabled: boolean;
  snapshot: HuntSnapshot | null;
  ageSec: number | null;
}

const STATUS_STYLE: Record<HuntSnapshot["status"], string> = {
  running: "bg-verdict-esBg text-verdict-es border-verdict-esBorder",
  waiting_quota: "bg-verdict-inconcBg text-verdict-inconc border-verdict-inconcBorder",
  sleeping: "bg-panel2 text-texto-2 border-borde-fuerte",
  error: "bg-verdict-otherBg text-verdict-other border-verdict-otherBorder",
};

const STATUS_LABEL: Record<HuntSnapshot["status"], string> = {
  running: "Rastreando",
  waiting_quota: "Esperando cuota de la IA",
  sleeping: "En pausa hasta la próxima vuelta",
  error: "Con problemas",
};

const STANDARD = new Set(["PS4", "PlayStation"]);

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

function StripTag({ strip }: { strip: string | null }) {
  const rare = !!strip && !STANDARD.has(strip);
  return (
    <span
      className={[
        "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold",
        !strip
          ? "bg-panel2 text-texto-3"
          : rare
            ? "bg-brand-600 text-white"
            : "bg-gold-500 text-carbon",
      ].join(" ")}
    >
      {strip ?? "sin leer"}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-card border border-borde bg-panel p-3">
      <div className="font-display text-2xl leading-none text-white tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-texto-3">{label}</div>
    </div>
  );
}

function FindCard({ f }: { f: HuntFind }) {
  return (
    <a
      href={f.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col overflow-hidden rounded-card border border-brand-600/60 bg-panel transition hover:border-brand-500"
    >
      <div className="relative aspect-[3/4] w-full bg-carbon">
        {f.photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={f.photo} alt={f.title} loading="lazy" className="h-full w-full object-cover" />
        )}
        <div className="absolute left-1.5 top-1.5 flex gap-1">
          <StripTag strip={f.strip} />
          <span
            className={[
              "rounded px-1.5 py-0.5 text-[11px] font-bold",
              f.confirmed ? "bg-verdict-es text-carbon" : "bg-verdict-inconc text-carbon",
            ].join(" ")}
          >
            {f.confirmed ? "confirmada" : "por confirmar"}
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <div className="clamp-2 text-sm font-bold leading-snug text-texto-1">{f.title}</div>
        <div className="text-xs text-texto-3">
          {MARKET_LABELS[f.source]} · {ago(f.at)}
        </div>
        <div className="mt-auto font-display text-xl text-white">{formatPrice(f.price, "EUR")}</div>
      </div>
    </a>
  );
}

function RecentRow({ it }: { it: HuntItem }) {
  return (
    <a
      href={it.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 border-b border-borde px-3 py-2 last:border-0 hover:bg-white/5"
    >
      {it.photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={it.photo} alt="" loading="lazy" className="h-12 w-9 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-12 w-9 shrink-0 rounded bg-carbon" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-texto-1">{it.title}</div>
        <div className="text-xs text-texto-3">
          {MARKET_LABELS[it.source]} · {formatPrice(it.price, "EUR")} · {ago(it.at)}
        </div>
      </div>
      <StripTag strip={it.strip} />
    </a>
  );
}

export function Hallazgos() {
  const q = useQuery<HuntResponse>({
    queryKey: ["hallazgos"],
    queryFn: async () => {
      const r = await fetch("/api/hallazgos", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 3000,
  });

  const s = q.data?.snapshot ?? null;
  // The PC pushes every few seconds while this page is open: a snapshot this
  // old means the PC is off or the hunter isn't running.
  const offline = q.data && (q.data.ageSec === null || q.data.ageSec > 90);

  return (
    <section className="pt-6">
      <h1 className="font-display text-3xl text-white">Hallazgos</h1>
      <p className="mt-1 max-w-2xl text-sm text-texto-2">
        Tu PC recorre juegos de PS4 precintados en Vinted y Wallapop y lee la tira del precinto.
        Las tiras raras (PSP, Blu-ray Disc, PS3…) son errores de fábrica y aparecen aquí.
      </p>

      {!q.data ? (
        <p className="pt-8 text-texto-3">Cargando…</p>
      ) : !s ? (
        <div className="mt-6 rounded-card border border-borde bg-panel p-5 text-sm text-texto-2">
          {q.data.enabled
            ? "Esperando los primeros datos del rastreador de tu PC… (si tarda más de un minuto, el PC está apagado o el rastreador no está en marcha)."
            : "El rastreador no está configurado en el servidor."}
        </div>
      ) : (
        <div className="mt-5 space-y-6">
          {/* Status */}
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={[
                "rounded-full border px-3 py-1 text-sm font-semibold",
                offline ? STATUS_STYLE.error : STATUS_STYLE[s.status],
              ].join(" ")}
            >
              {offline ? "PC sin conexión" : STATUS_LABEL[s.status]}
            </span>
            <span className="text-sm text-texto-2">{s.statusText}</span>
            <span className="text-xs text-texto-3">actualizado {ago(s.updatedAt)}</span>
          </div>

          {/* Progress through the sweep's searches */}
          {s.query.total > 0 && (
            <div>
              <div className="mb-1 flex justify-between text-xs text-texto-3">
                <span className="truncate">
                  Búsqueda {Math.min(s.query.index + 1, s.query.total)} de {s.query.total}
                  {s.query.text ? ` · «${s.query.text}»` : ""}
                  {s.query.source ? ` en ${MARKET_LABELS[s.query.source]}` : ""}
                </span>
                {s.nextSweepAt && s.status === "sleeping" && (
                  <span>próxima vuelta {new Date(s.nextSweepAt).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</span>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-panel2">
                <div
                  className="h-full rounded-full bg-brand-600 transition-all"
                  style={{ width: `${Math.round((100 * Math.min(s.query.index, s.query.total)) / s.query.total)}%` }}
                />
              </div>
            </div>
          )}

          {/* Counters */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Anuncios vistos" value={s.counts.seen} />
            <Stat label="Precintados analizados" value={s.counts.analyzed} />
            <Stat label="Tiras leídas" value={s.counts.stripRead} />
            <Stat label="Tiras raras" value={s.finds.length} />
          </div>

          {/* Strip distribution */}
          <div className="flex flex-wrap gap-2">
            {Object.entries(s.counts.byStrip)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => (
                <span key={k} className="flex items-center gap-1.5 rounded-full border border-borde bg-panel px-2.5 py-1 text-xs text-texto-2">
                  <StripTag strip={k === "none" ? null : k} />
                  <span className="tabular-nums">{n}</span>
                </span>
              ))}
          </div>

          {/* Finds */}
          <div>
            <h2 className="mb-3 font-display text-xl text-white">Tiras raras ({s.finds.length})</h2>
            {s.finds.length === 0 ? (
              <p className="text-sm text-texto-3">Todavía ninguna. Cuando aparezca una, saldrá aquí con su enlace.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
                {s.finds.map((f) => (
                  <FindCard key={f.key} f={f} />
                ))}
              </div>
            )}
          </div>

          {/* Recent activity */}
          <div>
            <h2 className="mb-3 font-display text-xl text-white">Últimos analizados</h2>
            <div className="rounded-card border border-borde bg-panel">
              {s.recent.length === 0 ? (
                <p className="p-3 text-sm text-texto-3">Nada todavía.</p>
              ) : (
                s.recent.map((it) => <RecentRow key={it.key + it.at} it={it} />)
              )}
            </div>
          </div>

          <p className="text-xs text-texto-3">
            Vinted: {s.bySource.vinted.analyzed} analizados de {s.bySource.vinted.seen} vistos ·
            Wallapop: {s.bySource.wallapop.analyzed} de {s.bySource.wallapop.seen}
            {s.counts.errors ? ` · ${s.counts.errors} errores` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
