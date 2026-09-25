"use client";

import { useMemo, useState } from "react";
import { ListingCard } from "./ListingCard";
import { EmptyState } from "./States";
import type { SortKey } from "./SortDropdown";
import { totalPrice, type Listing } from "@/lib/types";

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
  const [expandInconclusive, setExpandInconclusive] = useState(false);

  // "Precintados" ON = only copies confirmed BOTH playable in Spanish (Spanish
  // edition "es" OR multi-language disc with ES, "es_multi" — same pair the
  // "Solo en español" toggle shows) AND new with the factory seal intact
  // (sealed "yes"). Applied as a PRE-filter so the grouping below (with "Solo
  // en español" on or off) works unchanged over the reduced list, which already
  // orders "es" before "es_multi".
  const visible = useMemo(
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

  // Precintados filtered everything out → same friendly empty state as the
  // language filter (never a bare, broken grid).
  if (precintados && visible.length === 0) {
    const analyzing = listings.filter(
      (l) => l.languageVerdict === "pending"
    ).length;
    return (
      <EmptyState
        title={`Hay ${listings.length} ${
          listings.length === 1 ? "copia" : "copias"
        }, pero ninguna precintada confirmada en español`}
      >
        <p className="text-sm text-texto-3">
          {analyzing > 0
            ? `Todavía se están analizando ${analyzing} ${
                analyzing === 1 ? "anuncio" : "anuncios"
              }; puede aparecer alguna.`
            : "Desactiva “Precintados” para ver el resto."}
        </p>
      </EmptyState>
    );
  }

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
          title={`Hay ${listings.length} ${
            listings.length === 1 ? "copia" : "copias"
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
