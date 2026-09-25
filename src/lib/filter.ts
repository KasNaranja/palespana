// ─────────────────────────────────────────────────────────────
// Deduplication + relevance filtering for raw Vinted results.
// ─────────────────────────────────────────────────────────────

import type { ConsoleKey, DetectedPlatform, Listing } from "./types";

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
// Matched as substrings of the normalized (accent-free) title, so avoid words
// that live inside real game listings — e.g. NOT "libro": "sin libro de
// instrucciones" is a complete game missing its manual.
const IRRELEVANT = [
  "placa",
  "metal plate",
  "lamina",
  "targa",
  "cartel",
  "artbook",
  "art book",
  "banda sonora",
  "soundtrack",
  "vinilo",
  "comic",
  "booklet",
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
 * How well a listing's title matches the query:
 *   2 = STRONG — short queries (1–2 tokens) match every token; longer ones
 *       match ≥60% of them. (The original, only rule.)
 *   1 = LOOSE — long queries (≥4 tokens) whose title carries only the HEAD of
 *       the name (the first two tokens). Users type the full official title,
 *       sellers write it short: "Dark Souls Scholar of the First Sin" is listed
 *       as "Dark Souls 2 PS4" (2/5 tokens) — the only Dark Souls 2 on PS4 —
 *       and the strong rule alone silently dropped it. Loose matches also let
 *       in some siblings ("Dark Souls III"), so cleanListings ranks them AFTER
 *       every strong match: they only take slots the strong ones leave free.
 *   0 = irrelevant (accessory / guide / empty box, or too little in common).
 */
export function relevanceTier(listing: Listing, query: string): 0 | 1 | 2 {
  const title = normalize(listing.title);
  if (!title) return 0;

  for (const bad of IRRELEVANT) {
    if (title.includes(bad)) {
      // Allow "guia" etc. only if it's clearly part of the game name is rare;
      // safest to drop these to avoid noise.
      return 0;
    }
  }

  const tokens = queryTokens(query);
  if (tokens.length === 0) return 2; // nothing to match against

  const hit = tokens.map((t) => title.includes(t));
  const matched = hit.filter(Boolean).length;

  if (tokens.length <= 2) return matched === tokens.length ? 2 : 0;
  if (matched / tokens.length >= 0.6) return 2;
  if (tokens.length >= 4 && hit[0] && hit[1]) return 1;
  return 0;
}

/** Relevant at any tier (see relevanceTier). */
export function isRelevant(listing: Listing, query: string): boolean {
  return relevanceTier(listing, query) > 0;
}

// Sequel numbers as whole tokens of a NORMALIZED title ("ps4" is one token,
// so the 4 inside it never counts). Roman numerals map to digits.
const ROMAN: Record<string, string> = {
  ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9",
};
function sequelNumbers(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const tok of normalized.split(" ")) {
    if (/^[2-9]$/.test(tok)) out.add(tok);
    else if (ROMAN[tok]) out.add(ROMAN[tok]);
  }
  return out;
}

/**
 * Which sequel number the searched game carries, learned from the data: the
 * query's own number if it has one, otherwise the number most STRONG matches
 * agree on ("Dark Souls II Scholar…" listings ⇒ "2"). null = the game has no
 * sequel number (strong matches don't agree on one).
 */
function targetSequel(query: string, strong: Listing[]): string | null {
  const fromQuery = sequelNumbers(normalize(query));
  if (fromQuery.size > 0) return [...fromQuery][0];
  const counts = new Map<string, number>();
  for (const l of strong) {
    for (const n of sequelNumbers(normalize(l.title))) {
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [n, c] of counts) {
    if (c > bestCount) {
      best = n;
      bestCount = c;
    }
  }
  return best && bestCount >= Math.max(2, strong.length * 0.25) ? best : null;
}

/**
 * A LOOSE match only shares the franchise head with the query, so it may be a
 * sibling game. Keep it only when its sequel number agrees with the target:
 * with target "2", "Dark Souls 2 PS4" stays while "Dark Souls III" and
 * "Dark Souls Trilogy" go; with no target, a loose title that DOES carry a
 * number is a sequel of a numberless game and goes.
 */
function looseMatchesSequel(listing: Listing, target: string | null): boolean {
  const nums = sequelNumbers(normalize(listing.title));
  return target ? nums.has(target) : nums.size === 0;
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

/**
 * Client-side platform gate using the console the AI read off the box art
 * (`Listing.detectedPlatform`). Complements the title-based `consoleAllows`:
 * it catches wrong-platform copies whose TITLE is just the game name. Same
 * safety rule — only hide on a CONFIDENT mismatch; keep on "unknown"/undefined.
 */
export function platformMatchesConsole(
  detected: DetectedPlatform | undefined,
  sel: ConsoleKey
): boolean {
  if (!STRICT_CONSOLES.has(sel)) return true; // broad/catch-all chip → no filter
  if (!detected || detected === "unknown") return true; // uncertain → never hide
  // ps1-5/switch/xbox map 1:1 to the chip; "pc"/"other" never equal a strict
  // console, so a detected pc/other/handheld is hidden when a console is chosen.
  return detected === sel;
}

/**
 * True when the TITLE explicitly names the selected strict console. The seller
 * stating the platform is authoritative, so the AI's cover reading must NOT
 * override it — the AI gate (platformMatchesConsole) only applies to listings
 * whose title is ambiguous (just the game name). Non-strict chips → false.
 */
export function titleNamesConsole(title: string, sel: ConsoleKey): boolean {
  if (!STRICT_CONSOLES.has(sel)) return false;
  const re = PLATFORM_PATTERNS[sel];
  return !!re && re.test(normalize(title));
}

/**
 * Final keep/hide decision for the console chip, combining both signals:
 * keep if the TITLE confirms the console, OR the AI didn't confidently read a
 * different one. Only ambiguous-title copies can be hidden by the AI.
 */
export function consoleKeep(
  title: string,
  detected: DetectedPlatform | undefined,
  sel: ConsoleKey
): boolean {
  return titleNamesConsole(title, sel) || platformMatchesConsole(detected, sel);
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
  const scored = dedupe(listings)
    .map((l) => ({ l, tier: relevanceTier(l, query) }))
    .filter(({ l, tier }) => tier > 0 && consoleAllows(l.title, consoleKey));
  const target = targetSequel(
    query,
    scored.filter((s) => s.tier === 2).map((s) => s.l)
  );
  // Strong matches first, loose ones after (stable sort keeps each tier in the
  // order the sources returned it, i.e. the dual search's interleave), so the
  // per-source cap trims loose matches before any strong one.
  return scored
    .filter(({ l, tier }) => tier === 2 || looseMatchesSequel(l, target))
    .sort((a, b) => b.tier - a.tier)
    .map(({ l }) => l);
}
