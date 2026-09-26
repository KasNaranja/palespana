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

// Words that signal a non-game listing (accessory, guide, poster…). Matched as
// WHOLE WORDS of the normalized (accent-free) title, plural -s/-es included.
// As plain substrings they misfired on real games: "sin juego" inside "…of the
// First SIN JUEGO para PS4", "mando" inside "comando", "poster" inside
// "posterior". Still avoid words that live inside real game listings — e.g.
// NOT "libro": "sin libro de instrucciones" is a complete game missing its
// manual. Entries are regex fragments over the normalized title.
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
  "mando",
  "manette", // FR controller: "Manette Switch Zelda…" names the console, so it
  // would lead the console-first order
  "comandos", // PT controllers ("PS4 Pro 1TB + 2 Comandos + Jogos")
  "joystick",
  "controller",
  // NOT "joy con": "Mario Kart 8 Deluxe con Joycon Wheel" is the game plus
  // the wheels, and the accessory-only Joy-Con listings say "manette"/"grip".
  "split pad",
  "grip", // "Grip protection silicone switch Zelda…", "Joycon Grip"
  "thumbgrip",
  "dock",
  "housse", // FR case/sleeve
  "pochette",
  "etui",
  "guia",
  "guide",
  "poster",
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
  "portes? cle", // FR keychain ("Porte-clés … Zelda", "portes clés")
  "portachiavi",
  "pegatina",
  "sticker",
  "vacia",
  "vide", // FR empty: "Steelbook vide", "Boîte vide" (whole word: not "video")
  "caja vacia",
  "solo caja",
  "solo manual",
  "sin juego",
  // Non-games that eBay sellers list as "New" (seen in a real DS2 search:
  // a metal lithograph, a trophy-boosting service, a cover-art insert).
  "lithograph",
  "litografia",
  "trophy",
  "trophies",
  "trofeo",
  "boosting",
  "arte solo",
  "art only",
  "insert only",
  "insertar",
  "cover art",
  "solo caratula",
  "caratula solo",
  "solo portada",
  "replacement case",
  "caja de repuesto",
];
const irrelevantEntryRe = (w: string) => new RegExp(`\\b${w}(?:s|es)?\\b`);

// A word the user TYPED can't be a noise signal: searching "grip combat
// racing" must not throw away every "GRIP" copy. The regex drops the entries
// the query itself contains; memoized for the last query (cleanListings calls
// relevanceTier once per listing with the same query).
let irrelevantMemo: { q: string; re: RegExp } | null = null;
function irrelevantReFor(normQuery: string): RegExp {
  if (irrelevantMemo?.q === normQuery) return irrelevantMemo.re;
  const words = IRRELEVANT.filter((w) => !irrelevantEntryRe(w).test(normQuery));
  const re = words.length
    ? new RegExp(`\\b(?:${words.join("|")})(?:s|es)?\\b`)
    : /(?!)/; // never matches
  irrelevantMemo = { q: normQuery, re };
  return re;
}

// A storage capacity means hardware: "PS4 Slim 500GB + GTA V", "PS4 500 go +
// 5 jeux", "Nintendo Switch … + SD 512GB". Across ~4,900 real titles every one
// carrying a capacity was a console, PC or memory card. A spaced one-digit
// "2 GB" is left alone: it may be Game Boy ("Super Mario Land 2 GB").
const CAPACITY_RE = /\b(?:\d+ ?tb|\d{2,} ?(?:gb|go)|\d(?:gb|go))\b/;

// "consola"/"console" (and the Switch hardware models "OLED"/"Lite") usually
// mean the hardware, but "Juego para Consola PlayStation 4" is a game: they
// only disqualify a title that doesn't say it is a game BEFORE naming the
// console. "Consola PS4 Slim + juego GTA V" is a bundle, and so is anything
// with plural "juegos" ("Consola PS4 + 3 juegos").
const CONSOLE_WORD_RE = /\b(?:video)?(?:consola|console)s?\b|\boled\b|\blite\b/;
const GAME_WORD_RE = /\b(?:juego|jeu|game|gioco|videojuego)\b/;

function looksIrrelevant(normTitle: string, normQuery: string): boolean {
  // "Scholar of the First Sin juego…" is not "sin juego" (= without the game).
  // A plain rewrite instead of a lookbehind: this module also ships to the
  // browser (page.tsx imports consoleKeep), where older Safari rejects them.
  const t = normTitle.replace(/\bfirst sin\b/g, "firstsin");
  if (irrelevantReFor(normQuery).test(t) || CAPACITY_RE.test(t)) return true;
  const c = t.search(CONSOLE_WORD_RE);
  if (c < 0) return false;
  const g = t.search(GAME_WORD_RE);
  return !(g >= 0 && g < c);
}

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
export function queryTokens(query: string): string[] {
  return normalize(query)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// Platform words the user may type into the query itself ("… ps4"): they are
// not part of the game's name.
const PLATFORM_TOKEN_RE = /^(?:ps[1-5]|switch|nsw|xbox)$/;

/** The query tokens that name the GAME: queryTokens minus platform words, so
 *  "mario kart 8 deluxe switch" counts like "mario kart 8 deluxe". */
export function nameTokens(query: string): string[] {
  return queryTokens(query).filter((t) => !PLATFORM_TOKEN_RE.test(t));
}

/**
 * The franchise HEAD of the query, as typed: its words up to and including
 * the second significant token, platform words left out ("dark souls scholar
 * of the first sin" → "dark souls"; "the last of us part ii" → "the last of
 * us"). null when the query has fewer than two significant tokens.
 */
export function queryHead(query: string): string | null {
  const words = normalize(query)
    .split(" ")
    .filter((w) => w && !PLATFORM_TOKEN_RE.test(w));
  let significant = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i].length >= 2 && !STOPWORDS.has(words[i])) significant++;
    if (significant === 2) return words.slice(0, i + 1).join(" ");
  }
  return null;
}

/** True when a and b are at most ONE edit apart (Levenshtein ≤ 1). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Common listing words never taken as a typo of a query token: "para" is one
// edit from "part", so "The Last of Us Remastered para PS4" read as "Part II".
const FUZZY_SKIP = new Set(["para", "pour", "sous", "sans", "avec", "como"]);

/** Title word `w` is query token `token`, or one typo away from it (alphabetic
 *  tokens of 4+ letters only). */
function wordMatches(token: string, w: string): boolean {
  if (w === token) return true;
  if (token.length < 4 || !/^[a-z]+$/.test(token)) return false;
  return w.length >= 4 && !FUZZY_SKIP.has(w) && withinOneEdit(token, w);
}

/**
 * Whether the title carries a query token: as a substring (the original rule,
 * which also finds "souls" inside "darksouls"), or — for alphabetic tokens of
 * 4+ letters — as a title word one typo away. Sellers type fast: "Datk souls
 * 2" (PS4, 10 €) came 4th in Vinted's own ranking and was thrown away; "Dark
 * Soul 2" missed "souls" the same way.
 */
function titleHasToken(title: string, words: string[], token: string): boolean {
  if (title.includes(token)) return true;
  return words.some((w) => wordMatches(token, w));
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
 *       in some siblings ("Dark Souls III"), so cleanListings filters them by
 *       sequel number and ranks them after the strong matches.
 *   0 = irrelevant (accessory / guide / empty box, or too little in common).
 * Tokens tolerate one typo (see titleHasToken).
 */
export function relevanceTier(listing: Listing, query: string): 0 | 1 | 2 {
  const title = normalize(listing.title);
  if (!title) return 0;
  if (looksIrrelevant(title, normalize(query))) return 0;

  const tokens = queryTokens(query);
  if (tokens.length === 0) return 2; // nothing to match against

  const words = title.split(" ");
  const hit = tokens.map((t) => titleHasToken(title, words, t));
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
// A number that COUNTS games is not a sequel: "Lotería de 2 juegos PS4:
// Creed y Dark Souls", "Set 2 giochi PS4 - The Witcher e Dark souls III".
const GAMES_WORD_RE = /^(?:juegos|videojuegos|jeux|giochi|games|jogos|spiele)$/;
// Nor is a number that belongs to a CONSOLE name: "Nintendo Switch 2"
// (normalized "switch 2") would make "…Switch 2 Edition" titles vote "2" and
// send Zelda BOTW's short-name pass after "the legend of zelda 2". ("ds" is
// left out on purpose: "DS 2" is how sellers abbreviate Dark Souls 2.)
const CONSOLE_BEFORE_NUMBER_RE = /^(?:switch|nsw|xbox|wii)$/;

function sequelNumbers(normalized: string): Set<string> {
  const out = new Set<string>();
  const toks = normalized.split(" ");
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (GAMES_WORD_RE.test(toks[i + 1] ?? "")) continue;
    if (i > 0 && CONSOLE_BEFORE_NUMBER_RE.test(toks[i - 1])) continue;
    if (/^[2-9]$/.test(tok)) out.add(tok);
    else if (ROMAN[tok]) out.add(ROMAN[tok]);
  }
  return out;
}

/** How sellers write sequel number `n`: as a digit and as a roman numeral
 *  ("2" → ["2", "ii"]). */
export function sequelSpellings(n: string): string[] {
  const roman = Object.keys(ROMAN).find((r) => ROMAN[r] === n);
  return roman ? [n, roman] : [n];
}

/**
 * Which sequel number the searched game carries, learned from the data: the
 * query's own number if it has one, otherwise the number most STRONG matches
 * agree on ("Dark Souls II Scholar…" listings ⇒ "2"). null = the game has no
 * sequel number (strong matches don't agree on one). A learned number must
 * also outnumber the strong matches that carry NO number: for "call of duty
 * black ops" (the first one) 36 strong titles say "2" (Black Ops II) but 58
 * say none, and "2" would have sent the short-name pass after Call of Duty 2.
 */
export function targetSequel(query: string, strong: Listing[]): string | null {
  const fromQuery = sequelNumbers(normalize(query));
  if (fromQuery.size > 0) return [...fromQuery][0];
  const counts = new Map<string, number>();
  let numberless = 0;
  for (const l of strong) {
    const nums = sequelNumbers(normalize(l.title));
    if (nums.size === 0) numberless++;
    for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [n, c] of counts) {
    if (c > bestCount) {
      best = n;
      bestCount = c;
    }
  }
  return best &&
    bestCount > numberless &&
    bestCount >= Math.max(2, strong.length * 0.25)
    ? best
    : null;
}

/** The query's franchise head as matched against titles: queryHead without
 *  leading stopwords ("the last of us" → "last of us"), as words. */
function headWords(head: string): string[] {
  const words = head.split(" ");
  let i = 0;
  while (i < words.length - 1 && STOPWORDS.has(words[i])) i++;
  return words.slice(i);
}

/**
 * Whether a title writes sequel `n` in the SHORT form "<head> <n>" — "Dark
 * Souls 2 PS4", "Dark Souls II", "The last of us 2", "Final Fantasy VII" —
 * i.e. the number right after the franchise head. Head words tolerate one
 * typo ("Datk souls 2") and may come glued ("Darksouls 2"). The short form is
 * what tells a sequel of the searched franchise from ANOTHER game that merely
 * shares head + number: for "call of duty modern warfare 2", "Call of Duty
 * Black Ops II PS3" carries "2" too, but not after "call of duty".
 */
export function headSequelIn(text: string, head: string, n: string): boolean {
  const hw = headWords(head);
  const spellings = sequelSpellings(n);
  const words = normalize(text).split(" ");
  const glued = hw.join("");
  for (let i = 0; i < words.length - 1; i++) {
    if (hw.length > 1 && words[i] === glued && spellings.includes(words[i + 1])) {
      return true;
    }
    const at = i + hw.length; // where the number must be
    if (
      at < words.length &&
      spellings.includes(words[at]) &&
      hw.every((h, j) => wordMatches(h, words[i + j]))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A LOOSE match only shares the franchise head with the query, so it may be a
 * sibling game. Keep it only when its sequel number agrees with the target:
 * with target "2", "Dark Souls 2 PS4" stays while "Dark Souls III" goes
 * ("Dark Souls Trilogy" is rescued by compilationWithSequel); with no target,
 * a loose title that DOES carry a number is a sequel of a numberless game and
 * goes.
 */
function looseMatchesSequel(listing: Listing, target: string | null): boolean {
  const nums = sequelNumbers(normalize(listing.title));
  return target ? nums.has(target) : nums.size === 0;
}

// Compilations name the franchise, not the number: "Dark Souls Trilogy",
// "Pack trilogía", "Saga", "Collection" — yet they contain the searched
// sequel, so looseMatchesSequel alone would throw them away. Bare "pack" is
// NOT a compilation signal: measured on Wallapop it only rescued sellers'
// bundles of unrelated games ("Pack PS4: RDR2, Bioshock, Dark Souls"), while
// every real "Pack trilogía" is already caught by trilog*.
const COMPILATION_RE =
  /\b(?:trilog[a-z]*|sagas?|collections?|coleccion|colecciones)\b/;

// "Colección juegos PS4 …", "Collezione giochi": a seller's own lot, not an
// official compilation.
const GAMES_LOT_RE = /\b(?:juegos|videojuegos|jeux|giochi|games|jogos|spiele)\b/;

/**
 * A LOOSE match that is a compilation which may hold sequel `target`: it names
 * the target; or it's a trilogy and the target is ≤ 3; or it names no number
 * at all, the target is ≤ 3 (the range compilations like "Dark Souls Saga" or
 * "Metal Gear Solid HD Collection" cover) and it isn't a seller's lot of
 * games. One that names only OTHER numbers ("Pack Dark Souls 3 + Bloodborne")
 * doesn't; neither does "Final fantasy coleccion ps2, Xbox y ps4" for FF VII.
 */
function compilationWithSequel(listing: Listing, target: string): boolean {
  const title = normalize(listing.title);
  if (!COMPILATION_RE.test(title)) return false;
  const nums = sequelNumbers(title);
  if (nums.has(target)) return true;
  const early = Number(target) <= 3;
  if (/\btrilog/.test(title)) return early;
  return nums.size === 0 && early && !GAMES_LOT_RE.test(title);
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
  // Glued forms too: "GTA V xbox360", "Dark Souls 2 … Xbox360".
  xbox: /\bxbox(?:360|one)?\b|\bx360\b|\bseries [xs]\b|\bone [xs]\b/,
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

/** The sequel number of the searched game as cleanListings will judge it:
 *  targetSequel over the STRONG matches the console chip allows. */
export function sequelTargetOf(
  listings: Listing[],
  query: string,
  consoleKey: ConsoleKey = "todas"
): string | null {
  return targetSequel(
    query,
    dedupe(listings).filter(
      (l) => relevanceTier(l, query) === 2 && consoleAllows(l.title, consoleKey)
    )
  );
}

/**
 * Whether sellers really call the searched game "<head> <target>" — the
 * short-name pass searches exactly that, so it must not run when the number
 * belongs elsewhere in the name: "call of duty modern warfare 2" would search
 * "call of duty 2" (another game), "final fantasy x x-2 hd remaster" "final
 * fantasy 2". Attested when the query itself carries the short form ("final
 * fantasy vii remake"), or at least 2 relevant candidates the chip allows do
 * ("Dark Souls II Scholar…" for "dark souls scholar of the first sin"; "The
 * last of us 2 PS4" for "the last of us part ii").
 */
export function shortFormAttested(
  listings: Listing[],
  query: string,
  consoleKey: ConsoleKey,
  target: string
): boolean {
  const head = queryHead(query);
  if (!head) return false;
  if (headSequelIn(query, head, target)) return true;
  let seen = 0;
  for (const l of dedupe(listings)) {
    if (
      headSequelIn(l.title, head, target) &&
      relevanceTier(l, query) > 0 &&
      consoleAllows(l.title, consoleKey) &&
      ++seen >= 2
    ) {
      return true;
    }
  }
  return false;
}

interface Ranked {
  l: Listing;
  /** 2 strong · 1 loose single copy of the right sequel · 0.5 loose
   *  compilation that holds it · 0 dropped. */
  rank: number;
  /** Order group: 2 = the searched game for sure (strong matches, and loose
   *  ones in the short form "Dark Souls 2 PS4"); 1 = other loose single
   *  copies (may be a sibling: "Call of Duty Black Ops II" for "… modern
   *  warfare 2"); 0 = compilations. */
  group: number;
  named: boolean;
}

function rankListings(
  listings: Listing[],
  query: string,
  consoleKey: ConsoleKey
): Ranked[] {
  const scored = dedupe(listings)
    .map((l) => ({ l, tier: relevanceTier(l, query) }))
    .filter(({ l, tier }) => tier > 0 && consoleAllows(l.title, consoleKey));
  const target = targetSequel(
    query,
    scored.filter((s) => s.tier === 2).map((s) => s.l)
  );
  const head = queryHead(query);
  const ranked: Ranked[] = [];
  for (const { l, tier } of scored) {
    let rank = 0;
    let group = 0;
    if (tier === 2) {
      rank = 2;
      group = 2;
    } else if (looseMatchesSequel(l, target)) {
      rank = 1;
      group = target && head && headSequelIn(l.title, head, target) ? 2 : 1;
    } else if (target && compilationWithSequel(l, target)) {
      rank = 0.5;
    }
    if (rank > 0) {
      ranked.push({ l, rank, group, named: titleNamesConsole(l.title, consoleKey) });
    }
  }
  // Order BEFORE the route's per-source cap: by group; inside it, titles that
  // name the chosen console first (their platform is certain; a title-only
  // copy may be another platform's), then by rank. Sorting by tier alone let
  // strong title-only copies push every "Dark Souls 2 PS4" (loose, short
  // form) past the cap once the extra passes brought more candidates; putting
  // EVERY console-naming title first let "Dark Souls Trilogy PS4" and other
  // games' "… II PS3" take the cap from exact copies. The sort is stable, so
  // equal keys keep the order the sources returned (the passes' interleave).
  return ranked.sort(
    (a, b) =>
      b.group - a.group || Number(b.named) - Number(a.named) || b.rank - a.rank
  );
}

/** Full clean-up pipeline used after fetching from any source. */
export function cleanListings(
  listings: Listing[],
  query: string,
  consoleKey: ConsoleKey = "todas"
): Listing[] {
  return rankListings(listings, query, consoleKey).map(({ l }) => l);
}

/** The candidates in the LEADING block of cleanListings' order: the searched
 *  game for sure (group 2) AND, with a strict chip, a title that names the
 *  console. A next page is only worth fetching while these don't fill the
 *  cap. */
export function leadingCandidates(
  listings: Listing[],
  query: string,
  consoleKey: ConsoleKey
): Listing[] {
  const strict = STRICT_CONSOLES.has(consoleKey);
  return rankListings(listings, query, consoleKey)
    .filter((r) => r.group === 2 && (!strict || r.named))
    .map(({ l }) => l);
}
