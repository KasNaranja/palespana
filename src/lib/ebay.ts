// ─────────────────────────────────────────────────────────────
// eBay client — ISOLATED (like vinted.ts / wallapop.ts).
//
// Unlike Vinted/Wallapop, eBay has an OFFICIAL API (Browse API) that needs app
// credentials: a client id + secret (from developer.ebay.com) exchanged for an
// application OAuth token via the client-credentials grant (no user login).
//
// The search endpoint (item_summary/search) only returns the PRIMARY image, but
// the language analysis needs the BACK cover — so for each result we call
// getItem to pull its full photo set (additionalImages). eBay's free daily
// limit is generous, so the extra calls are fine. Node runtime only.
// ─────────────────────────────────────────────────────────────

import { config } from "./config";
import type { ConsoleKey, Listing } from "./types";

export type EbayErrorKind = "blocked" | "rate_limited" | "unavailable";

export class EbayError extends Error {
  kind: EbayErrorKind;
  status?: number;
  constructor(kind: EbayErrorKind, message: string, status?: number) {
    super(message);
    this.name = "EbayError";
    this.kind = kind;
    this.status = status;
  }
}

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const ITEM_URL = "https://api.ebay.com/buy/browse/v1/item/";
const MARKETPLACE = "EBAY_ES"; // eBay Spain
const SCOPE = "https://api.ebay.com/oauth/api_scope";

// ── Application OAuth token (client-credentials), cached ~2h ────
let _token = "";
let _tokenExp = 0;

async function getToken(): Promise<string> {
  if (_token && Date.now() < _tokenExp) return _token;
  const basic = Buffer.from(
    `${config.ebayClientId}:${config.ebayClientSecret}`
  ).toString("base64");
  let res: Response;
  try {
    res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    });
  } catch (e) {
    throw new EbayError(
      "unavailable",
      `No se pudo contactar con eBay: ${(e as Error).message}`
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new EbayError(
      res.status === 429 ? "rate_limited" : "unavailable",
      `eBay OAuth ${res.status}: ${detail.slice(0, 160)}`,
      res.status
    );
  }
  const data: any = await res.json();
  _token = data?.access_token || "";
  _tokenExp = Date.now() + ((Number(data?.expires_in) || 7200) - 120) * 1000;
  if (!_token) throw new EbayError("unavailable", "eBay no devolvió token.");
  return _token;
}

async function ebayGet(url: string, retry = true): Promise<Response> {
  const token = await getToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401 && retry) {
    _token = "";
    _tokenExp = 0;
    return ebayGet(url, false);
  }
  return res;
}

/** getItem gives the full photo set (primary + additionalImages). */
async function fetchItemPhotos(itemId: string): Promise<string[]> {
  try {
    const res = await ebayGet(ITEM_URL + encodeURIComponent(itemId));
    if (!res.ok) return [];
    const item: any = await res.json();
    const urls: string[] = [];
    if (item?.image?.imageUrl) urls.push(item.image.imageUrl);
    for (const a of item?.additionalImages ?? []) {
      if (a?.imageUrl) urls.push(a.imageUrl);
    }
    return urls;
  } catch {
    return [];
  }
}

function summaryToListing(s: any, photos: string[]): Listing | null {
  if (!s || !s.itemId) return null;
  const amount = Number(s.price?.value);
  if (!Number.isFinite(amount)) return null;

  const main: string | null =
    s.image?.imageUrl || s.thumbnailImages?.[0]?.imageUrl || null;

  return {
    source: "ebay",
    vintedId: String(s.itemId),
    title: String(s.title ?? "").trim() || `Anuncio eBay`,
    price: amount,
    shippingPrice: null, // could be parsed from shippingOptions; unknown up front
    currency: s.price?.currency || "EUR",
    photoUrls: photos.length ? photos : main ? [main] : [],
    thumbUrl: main,
    listingUrl: s.itemWebUrl || `https://www.ebay.es/itm/${s.legacyItemId ?? ""}`,
    sellerCountry: s.itemLocation?.country || null,
    languageVerdict: "pending",
    verdictEvidence: null,
    analyzedAt: null,
  };
}

/** Run an async fn over items with bounded concurrency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/** ONE call to item_summary/search. Returns raw summaries, sliced to perPage. */
async function fetchSummaries(query: string, perPage: number): Promise<any[]> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(Math.min(perPage, 50)));

  const res = await ebayGet(`${SEARCH_URL}?${params.toString()}`);
  if (res.status === 429) {
    throw new EbayError("rate_limited", "eBay está limitando peticiones.", 429);
  }
  if (res.status === 403) {
    throw new EbayError("blocked", "eBay bloqueó la petición (403).", 403);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new EbayError(
      "unavailable",
      `eBay respondió ${res.status}: ${detail.slice(0, 160)}`,
      res.status
    );
  }

  const data: any = await res.json();
  return (data?.itemSummaries ?? []).slice(0, perPage);
}

/** Enrich summaries with the full photo set (back cover) — bounded concurrency.
 *  12 en paralelo: esta fase alarga la respuesta inicial de la búsqueda (una
 *  llamada getItem por anuncio) y el límite diario de eBay es holgado (5.000). */
async function enrichSummaries(summaries: any[]): Promise<Listing[]> {
  const listings = await mapLimit(summaries, 12, async (s) => {
    const photos = await fetchItemPhotos(s.itemId);
    return summaryToListing(s, photos);
  });
  return listings.filter((l): l is Listing => l !== null);
}

/** Search eBay España. Returns raw (un-deduped, un-filtered) listings, with the
 *  full photo set fetched per item so the back cover is available. */
export async function searchListings(
  query: string,
  _consoleKey: ConsoleKey,
  perPage: number
): Promise<Listing[]> {
  if (!config.ebayClientId || !config.ebayClientSecret) return [];
  return enrichSummaries(await fetchSummaries(query, perPage));
}

/** Dual (console-focused + plain) search, resolved at the SUMMARY level.
 *
 *  Going through the API route's generic searchDual would enrich photos per
 *  pass: every listing found by BOTH queries (typically most of them — "mario
 *  ps4" vs "mario") would pay its getItem call twice only for the duplicate to
 *  be thrown away in the dedupe, doubling the daily-quota spend (~51 → ~102
 *  calls per search) and running two mapLimit(12) pools in parallel (24
 *  concurrent getItem). Instead: run the 2 cheap item_summary/search calls in
 *  parallel, merge the summaries deduped by itemId, and enrich the merged set
 *  ONCE (concurrency stays at 12, one getItem per unique listing).
 *
 *  The merge interleaves 1:1 (focused[0], plain[0], …) for the same reason
 *  searchDual does: downstream fetchSource caps at 25 cleaned listings, and a
 *  focused-first concat would push out exactly the plain-only items (copies
 *  whose title never names the console) this dual search exists to recover.
 *  Error semantics also match searchDual: if one pass fails we use the other;
 *  if both fail we rethrow the first error. `focusedQuery` null (no console
 *  chip, or the query already names it) collapses to the plain single search. */
export async function searchListingsDual(
  query: string,
  focusedQuery: string | null,
  perPage: number
): Promise<Listing[]> {
  if (!config.ebayClientId || !config.ebayClientSecret) return [];
  if (!focusedQuery) return enrichSummaries(await fetchSummaries(query, perPage));

  const [focusedRes, plainRes] = await Promise.allSettled([
    fetchSummaries(focusedQuery, perPage),
    fetchSummaries(query, perPage),
  ]);
  if (focusedRes.status === "rejected" && plainRes.status === "rejected") {
    throw focusedRes.reason;
  }
  const focused = focusedRes.status === "fulfilled" ? focusedRes.value : [];
  const plain = plainRes.status === "fulfilled" ? plainRes.value : [];

  const merged: any[] = [];
  const seen = new Set<string>();
  const push = (s: any) => {
    if (!s || s.itemId == null) return; // summaryToListing would drop it anyway
    const id = String(s.itemId);
    if (seen.has(id)) return;
    seen.add(id);
    merged.push(s);
  };
  const longest = Math.max(focused.length, plain.length);
  for (let i = 0; i < longest; i++) {
    if (i < focused.length) push(focused[i]);
    if (i < plain.length) push(plain[i]);
  }
  return enrichSummaries(merged);
}
