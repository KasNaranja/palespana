import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { config, COST_GUARD, demoReason, isDemoMode } from "@/lib/config";
import { createSearch, supersedeSearch } from "@/lib/db";
import { getDemoListings } from "@/lib/demo";
import { cleanListings } from "@/lib/filter";
import { startAnalysis } from "@/lib/analyzer";
import { searchPlanned } from "@/lib/searchPlan";
import { ensureRuntimeSampler } from "@/lib/runtimeStats";
import {
  searchListingsPlanned as searchVinted,
  VintedError,
} from "@/lib/vinted";
import {
  searchListings as searchWallapop,
  WallapopError,
} from "@/lib/wallapop";
import { searchListingsPlanned as searchEbay, EbayError } from "@/lib/ebay";
import type {
  ApiError,
  ConsoleKey,
  Listing,
  MarketSource,
  SearchMeta,
  SearchResponse,
  SourceInfo,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CONSOLES: ConsoleKey[] = [
  "todas",
  "ps1",
  "ps2",
  "ps3",
  "ps4",
  "ps5",
  "switch",
  "nintendo_handheld",
  "xbox",
  "otras",
];

const CAP = COST_GUARD.MAX_LISTINGS_PER_SEARCH;

interface SourceResult {
  listings: Listing[];
  error: string | null;
}

/** Fetch + clean one marketplace. Never throws: failures come back as `error`
 *  so one source going down doesn't take the other with it. `preCleaned`:
 *  the fetcher already returns the cleaned, ordered result (eBay, which must
 *  choose before paying one getItem call per listing): only the cap applies. */
async function fetchSource(
  label: string,
  fetcher: () => Promise<Listing[]>,
  query: string,
  consoleKey: ConsoleKey,
  preCleaned = false
): Promise<SourceResult> {
  try {
    const raw = await fetcher();
    const listings = (
      preCleaned ? raw : cleanListings(raw, query, consoleKey)
    ).slice(0, CAP);
    return { listings, error: null };
  } catch (e) {
    let kind: string | undefined;
    if (
      e instanceof VintedError ||
      e instanceof WallapopError ||
      e instanceof EbayError
    )
      kind = e.kind;
    const error =
      kind === "blocked"
        ? `${label} ha bloqueado la petición. Inténtalo en un minuto.`
        : kind === "rate_limited"
          ? `${label} está limitando las peticiones. Inténtalo en un minuto.`
          : `${label} no responde ahora mismo. Inténtalo en un minuto.`;
    return { listings: [], error };
  }
}

export async function POST(req: Request) {
  ensureRuntimeSampler();
  let body: { query?: string; console?: string; supersedes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json<ApiError>(
      { error: "Cuerpo de la petición no válido.", code: "bad_request" },
      { status: 400 }
    );
  }

  // The client replaced its previous search: stop analyzing it (ids are
  // unguessable UUIDs, so only the client that owns one can supersede it).
  if (typeof body.supersedes === "string") supersedeSearch(body.supersedes);

  const query = (body.query || "").trim();
  const consoleKey = (
    VALID_CONSOLES.includes(body.console as ConsoleKey) ? body.console : "todas"
  ) as ConsoleKey;

  if (!query) {
    return NextResponse.json<ApiError>(
      { error: "Escribe el nombre de un juego.", code: "bad_request" },
      { status: 400 }
    );
  }

  const demo = isDemoMode();
  let listings: Listing[] = [];
  let sources: Record<MarketSource, SourceInfo>;

  if (demo) {
    // Demo mode ignores the query filter and always serves the sample search
    // (bundled under Vinted; Wallapop stays empty offline).
    listings = getDemoListings(query).slice(0, CAP);
    sources = {
      vinted: { total: listings.length, error: null },
      wallapop: { total: 0, error: null },
      ebay: { total: 0, error: null },
    };
  } else {
    const skip = Promise.resolve<SourceResult>({ listings: [], error: null });
    const ebayEnabled = !!(config.ebayClientId && config.ebayClientSecret);
    const [vintedRes, wallapopRes, ebayRes] = await Promise.all([
      // Each source runs the search PLAN (searchPlan.ts: focused + plain
      // passes, next pages, short-name pass; merged/deduped); the merge
      // happens BEFORE cleanListings, which dedupes, filters, orders and caps.
      config.vintedEnabled
        ? fetchSource(
            "Vinted",
            // Vinted's wrapper also caps and paces its catalog pages (≤6 per
            // search, shared per-minute budget with the item pages).
            () => searchVinted(query, consoleKey, CAP),
            query,
            consoleKey
          )
        : skip,
      config.wallapopEnabled
        ? fetchSource(
            "Wallapop",
            () =>
              searchPlanned(
                // The PLAIN pass hands "todas" to wallapopKeywords so it falls
                // back to the generic disambiguator ("mario videojuego")
                // instead of re-appending the selected console — which would
                // make the plain pass identical to the focused one and never
                // recover copies whose title omits the console. (Short-name
                // queries already carry the console term.)
                (q, kind) =>
                  searchWallapop(q, kind === "plain" ? "todas" : consoleKey, CAP),
                query,
                consoleKey,
                { cap: CAP }
              ),
            query,
            consoleKey
          )
        : skip,
      ebayEnabled
        ? fetchSource(
            "eBay",
            // eBay plans at the SUMMARY level instead of through searchPlanned:
            // the item_summary/search results are merged, deduped and
            // cleaned BEFORE the per-item getItem photo enrichment, so extra
            // queries don't multiply eBay's daily-quota spend. Its result is
            // final (preCleaned): cleaning that subset again could change the
            // learned sequel target and drop listings already paid for.
            () => searchEbay(query, consoleKey, CAP),
            query,
            consoleKey,
            true
          )
        : skip,
    ]);

    // Analyse in SOURCE ORDER — Vinted first, then Wallapop, then eBay — so the
    // top-priority marketplace (Vinted) is fully classified first instead of all
    // three trickling together. The FETCH above is already parallel; the
    // ANALYSIS can't be (Gemini's rate limit), so this only sets the ORDER in
    // which verdicts appear.
    listings = [
      ...vintedRes.listings,
      ...wallapopRes.listings,
      ...ebayRes.listings,
    ];
    sources = {
      vinted: { total: vintedRes.listings.length, error: vintedRes.error },
      wallapop: {
        total: wallapopRes.listings.length,
        error: wallapopRes.error,
      },
      ebay: { total: ebayRes.listings.length, error: ebayRes.error },
    };

    // Only a hard error if EVERY marketplace failed and we have nothing.
    const anyError =
      vintedRes.error || wallapopRes.error || ebayRes.error;
    const allFailed =
      (!config.vintedEnabled || vintedRes.error) &&
      (!config.wallapopEnabled || wallapopRes.error) &&
      (!ebayEnabled || ebayRes.error);
    if (listings.length === 0 && anyError && allFailed) {
      return NextResponse.json<ApiError>(
        {
          error:
            "Las tiendas no responden ahora mismo. Inténtalo en un minuto.",
          code: "sources_unavailable",
        },
        { status: 503 }
      );
    }
  }

  const meta: SearchMeta = {
    id: randomUUID(),
    query,
    console: consoleKey,
    createdAt: new Date().toISOString(),
    demo,
    total: listings.length,
    sources,
  };

  createSearch(meta, listings);

  // Fire-and-forget: analysis runs in the background; the UI polls /status.
  if (listings.length > 0) {
    void startAnalysis(meta.id);
  }

  const res: SearchResponse = {
    search: meta,
    listings,
    demoReason: demoReason(),
  };
  return NextResponse.json(res, { status: 200 });
}
