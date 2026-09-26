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
//   2. searchListings(): GET /catalog?search_text=...&page=N (HTML, ~95
//      cards/page) and parse the item cards. Each card's <a> carries a title
//      attribute like "TÍTULO, Marca: X, Estado: Y, 12.00 €, 13.20 €" plus the
//      thumb. searchListingsPlanned() runs one user search (several pages).
//   3. fetchListingPhotos(): GET /items/{id} (HTML) and extract the full-size
//      (f800) gallery — the back cover lives there. Called lazily by the
//      analyzer only for listings actually being analyzed.
//
// When Vinted changes their markup (they will), THIS is the only file to
// patch. Every failure is normalized into a VintedError with a `kind` the API
// layer maps to a friendly Spanish message. Node runtime only.
// ─────────────────────────────────────────────────────────────

import { config } from "./config";
import { searchPlanned } from "./searchPlan";
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
// bootstrap already in flight instead. A FORCE re-bootstrap (the 401/403
// retry path, where the session the request carried is known-bad) doesn't
// join a normal one, but concurrent forced ones share a single homepage GET,
// and none is needed when the session was already renewed after the failing
// request went out (`failedSession`): two pages failing together used to
// fetch the homepage twice.
let bootstrapInFlight: Promise<void> | null = null;
let forceInFlight: Promise<void> | null = null;

async function bootstrapSession(
  force = false,
  failedSession = cookieFetchedAt
): Promise<void> {
  const datadome = getDatadomeCookie();
  const fresh = Date.now() - cookieFetchedAt < COOKIE_TTL_MS;
  // A "fresh" session is still stale if the stored datadome changed since the
  // last bootstrap (a new cookie just arrived): re-bootstrap with it right away.
  if (cookieJar && fresh && !force && datadome === bootstrapDatadome) return;
  if (force) {
    if (forceInFlight) return forceInFlight;
    if (cookieJar && cookieFetchedAt > failedSession) return; // already renewed
  } else if (bootstrapInFlight) {
    return bootstrapInFlight;
  }

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
      notePageRequest(); // Vinted counts the homepage against the same limit
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
  if (force) forceInFlight = run;
  try {
    await run;
  } finally {
    // Guard against a FORCE bootstrap having replaced the slot meanwhile.
    if (bootstrapInFlight === run) bootstrapInFlight = null;
    if (forceInFlight === run) forceInFlight = null;
  }
}

/** GET an SSR page as text with the anonymous session (retries once on 401/403). */
async function htmlGet(pathWithQuery: string, retryOnAuth = true): Promise<string> {
  await bootstrapSession();
  const session = cookieFetchedAt; // which session this request carries
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
  // breve para no parecer un bucle automático. El reintento (y la portada que
  // pide bootstrapSession) son peticiones reales para Vinted: se anotan en la
  // ventana del limitador para que las páginas siguientes las respeten.
  if ((res.status === 401 || res.status === 403) && retryOnAuth) {
    await new Promise((r) => setTimeout(r, 900));
    await bootstrapSession(true, session);
    notePageRequest();
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
      /^(.*?)(?:, Marca: .{0,120}?)?, Estado: ([^,]{0,80}), ([\d.,]+) €, [\d.,]+ €$/
    );
    // Cards without the trailing prices (rare/ads) are dropped: a Listing
    // without a price can't be ranked or displayed.
    if (!m) continue;
    const title = m[1].trim();
    const price = parsePriceEur(m[3]);
    if (!title || price == null) continue;
    // Vinted's conditions: "Nuevo con etiquetas", "Nuevo sin etiquetas" (new)
    // and "Muy bueno", "Bueno", "Satisfactorio" (used).
    const estado = m[2].trim().toLowerCase();
    const sellerCondition = estado.startsWith("nuevo")
      ? ("new" as const)
      : /^(muy bueno|bueno|satisfactorio)$/.test(estado)
        ? ("used" as const)
        : null;

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
      sellerCondition,
      languageVerdict: "pending",
      verdictEvidence: null,
      analyzedAt: null,
    });
  }
  return listings;
}

/** A catalog page with at least this many cards is FULL: there is probably a
 *  next page worth fetching. (Full pages carry ~95.) */
export const FULL_CATALOG_PAGE = 90;

/** Hard cap on catalog pages ONE search may request (see searchListingsPlanned). */
export const MAX_CATALOG_PAGES_PER_SEARCH = 6;

/** Catalog pages a search may still request. One per search, shared by all
 *  its passes. */
export interface CatalogBudget {
  remaining: number;
}

export function catalogBudget(
  max: number = MAX_CATALOG_PAGES_PER_SEARCH
): CatalogBudget {
  return { remaining: max };
}

export interface CatalogRequestOptions {
  /** The search's page allowance; out of pages → [] without a request. */
  budget?: CatalogBudget;
  /** An EXTRA page (next page, short-name pass): if the rate limiter can't
   *  serve it quickly it is skipped ([]) instead of making the user wait. */
  optional?: boolean;
}

/** Search Vinted's catalog (one results page, 1-based). Returns raw
 *  (un-deduped, un-filtered) listings. */
export async function searchListings(
  query: string,
  consoleKey: ConsoleKey,
  perPage: number,
  page = 1,
  opts: CatalogRequestOptions = {}
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
  if (page > 1) params.set("page", String(page));

  if (opts.budget) {
    if (opts.budget.remaining <= 0) return [];
    opts.budget.remaining--;
  }
  const granted = await acquirePageToken(
    "catalog",
    opts.optional ? OPTIONAL_CATALOG_MAX_WAIT_MS : CATALOG_MAX_WAIT_MS
  );
  if (!granted) {
    if (opts.optional) {
      console.warn(
        `[vinted] página opcional omitida (cupo por minuto agotado): "${query}" p${page}`
      );
      return [];
    }
    // Blocked, or the minute's quota is spent by other searches: fail fast
    // (the route says "inténtalo en un minuto") instead of hitting Vinted
    // and extending the block for everyone.
    throw new VintedError(
      "rate_limited",
      "Vinted está limitando peticiones (cupo por minuto agotado)."
    );
  }

  // The SSR catalog page carries ~95 cards (no per_page control). We return
  // ALL of them: parsing is cheap, and the route's relevance filter + per-source
  // cap decide what reaches analysis. (Trimming to 48 here threw away half the
  // page before the filter ever saw it — real copies ranked 49-96 by Vinted
  // were invisible.)
  let html: string;
  try {
    html = await htmlGet(`/catalog?${params.toString()}`);
  } catch (e) {
    if (e instanceof VintedError && e.kind === "rate_limited") noteRateLimited();
    throw e;
  }
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

/**
 * The route's Vinted search: searchPlanned (dual passes + next pages +
 * short-name pass) with this search's catalog pages capped and paced by the
 * shared limiter below. Catalog requests per search WITH a console chip:
 *   · 2 always — focused + plain page 1 (they wait for the limiter);
 *   · +1 per pass whose page 1 came back full (≥ FULL_CATALOG_PAGE cards) while
 *     the first pages left fewer than `cap` candidates whose title names the
 *     console (all candidates without a chip) → its page 2;
 *   · +2 when the short-name pass applies ("dark souls 2 ps4", "… ii ps4");
 *   never more than MAX_CATALOG_PAGES_PER_SEARCH (6). Without a chip: 1 + 1 + 2.
 * Page 2 and short-name pages are optional: skipped when the limiter can't
 * serve them within OPTIONAL_CATALOG_MAX_WAIT_MS. The short-name pages ask
 * first, so when only CATALOG_RESERVE slots are free (a follow-up search while
 * the previous one's galleries load) they are the ones served.
 */
export async function searchListingsPlanned(
  query: string,
  consoleKey: ConsoleKey,
  cap: number
): Promise<Listing[]> {
  const budget = catalogBudget();
  return searchPlanned(
    (q, kind) =>
      searchListings(q, consoleKey, cap, 1, {
        budget,
        optional: kind === "short",
      }),
    query,
    consoleKey,
    {
      cap,
      nextPage: (q, _kind, first) =>
        first.length >= FULL_CATALOG_PAGE
          ? searchListings(q, consoleKey, cap, 2, { budget, optional: true })
          : Promise.resolve([]),
    }
  );
}

// ── Pacing: every page we request (catalog + item) shares one budget ──
// Vinted answers 429 "You are rate limited" after ~15 page requests in a row
// from one IP and then blocks for ~50s (measured: 15 OK then 429; 1 request
// every 1.5s still gets blocked). Firing gallery fetches unpaced made ~45% of
// them fail, so those listings were analyzed from the front cover alone.
//
// Vinted counts requests in any 60s window, so pages go through a SLIDING-
// window limiter kept below that (a token bucket let the initial burst plus
// its refills exceed 15 within the first minute and got blocked). Catalog
// pages count too: a search now asks for up to 6 of them, too many to fit in
// unpaced headroom. The catalog has PRIORITY (the user is waiting): item pages
// may only fill the window up to PAGES_PER_WINDOW - CATALOG_RESERVE, so a new
// search always finds at least CATALOG_RESERVE slots free and takes every
// slot that frees up after them (item pages can't until the count drops below
// their share). The reserve covers a search's 2 essential pages + its 2
// short-name pages (they ask before the page 2s): a follow-up search typed
// while the previous one's galleries still fill the window used to get only
// 3 slots and silently lose the short-name pass. It stays below the 6-page
// maximum on purpose: item pages set how fast Vinted listings get analyzed
// (their back cover), and each reserved slot costs them one page a minute.
// Every real request to vinted.es counts, including the homepage bootstrap
// and the 401/403 retry (notePageRequest). A 429 on either kind blocks both
// for VINTED_BLOCK_MS. Item pages also have a small concurrency cap (~2MB each
// on a 512MB instance) and wait out a block to retry once.
const PAGES_WINDOW_MS = 60_000;
const PAGES_PER_WINDOW = 14; // catalog + item pages in any 60 s (Vinted: ~15)
const CATALOG_RESERVE = 4; // slots item pages leave to the catalog
const DETAIL_PER_WINDOW = PAGES_PER_WINDOW - CATALOG_RESERVE; // 10
// Measured ~50 s; with margin, so the first request after it doesn't meet a
// block that lasted a little longer (it would burn the gallery's last try).
const VINTED_BLOCK_MS = 65_000;
// After a block the window restarts HALF full, so the requests that queued
// during it don't leave together as a burst of a whole window.
const PAGES_AFTER_BLOCK = Math.floor(PAGES_PER_WINDOW / 2);
// How long a search's catalog page waits for a slot before giving up: the
// essential ones (page 1) then fail as "rate_limited"; optional ones are skipped.
const CATALOG_MAX_WAIT_MS = 20_000;
const OPTIONAL_CATALOG_MAX_WAIT_MS = 10_000;
const DETAIL_MAX_CONCURRENT = 2;

let detailInFlight = 0;
const detailWaiters: Array<() => void> = [];
const pageRecent: number[] = []; // start times of every paced page request
let blockedUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Record a request in the window (kept sorted: a note can arrive while the
 *  post-block entries, stamped at the block's end, are still ahead). */
function recordPage(at: number): void {
  let i = pageRecent.length;
  while (i > 0 && pageRecent[i - 1] > at) i--;
  pageRecent.splice(i, 0, at);
}

/** A request to vinted.es that doesn't go through acquirePageToken (homepage
 *  bootstrap, 401/403 retry): it counts against Vinted's limit all the same,
 *  so the pages after it wait for it. */
function notePageRequest(): void {
  recordPage(Date.now());
}

/** Vinted just answered 429: stop every page request for the block. */
function noteRateLimited(): void {
  blockedUntil = Math.max(blockedUntil, Date.now() + VINTED_BLOCK_MS);
  // The block resets Vinted's window too, but restart ours half full (see
  // PAGES_AFTER_BLOCK); a second 429 from a request already in flight
  // re-stamps them instead of adding more.
  pageRecent.length = 0;
  for (let i = 0; i < PAGES_AFTER_BLOCK; i++) pageRecent.push(blockedUntil);
}

/**
 * Wait until Vinted isn't blocking us and the last-60s window has room for a
 * page of this kind; true once the slot is taken. Gives up (false) when that
 * would take longer than `maxWaitMs`, or as soon as `stillWanted` says the
 * page isn't needed any more (a slot taken for nothing would sit in the
 * window for a minute).
 */
async function acquirePageToken(
  kind: "catalog" | "detail",
  maxWaitMs = Infinity,
  stillWanted: () => boolean = () => true
): Promise<boolean> {
  const limit = kind === "catalog" ? PAGES_PER_WINDOW : DETAIL_PER_WINDOW;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    if (!stillWanted()) return false;
    const now = Date.now();
    while (pageRecent.length && now - pageRecent[0] >= PAGES_WINDOW_MS) {
      pageRecent.shift();
    }
    let wakeAt: number;
    if (now < blockedUntil) {
      wakeAt = blockedUntil;
    } else if (pageRecent.length < limit) {
      recordPage(now);
      return true;
    } else {
      // The count drops below `limit` once the oldest (length - limit + 1)
      // requests have left the window.
      wakeAt = pageRecent[pageRecent.length - limit] + PAGES_WINDOW_MS + 50;
    }
    if (wakeAt > deadline) return false;
    await sleep(wakeAt - now);
  }
}

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

/** The photo's own id (`/t/<id>/`), shared by every size and signature. */
function photoId(url: string): string {
  return url.match(/\/t\/([^/]+)\//)?.[1] ?? url;
}

function extractGallery(html: string): string[] {
  // Each gallery photo is an <img> inside data-testid="item-photo-N" (N = its
  // position). The page renders the gallery twice (desktop + mobile) and the
  // seller's avatar also comes in the f800 size, so a bare f800 scan returned
  // every photo twice — the second copy with a signature that 404s — plus the
  // avatar. The analyzer sends the LAST photo too, so a listing could be
  // judged on the seller's avatar instead of its disc photo.
  const byPosition = new Map<number, string>();
  for (const m of html.matchAll(
    /data-testid="item-photo-(\d+)"[^>]*>\s*<img[^>]*?\ssrc="(https:\/\/images1\.vinted\.net\/[^"]+)"/g
  )) {
    const pos = Number(m[1]);
    if (!byPosition.has(pos)) byPosition.set(pos, decodeEntities(m[2]));
  }
  const ordered = Array.from(byPosition.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, url]) => url);
  // Same photo at two positions would be a markup quirk: keep it once.
  const seen = new Set<string>();
  return ordered.filter((u) => {
    const id = photoId(u);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Fetch the full photo set for one listing from its SSR item page (the
 * catalog card only shows the front cover; the gallery has the back cover —
 * the decisive photo for language detection). /items/{id} without the slug
 * redirects to the canonical URL. Returns [] on failure so the analyzer can
 * degrade to the front cover it already has.
 *
 * `stillWanted` is checked right before each request: when the search is no
 * longer watched, a queued fetch gives up instead of spending Vinted's rate
 * budget on it.
 */
export async function fetchListingPhotos(
  vintedId: string,
  stillWanted: () => boolean = () => true
): Promise<string[]> {
  await acquireDetailSlot();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Only called while holding a slot, so at most DETAIL_MAX_CONCURRENT
      // item pages wait for a token at once. The token is only taken while
      // the search is still wanted (checked right before taking it), so an
      // abandoned search doesn't leave a used-up slot behind.
      if (!(await acquirePageToken("detail", Infinity, stillWanted))) return [];
      try {
        return extractGallery(await htmlGet(`/items/${vintedId}`));
      } catch (e) {
        if (e instanceof VintedError && e.kind === "rate_limited") {
          noteRateLimited();
          continue; // wait out the block (acquirePageToken) and retry once
        }
        return [];
      }
    }
    return [];
  } finally {
    releaseDetailSlot();
  }
}
