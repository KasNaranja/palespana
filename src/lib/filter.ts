// ─────────────────────────────────────────────────────────────
// Deduplication + relevance filtering for raw Vinted results.
// ─────────────────────────────────────────────────────────────

import type { ConsoleKey, Listing } from "./types";

function normalize(s: string): string {
  let t = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Canonicalize platform synonyms so "playstation 4" \u2261 "ps4", "play station 3"
  // \u2261 "ps3", etc. Without this, searching "undertale ps4" would drop a listing
  // titled "Undertale Sony PlayStation 4" (the token "ps4" isn't a substring of
  // "playstation 4"). Applied to both the query and the title.
  t = t
    .replace(/\bplay station\b/g, "playstation")
    .replace(/\bplaystation ([1-5])\b/g, "ps$1")
    .replace(/\bplaystation([1-5])\b/g, "ps$1") // no space: "PlayStation4"
    .replace(/\bplaystation one\b/g, "ps1")
    .replace(/\bps ([1-5])\b/g, "ps$1")
    .replace(/\bps one\b/g, "ps1")
    .replace(/\bpsx\b/g, "ps1")
    .replace(/\bnintendo switch\b/g, "switch");
  return t;
}

// Words that signal a non-game listing (console, accessory, guide, poster…).
const IRRELEVANT = [
  "consola",
  "console",
  "mando",
  "mandos",
  "joystick",
  "controller",
  "guia",
  "guide",
  "poster",
  "póster",
  "funda",
  "cargador",
  "cable",
  "adaptador",
  "figura",
  "amiibo",
  "peluche",
  "camiseta",
  "taza",
  "llavero",
  "pegatina",
  "sticker",
  "vacia",
  "vacía",
  "caja vacia",
  "solo caja",
  "solo manual",
  "sin juego",
];

const STOPWORDS = new Set([
  "the",
  "of",
  "and",
  "y",
  "el",
  "la",
  "los",
  "las",
  "de",
  "para",
  "juego",
  "videojuego",
  "game",
]);

/** Meaningful tokens from the user's query (length ≥ 2, not a stopword). */
function queryTokens(query: string): string[] {
  return normalize(query)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * A listing is relevant when its title shares enough with the query and does
 * not look like an accessory / guide / empty box. We require the majority of
 * meaningful query tokens to appear in the title (roman numerals & short
 * titles handled by the ratio, not an exact-count rule).
 */
export function isRelevant(listing: Listing, query: string): boolean {
  const title = normalize(listing.title);
  if (!title) return false;

  for (const bad of IRRELEVANT) {
    if (title.includes(bad)) {
      // Allow "guia" etc. only if it's clearly part of the game name is rare;
      // safest to drop these to avoid noise.
      return false;
    }
  }

  const tokens = queryTokens(query);
  if (tokens.length === 0) return true; // nothing to match against

  const matched = tokens.filter((t) => title.includes(t)).length;
  const ratio = matched / tokens.length;

  // Short queries (1–2 tokens) must match all; longer ones allow one miss.
  if (tokens.length <= 2) return matched === tokens.length;
  return ratio >= 0.6;
}

// ── Console filtering ──────────────────────────────────────────
// Vinted's own platform filter uses internal category ids we can't reliably
// obtain, so we infer the platform from the TITLE (already canonicalized by
// normalize(), so "playstation 4" reads as "ps4"). The filter is NEGATIVE: we
// keep a listing for the selected console if the title says that console OR
// mentions no console at all (ambiguous — could be it); we only drop it when the
// title explicitly names a DIFFERENT console. This avoids losing e.g. a PS4 copy
// titled just "Under the Waves", which appending "PS4" to the search would miss.
const PLATFORM_PATTERNS: Partial<Record<ConsoleKey, RegExp>> = {
  ps1: /\bps1\b/,
  ps2: /\bps2\b/,
  ps3: /\bps3\b/,
  ps4: /\bps4\b/,
  ps5: /\bps5\b/,
  switch: /\bswitch\b|\bnsw\b/,
  xbox: /\bxbox\b|\bseries [xs]\b|\bone [xs]\b/,
};

// Extra platforms that are NOT selectable chips but must still cause a listing to
// be dropped when a strict console is chosen (e.g. searching PS4 must hide a "PC"
// or "PSP" copy). Kept separate from PLATFORM_PATTERNS since you can't pick them.
// All use word boundaries so they only match standalone tokens ("ds" won't match
// inside "3ds" or a game name).
const OTHER_PLATFORM_PATTERNS: RegExp[] = [
  /\bpc\b/,
  /\bsteam\b/,
  /\bordenador\b/,
  /\bpsp\b/,
  /\bps ?vita\b/,
  /\bvita\b/,
  /\bwii ?u\b/,
  /\bwii\b/,
  /\b3ds\b/,
  /\b2ds\b/,
  /\bnds\b/,
  /\bds\b/,
  /\bgba\b/,
  /\bgameboy\b/,
  /\bgame boy\b/,
  /\bgamecube\b/,
  /\bngc\b/,
  /\bn64\b/,
  /\bnintendo 64\b/,
  /\bsnes\b/,
  /\bsuper nintendo\b/,
  /\bnes\b/,
  /\bmega ?drive\b/,
  /\bgenesis\b/,
  /\bdreamcast\b/,
  /\bsaturn\b/,
];

// Consoles we filter strictly. "todas"/"otras"/"nintendo_handheld" are broad or
// catch-all, so they don't strictly filter (nintendo_handheld spans Game Boy,
// DS, 3DS… — too many title forms to match cleanly).
const STRICT_CONSOLES = new Set<ConsoleKey>([
  "ps1",
  "ps2",
  "ps3",
  "ps4",
  "ps5",
  "switch",
  "xbox",
]);

function consoleAllows(title: string, sel: ConsoleKey): boolean {
  if (!STRICT_CONSOLES.has(sel)) return true;
  const norm = normalize(title);
  const selRe = PLATFORM_PATTERNS[sel];
  if (selRe && selRe.test(norm)) return true; // explicitly the selected console
  // Explicitly a DIFFERENT selectable console (e.g. PS3 when PS4 is chosen).
  for (const [k, re] of Object.entries(PLATFORM_PATTERNS)) {
    if (k !== sel && re.test(norm)) return false;
  }
  // Explicitly a non-selectable platform (PC, PSP, Wii, DS, retro…).
  for (const re of OTHER_PLATFORM_PATTERNS) {
    if (re.test(norm)) return false;
  }
  return true; // no platform named → ambiguous → keep
}

/** Remove duplicate vintedIds, keeping the first occurrence (Vinted paginates
 *  overlapping pages, so the same id can appear twice). */
export function dedupe(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  const out: Listing[] = [];
  for (const l of listings) {
    if (seen.has(l.vintedId)) continue;
    seen.add(l.vintedId);
    out.push(l);
  }
  return out;
}

/** Full clean-up pipeline used after fetching from Vinted. */
export function cleanListings(
  listings: Listing[],
  query: string,
  consoleKey: ConsoleKey = "todas"
): Listing[] {
  return dedupe(listings)
    .filter((l) => isRelevant(l, query))
    .filter((l) => consoleAllows(l.title, consoleKey));
}
