// ─────────────────────────────────────────────────────────────
// Vinted client — ISOLATED on purpose.
//
// Vinted has no public API. Worse: in Sept 2026 they REMOVED the internal
// JSON endpoints (/api/v2/catalog/items and /api/v2/items/{id} now 404 even
// for a real logged-in browser) and moved the web to Next.js server-side
// rendering. The item data now only exists as rendered HTML, so this module
// scrapes the SSR pages:
//
//   1. bootstrapSession(): GET the homepage to obtain the anonymous session
//      cookies (Vinted still mints them via set-cookie, datadome included).
//   2. searchListings(): GET /catalog?search_text=... (HTML, ~95 cards/page)
//      and parse the item cards. Each card's <a> carries a title attribute
//      like "TÍTULO, Marca: X, Estado: Y, 12.00 €, 13.20 €" plus the thumb.
//   3. fetchListingPhotos(): GET /items/{id} (HTML) and extract the full-size
//      (f800) gallery — the back cover lives there. Called lazily by the
//      analyzer only for listings actually being analyzed.
//
// When Vinted changes their markup (they will), THIS is the only file to
// patch. Every failure is normalized into a VintedError with a `kind` the API
// layer maps to a friendly Spanish message. Node runtime only.
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

// Cold-start lock: the dual search fires two htmlGet calls together, and with
// an empty (or TTL-expired) jar both would enter the bootstrap at once — two
// simultaneous homepage GETs with the same datadome (a burst pattern for
// DataDome) whose set-cookie responses mergeSetCookies could interleave into a
// jar mixing two different anonymous sessions. Concurrent callers join the
// bootstrap already in flight instead; only a FORCE re-bootstrap (the 401/403
// retry path, where the current session is known-bad) starts its own.
let bootstrapInFlight: Promise<void> | null = null;

async function bootstrapSession(force = false): Promise<void> {
  const datadome = getDatadomeCookie();
  const fresh = Date.now() - cookieFetchedAt < COOKIE_TTL_MS;
  // A "fresh" session is still stale if the stored datadome changed since the
  // last bootstrap (a new cookie just arrived): re-bootstrap with it right away.
  if (cookieJar && fresh && !force && datadome === bootstrapDatadome) return;
  if (bootstrapInFlight && !force) return bootstrapInFlight;

  const run = (async () => {
    // The stored datadome changed since the last bootstrap: purge the jar's old
    // datadome copy (a rotation of the PREVIOUS value) so it cannot shadow the
    // new one in htmlGet. If this response rotates the new value, mergeSetCookies
    // below re-adds the rotation; otherwise htmlGet appends the stored value.
    if (cookieJar && datadome !== bootstrapDatadome) {
      cookieJar = cookieJar
        .split("; ")
        .filter((kv) => !kv.startsWith("datadome="))
        .join("; ");
    }

    // Presenting a valid datadome cookie on the homepage request keeps DataDome
    // happy on datacenter IPs and makes Vinted hand out the anonymous session
    // cookies (access_token_web etc.) via set-cookie.
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
  })();
  bootstrapInFlight = run;
  try {
    await run;
  } finally {
    // Guard against a FORCE bootstrap having replaced the slot meanwhile.
    if (bootstrapInFlight === run) bootstrapInFlight = null;
  }
}

/** GET an SSR page as text with the anonymous session (retries once on 401/403). */
async function htmlGet(pathWithQuery: string, retryOnAuth = true): Promise<string> {
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
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
        Cookie: cookieHeader,
        Referer: base() + "/",
      },
      redirect: "follow",
    });
  } catch (e) {
    throw new VintedError(
      "unavailable",
      `Fallo de red hacia Vinted: ${(e as Error).message}`
    );
  }

  // 401 (sesión caducada) y 403 (anti-bot rechazando una cookie rancia) suelen
  // arreglarse renovando la sesión anónima. Reintentamos UNA vez, con una pausa
  // breve para no parecer un bucle automático.
  if ((res.status === 401 || res.status === 403) && retryOnAuth) {
    await new Promise((r) => setTimeout(r, 900));
    await bootstrapSession(true);
    return htmlGet(pathWithQuery, false);
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
  return res.text();
}

// Optional: map our console chips to Vinted catalog_ids. These ids drift over
// time; left empty by default so search still works. Fill them in per host.
const CONSOLE_CATALOG_IDS: Partial<Record<ConsoleKey, number[]>> = {
  // e.g. ps2: [3025], switch: [3029], ...
};

/** Minimal HTML entity decoding for the card title attribute. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

function parsePriceEur(s: string): number | null {
  // Vinted ES renders "39.99 €" (dot decimal); tolerate a comma decimal too.
  const n = Number.parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the catalog page's item cards. Each card renders an anchor like
 *   <a href="https://www.vinted.es/items/123-slug?referrer=catalog"
 *      title="TÍTULO, Marca: X, Estado: Muy bueno, 12.00 €, 13.20 €">
 * with the thumb <img src="https://images1.vinted.net/t/..._310x430/..."> in
 * the same card markup (between this anchor and the next one).
 */
function parseCatalogCards(html: string): Listing[] {
  type RawCard = { id: string; path: string; attr: string; at: number; rawIdx: number };
  const cards: RawCard[] = [];
  // Positions of EVERY titled anchor (duplicates included): they are the card
  // boundaries for thumb pairing, even when a duplicate id is dropped below.
  const rawAnchorAts: number[] = [];
  const seen = new Set<string>();
  const anchorRe =
    /href="(?:https?:\/\/[^"/]+)?(\/items\/(\d+)-[^"?]*)[^"]*"[^>]*\btitle="([^"]+)"/g;
  for (const m of html.matchAll(anchorRe)) {
    const id = m[2];
    const at = m.index ?? 0;
    const rawIdx = rawAnchorAts.length;
    rawAnchorAts.push(at);
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push({ id, path: m[1], attr: m[3], at, rawIdx });
  }

  const listings: Listing[] = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const attr = decodeEntities(c.attr);

    // "TÍTULO[, Marca: X], Estado: Y, 12.00 €, 13.20 €" — anchored at the END
    // so commas inside the title never break the split. The first price is the
    // item price, the second is Vinted's price with buyer protection.
    const m = attr.match(
      /^(.*?)(?:, Marca: .{0,120}?)?, Estado: [^,]{0,80}, ([\d.,]+) €, [\d.,]+ €$/
    );
    // Cards without the trailing prices (rare/ads) are dropped: a Listing
    // without a price can't be ranked or displayed.
    if (!m) continue;
    const title = m[1].trim();
    const price = parsePriceEur(m[2]);
    if (!title || price == null) continue;

    // Thumb: in Vinted's card markup the item photo comes BEFORE the titled
    // anchor, so each card's image is the LAST vinted.net image between the
    // PREVIOUS titled anchor and this one. (Pairing it with the image AFTER
    // the anchor silently shifted every thumbnail by one listing — verified
    // against the detail galleries: 0/8 right the old way, 8/8 this way.)
    const segStart =
      c.rawIdx > 0 ? rawAnchorAts[c.rawIdx - 1] : Math.max(0, c.at - 8000);
    const seg = html.slice(segStart, c.at);
    const imgs = [
      ...seg.matchAll(/src="(https:\/\/images1\.vinted\.net\/[^"]+)"/g),
    ];
    // Prefer the catalog thumb size (310x430) in case other images (avatars,
    // promoted blocks) ever share the segment; otherwise take the last one.
    const preferred =
      [...imgs].reverse().find((m) => m[1].includes("/310x430/")) ??
      imgs[imgs.length - 1];
    const thumbUrl = preferred ? decodeEntities(preferred[1]) : null;

    listings.push({
      source: "vinted",
      vintedId: c.id,
      title,
      price,
      shippingPrice: null, // the card only shows price + buyer-protection total
      currency: "EUR",
      // Front cover only at search time; the analyzer lazily fetches the full
      // gallery (back cover included) via fetchListingPhotos for the listings
      // it actually analyzes.
      photoUrls: thumbUrl ? [thumbUrl] : [],
      thumbUrl,
      listingUrl: base() + c.path,
      sellerCountry: null, // not present in the card markup
      languageVerdict: "pending",
      verdictEvidence: null,
      analyzedAt: null,
    });
  }
  return listings;
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
  // "relevance" (Vinted's own match ranking) surfaces the copies that actually
  // match the game, including older listings; we re-sort by price for display.
  params.set("order", "relevance");
  const catalogIds = CONSOLE_CATALOG_IDS[consoleKey];
  if (catalogIds?.length) params.set("catalog_ids", catalogIds.join(","));

  // The SSR catalog page carries ~95 cards (no per_page control). We return
  // ALL of them: parsing is cheap, and the route's relevance filter + per-source
  // cap decide what reaches analysis. (Trimming to 48 here threw away half the
  // page before the filter ever saw it — real copies ranked 49-96 by Vinted
  // were invisible.)
  const html = await htmlGet(`/catalog?${params.toString()}`);
  const all = parseCatalogCards(html);
  if (all.length === 0 && !/\/items\/\d+-/.test(html)) {
    // Zero cards AND zero item links: either a real empty result or a layout
    // change. An empty result page still renders the catalog chrome, so only
    // flag markup drift when the page doesn't look like a results page at all.
    const looksLikeCatalog = /search_text|catalog/i.test(html);
    if (!looksLikeCatalog) {
      throw new VintedError(
        "unavailable",
        "Vinted devolvió una página inesperada (¿cambió el diseño?)."
      );
    }
  }
  return all;
}

// Detail pages are ~2MB of HTML each, so keep a small cap on how many we fetch
// at once: the analyzer may run 16 listings in parallel, and 16 simultaneous
// 2MB downloads would spike memory on Render's 512MB instance (and look like a
// bot burst to DataDome).
let detailInFlight = 0;
const detailWaiters: Array<() => void> = [];
const DETAIL_MAX_CONCURRENT = 3;

async function acquireDetailSlot(): Promise<void> {
  if (detailInFlight < DETAIL_MAX_CONCURRENT) {
    detailInFlight++;
    return;
  }
  await new Promise<void>((resolve) => detailWaiters.push(resolve));
  detailInFlight++;
}

function releaseDetailSlot(): void {
  detailInFlight--;
  const next = detailWaiters.shift();
  if (next) next();
}

/**
 * Fetch the full photo set for one listing from its SSR detail page (the
 * catalog card only shows the front cover; the gallery has the back cover —
 * the decisive photo for language detection). /items/{id} without the slug
 * redirects to the canonical URL. Returns [] on failure so the analyzer can
 * degrade to the front cover it already has.
 */
export async function fetchListingPhotos(vintedId: string): Promise<string[]> {
  await acquireDetailSlot();
  try {
    const html = await htmlGet(`/items/${vintedId}`);
    // Gallery photos render as f800 (full-size) image URLs, in document order
    // (front first). Thumbs/avatars use other size segments, so f800 alone
    // selects exactly the gallery.
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(
      /https:\/\/images1\.vinted\.net\/t[^"'\\ )]+\/f800\/[^"'\\ )]+/g
    )) {
      const u = decodeEntities(m[0]);
      if (!seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    }
    return urls;
  } catch {
    return [];
  } finally {
    releaseDetailSlot();
  }
}
