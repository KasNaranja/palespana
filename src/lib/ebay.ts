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
import { cleanListings } from "./filter";
import { focusedQueryFor, interleave, shortNameQueries } from "./searchPlan";
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

// getItem results, cached per item: repeating a search (another chip, a typo
// fixed) used to pay the same ≤50 getItem calls again out of the 5,000/day
// quota. A listing's photos rarely change within hours. Map order = insertion
// order, so the first key is the oldest (evicted when full).
const PHOTO_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PHOTO_CACHE_MAX = 3000;
const photoCache = new Map<string, { at: number; urls: string[] }>();

// getItem outcomes, for /api/health: in production 17 of 50 eBay listings of
// one search arrived with a single photo although the listing had more, and
// those ended "inconclusive" — the calls were failing silently.
const itemStats = { ok: 0, fail: 0, lastFailStatus: 0 };
export function getEbayItemStats() {
  return { ...itemStats };
}

/** getItem gives the full photo set (primary + additionalImages). One retry
 *  after a pause on a 429 or 5xx (eBay throttles bursts). */
async function fetchItemPhotos(itemId: string): Promise<string[]> {
  const hit = photoCache.get(itemId);
  if (hit && Date.now() - hit.at < PHOTO_CACHE_TTL_MS) return hit.urls;
  try {
    let res = await ebayGet(ITEM_URL + encodeURIComponent(itemId));
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await ebayGet(ITEM_URL + encodeURIComponent(itemId));
    }
    if (!res.ok) {
      itemStats.fail++;
      itemStats.lastFailStatus = res.status;
      return [];
    }
    itemStats.ok++;
    const item: any = await res.json();
    const urls: string[] = [];
    if (item?.image?.imageUrl) urls.push(item.image.imageUrl);
    for (const a of item?.additionalImages ?? []) {
      if (a?.imageUrl) urls.push(a.imageUrl);
    }
    if (urls.length > 0) {
      photoCache.delete(itemId); // re-insert as the newest
      photoCache.set(itemId, { at: Date.now(), urls });
      if (photoCache.size > PHOTO_CACHE_MAX) {
        photoCache.delete(photoCache.keys().next().value as string);
      }
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
  // If getItem failed, the search summary's own additionalImages (when eBay
  // includes them) still beat a lone main photo.
  const fromSummary = [
    main,
    ...((s.additionalImages ?? []) as any[]).map((a) => a?.imageUrl),
  ].filter((u): u is string => typeof u === "string" && !!u);

  return {
    source: "ebay",
    vintedId: String(s.itemId),
    title: String(s.title ?? "").trim() || `Anuncio eBay`,
    price: amount,
    shippingPrice: null, // could be parsed from shippingOptions; unknown up front
    currency: s.price?.currency || "EUR",
    photoUrls: photos.length ? photos : fromSummary,
    thumbUrl: main,
    listingUrl: s.itemWebUrl || `https://www.ebay.es/itm/${s.legacyItemId ?? ""}`,
    sellerCountry: s.itemLocation?.country || null,
    // eBay conditionId: 1000 new, 1500/1750 new other / with defects,
    // 2000-2500 refurbished, 2750+ used (like new, very good, good…).
    sellerCondition: (() => {
      const id = Number(s.conditionId);
      if (!Number.isFinite(id) || id <= 0) return null;
      return id === 1000 ? "new" : id >= 2000 ? "used" : null;
    })(),
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

/** ONE call to item_summary/search. Returns raw summaries, sliced to perPage.
 *  `spainOnly` keeps only items located in Spain. */
async function fetchSummaries(
  query: string,
  perPage: number,
  spainOnly = false
): Promise<any[]> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(Math.min(perPage, 50)));
  if (spainOnly) params.set("filter", "itemLocationCountry:ES");

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
  const listings = await mapLimit(summaries, 6, async (s) => {
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

/** A raw summary plus its photo-less Listing (for titles/relevance). */
interface Summary {
  s: any;
  light: Listing;
}

function toSummaries(raw: any[]): Summary[] {
  const out: Summary[] = [];
  for (const s of raw) {
    const light = summaryToListing(s, []); // null = no id/price: unusable
    if (light) out.push({ s, light });
  }
  return out;
}

const summaryKey = (x: Summary) => x.light.vintedId;

/** The route's eBay search plan, resolved at the SUMMARY level (the same
 *  passes as searchPlanned in searchPlan.ts, plus a Spain-located one).
 *
 *  Queries (item_summary/search, cheap), in two parallel rounds:
 *    1. plain query restricted to items LOCATED IN SPAIN, console-focused
 *       query, plain query;
 *    2. the short-name pass ("dark souls 2 ps4"…) when it applies — each
 *       short query both Spain-located and best match.
 *  eBay's best-match top 50 for a popular game is full of US/Japan copies, so
 *  Spanish sellers' copies (the ones this app is for) never made the list:
 *  e.g. a new "…First Sin, juego para PS4" at 24,32 € from Spain. The
 *  Spain-located results go FIRST in the merge, then the dual passes
 *  interleaved 1:1, then the short-name ones; and they are guaranteed a slot
 *  in the cap (see below).
 *
 *  Photo enrichment (one getItem per listing, the costly part) runs ONCE, over
 *  the merged set deduped by itemId and pre-filtered with the route's own
 *  cleanListings + cap, so extra queries never mean extra getItem calls: at
 *  most `perPage` per search (the old dual enriched up to ~100), fewer when
 *  fetchItemPhotos' cache already holds them. Calls per search, worst case:
 *  3 searches + 4 short-name searches + `perPage` getItem.
 *
 *  The result is FINAL — already cleaned, capped and in cleanListings' order
 *  — so the route must not clean it again: re-running cleanListings over this
 *  subset recomputes the learned sequel target on fewer strong matches, and a
 *  different target could drop listings whose getItem was already paid.
 *
 *  Errors: if every round-1 query fails we rethrow the first error; otherwise
 *  failed queries just add nothing. */
export async function searchListingsPlanned(
  query: string,
  consoleKey: ConsoleKey,
  perPage: number
): Promise<Listing[]> {
  if (!config.ebayClientId || !config.ebayClientSecret) return [];
  const focusedQuery = focusedQueryFor(query, consoleKey);

  const settled = await Promise.allSettled([
    fetchSummaries(query, perPage, true),
    ...(focusedQuery ? [fetchSummaries(focusedQuery, perPage)] : []),
    fetchSummaries(query, perPage),
  ]);
  if (settled.every((r) => r.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  const [spain, ...bestMatch] = settled.map((r) =>
    toSummaries(r.status === "fulfilled" ? r.value : [])
  );

  const shorts = shortNameQueries(
    query,
    consoleKey,
    [...spain, ...bestMatch.flat()].map((x) => x.light)
  );
  const shortRes = await Promise.all(
    shorts.map(async (q) => {
      const [inSpain, anywhere] = await Promise.all([
        fetchSummaries(q, perPage, true).catch(() => []),
        fetchSummaries(q, perPage).catch(() => []),
      ]);
      return { inSpain: toSummaries(inSpain), anywhere: toSummaries(anywhere) };
    })
  );

  const locatedInSpain = interleave(
    [spain, ...shortRes.map((r) => r.inSpain)],
    summaryKey
  );
  const dual = interleave(bestMatch, summaryKey);
  const shortAnywhere = interleave(
    shortRes.map((r) => r.anywhere),
    summaryKey
  );
  // Concatenated in that order; a one-list interleave = dedupe by itemId.
  const merged = interleave(
    [[...locatedInSpain, ...dual, ...shortAnywhere]],
    summaryKey
  );

  // Which listings take the `perPage` slots is decided HERE: every relevant
  // copy located in Spain first, so a pool of US/Japan best-match copies
  // (NTSC, useless to this app's users) can't push them out. They come back
  // in cleanListings' order (console in title first, …), like any source.
  const ranked = cleanListings(
    merged.map((x) => x.light),
    query,
    consoleKey
  );
  const inSpain = (l: Listing) => l.sellerCountry === "ES";
  const keep = new Set(
    [...ranked.filter(inSpain), ...ranked.filter((l) => !inSpain(l))]
      .slice(0, perPage)
      .map((l) => l.vintedId)
  );
  const byId = new Map(merged.map((x) => [x.light.vintedId, x.s]));
  return enrichSummaries(
    ranked.filter((l) => keep.has(l.vintedId)).map((l) => byId.get(l.vintedId))
  );
}
