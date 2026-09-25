// ─────────────────────────────────────────────────────────────
// Dual per-console search plan (plain query + console-focused query).
//
// Lives outside the route so it can be exercised without Next.js (the recall
// harness compiles src/lib standalone and replays real searches).
// ─────────────────────────────────────────────────────────────

import type { ConsoleKey, Listing } from "./types";

// Focus term appended to the query in the SECOND, console-focused search of
// searchDual(). Searching only by game name dilutes each store's ~96
// relevance-ranked results among metal plates, comics and other-platform
// versions; adding the console centers them. We do BOTH searches (see
// searchDual) because focusing alone would drop copies whose title never
// mentions the console (e.g. a PS4 copy titled just "Under the Waves" —
// the historic reason vinted.ts never appended it to the query).
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

/** Run a source's search twice — console-focused query plus plain query — and
 *  merge, INTERLEAVED 1:1 (focused[0], plain[0], focused[1], plain[1], …).
 *  Interleaving matters because the route caps the cleaned merge per source:
 *  if all focused results went first, a popular game would fill the whole cap
 *  with console-titled hits and push out the plain-pass-only copies whose
 *  title never names the console — the exact case this dual search exists to
 *  recover. Deduped by `vintedId` (the source-local generic id on every
 *  Listing regardless of marketplace). If one of the two searches fails we use
 *  the other; if BOTH fail we rethrow the first error so the caller classifies
 *  it as before.
 *
 *  `searchFn` receives whether its pass is the console-FOCUSED one, so sources
 *  that shape their own keywords (Wallapop appends a console/disambiguator
 *  term) can keep the plain pass genuinely plain instead of re-appending the
 *  console and turning it into a copy of the focused pass.
 *
 *  Cost note: with a console chip selected, each source makes 2 search
 *  requests instead of 1 (for Vinted that's 2 HTML pages of ~7MB —
 *  acceptable; eBay's per-item photo enrichment is NOT doubled — see
 *  searchListingsDual in ebay.ts). Gemini spend is bounded by the per-source
 *  cap, not by how many candidates the two passes find. */
export async function searchDual(
  searchFn: (q: string, focused: boolean) => Promise<Listing[]>,
  query: string,
  consoleKey: ConsoleKey
): Promise<Listing[]> {
  const focusedQuery = focusedQueryFor(query, consoleKey);
  // Single search. `focused: true` because the query as typed already carries
  // whatever console focus there is (possibly none) — this reproduces each
  // source's pre-dual behavior exactly (Wallapop keeps its consoleKey term).
  if (!focusedQuery) return searchFn(query, true);

  const [focusedRes, plainRes] = await Promise.allSettled([
    searchFn(focusedQuery, true),
    searchFn(query, false),
  ]);
  if (focusedRes.status === "rejected" && plainRes.status === "rejected") {
    throw focusedRes.reason;
  }

  const focused = focusedRes.status === "fulfilled" ? focusedRes.value : [];
  const plain = plainRes.status === "fulfilled" ? plainRes.value : [];

  // Round-robin merge: both passes share the downstream cap fairly. An item
  // found by BOTH passes is deduped to its first (focused) slot, so
  // interleaving only spends extra slots on genuinely plain-only results.
  const merged: Listing[] = [];
  const seen = new Set<string>();
  const push = (listing: Listing) => {
    if (seen.has(listing.vintedId)) return;
    seen.add(listing.vintedId);
    merged.push(listing);
  };
  const longest = Math.max(focused.length, plain.length);
  for (let i = 0; i < longest; i++) {
    if (i < focused.length) push(focused[i]);
    if (i < plain.length) push(plain[i]);
  }
  return merged;
}
