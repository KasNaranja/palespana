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
import { Favorites } from "@/components/Favorites";
import { getStatus, postSearch, CazaApiError } from "@/lib/api";
import { useRecentSearches } from "@/lib/useRecentSearches";
import { useFavorites } from "@/lib/useFavorites";
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
  // "Precintados": show ONLY new+factory-sealed Spanish copies (verdict "es"
  // AND sealed "yes"). Independent of "Solo en español"; same reset rules.
  const [precintados, setPrecintados] = useState(false);
  const [sort, setSort] = useState<SortKey>("total");
  // Footer view: the search (Caza) or the saved favorites list.
  const [view, setView] = useState<"search" | "favorites">("search");

  const inputRef = useRef<HTMLInputElement>(null);
  const lastSubmit = useRef<{ q: string; c: ConsoleKey } | null>(null);
  // Id of the search on screen, sent as `supersedes` with the next search.
  const activeId = useRef<string | null>(null);
  const { recent, add, clear } = useRecentSearches();

  const search = useMutation<SearchResponse, CazaApiError, { q: string; c: ConsoleKey }>(
    {
      mutationFn: ({ q, c }) => postSearch(q, c, activeId.current ?? undefined),
      onSuccess: (data) => {
        activeId.current = data.search.id;
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
    // Keep polling in a background tab: the server pauses the analysis of
    // searches nobody polls (see isSearchWatched), and switching tabs while
    // waiting must not pause yours.
    refetchIntervalInBackground: true,
    // A 404 means the server lost the search (see the effect below): retrying
    // the same id can never succeed, so surface it at once.
    retry: (count, err) =>
      !(err instanceof CazaApiError && err.status === 404) && count < 3,
  });

  // Searches live in the server's memory. When Render restarts the instance
  // (free tier: sleep after inactivity, crash, redeploy) mid-analysis, /status
  // answers 404 forever and the screen froze at "0 de N". Re-run the same
  // search instead, keeping the user's filters. Capped per user search so a
  // server that keeps restarting can't loop us.
  const autoResumes = useRef(0);
  useEffect(() => {
    const err = status.error;
    if (!(err instanceof CazaApiError) || err.status !== 404) return;
    if (!lastSubmit.current || search.isPending || autoResumes.current >= 2) {
      return;
    }
    autoResumes.current += 1;
    search.mutate(lastSubmit.current);
  }, [status.error, search]);

  const submit = useCallback(
    (q: string, c: ConsoleKey) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      lastSubmit.current = { q: trimmed, c };
      autoResumes.current = 0;
      setActive(null);
      setSoloEspanol(false); // always unchecked after a new search
      setPrecintados(false);
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

  // Keyboard shortcuts: "/" focuses search, "s" toggles Solo en español,
  // "p" toggles Precintados.
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
      } else if ((e.key === "p" || e.key === "P") && !typing && active) {
        e.preventDefault();
        setPrecintados((v) => !v);
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
      {view === "favorites" ? (
        <Favorites />
      ) : !showResults ? (
        <section className="mx-auto max-w-2xl pt-8 sm:pt-14">
          {/* Brand logo straight on the dark page background — the PNG is
              transparent and its white "PAL" reads on carbon, so no plate. */}
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/palespana-logo.png"
              alt="PAL España"
              className="h-44 w-auto sm:h-56"
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
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                        <Toggle
                          id="solo-es"
                          checked={soloEspanol}
                          onChange={setSoloEspanol}
                          label="Solo en español"
                        />
                        <Toggle
                          id="precintados"
                          checked={precintados}
                          onChange={setPrecintados}
                          label="Precintados"
                        />
                      </div>
                      <SortDropdown value={sort} onChange={setSort} />
                    </div>
                  </div>

                  <div className="pt-5">
                    <Results
                      key={active.id}
                      listings={listings}
                      soloEspanol={soloEspanol}
                      precintados={precintados}
                      sort={sort}
                    />
                  </div>
                </>
              )}
            </>
          ) : null}
        </section>
      )}

      <Footer view={view} onNav={setView} />
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

function Footer({
  view,
  onNav,
}: {
  view: "search" | "favorites";
  onNav: (v: "search" | "favorites") => void;
}) {
  // Fixed bottom nav, Vinted-style: Caza (buscador) · corazón (favoritos) ·
  // Precios. The white logos read on the dark bar.
  const { count } = useFavorites();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-borde bg-panel"
      aria-label="Navegación"
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around">
        {/* Caza — mirilla + palabra, recreado en código para que los 3 accesos
            sean idénticos en estilo (icono rojo + palabra Anton blanca). */}
        <button
          type="button"
          onClick={() => onNav("search")}
          aria-label="Caza (buscador)"
          aria-current={view === "search"}
          className="flex flex-1 flex-col items-center justify-center gap-1 py-2 transition hover:bg-white/5"
        >
          <Mirilla size={28} />
          <span className="font-display text-[12px] leading-none tracking-wide text-texto-1">
            CAZA
          </span>
        </button>

        {/* Favoritos — mismo lockup pero con corazón rojo + contador */}
        <button
          type="button"
          onClick={() => onNav("favorites")}
          aria-label={`Favoritos${count ? ` (${count})` : ""}`}
          aria-current={view === "favorites"}
          className="relative flex flex-1 flex-col items-center justify-center gap-1 py-2 transition hover:bg-white/5"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            aria-hidden
            fill={view === "favorites" ? "currentColor" : "none"}
            className="text-brand-500"
          >
            <path
              d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-display text-[12px] leading-none tracking-wide text-texto-1">
            FAVORITOS
          </span>
          {count > 0 && (
            <span className="absolute right-[24%] top-0.5 min-w-[17px] rounded-full bg-brand-600 px-1 text-center text-[10px] font-bold leading-[17px] text-white ring-2 ring-panel">
              {count}
            </span>
          )}
        </button>

        {/* Precios — misma mirilla + palabra */}
        <button
          type="button"
          onClick={() => onNav("search")}
          aria-label="Precios"
          className="flex flex-1 flex-col items-center justify-center gap-1 py-2 transition hover:bg-white/5"
        >
          <Mirilla size={28} />
          <span className="font-display text-[12px] leading-none tracking-wide text-texto-1">
            PRECIOS
          </span>
        </button>
      </div>
    </nav>
  );
}
