"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { SearchBox } from "@/components/SearchBox";
import { ConsoleChips } from "@/components/ConsoleChips";
import { RecentSearches } from "@/components/RecentSearches";
import { ProgressBar } from "@/components/ProgressBar";
import { Toggle } from "@/components/Toggle";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import { Results } from "@/components/Results";
import { DemoBanner, EmptyState, ErrorState } from "@/components/States";
import { Mirilla } from "@/components/Mirilla";
import { getStatus, postSearch, CazaApiError } from "@/lib/api";
import { useRecentSearches } from "@/lib/useRecentSearches";
import { consoleKeep } from "@/lib/filter";
import { MARKET_LABELS, MARKET_SOURCES } from "@/lib/types";
import type {
  ConsoleKey,
  Listing,
  MarketSource,
  SearchResponse,
  SourceInfo,
  SourceProgress,
} from "@/lib/types";

interface ActiveSearch {
  id: string;
  query: string;
  console: ConsoleKey;
  demo: boolean;
  demoReason: string | null;
  initial: Listing[];
  total: number;
  sources: Record<MarketSource, SourceInfo>;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [consoleKey, setConsoleKey] = useState<ConsoleKey>("todas");
  const [active, setActive] = useState<ActiveSearch | null>(null);
  // "Solo en español" starts OFF so a fresh search shows every result; the user
  // turns it on when they want to filter. Also reset to OFF on each new search.
  const [soloEspanol, setSoloEspanol] = useState(false);
  const [sort, setSort] = useState<SortKey>("total");

  const inputRef = useRef<HTMLInputElement>(null);
  const lastSubmit = useRef<{ q: string; c: ConsoleKey } | null>(null);
  const { recent, add, clear } = useRecentSearches();

  const search = useMutation<SearchResponse, CazaApiError, { q: string; c: ConsoleKey }>(
    {
      mutationFn: ({ q, c }) => postSearch(q, c),
      onSuccess: (data) => {
        setActive({
          id: data.search.id,
          query: data.search.query,
          console: data.search.console,
          demo: data.search.demo,
          demoReason: data.demoReason ?? null,
          initial: data.listings,
          total: data.search.total,
          sources: data.search.sources,
        });
        add(data.search.query, consoleKey);
      },
    }
  );

  const status = useQuery({
    queryKey: ["status", active?.id],
    queryFn: () => getStatus(active!.id),
    enabled: !!active && active.total > 0,
    refetchInterval: (q) => (q.state.data?.done ? false : 1500),
  });

  const submit = useCallback(
    (q: string, c: ConsoleKey) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      lastSubmit.current = { q: trimmed, c };
      setActive(null);
      setSoloEspanol(false); // always unchecked after a new search
      search.mutate({ q: trimmed, c });
    },
    [search]
  );

  const onSubmit = () => submit(query, consoleKey);

  const retry = () => {
    if (lastSubmit.current) {
      submit(lastSubmit.current.q, lastSubmit.current.c);
    }
  };

  // Keyboard shortcuts: "/" focuses search, "s" toggles Solo en español.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if ((e.key === "s" || e.key === "S") && !typing && active) {
        e.preventDefault();
        setSoloEspanol((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Base listings from the live poll (or the initial payload before the first
  // poll). Keep a listing if its TITLE names the search's console (seller is
  // authoritative) OR the AI didn't confidently read a DIFFERENT one. So only
  // ambiguous-title copies (e.g. a PS3 disc titled just "The Evil Within") get
  // hidden by the AI; a listing that says "PS4" is never dropped by a misread.
  const listings = (status.data?.listings ?? active?.initial ?? []).filter((l) =>
    consoleKeep(l.title, l.detectedPlatform, active?.console ?? "todas")
  );
  const total = active?.total ?? 0;
  const showResults = !!active || search.isPending;

  // Live per-source progress for the two bars: prefer the polled status; before
  // the first poll, fall back to the initial per-source totals with 0 analyzed.
  const sourceProgress = (src: MarketSource): SourceProgress => {
    const live = status.data?.sources?.[src];
    if (live) return live;
    const init = active?.sources?.[src];
    return { total: init?.total ?? 0, analyzed: 0, error: init?.error ?? null };
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 pb-24">
      {!showResults ? (
        <section className="mx-auto max-w-2xl pt-8 sm:pt-14">
          {/* Brand logo on a dark panel so the white "PAL" shows clearly. */}
          <div className="mx-auto flex max-w-xs items-center justify-center rounded-3xl border border-borde bg-panel px-6 py-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/palespana-logo.png"
              alt="PAL España"
              className="h-40 w-auto sm:h-48"
            />
          </div>
          <p className="mx-auto mt-5 max-w-lg text-center text-texto-2">
            Buscamos en Vinted, Wallapop y eBay y analizamos las fotos con IA para enseñarte solo
            las copias en castellano, de la más barata a la más cara.
          </p>

          <div className="mt-8">
            <SearchBox
              ref={inputRef}
              value={query}
              onChange={setQuery}
              onSubmit={onSubmit}
              loading={search.isPending}
            />
            <div className="mt-4">
              <ConsoleChips value={consoleKey} onChange={setConsoleKey} />
            </div>
          </div>

          <RecentSearches
            items={recent}
            onPick={(r) => {
              setQuery(r.query);
              setConsoleKey(r.console);
              submit(r.query, r.console);
            }}
            onClear={clear}
          />
        </section>
      ) : (
        <section className="pt-4">
          {/* Compact search bar */}
          <div className="mb-4">
            <SearchBox
              ref={inputRef}
              value={query}
              onChange={setQuery}
              onSubmit={onSubmit}
              loading={search.isPending}
              size="compact"
            />
            <div className="mt-3">
              <ConsoleChips value={consoleKey} onChange={setConsoleKey} />
            </div>
          </div>

          {search.isError ? (
            <div className="pt-10">
              <ErrorState message={search.error.message} onRetry={retry} />
            </div>
          ) : search.isPending ? (
            <div>
              <div className="flex items-center justify-center gap-3 py-6 text-texto-2">
                <Mirilla size={30} spinning />
                <span className="text-sm">Rastreando Vinted, Wallapop y eBay…</span>
              </div>
              <SkeletonGrid />
            </div>
          ) : active ? (
            <>
              {active.demo && (
                <div className="mb-4">
                  <DemoBanner reason={active.demoReason} />
                </div>
              )}

              {total === 0 ? (
                <div className="pt-10">
                  <EmptyState title="No hay anuncios de ese juego ahora mismo en Vinted, Wallapop ni eBay">
                    <p className="text-sm text-texto-3">
                      Prueba con otro título o revisa la ortografía.
                    </p>
                  </EmptyState>
                </div>
              ) : (
                <>
                  {/* Sticky controls */}
                  <div className="sticky top-0 z-20 -mx-4 border-b border-borde bg-carbon/95 px-4 py-3 backdrop-blur">
                    <div className="space-y-2">
                      {MARKET_SOURCES.map((src) => {
                        const sp = sourceProgress(src);
                        return (
                          <ProgressBar
                            key={src}
                            label={MARKET_LABELS[src]}
                            analyzed={sp.analyzed}
                            total={sp.total}
                            error={sp.error}
                          />
                        );
                      })}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <Toggle
                        id="solo-es"
                        checked={soloEspanol}
                        onChange={setSoloEspanol}
                        label="Solo en español"
                      />
                      <SortDropdown value={sort} onChange={setSort} />
                    </div>
                  </div>

                  <div className="pt-5">
                    <Results
                      key={active.id}
                      listings={listings}
                      soloEspanol={soloEspanol}
                      sort={sort}
                    />
                  </div>
                </>
              )}
            </>
          ) : null}
        </section>
      )}

      <Footer />
    </main>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-2.5 pt-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-card border border-borde bg-panel"
        >
          <div className="aspect-[3/4] w-full animate-pulseSoft bg-carbon" />
          <div className="space-y-2 p-3">
            <div className="h-4 w-4/5 animate-pulseSoft rounded bg-panel2" />
            <div className="h-4 w-2/5 animate-pulseSoft rounded bg-panel2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Footer() {
  // Fixed bottom navigation bar, Vinted-style. Dark so the white "CAZA"/"PRECIOS"
  // logos read. Both link to the home page for now.
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-borde bg-panel"
      aria-label="Navegación"
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around">
        <a
          href="/"
          aria-label="Caza"
          className="flex flex-1 items-center justify-center py-1.5 transition hover:bg-white/5"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/caza-logo.png"
            alt="Caza"
            className="h-14 w-auto"
          />
        </a>
        <a
          href="/"
          aria-label="Precios"
          className="flex flex-1 items-center justify-center py-1.5 transition hover:bg-white/5"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/precios-logo.png"
            alt="Precios"
            className="h-14 w-auto"
          />
        </a>
      </div>
    </nav>
  );
}
