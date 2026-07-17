// ─────────────────────────────────────────────────────────────
// Wallapop client — ISOLATED on purpose (like vinted.ts).
//
// Wallapop has no public API. This talks to the same internal JSON endpoint the
// web at es.wallapop.com uses for search. When Wallapop changes it, THIS is the
// only file to patch.
//
// Unlike Vinted, no cookie bootstrap is needed — the search endpoint works with
// the right headers (notably X-DeviceOS + Origin/Referer) and a lat/long. Every
// failure is normalized into a WallapopError with a `kind` the API layer maps to
// a friendly Spanish message. Node runtime only.
// ─────────────────────────────────────────────────────────────

import { config } from "./config";
import type { ConsoleKey, Listing } from "./types";

export type WallapopErrorKind = "blocked" | "rate_limited" | "unavailable";

export class WallapopError extends Error {
  kind: WallapopErrorKind;
  status?: number;
  constructor(kind: WallapopErrorKind, message: string, status?: number) {
    super(message);
    this.name = "WallapopError";
    this.kind = kind;
    this.status = status;
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SEARCH_URL = "https://api.wallapop.com/api/v3/search";

// Wallapop's keyword search is looser than Vinted's: for a multi-word title
// like "Under the Waves" it ranks BRAND matches on a single word (microondas
// "Wave", "Leatherman Wave"…) above the game, burying it. A disambiguating term
// fixes it — the selected console when there is one, else "videojuego". (Its
// category_ids filter is ignored by this endpoint, so this is the lever.)
const CONSOLE_TERMS: Partial<Record<ConsoleKey, string>> = {
  ps1: "PS1",
  ps2: "PS2",
  ps3: "PS3",
  ps4: "PS4",
  ps5: "PS5",
  switch: "Switch",
  xbox: "Xbox",
};

function wallapopKeywords(query: string, consoleKey: ConsoleKey): string {
  const term = CONSOLE_TERMS[consoleKey] ?? "videojuego";
  if (query.toLowerCase().includes(term.toLowerCase())) return query;
  return `${query} ${term}`;
}

function itemToListing(item: any): Listing | null {
  if (!item || item.id == null) return null;
  const amount = Number(item.price?.amount ?? item.price);
  if (!Number.isFinite(amount)) return null;

  const currency: string = item.price?.currency || item.currency || "EUR";

  // Each image exposes urls.{small,medium,big}; the big one goes to vision, the
  // small one (W320) is the fast card thumbnail.
  const images: any[] = Array.isArray(item.images) ? item.images : [];
  const photoUrls: string[] = images
    .map((im) => im?.urls?.big || im?.urls?.medium || im?.urls?.small)
    .filter((u: unknown): u is string => typeof u === "string");
  const firstImg = images[0]?.urls;
  const thumbUrl: string | null =
    firstImg?.small || firstImg?.medium || photoUrls[0] || null;

  const slug: string | null =
    typeof item.web_slug === "string" ? item.web_slug : null;
  const url = slug
    ? `https://es.wallapop.com/item/${slug}`
    : `https://es.wallapop.com/item/${item.id}`;

  // Wallapop is Spain-centric; use the seller's country if present, else ES.
  const country: string =
    item.location?.country_code || item.location?.countryCode || "ES";

  return {
    source: "wallapop",
    vintedId: String(item.id),
    title: String(item.title ?? "").trim() || `Anuncio ${item.id}`,
    price: amount,
    shippingPrice: null, // Wallapop shipping is quoted later; unknown up front
    currency: String(currency),
    photoUrls,
    thumbUrl,
    listingUrl: url,
    sellerCountry: country,
    languageVerdict: "pending",
    verdictEvidence: null,
    analyzedAt: null,
  };
}

/** Dig the item array out of Wallapop's (occasionally reshaped) response. */
function extractItems(data: any): any[] {
  return (
    data?.data?.section?.payload?.items ??
    data?.data?.sections?.[0]?.payload?.items ??
    data?.data?.items ??
    data?.search_objects ??
    []
  );
}

/** Search Wallapop's catalog. Returns raw (un-deduped, un-filtered) listings. */
export async function searchListings(
  query: string,
  consoleKey: ConsoleKey,
  perPage: number
): Promise<Listing[]> {
  const params = new URLSearchParams();
  params.set("keywords", wallapopKeywords(query, consoleKey));
  params.set("source", "search_box");
  // A location is required; default to the centre of Spain (national reach).
  params.set("latitude", config.wallapopLat);
  params.set("longitude", config.wallapopLng);

  let res: Response;
  try {
    res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "es-ES,es;q=0.9",
        "X-DeviceOS": "0",
        Origin: "https://es.wallapop.com",
        Referer: "https://es.wallapop.com/",
      },
    });
  } catch (e) {
    throw new WallapopError(
      "unavailable",
      `No se pudo contactar con Wallapop: ${(e as Error).message}`
    );
  }

  if (res.status === 429) {
    throw new WallapopError("rate_limited", "Wallapop está limitando peticiones.", 429);
  }
  if (res.status === 403) {
    throw new WallapopError("blocked", "Wallapop bloqueó la petición (403).", 403);
  }
  if (!res.ok) {
    throw new WallapopError("unavailable", `Wallapop respondió ${res.status}.`, res.status);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new WallapopError("unavailable", "Respuesta de Wallapop no era JSON.");
  }

  const items = extractItems(data);
  return items
    .map(itemToListing)
    .filter((l): l is Listing => l !== null)
    .slice(0, perPage);
}
