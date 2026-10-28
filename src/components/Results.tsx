"use client";

import { useMemo, useState } from "react";
import { ListingCard } from "./ListingCard";
import { EmptyState } from "./States";
import type { SortKey } from "./SortDropdown";
import { totalPrice, type Listing, type SealStripText } from "@/lib/types";

// "Tira" filter inside Precintados: which letters the seal's tear strip
// carries. "none" = sealed, but the strip wasn't seen or read in the photos.
type StripKey = "all" | SealStripText | "none";

const STRIP_OPTIONS: { key: StripKey; label: string; always: boolean }[] = [
  { key: "all", label: "Todas", always: true },
  { key: "PS4", label: "Tira PS4", always: true },
  { key: "PlayStation", label: "Tira PlayStation", always: true },
  { key: "PS5", label: "Tira PS5", always: false },
  { key: "PS3", label: "Tira PS3", always: false },
  { key: "PSP", label: "Tira PSP", always: false },
  { key: "PS Vita", label: "Tira PS Vita", always: false },
  { key: "Blu-ray Disc", label: "Tira Blu-ray Disc", always: false },
  { key: "none", label: "Tira sin identificar", always: false },
];

function stripOf(l: Listing): StripKey {
  return l.sealStrip ?? "none";
}

function StripChips({
  value,
  counts,
  onChange,
}: {
  value: StripKey;
  counts: Record<StripKey, number>;
  onChange: (key: StripKey) => void;
}) {
  return (
    <div
      className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0"
      role="radiogroup"
      aria-label="Tira del precinto"
    >
      {STRIP_OPTIONS.filter((o) => o.always || counts[o.key] > 0).map((opt) => {
        const active = opt.key === value;
        const empty = counts[opt.key] === 0 && !active;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={empty}
            onClick={() => onChange(opt.key)}
            className={[
              "shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-medium transition min-h-[40px]",
              active
                ? "border-gold-500 bg-gold-500 text-carbon"
                : "border-borde-fuerte bg-carbon text-texto-2 hover:border-gold-500/60 hover:text-texto-1",
              empty ? "cursor-not-allowed opacity-40 hover:border-borde-fuerte hover:text-texto-2" : "",
            ].join(" ")}
          >
            {opt.label} <span className="tabular-nums opacity-70">({counts[opt.key]})</span>
          </button>
        );
      })}
    </div>
  );
}

function sorter(sort: SortKey) {
  return (a: Listing, b: Listing) => {
    const av = sort === "total" ? totalPrice(a) : a.price;
    const bv = sort === "total" ? totalPrice(b) : b.price;
    return av - bv;
  };
}

function Grid({ listings }: { listings: Listing[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
      {listings.map((l) => (
        <ListingCard key={`${l.source}-${l.vintedId}`} listing={l} />
      ))}
    </div>
  );
}

export function Results({
  listings,
  soloEspanol,
  precintados,
  sort,
}: {
  listings: Listing[];
  soloEspanol: boolean;
  precintados: boolean;
  sort: SortKey;
}) {
  const [strip, setStrip] = useState<StripKey>("all");

  // "Precintados" ON = only copies confirmed BOTH playable in Spanish (Spanish
  // edition "es" OR multi-language disc with ES, "es_multi" — same pair the
  // "Solo en español" toggle shows) AND new with the factory seal intact
  // (sealed "yes"). Applied as a PRE-filter so the grouping below (with "Solo
  // en español" on or off) works unchanged over the reduced list, which already
  // orders "es" before "es_multi".
  const sealedList = useMemo(
    () =>
      precintados
        ? listings.filter(
            (l) =>
              (l.languageVerdict === "es" ||
                l.languageVerdict === "es_multi") &&
              l.sealed === "yes"
          )
        : listings,
    [listings, precintados]
  );

  // Within Precintados, the "Tira" chips narrow to one kind of tear strip.
  const stripCounts = useMemo(() => {
    const counts: Record<StripKey, number> = {
      all: sealedList.length,
      PS4: 0,
      PS5: 0,
      PlayStation: 0,
      PS3: 0,
      PSP: 0,
      "PS Vita": 0,
      "Blu-ray Disc": 0,
      none: 0,
    };
    for (const l of sealedList) counts[stripOf(l)]++;
    return counts;
  }, [sealedList]);

  const visible = useMemo(
    () =>
      precintados && strip !== "all"
        ? sealedList.filter((l) => stripOf(l) === strip)
        : sealedList,
    [sealedList, precintados, strip]
  );

  const analyzing = listings.filter(
    (l) => l.languageVerdict === "pending"
  ).length;
  const stillAnalyzing =
    analyzing > 0
      ? `Todavía se están analizando ${analyzing} ${
          analyzing === 1 ? "anuncio" : "anuncios"
        }; puede aparecer alguna.`
      : null;

  // Precintados filtered everything out → same friendly empty state as the
  // language filter (never a bare, broken grid).
  if (precintados && sealedList.length === 0) {
    return (
      <EmptyState
        title={`Hay ${listings.length} ${
          listings.length === 1 ? "copia" : "copias"
        }, pero ninguna precintada confirmada en español`}
      >
        <p className="text-sm text-texto-3">
          {stillAnalyzing ?? "Desactiva “Precintados” para ver el resto."}
        </p>
      </EmptyState>
    );
  }

  const stripLabel = STRIP_OPTIONS.find((o) => o.key === strip)?.label ?? "";
  // One shape for both modes, so toggling Precintados keeps the grid's state
  // (the expanded "No concluyentes" block).
  return (
    <div className="space-y-4">
      {precintados && (
        <StripChips value={strip} counts={stripCounts} onChange={setStrip} />
      )}
      {precintados && visible.length === 0 ? (
        <EmptyState
          title={`Hay ${sealedList.length} ${
            sealedList.length === 1 ? "precintada" : "precintadas"
          }, pero ninguna con «${stripLabel}»`}
        >
          <p className="text-sm text-texto-3">
            {stillAnalyzing ?? "Elige otra tira para ver el resto."}
          </p>
        </EmptyState>
      ) : (
        <Grouped
          visible={visible}
          total={listings.length}
          soloEspanol={soloEspanol}
          sort={sort}
        />
      )}
    </div>
  );
}

/** The result grid, grouped by language verdict. */
function Grouped({
  visible,
  total,
  soloEspanol,
  sort,
}: {
  visible: Listing[];
  total: number; // listings in the search, before any filter
  soloEspanol: boolean;
  sort: SortKey;
}) {
  const [expandInconclusive, setExpandInconclusive] = useState(false);

  const groups = useMemo(() => {
    const by = sorter(sort);
    // "es" (Spanish edition, 🟢) and "es_multi" (multi-language disc that
    // includes Spanish, 🔵) are kept in SEPARATE groups so we can show the
    // Spanish editions first; within each group we sort by price.
    const es = visible.filter((l) => l.languageVerdict === "es").sort(by);
    const esMulti = visible
      .filter((l) => l.languageVerdict === "es_multi")
      .sort(by);
    const pending = visible
      .filter((l) => l.languageVerdict === "pending")
      .sort(by);
    const inconclusive = visible
      .filter((l) => l.languageVerdict === "inconclusive")
      .sort(by);
    const other = visible
      .filter((l) => l.languageVerdict === "other")
      .sort(by);
    const all = [...visible].sort(by);
    return { es, esMulti, pending, inconclusive, other, all };
  }, [visible, sort]);

  // Toggle OFF (default view): show everything, but grouped by verdict —
  // Spanish editions (🟢) first, then playable-in-Spanish (🔵), then the rest
  // (other / inconclusive / pending). Each block stays sorted by price.
  if (!soloEspanol) {
    const rest = groups.all.filter(
      (l) => l.languageVerdict !== "es" && l.languageVerdict !== "es_multi"
    );
    return <Grid listings={[...groups.es, ...groups.esMulti, ...rest]} />;
  }

  // Toggle ON: Spanish EDITIONS (🟢) first, then playable-in-Spanish (🔵), then
  // anything still analyzing. Each block is already price-sorted. Inconclusive
  // stays collapsed below; "other" (confirmed non-Spanish) is hidden.
  const main = [...groups.es, ...groups.esMulti, ...groups.pending];
  const inconclusiveCount = groups.inconclusive.length;

  // Results exist but none in Spanish (and nothing left pending).
  const noneSpanish =
    groups.es.length === 0 &&
    groups.esMulti.length === 0 &&
    groups.pending.length === 0;

  return (
    <div className="space-y-6">
      {noneSpanish ? (
        <EmptyState
          title={`Hay ${total} ${
            total === 1 ? "copia" : "copias"
          }, pero ninguna confirmada en español`}
        >
          {inconclusiveCount > 0 ? (
            <button
              type="button"
              onClick={() => setExpandInconclusive(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 font-semibold text-white transition hover:bg-brand-700"
            >
              Ver no concluyentes ({inconclusiveCount})
            </button>
          ) : (
            <p className="text-sm text-texto-3">
              Prueba a desactivar “Solo en español” para ver el resto.
            </p>
          )}
        </EmptyState>
      ) : (
        <Grid listings={main} />
      )}

      {inconclusiveCount > 0 && (
        <div className="rounded-card border border-borde bg-panel/60">
          <button
            type="button"
            onClick={() => setExpandInconclusive((v) => !v)}
            aria-expanded={expandInconclusive}
            className="flex w-full items-center justify-between px-4 py-3 text-left"
          >
            <span className="font-semibold text-texto-1">
              No concluyentes ({inconclusiveCount})
            </span>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              className={[
                "text-texto-3 transition",
                expandInconclusive ? "rotate-180" : "",
              ].join(" ")}
              aria-hidden
            >
              <path
                d="m6 9 6 6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {expandInconclusive && (
            <div className="border-t border-borde p-4">
              <Grid listings={groups.inconclusive} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
