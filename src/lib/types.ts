// ─────────────────────────────────────────────────────────────
// Shared domain types for CazaPAL.
// ─────────────────────────────────────────────────────────────

// Verdicts:
//   es        → the physical copy is a SPANISH EDITION (cover/back in Spanish,
//               "PAL España", Spanish distributor). 🟢
//   es_multi  → other-language box (French/Italian/…) BUT the disc is
//               multi-language and lists Spanish (ES) among its languages, so
//               the game is PLAYABLE IN SPANISH. 🔵
//   other     → no Spanish at all. 🔴
//   inconclusive / pending as usual.
export type LanguageVerdict =
  | "es"
  | "es_multi"
  | "other"
  | "inconclusive"
  | "pending";

// Console/platform detected by the vision AI from the box art, used to hide
// wrong-platform copies (e.g. a PS3 disc shown when the PS4 chip is selected)
// that the title-based filter can't catch. "other" = some platform outside the
// selectable chips (PSP, Vita, Wii, retro…). "unknown" = couldn't tell → never
// hidden on uncertainty.
export type DetectedPlatform =
  | "ps1"
  | "ps2"
  | "ps3"
  | "ps4"
  | "ps5"
  | "switch"
  | "xbox"
  | "pc"
  | "other"
  | "unknown";

// Factory-seal verdict from the vision AI: is the copy NEW with the seal
// intact? "yes" only on clear visual evidence (the horizontal pull-tab strip
// printed "PlayStation"/"PS4"/"PS5" along the bottom of a PS4/PS5 front cover,
// intact shrink-wrap, the red "Nintendo Switch" strip). "no" = clearly opened.
// "unknown" = can't tell from the photos (default → never guessed as sealed).
export type SealedVerdict = "yes" | "no" | "unknown";

// What the tear strip of a sealed PS4/PS5 copy says, read off the photos: the
// console logo repeated ("PS4"/"PS5") or the word "PlayStation" repeated,
// and rarer ones on older or special runs ("PS3", "PSP", "PS Vita", the
// "Blu-ray Disc" logo). Collectors tell print runs apart by it. null = not
// seen or not legible.
export type SealStripText =
  | "PS4"
  | "PS5"
  | "PlayStation"
  | "PS3"
  | "PSP"
  | "PS Vita"
  | "Blu-ray Disc";

// Marketplaces CazaPAL searches. Each listing carries its source so the UI can
// show two independent progress bars and tag every card.
export type MarketSource = "vinted" | "wallapop" | "ebay";

export const MARKET_LABELS: Record<MarketSource, string> = {
  vinted: "Vinted",
  wallapop: "Wallapop",
  ebay: "eBay",
};

export const MARKET_SOURCES: MarketSource[] = ["vinted", "wallapop", "ebay"];

export type ConsoleKey =
  | "todas"
  | "ps1"
  | "ps2"
  | "ps3"
  | "ps4"
  | "ps5"
  | "switch"
  | "nintendo_handheld"
  | "xbox"
  | "otras";

export interface ConsoleOption {
  key: ConsoleKey;
  label: string;
}

export const CONSOLE_OPTIONS: ConsoleOption[] = [
  { key: "todas", label: "Todas" },
  { key: "ps1", label: "PS1" },
  { key: "ps2", label: "PS2" },
  { key: "ps3", label: "PS3" },
  { key: "ps4", label: "PS4" },
  { key: "ps5", label: "PS5" },
  { key: "switch", label: "Switch" },
  { key: "nintendo_handheld", label: "Game Boy/DS" },
  { key: "xbox", label: "Xbox" },
  { key: "otras", label: "Otras" },
];

export interface Listing {
  source: MarketSource; // which marketplace this came from
  vintedId: string; // source-local item id (name kept for continuity; unique per source)
  title: string;
  price: number; // item price
  shippingPrice: number | null; // best-guess shipping; null if unknown
  currency: string; // e.g. "EUR"
  photoUrls: string[]; // full-size, used for the AI vision analysis (needs detail)
  thumbUrl: string | null; // small image for the card grid (fast on mobile)
  listingUrl: string;
  sellerCountry: string | null; // ISO-2 code, e.g. "ES", "FR"
  // Condition the SELLER declared on the marketplace ("used" = Vinted "Muy
  // bueno/Bueno/Satisfactorio", eBay used/refurbished). A copy declared used
  // can't be factory-sealed, whatever the photos seem to show. "open_box" =
  // eBay "New other / Open box" (1500): new, but by eBay's own definition
  // possibly in its packaging and NOT sealed. null = unknown (Wallapop search
  // results don't carry it).
  sellerCondition?: "new" | "used" | "open_box" | null;
  // The marketplace's own condition label, verbatim ("Nuevo con etiquetas",
  // "un_opened", "Nuevo"…): finer than sellerCondition, used as seal evidence.
  // Server-side only (see publicListing).
  sellerConditionRaw?: string | null;
  // What the seller wrote (title + description when the source gives it), for
  // the seal claims in sealSignals.ts ("precintado", "desprecintado"…).
  // Server-side only (see publicListing).
  sellerText?: string;
  languageVerdict: LanguageVerdict;
  verdictEvidence: string | null; // one sentence in Spanish
  detectedPlatform?: DetectedPlatform; // console read from the box art by the AI
  sealed?: SealedVerdict; // "yes" = new copy with the factory seal intact
  sealStrip?: SealStripText | null; // tear-strip letters, only when sealed "yes"
  analyzedAt: string | null; // ISO timestamp
}

/** Total price used for sorting (item + shipping). */
export function totalPrice(l: Listing): number {
  return l.price + (l.shippingPrice ?? 0);
}

/** A listing as sent to the browser: without the seller's text and raw
 *  condition (up to ~2 KB each, only the server's seal analysis reads them),
 *  which the status poll would otherwise resend every 1.5 s. */
export function publicListing(l: Listing): Listing {
  const out = { ...l };
  delete out.sellerText;
  delete out.sellerConditionRaw;
  return out;
}

/** Per-source outcome fixed at search time (how many we got, or why not). */
export interface SourceInfo {
  total: number;
  error: string | null; // friendly Spanish message if this source failed to load
}

/** Per-source live progress returned by the status endpoint. */
export interface SourceProgress {
  total: number;
  analyzed: number;
  error: string | null;
}

export interface SearchMeta {
  id: string;
  query: string;
  console: ConsoleKey;
  createdAt: string;
  demo: boolean;
  total: number; // total listings across all sources
  sources: Record<MarketSource, SourceInfo>; // per-marketplace breakdown
}

export interface SearchResponse {
  search: SearchMeta;
  listings: Listing[];
  demoReason?: string | null;
}

export interface StatusResponse {
  search: SearchMeta;
  listings: Listing[];
  analyzed: number; // count with a non-pending verdict (all sources)
  total: number;
  done: boolean;
  sources: Record<MarketSource, SourceProgress>; // one entry per marketplace
}

/** The strict JSON we require back from the vision model. */
export interface VisionResult {
  verdict: "es" | "es_multi" | "other" | "inconclusive";
  evidence: string;
  platform: DetectedPlatform;
  sealed: SealedVerdict;
  // WHY the seal verdict: hard evidence of an opened/used copy ("opened",
  // "used_label", "loose_sleeve") vs merely not seeing a wrap ("no_wrap",
  // "unknown"). Lets marketplace data (eBay "New") settle the soft cases only.
  sealReason?:
    | "opened"
    | "used_label"
    | "loose_sleeve"
    | "no_wrap"
    | "wrap"
    | "strip"
    | "seller"
    | "unknown";
  // Some photo shows the game's case (front, back or spine). Marketplace
  // "New" only stands in for a seal on something that IS a boxed game.
  sawCase?: boolean;
  // Letters on the tear strip, when the strip was seen and read.
  stripText?: SealStripText | null;
  // The raw sealStripText when the strip was visible (see decide()).
  stripReading?: string | null;
}

export interface ApiError {
  error: string;
  code:
    | "vinted_unavailable"
    | "vinted_blocked"
    | "sources_unavailable" // every marketplace failed
    | "bad_request"
    | "not_found"
    | "internal";
}

// ── Hallazgos: the rare tear-strip hunter running on the owner's PC ──
// (worker/strip-hunter.mjs). It pushes this snapshot to the server, which
// serves it to the "Hallazgos" dashboard.

export interface HuntItem {
  key: string; // "<source>:<id>"
  source: MarketSource;
  title: string;
  price: number;
  url: string;
  photo: string | null;
  strip: string | null; // letters read on the strip ("PS4", "PSP"…), null = not read
  reason?: string | null; // why not read: "tira ilegible", "sin tira visible"…
  sealed: SealedVerdict;
  at: string; // ISO time it was analyzed
}

export interface HuntFind extends HuntItem {
  confirmed: boolean; // a second, independent reading agreed
  note: string;
}

export interface HuntSnapshot {
  status: "running" | "paused" | "waiting_quota" | "sleeping" | "error";
  statusText: string; // one sentence in Spanish
  startedAt: string | null; // current sweep
  nextSweepAt: string | null; // when sleeping
  query: { index: number; total: number; text: string; source: MarketSource | null };
  counts: {
    seen: number; // listings looked at (all sweeps)
    candidates: number; // sealed PS4 candidates sent to the AI
    analyzed: number;
    stripRead: number;
    byStrip: Record<string, number>; // "PS4" → n, "PlayStation" → n, "none" → n…
    errors: number;
  };
  bySource: Record<MarketSource, { seen: number; analyzed: number; stripRead?: number }>;
  sources?: MarketSource[]; // marketplaces the hunter searches
  recent: HuntItem[]; // newest first, ~30
  finds: HuntFind[]; // every non-standard strip, newest first
  updatedAt: string;
}
