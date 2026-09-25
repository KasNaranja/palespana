// ─────────────────────────────────────────────────────────────
// Background analysis runner. Processes a search's pending listings in small
// concurrent batches, writing each verdict to SQLite as it arrives so the UI
// can poll and update badges live. Enforces the per-search cost guard.
//
// Fire-and-forget from the search route: startAnalysis(searchId). Designed for
// the Node server runtime (next dev / next start), not edge/serverless.
// ─────────────────────────────────────────────────────────────

import { config, COST_GUARD, isDemoMode } from "./config";
import {
  getCachedVerdicts,
  getListings,
  updateListingVerdict,
} from "./db";
import { getDemoVerdict } from "./demo";
import { totalPrice } from "./types";
import type { Listing, LanguageVerdict } from "./types";
import { fetchListingPhotos } from "./vinted";
import { analyzeImages } from "./vision";

const active = new Set<string>();

// Pause before the retry pass: long enough for a 503 burst to ease and for
// per-minute 429 key parking (20s) to lapse.
const RETRY_PAUSE_MS = 20_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Choose the photos most likely to reveal the copy's language. In Vinted game
 * listings the layout is almost always: photo 0 = front cover, photo 1 = BACK
 * cover (the decisive one — language list, PEGI, distributor), then detail /
 * receipt / spine shots. The old "last two photos" heuristic skipped the back
 * cover entirely on any listing with 4+ photos (it sent detail shots instead),
 * which made the model guess — the root cause of French copies slipping through
 * as "en español".
 *
 * We now send: front (0) for context, the second photo (1) which is the back
 * cover in the vast majority of listings, and the last photo as a fallback in
 * case the seller placed the back cover last. Deduped, capped at 3. On Gemini's
 * free tier extra images add no cost and no extra rate-limit hit (still one
 * request per listing), so 3 candidates is a strict accuracy win.
 */
function selectPhotos(all: string[]): string[] {
  if (all.length <= 1) return all.slice(0, 1);
  // PROBADO Y REVERTIDO: enviar 2 fotos en vez de 3 solo bajó la latencia un 3%
  // (11.857 → 11.515 ms), así que no compensaba perder el comodín de la última
  // foto (los anuncios donde el vendedor pone la contraportada al final). El
  // freno real no es el tamaño del envío, sino la capacidad de la instancia.
  if (all.length === 2) return [all[0], all[1]];
  const picks = [all[0], all[1], all[all.length - 1]];
  return Array.from(new Set(picks));
}

/** Returns false on a TRANSIENT failure (overload, rate limit, image
 *  download) when `finalAttempt` is false: the listing is left "pending" so
 *  the caller can retry it later and the UI keeps polling meanwhile. */
async function analyzeOneLive(
  searchId: string,
  listing: Listing,
  imagesBudget: { remaining: number },
  finalAttempt: boolean
): Promise<boolean> {
  // Vinted's catalog card only carries the front cover (their JSON API is
  // gone; we scrape SSR HTML now), and the decisive photo for language is the
  // BACK cover. Enrich lazily — one detail-page fetch per listing, only for
  // listings that reach analysis, throttled inside fetchListingPhotos. On
  // failure we fall back to the front cover we already have.
  let photos = listing.photoUrls;
  if (listing.source === "vinted" && photos.length <= 1) {
    const gallery = await fetchListingPhotos(listing.vintedId);
    if (gallery.length > photos.length) photos = gallery;
  }

  // No photos at all → genuinely nothing to analyze.
  if (photos.length === 0) {
    updateListingVerdict(
      searchId,
      listing.source,
      listing.vintedId,
      "inconclusive",
      "El anuncio no tiene fotos para analizar.",
      nowIso()
    );
    return true;
  }

  // NOTE: we no longer skip single-photo (front-only) listings. The front cover
  // of modern games carries real language signals — the blue "PS5 upgrade"
  // ribbon, PEGI descriptor text and retail stickers are printed in the
  // edition's language (e.g. "Aggiornamento disponibile per PS5" = italiano;
  // "Actualización disponible para PS5" = español). We send whatever photos
  // exist and let the model read those signals.
  const chosen = selectPhotos(photos);
  const willSend = Math.min(chosen.length, imagesBudget.remaining);
  if (willSend < 1) {
    // Out of image budget for this search — search-specific, not a property of
    // the listing, so don't persist it (retry next time).
    updateListingVerdict(
      searchId,
      listing.source,
      listing.vintedId,
      "inconclusive",
      "No se analizó por el límite de imágenes de esta búsqueda.",
      nowIso(),
      false
    );
    return true;
  }
  imagesBudget.remaining -= willSend;

  try {
    const result = await analyzeImages(chosen.slice(0, willSend));
    updateListingVerdict(
      searchId,
      listing.source,
      listing.vintedId,
      result.verdict,
      result.evidence,
      nowIso(),
      true,
      result.platform,
      result.sealed
    );
    return true;
  } catch (e) {
    // Nothing was actually analyzed: give the images back to the budget so a
    // retry of this listing isn't starved by its own failed attempt.
    imagesBudget.remaining += willSend;
    if (!finalAttempt) return false;
    // Transient failure (rate limit, overload, image download): do NOT persist,
    // so this listing is retried on the next search instead of being stuck.
    updateListingVerdict(
      searchId,
      listing.source,
      listing.vintedId,
      "inconclusive",
      "No se pudo completar el análisis de idioma de este anuncio (reintentable).",
      nowIso(),
      false
    );
    return true;
  }
}

async function analyzeOneDemo(
  searchId: string,
  listing: Listing
): Promise<void> {
  // Simulate per-listing latency so badges reveal progressively.
  await sleep(400 + Math.floor(((listing.vintedId.length * 137) % 900)));
  const baked = getDemoVerdict(listing.vintedId);
  if (baked) {
    updateListingVerdict(
      searchId,
      listing.source,
      listing.vintedId,
      baked.verdict,
      baked.evidence,
      nowIso(),
      true,
      "unknown",
      baked.sealed ?? "unknown"
    );
  } else {
    updateListingVerdict(
      searchId,
      listing.source,
      listing.vintedId,
      "inconclusive",
      "Sin datos de ejemplo para este anuncio.",
      nowIso()
    );
  }
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/**
 * Kick off analysis for a search. Idempotent per searchId while running.
 * Returns immediately if already active; otherwise runs to completion in the
 * background (caller should NOT await if it wants an instant response).
 */
export async function startAnalysis(searchId: string): Promise<void> {
  if (active.has(searchId)) return;
  active.add(searchId);
  try {
    const demo = isDemoMode();
    // Per-source caps are already applied at fetch time; the search may hold up
    // to MAX_LISTINGS_PER_SEARCH from EACH source, so don't slice the combined
    // list here (that would truncate the second source).
    const all = getListings(searchId);

    // Apply the cross-search cache first (skip re-paying for seen items). One
    // batched read (Redis MGET when configured) instead of N round-trips.
    const candidates = all.filter((l) => l.languageVerdict === "pending");
    const cached = await getCachedVerdicts(
      candidates.map((l) => ({ source: l.source, vintedId: l.vintedId }))
    );
    const pending: Listing[] = [];
    candidates.forEach((l, i) => {
      const c = cached[i];
      // Entries cached BEFORE the "Precintados" feature carry no `sealed` field.
      // Replaying them as-is would freeze those listings at sealed:"unknown"
      // forever (the hit re-persists the entry), silently emptying the filter on
      // every already-searched game. Treat as a MISS — but ONLY for the verdicts
      // the seal filter can actually show (es / es_multi), so each old Spanish
      // copy is re-analyzed just once and re-cached with a real seal verdict,
      // without re-burning the Gemini quota for the whole cache.
      const needsSeal =
        !!c &&
        (c.verdict === "es" || c.verdict === "es_multi") &&
        c.sealed === undefined;
      if (c && c.verdict !== "pending" && !needsSeal) {
        updateListingVerdict(
          searchId,
          l.source,
          l.vintedId,
          c.verdict as LanguageVerdict,
          c.evidence,
          c.analyzedAt,
          true,
          c.platform ?? "unknown",
          c.sealed ?? "unknown"
        );
      } else {
        pending.push(l);
      }
    });

    // ORDEN DE ANÁLISIS = MÁS BARATOS PRIMERO. El análisis está limitado por el
    // ritmo de Gemini (no por latencia), así que no podemos hacerlo más rápido
    // en total — pero SÍ decidir qué se resuelve antes. La vista ordena por
    // precio, así que analizando de barato a caro los veredictos aparecen en las
    // tarjetas de arriba (las que el usuario mira) en segundos, en vez de tener
    // que esperar a que termine todo. Antes se analizaba por orden de fuente:
    // el chollo más barato podía ser el ÚLTIMO en resolverse.
    pending.sort((a, b) => totalPrice(a) - totalPrice(b));

    if (demo) {
      await runPool(pending, COST_GUARD.ANALYSIS_CONCURRENCY, (l) =>
        analyzeOneDemo(searchId, l)
      );
    } else {
      const imagesBudget = { remaining: COST_GUARD.MAX_IMAGES_PER_SEARCH };
      // Run as many listings concurrently as we have Gemini keys, so each key is
      // busy at once (each is throttled independently in vision.ts). One key →
      // the usual 2; three keys → 3 in parallel ≈ 3× throughput.
      // MEDIDO en producción: cada llamada a Gemini tarda ~8,6 s y NO recibimos
      // ningún 429 (ni por minuto ni diario), y la espera del throttle es de
      // ~0,3 s. Es decir: el cuello de botella NO son las claves ni el ritmo,
      // sino cuántas llamadas hacemos EN PARALELO. Con C llamadas simultáneas y
      // ~8,6 s cada una, el ritmo es C/8,6 → con C = nº claves nos quedábamos en
      // ~1,2 análisis/s desaprovechando las claves. Duplicamos el paralelismo
      // (tope 16 para no arriesgar la memoria del plan free de Render); el
      // throttle por clave sigue limitando a ~13 req/min por clave.
      const concurrency = Math.min(
        Math.max(COST_GUARD.ANALYSIS_CONCURRENCY, config.geminiKeys.length * 2),
        16
      );
      // Gemini overloads come in bursts (503s): a listing that fails now very
      // often succeeds a few seconds later, typically on the fallback model.
      // First pass leaves transient failures "pending" (the UI keeps polling);
      // after a short pause they get ONE final attempt. Before this, a burst
      // turned ~85 of 118 listings "inconclusive" in a single search.
      const retry: Listing[] = [];
      await runPool(pending, concurrency, async (l) => {
        if (!(await analyzeOneLive(searchId, l, imagesBudget, false))) {
          retry.push(l);
        }
      });
      if (retry.length > 0) {
        await sleep(RETRY_PAUSE_MS);
        await runPool(retry, concurrency, async (l) => {
          await analyzeOneLive(searchId, l, imagesBudget, true);
        });
      }
    }
  } finally {
    active.delete(searchId);
  }
}
