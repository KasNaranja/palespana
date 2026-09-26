// ─────────────────────────────────────────────────────────────
// Per-source search plan: which queries (and pages) each marketplace runs for
// one user search, and how their results are merged before cleanListings.
//
//   round 1  console-focused query + plain query (the "dual" search)
//   round 2  in parallel, both optional:
//            · the SHORT-NAME pass (see shortNameQueries), requested first
//            · the NEXT page of a pass whose first page came back full, while
//              the first pages left fewer LEADING candidates (the searched
//              game for sure, title naming the chosen console) than the cap
//              (only sources that page by request — Vinted)
//
// Lives outside the route so it can be exercised without Next.js (the recall
// harness compiles src/lib standalone and replays real searches).
// ─────────────────────────────────────────────────────────────

import {
  dedupe,
  leadingCandidates,
  nameTokens,
  queryHead,
  sequelSpellings,
  sequelTargetOf,
  shortFormAttested,
} from "./filter";
import type { ConsoleKey, Listing } from "./types";

// Focus term appended to the query in the SECOND, console-focused search of
// the dual round. Searching only by game name dilutes each store's ~96
// relevance-ranked results among metal plates, comics and other-platform
// versions; adding the console centers them. We do BOTH searches because
// focusing alone would drop copies whose title never mentions the console
// (e.g. a PS4 copy titled just "Under the Waves" — the historic reason
// vinted.ts never appended it to the query).
// "todas" and "otras" have no focus term: plain single search as before.
const CONSOLE_FOCUS_TERM: Partial<Record<ConsoleKey, string>> = {
  ps1: "ps1",
  ps2: "ps2",
  ps3: "ps3",
  ps4: "ps4",
  ps5: "ps5",
  switch: "switch",
  xbox: "xbox",
  nintendo_handheld: "nintendo ds",
};

/** The console-focused variant of `query`, or null when the dual search must
 *  collapse to a single plain search: either this console has no focus term
 *  ("todas"/"otras"), or the user already typed it ("elden ring ps5" with the
 *  PS5 chip) — appending it again ("elden ring ps5 ps5") would make the second
 *  pass return a near-identical set that the dedupe throws away entirely. */
export function focusedQueryFor(
  query: string,
  consoleKey: ConsoleKey
): string | null {
  const focusTerm = CONSOLE_FOCUS_TERM[consoleKey];
  if (!focusTerm || query.toLowerCase().includes(focusTerm.toLowerCase())) {
    return null;
  }
  return `${query} ${focusTerm}`;
}

/** Significant tokens of the game's NAME (platform words don't count) needed
 *  before the short-name pass kicks in: short queries already ARE the short
 *  name. */
const SHORT_NAME_MIN_TOKENS = 4;

/**
 * The SHORT-NAME pass. Users type the official title ("dark souls scholar of
 * the first sin"); sellers list the short, numbered name ("Dark Souls 2 PS4",
 * "Dark Souls II PS4"), which neither Vinted nor Wallapop return for the long
 * query. When the name has ≥4 significant tokens, the STRONG matches found so
 * far agree on a sequel number (or the query carries one) AND sellers really
 * write "<head> <number>" (shortFormAttested — otherwise "call of duty modern
 * warfare 2" would search "call of duty 2", another game), search the short
 * name too: "<head> <number> <console>", once with the digit and once with the
 * roman numeral. Generic — the head and the number are learned from the query
 * and the data. [] when the pass doesn't apply.
 */
export function shortNameQueries(
  query: string,
  consoleKey: ConsoleKey,
  found: Listing[]
): string[] {
  if (nameTokens(query).length < SHORT_NAME_MIN_TOKENS) return [];
  const head = queryHead(query);
  if (!head) return [];
  const target = sequelTargetOf(found, query, consoleKey);
  if (!target || !shortFormAttested(found, query, consoleKey, target)) return [];
  const focus = CONSOLE_FOCUS_TERM[consoleKey];
  const already = new Set(
    [query, focusedQueryFor(query, consoleKey) ?? ""].map((q) =>
      q.toLowerCase().trim()
    )
  );
  const out: string[] = [];
  for (const n of sequelSpellings(target)) {
    const q = [head, n, focus].filter(Boolean).join(" ");
    if (!already.has(q) && !out.includes(q)) out.push(q);
  }
  return out;
}

/** Round-robin merge (a[0], b[0], c[0], a[1], …), deduped by `key` keeping
 *  the first occurrence. Round-robin so every pass gets a fair share of the
 *  downstream cap when keys tie in cleanListings' sort. */
export function interleave<T>(lists: T[][], key: (item: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      if (i >= list.length) continue;
      const k = key(list[i]);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(list[i]);
    }
  }
  return out;
}

const byId = (l: Listing) => l.vintedId;

/** Which pass a search request belongs to. "short" passes are extras: a
 *  source may run them at lower priority (Vinted skips them when its rate
 *  budget is tight). */
export type PassKind = "focused" | "plain" | "short";

export interface SearchPlanOptions {
  /** The route's per-source cap: next pages are only worth fetching while
   *  the first pages left fewer leading candidates than this. */
  cap: number;
  /** Fetch the NEXT page of a pass given its first page (return [] when it
   *  wasn't full). Only for sources that page per request (Vinted); Wallapop
   *  pages inside its own searchListings and eBay plans at summary level. */
  nextPage?: (q: string, kind: PassKind, firstPage: Listing[]) => Promise<Listing[]>;
}

/**
 * Run a source's search plan (see the header) and merge the results:
 * the dual passes INTERLEAVED 1:1 (each pass = its page 1 then page 2), then
 * the short-name passes, deduped by `vintedId` (the source-local generic id on
 * every Listing regardless of marketplace). Merge order only breaks ties:
 * cleanListings then orders by console-in-title and relevance before the cap.
 *
 * Errors: if one dual pass fails we use the other; if every dual pass fails we
 * rethrow the first error so the caller classifies it as before. Round-2
 * requests are best-effort (a failure just adds nothing).
 *
 * `searchFn` receives the pass kind, so sources that shape their own keywords
 * (Wallapop appends a console/disambiguator term) can keep the plain pass
 * genuinely plain instead of re-appending the console and turning it into a
 * copy of the focused pass. With no focused variant (no console chip, or the
 * query already names it) round 1 is a single pass of kind "focused": the
 * query as typed already carries whatever console focus there is.
 *
 * Cost per search, console chip selected: 2 searchFn calls in round 1, plus
 * up to 2 next pages, plus 2 short-name queries when that pass applies. In
 * HTTP requests per store that is:
 *   · Vinted ≤ 6 catalog pages (MAX_CATALOG_PAGES_PER_SEARCH) + the homepage
 *     bootstrap when the session is cold, all through its rate limiter;
 *   · Wallapop ≤ 12: each searchFn call pages up to 3 times (searchListings'
 *     MAX_PAGES) while it has fewer than `cap` relevant matches. The short
 *     queries page too on purpose: on the real DS2 search their pages 2-3
 *     held 3 of the 24 DS2 copies found (the cheapest one, 10 €, among them);
 *   · eBay 3 searches + 4 short-name searches + ≤ `cap` getItem (planned at
 *     summary level in ebay.ts, not here).
 * Gemini spend is bounded by the per-source cap, not by how many candidates
 * the passes find.
 */
export async function searchPlanned(
  searchFn: (q: string, kind: PassKind) => Promise<Listing[]>,
  query: string,
  consoleKey: ConsoleKey,
  opts: SearchPlanOptions
): Promise<Listing[]> {
  const focusedQuery = focusedQueryFor(query, consoleKey);
  const passes: Array<{ q: string; kind: PassKind }> = focusedQuery
    ? [
        { q: focusedQuery, kind: "focused" },
        { q: query, kind: "plain" },
      ]
    : [{ q: query, kind: "focused" }];

  // Round 1: the dual passes, in parallel.
  const settled = await Promise.allSettled(
    passes.map((p) => searchFn(p.q, p.kind))
  );
  if (settled.every((r) => r.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  const firstPages = settled.map((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  const round1 = interleave(firstPages, byId);

  // Round 2: next pages + short-name pass, all in parallel. A next page can
  // only change the capped result while the LEADING candidates (the searched
  // game for sure, with a title that names the chosen console: the block
  // cleanListings puts first) don't fill the cap yet: counting every
  // candidate skipped page 2 exactly when it mattered (DS2: plenty of
  // title-only and compilation candidates, few "… PS4").
  const leading = leadingCandidates(round1, query, consoleKey);
  const fetchNext =
    opts.nextPage && leading.length < opts.cap ? opts.nextPage : null;
  const shorts = shortNameQueries(query, consoleKey, round1);
  const none = Promise.resolve<Listing[]>([]);
  // The short-name requests are STARTED first: when a source's rate budget
  // is tight (Vinted), the scarce slots go to them. Measured on the real DS2
  // search, the short pass put 14 new copies in Vinted's capped 50 while page
  // 2 added none that the short pass didn't already bring.
  const shortPagesP = Promise.all(
    shorts.map((q) => searchFn(q, "short").catch(() => [] as Listing[]))
  );
  const nextPagesP = Promise.all(
    passes.map((p, i) =>
      fetchNext && settled[i].status === "fulfilled"
        ? fetchNext(p.q, p.kind, firstPages[i]).catch(() => [] as Listing[])
        : none
    )
  );
  const [shortPages, nextPages] = await Promise.all([shortPagesP, nextPagesP]);

  const dual = interleave(
    passes.map((_, i) => [...firstPages[i], ...nextPages[i]]),
    byId
  );
  return dedupe([...dual, ...interleave(shortPages, byId)]);
}
