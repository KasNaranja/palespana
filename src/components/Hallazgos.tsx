"use client";

// "Hallazgos": live dashboard of the rare tear-strip hunter running on the
// owner's PC (worker/strip-hunter.mjs → /api/hallazgos). Rare strips (PSP,
// Blu-ray Disc… on a PS4 game) are factory errors worth a lot to collectors.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatPrice } from "@/lib/format";
import { signalPc } from "@/lib/pcSignal";
import {
  MARKET_LABELS,
  MARKET_SOURCES,
  type HuntFind,
  type HuntGame,
  type HuntItem,
  type HuntSnapshot,
} from "@/lib/types";

interface HuntResponse {
  enabled: boolean;
  snapshot: HuntSnapshot | null;
  ageSec: number | null;
}

const STATUS_STYLE: Record<HuntSnapshot["status"], string> = {
  running: "bg-verdict-esBg text-verdict-es border-verdict-esBorder",
  paused: "bg-panel2 text-texto-1 border-borde-fuerte",
  waiting_quota: "bg-verdict-inconcBg text-verdict-inconc border-verdict-inconcBorder",
  sleeping: "bg-panel2 text-texto-2 border-borde-fuerte",
  error: "bg-verdict-otherBg text-verdict-other border-verdict-otherBorder",
};

const STATUS_LABEL: Record<HuntSnapshot["status"], string> = {
  running: "Rastreando",
  paused: "En pausa",
  waiting_quota: "Esperando a la IA",
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

// Letters a strip can carry; any other key in counts.byStrip is a reason it
// wasn't read ("tira ilegible", "sin tira visible"…; "none" = counted before
// the reasons existed).
const LETTERS = new Set(["PS4", "PS5", "PlayStation", "PS3", "PSP", "PS Vita", "Blu-ray Disc", "otras letras"]);

function StripTag({ strip, reason }: { strip: string | null; reason?: string | null }) {
  const rare = !!strip && !STANDARD.has(strip);
  return (
    <span
      className={[
        "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold",
        strip
          ? rare
            ? "bg-brand-600 text-white"
            : "bg-gold-500 text-carbon"
          : reason === "tira ilegible"
            ? "bg-verdict-inconcBg text-verdict-inconc" // worth a look by hand
            : "bg-panel2 text-texto-3",
      ].join(" ")}
    >
      {strip ?? reason ?? "sin leer"}
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

const GAME_STATUS: Record<HuntGame["status"], string> = {
  done: "hecho",
  current: "ahora",
  pending: "pendiente",
};

function Num({ n, strong }: { n: number; strong?: boolean }) {
  return (
    <td
      className={[
        "px-2 py-2 text-right tabular-nums",
        n === 0 ? "text-texto-3" : strong ? "font-bold text-brand-500" : "text-texto-1",
      ].join(" ")}
    >
      {n}
    </td>
  );
}

// Every copy of each game: the main view. Pending games are folded away.
function GameTable({ games }: { games: HuntGame[] }) {
  const [showPending, setShowPending] = useState(false);
  const started = games.filter((g) => g.status !== "pending");
  const pending = games.filter((g) => g.status === "pending");
  const rows = showPending ? games : started;
  return (
    <div className="overflow-x-auto rounded-card border border-borde bg-panel">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs text-texto-3">
            <th className="px-3 py-2 font-medium">Juego</th>
            <th className="px-2 py-2 text-right font-medium">Anuncios</th>
            <th className="px-2 py-2 text-right font-medium">Precintados</th>
            <th className="px-2 py-2 text-right font-medium">Tira PS4</th>
            <th className="px-2 py-2 text-right font-medium">Tira PlayStation</th>
            <th className="px-2 py-2 text-right font-medium">Raras</th>
            <th className="px-2 py-2 text-right font-medium">Sin leer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr
              key={g.name}
              className={["border-t border-borde", g.status === "current" ? "bg-white/5" : ""].join(" ")}
            >
              <td className="px-3 py-2">
                <span className="capitalize text-texto-1">{g.name}</span>
                <span
                  className={[
                    "ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
                    g.status === "current"
                      ? "bg-verdict-esBg text-verdict-es"
                      : g.status === "done"
                        ? "bg-panel2 text-texto-2"
                        : "text-texto-3",
                  ].join(" ")}
                >
                  {GAME_STATUS[g.status]}
                </span>
              </td>
              <Num n={g.seen} />
              <Num n={g.sealed} />
              <Num n={g.ps4} />
              <Num n={g.playstation} />
              <Num n={g.rare} strong />
              <Num n={g.unread} />
            </tr>
          ))}
        </tbody>
      </table>
      {pending.length > 0 && (
        <button
          type="button"
          onClick={() => setShowPending((v) => !v)}
          className="w-full border-t border-borde px-3 py-2 text-left text-xs text-texto-3 hover:text-texto-1"
        >
          {showPending ? "Ocultar pendientes" : `Ver los ${pending.length} juegos pendientes`}
        </button>
      )}
    </div>
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
      <StripTag strip={it.strip} reason={it.reason} />
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
  const age = q.data?.ageSec ?? null;

  // Ask the PC for fresh data while this page is open and the snapshot is
  // getting old (it then pushes every few seconds while we watch).
  const lastAsk = useRef(0);
  useEffect(() => {
    if (!q.data?.enabled) return;
    if ((age === null || age > 10) && Date.now() - lastAsk.current > 20_000) {
      lastAsk.current = Date.now();
      void signalPc("hunt", "report");
    }
  }, [q.data, age]);

  // The PC answers within seconds: a snapshot this old, after asking, means
  // the PC is off or the hunter isn't running.
  const offline = q.data && (age === null || age > 90);

  // Play / pause: the command travels to the PC; the status updates once
  // the PC pushes its next snapshot, so show the request meanwhile.
  const [sent, setSent] = useState<"play" | "pause" | null>(null);
  useEffect(() => {
    if (!sent || !s) return;
    if ((sent === "pause") === (s.status === "paused")) setSent(null);
  }, [s, sent]);
  function command(c: "play" | "pause") {
    setSent(c);
    lastAsk.current = Date.now();
    void signalPc("hunt", c);
  }

  return (
    <section className="pt-6">
      <h1 className="font-display text-3xl text-white">Hallazgos</h1>
      <p className="mt-1 max-w-2xl text-sm text-texto-2">
        Tu PC recorre, juego a juego (PS4 de 2013 a 2017), todos sus anuncios en Vinted y Wallapop
        y lee la tira del precinto de cada copia precintada.
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
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => command("play")}
                disabled={!offline && s.status === "running"}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-verdict-es px-4 font-semibold text-carbon transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="currentColor"><path d="M7 4v16l13-8z" /></svg>
                {sent === "play" ? "Enviando…" : "Play"}
              </button>
              <button
                type="button"
                onClick={() => command("pause")}
                disabled={!offline && s.status === "paused"}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-borde-fuerte bg-panel px-4 font-semibold text-texto-1 transition hover:border-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
                {sent === "pause" ? "Enviando…" : "Pausa"}
              </button>
            </div>
          </div>

          {/* Progress through the sweep's searches */}
          {s.query.total > 0 && (
            <div>
              <div className="mb-1 flex justify-between text-xs text-texto-3">
                <span className="truncate">
                  {s.games ? "Juego" : "Búsqueda"} {Math.min(s.query.index + 1, s.query.total)} de {s.query.total}
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

          {/* Per game */}
          {s.games && (
            <div>
              <h2 className="mb-3 font-display text-xl text-white">Resumen por juego</h2>
              <GameTable games={s.games} />
            </div>
          )}

          <details className="group rounded-card border border-borde bg-panel">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm text-texto-2 hover:text-texto-1">
              Detalle por plataforma y motivos
            </summary>
            <div className="space-y-4 border-t border-borde p-3">
          {/* Per marketplace */}
          <div className="overflow-hidden rounded-card border border-borde bg-panel">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-texto-3">
                  <th className="px-3 py-2 font-medium">Plataforma</th>
                  <th className="px-3 py-2 text-right font-medium">Vistos</th>
                  <th className="px-3 py-2 text-right font-medium">Precintados analizados</th>
                  <th className="px-3 py-2 text-right font-medium">Tiras leídas</th>
                </tr>
              </thead>
              <tbody>
                {MARKET_SOURCES.map((src) => {
                  const b = s.bySource[src] ?? { seen: 0, analyzed: 0, stripRead: 0 };
                  const off = s.sources && !s.sources.includes(src);
                  return (
                    <tr key={src} className="border-t border-borde">
                      <td className="px-3 py-2 text-texto-1">{MARKET_LABELS[src]}</td>
                      {off ? (
                        <td colSpan={3} className="px-3 py-2 text-right text-xs text-texto-3">
                          no se rastrea (faltan sus claves en el PC)
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right tabular-nums text-texto-2">{b.seen}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-texto-2">{b.analyzed}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-texto-1">{b.stripRead ?? 0}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Strip distribution */}
          <div className="flex flex-wrap gap-2">
            {Object.entries(s.counts.byStrip)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => (
                <span key={k} className="flex items-center gap-1.5 rounded-full border border-borde bg-panel px-2.5 py-1 text-xs text-texto-2">
                  {LETTERS.has(k) ? (
                    <StripTag strip={k} />
                  ) : (
                    <StripTag strip={null} reason={k === "none" ? "sin leer (antes del desglose)" : k} />
                  )}
                  <span className="tabular-nums">{n}</span>
                </span>
              ))}
          </div>
            </div>
          </details>

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

          {s.counts.errors > 0 && (
            <p className="text-xs text-texto-3">{s.counts.errors} errores (se reintentan en la siguiente vuelta)</p>
          )}
        </div>
      )}
    </section>
  );
}
