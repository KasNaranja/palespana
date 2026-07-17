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

// Marketplaces CazaPAL searches. Each listing carries its source so the UI can
// show two independent progress bars and tag every card.
export type MarketSource = "vinted" | "wallapop";

export const MARKET_LABELS: Record<MarketSource, string> = {
  vinted: "Vinted",
  wallapop: "Wallapop",
};

export const MARKET_SOURCES: MarketSource[] = ["vinted", "wallapop"];

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
  languageVerdict: LanguageVerdict;
  verdictEvidence: string | null; // one sentence in Spanish
  analyzedAt: string | null; // ISO timestamp
}

/** Total price used for sorting (item + shipping). */
export function totalPrice(l: Listing): number {
  return l.price + (l.shippingPrice ?? 0);
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
