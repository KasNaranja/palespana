// ─────────────────────────────────────────────────────────────
// Background analysis runner. Processes a search's pending listings in small
// concurrent batches, writing each verdict to SQLite as it arrives so the UI
// can poll and update badges live. Enforces the per-search cost guard.
//
// Fire-and-forget from the search route: startAnalysis(searchId). Designed for
// the Node server runtime (next dev / next start), not edge/serverless.
// ─────────────────────────────────────────────────────────────

import { COST_GUARD, isDemoMode } from "./config";
import {
  getCachedVerdicts,
  getListings,
  updateListingVerdict,
} from "./db";
import { getDemoVerdict } from "./demo";
import type { Listing, LanguageVerdict } from "./types";
import { analyzeImages } from "./vision";

const active = new Set<string>();

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
  if (all.length === 2) return [all[0], all[1]];
  const picks = [all[0], all[1], all[all.length - 1]];
  return Array.from(new Set(picks));
}

async function analyzeOneLive(
  searchId: string,
  listing: Listing,
  imagesBudget: { remaining: number }
): Promise<void> {
  // The catalog response already carries the full photo set per listing, so we
  // use it directly. (The old per-item detail endpoint now 404s; falling back
  // to it just wasted a request per listing and raised the block risk.)
  const photos = listing.photoUrls;

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
    return;
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
    return;
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
      nowIso()
    );
  } catch (e) {
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
      nowIso()
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
      if (c && c.verdict !== "pending") {
        updateListingVerdict(
          searchId,
          l.source,
          l.vintedId,
          c.verdict as LanguageVerdict,
          c.evidence,
          c.analyzedAt
        );
      } else {
        pending.push(l);
      }
    });

    if (demo) {
      await runPool(pending, COST_GUARD.ANALYSIS_CONCURRENCY, (l) =>
        analyzeOneDemo(searchId, l)
      );
    } else {
      const imagesBudget = { remaining: COST_GUARD.MAX_IMAGES_PER_SEARCH };
      await runPool(pending, COST_GUARD.ANALYSIS_CONCURRENCY, (l) =>
        analyzeOneLive(searchId, l, imagesBudget)
      );
    }
  } finally {
    active.delete(searchId);
  }
}
