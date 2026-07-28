// ─────────────────────────────────────────────────────────────
// Vinted client — ISOLATED on purpose.
//
// Vinted has no public API. This module talks to the same internal JSON
// endpoints that vinted.es uses for search. When Vinted changes those
// endpoints (they do, periodically), THIS is the only file you need to patch.
//
// Flow:
//   1. bootstrapSession(): GET the homepage to obtain the anonymous session
//      cookies Vinted requires on every /api/v2 call.
//   2. searchListings(): GET /api/v2/catalog/items with the search text.
//   3. fetchListingPhotos(): GET /api/v2/items/{id} to get the full photo set
//      (the catalog list only returns the main photo; we need the back cover).
//
// Every failure is normalized into a VintedError with a `kind` the API layer
// maps to a friendly Spanish message. Node runtime only.
// ─────────────────────────────────────────────────────────────

import { config } from "./config";
import { getDatadomeCookie, markDatadomeOk } from "./vintedCookie";
import type { ConsoleKey, Listing } from "./types";

export type VintedErrorKind = "blocked" | "rate_limited" | "unavailable";

export class VintedError extends Error {
  kind: VintedErrorKind;
  status?: number;
  constructor(kind: VintedErrorKind, message: string, status?: number) {
    super(message);
    this.name = "VintedError";
    this.kind = kind;
    this.status = status;
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// In-memory cookie jar (per server process). Refreshed lazily / on 401.
let cookieJar = "";
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 10 * 60 * 1000;

// The datadome value used in the LAST bootstrap. When a fresh cookie arrives
// via /api/vinted-cookie mid-session, this lets us force a re-bootstrap so the
// new value takes effect immediately instead of waiting for the TTL to lapse.
let bootstrapDatadome: string | null = null;

function base(): string {
  return `https://${config.vintedHost}`;
}

function mergeSetCookies(header: Headers) {
  // Node's undici exposes getSetCookie(); fall back to the folded header.
  const anyHeaders = header as unknown as { getSetCookie?: () => string[] };
  const raw =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : header.get("set-cookie")
        ? [header.get("set-cookie") as string]
        : [];
  const pairs = new Map<string, string>();
  // seed with existing jar
  for (const kv of cookieJar.split("; ").filter(Boolean)) {
    const i = kv.indexOf("=");
    if (i > 0) pairs.set(kv.slice(0, i), kv.slice(i + 1));
  }
  for (const c of raw) {
    const first = c.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) pairs.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  cookieJar = Array.from(pairs.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function bootstrapSession(force = false): Promise<void> {
  const datadome = getDatadomeCookie();
  const fresh = Date.now() - cookieFetchedAt < COOKIE_TTL_MS;
  // A "fresh" session is still stale if the stored datadome changed since the
  // last bootstrap (a new cookie just arrived): re-bootstrap with it right away.
  if (cookieJar && fresh && !force && datadome === bootstrapDatadome) return;

  // The stored datadome changed since the last bootstrap: purge the jar's old
  // datadome copy (a rotation of the PREVIOUS value) so it cannot shadow the
  // new one in apiGet. If this response rotates the new value, mergeSetCookies
  // below re-adds the rotation; otherwise apiGet appends the stored value.
  if (cookieJar && datadome !== bootstrapDatadome) {
    cookieJar = cookieJar
      .split("; ")
      .filter((kv) => !kv.startsWith("datadome="))
      .join("; ");
  }

  // Presenting a valid datadome cookie on the homepage request is what makes
  // Vinted hand out access_token_web/refresh_token_web (validated empirically;
  // without it the catalog API answers 401 invalid_authentication_token).
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
  };
  if (datadome) headers.Cookie = `datadome=${datadome}`;

  let res: Response;
  try {
    res = await fetch(base() + "/", {
      headers,
      redirect: "follow",
    });
  } catch (e) {
    throw new VintedError(
      "unavailable",
      `No se pudo contactar con Vinted: ${(e as Error).message}`
    );
  }
  if (res.status === 403 || res.status === 429) {
    throw new VintedError(
      res.status === 429 ? "rate_limited" : "blocked",
      `Vinted respondió ${res.status} al iniciar sesión anónima.`,
      res.status
    );
  }
  mergeSetCookies(res.headers);
  cookieFetchedAt = Date.now();
  bootstrapDatadome = datadome;
  if (!cookieJar) {
    throw new VintedError(
      "blocked",
      "Vinted no entregó cookies de sesión (posible bloqueo)."
    );
  }
}

async function apiGet(pathWithQuery: string, retryOnAuth = true): Promise<any> {
  await bootstrapSession();
  // Vinted rotates datadome via set-cookie, which mergeSetCookies captures —
  // in that case the jar's copy is fresher and wins. Only when the jar has no
  // datadome at all do we append the stored one.
  let cookieHeader = cookieJar;
  const datadome = getDatadomeCookie();
  if (datadome && !/(^|; )datadome=/.test(cookieJar)) {
    cookieHeader = cookieHeader
      ? `${cookieHeader}; datadome=${datadome}`
      : `datadome=${datadome}`;
  }
  let res: Response;
  try {
    res = await fetch(base() + pathWithQuery, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "es-ES,es;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: cookieHeader,
        Referer: base() + "/",
      },
    });
  } catch (e) {
    throw new VintedError(
      "unavailable",
      `Fallo de red hacia Vinted: ${(e as Error).message}`
    );
  }

  // 401 (sesión caducada) y 403 (anti-bot rechazando una cookie rancia) suelen
  // arreglarse renovando la sesión anónima. Antes el 403 fallaba a la primera y
  // el usuario veía "Vinted ha bloqueado la petición" aunque un simple reintento
  // con cookies nuevas hubiera funcionado. Reintentamos UNA vez, con una pausa
  // breve para no parecer un bucle automático.
  if ((res.status === 401 || res.status === 403) && retryOnAuth) {
    await new Promise((r) => setTimeout(r, 900));
    await bootstrapSession(true);
    return apiGet(pathWithQuery, false);
  }
  if (res.status === 429) {
    throw new VintedError("rate_limited", "Vinted está limitando peticiones.", 429);
  }
  if (res.status === 403) {
    throw new VintedError("blocked", "Vinted bloqueó la petición (403).", 403);
  }
  if (!res.ok) {
    throw new VintedError(
      "unavailable",
      `Vinted respondió ${res.status}.`,
      res.status
    );
  }
  mergeSetCookies(res.headers);
  markDatadomeOk();
  try {
    return await res.json();
  } catch {
    throw new VintedError("unavailable", "Respuesta de Vinted no era JSON.");
  }
}

// Optional: map our console chips to Vinted catalog_ids. These ids drift over
// time; left empty by default so search still works. Fill them in per host.
const CONSOLE_CATALOG_IDS: Partial<Record<ConsoleKey, number[]>> = {
  // e.g. ps2: [3025], switch: [3029], ...
};


function itemToListing(item: any): Listing | null {
  if (!item || item.id == null) return null;
  const id = String(item.id);
  const priceObj = item.price ?? item.total_item_price ?? null;
  const amount =
    typeof priceObj === "object" && priceObj
      ? Number(priceObj.amount)
      : Number(priceObj);
  if (!Number.isFinite(amount)) return null;

  const currency =
    (typeof priceObj === "object" && priceObj?.currency_code) ||
    item.currency ||
    "EUR";

  // The catalog response already includes the FULL photo set per item (2–10
  // photos, each with full_size_url and an is_main flag). We collect them all
  // here — ordered with the main/front photo first — so the analyzer has the
  // back cover without needing a second request. (The old /api/v2/items/{id}
  // detail endpoint now returns 404, so the catalog list is our only source.)
  const photoList: any[] = Array.isArray(item.photos) ? item.photos : [];
  const orderedPhotos = [...photoList].sort(
    (a, b) => (b?.is_main ? 1 : 0) - (a?.is_main ? 1 : 0)
  );
  let photoUrls: string[] = orderedPhotos
    .map((p) => p?.full_size_url || p?.url)
    .filter((u: unknown): u is string => typeof u === "string");
  if (photoUrls.length === 0) {
    const single = item.photo?.full_size_url || item.photo?.url || null;
    if (single) photoUrls = [single];
  }

  // Small thumbnail for the card grid (much lighter than full_size on mobile).
  // Vinted photos expose a `thumbnails` array; ~310px wide is ideal for a card.
  const mainPhoto = orderedPhotos[0] || item.photo;
  const thumbs: any[] = Array.isArray(mainPhoto?.thumbnails)
    ? mainPhoto.thumbnails
    : [];
  const thumbUrl: string | null =
    thumbs.find((t) => t?.type === "thumb310x430")?.url ||
    thumbs.find((t) => t?.width >= 280 && t?.width <= 480)?.url ||
    mainPhoto?.url ||
    photoUrls[0] ||
    null;

  const url: string =
    item.url ||
    `${base()}/items/${id}${item.title ? "-" + slugify(item.title) : ""}`;

  return {
    source: "vinted",
    vintedId: id,
    title: String(item.title ?? "").trim() || `Anuncio ${id}`,
    price: amount,
    shippingPrice: null, // not present in catalog list; enriched later if available
    currency: String(currency),
    photoUrls,
    thumbUrl,
    listingUrl: url,
    sellerCountry: item?.user?.country_iso_code || null,
    languageVerdict: "pending",
    verdictEvidence: null,
    analyzedAt: null,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 60);
}

/** Search Vinted's catalog. Returns raw (un-deduped, un-filtered) listings. */
export async function searchListings(
  query: string,
  consoleKey: ConsoleKey,
  perPage: number
): Promise<Listing[]> {
  const params = new URLSearchParams();
  // Search by the game name only — the platform is applied afterwards by the
  // NEGATIVE console filter in filter.ts. Appending "PS4" to the query would
  // force Vinted to only return titles that literally contain "PS4", dropping
  // PS4 copies titled just "Under the Waves" (Vinted knows their platform from
  // its category; we don't, so we keep ambiguous titles rather than lose them).
  params.set("search_text", query);
  // Fetch a POOL larger than we'll analyze (capped at Vinted's max ~96) so noisy
  // queries still surface the real matches before the relevance filter + cap.
  // Pool mayor que el cap de análisis para que el ruido no entierre las
  // coincidencias, pero SIN pasarse: 96 (el máximo) es muy llamativo para el
  // anti-bot de Vinted y nos empezó a devolver 403. 48 es lo que usa su propia
  // web y sigue siendo casi 2× el cap.
  params.set("per_page", String(Math.min(Math.max(perPage, 48), 48)));
  // "relevance" (Vinted's own match ranking) surfaces the copies that actually
  // match the game, including older listings. "newest_first" only returned the
  // most recently uploaded ones, burying older matches beyond our fetch window
  // (e.g. an "Undertale PlayStation 4" listing sat at position ~73). We re-sort
  // by price for display afterwards, so fetch order only decides WHICH listings
  // we see, and relevance is the right set.
  params.set("order", "relevance");
  const catalogIds = CONSOLE_CATALOG_IDS[consoleKey];
  if (catalogIds?.length) params.set("catalog_ids", catalogIds.join(","));

  const data = await apiGet(`/api/v2/catalog/items?${params.toString()}`);
  const items: any[] = data?.items ?? [];
  return items.map(itemToListing).filter((l): l is Listing => l !== null);
}

/**
 * Fetch the full photo set for one listing (catalog list gives only the main
 * photo; the item detail gives every photo, which is where the back cover is).
 * Returns [] on failure so the analyzer can degrade to "inconclusive".
 */
export async function fetchListingPhotos(vintedId: string): Promise<string[]> {
  try {
    const data = await apiGet(`/api/v2/items/${vintedId}`);
    const item = data?.item ?? data;
    const photos: any[] = item?.photos ?? [];
    const urls = photos
      .map((p) => p?.full_size_url || p?.url)
      .filter((u: unknown): u is string => typeof u === "string");
    return urls;
  } catch {
    return [];
  }
}
