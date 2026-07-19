// ─────────────────────────────────────────────────────────────
// Persistence — file-based (no native modules, so the Electron .exe packages
// cleanly). Single-user by design.
//
//   • analysis cache  → persisted to a JSON file, keyed by vintedId, so we
//                       never re-pay for vision analysis of already-seen items.
//   • searches        → kept in memory (transient per server process); the UI
//                       polls within the same process while a search is live.
//
// Node runtime only.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type {
  DetectedPlatform,
  Listing,
  LanguageVerdict,
  MarketSource,
  SearchMeta,
} from "./types";

interface CacheEntry {
  verdict: LanguageVerdict;
  evidence: string | null;
  analyzedAt: string;
  platform?: DetectedPlatform;
}

function resolveFile(): string {
  if (config.dbPath) return config.dbPath;
  const dir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "cache.json");
}

// The verdict cache is layered:
//   L1  in-memory Map  → hot, per-process (survives HMR via globalThis).
//   L2  Upstash Redis  → PERSISTENT + shared across deploys/instances. This is
//                        what stops Render's ephemeral disk from wiping the cache
//                        on every redeploy and re-burning Gemini's daily quota.
//   L3  local JSON file → fallback for local dev when Redis isn't configured.
// If neither Redis nor a writable file exists, it degrades to L1 only.

const globalForCache = globalThis as unknown as {
  __cazapalCache?: Record<string, CacheEntry>;
};
const _cache: Record<string, CacheEntry> =
  globalForCache.__cazapalCache ?? {};
globalForCache.__cazapalCache = _cache;

// ── L2: Upstash Redis (REST, no dependency) ────────────────────
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL?.trim() || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || "";
const redisEnabled = !!(REDIS_URL && REDIS_TOKEN);

async function redisCmd(command: string[]): Promise<any> {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`redis_http_${res.status}`);
  const data = await res.json();
  return data?.result;
}

// ── L3: local file fallback (only when Redis isn't configured) ──
let _file = "";
let _fileLoaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function loadFileOnce() {
  if (_fileLoaded || redisEnabled) return;
  _fileLoaded = true;
  _file = resolveFile();
  try {
    if (fs.existsSync(_file)) {
      Object.assign(
        _cache,
        JSON.parse(fs.readFileSync(_file, "utf8")) as Record<string, CacheEntry>
      );
    }
  } catch {
    /* start empty */
  }
}

function scheduleWrite() {
  if (redisEnabled || writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      if (!_file) _file = resolveFile();
      const dir = path.dirname(_file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(_file, JSON.stringify(_cache), "utf8");
    } catch {
      /* best-effort */
    }
  }, 400);
}

// ── Analysis cache (cross-search, persisted) ───────────────────

export interface CachedVerdict {
  verdict: LanguageVerdict;
  evidence: string | null;
  analyzedAt: string;
  platform?: DetectedPlatform;
}

/** Cache key namespaced by source so ids that collide across marketplaces never
 *  share (and cross-contaminate) a verdict. */
function cacheKey(source: MarketSource, vintedId: string): string {
  return `cazapal:v2:${source}:${vintedId}`;
}

/**
 * Batch-read cached verdicts for many listings at once (one Redis MGET instead
 * of N round-trips). Returns an array aligned with the input `keys` (null where
 * there's no cache hit). Checks L1 first, then Redis for the misses (warming L1).
 */
export async function getCachedVerdicts(
  keys: { source: MarketSource; vintedId: string }[]
): Promise<(CachedVerdict | null)[]> {
  // Caching disabled → every listing is a "miss" so it gets re-analyzed live.
  if (!config.cacheEnabled) return new Array(keys.length).fill(null);
  loadFileOnce();
  const cks = keys.map((k) => cacheKey(k.source, k.vintedId));
  const result: (CachedVerdict | null)[] = new Array(keys.length).fill(null);
  const missIdx: number[] = [];
  const missKeys: string[] = [];

  cks.forEach((ck, i) => {
    const hit = _cache[ck];
    if (hit) result[i] = { ...hit };
    else if (redisEnabled) {
      missIdx.push(i);
      missKeys.push(ck);
    }
  });

  if (redisEnabled && missKeys.length) {
    try {
      const raws: (string | null)[] = await redisCmd(["MGET", ...missKeys]);
      raws.forEach((raw, j) => {
        if (!raw) return;
        try {
          const entry = JSON.parse(raw) as CacheEntry;
          _cache[missKeys[j]] = entry; // warm L1
          result[missIdx[j]] = { ...entry };
        } catch {
          /* ignore malformed */
        }
      });
    } catch {
      /* Redis down → treat as cache miss; we just re-analyze */
    }
  }

  return result;
}

export function setCachedVerdict(
  source: MarketSource,
  vintedId: string,
  verdict: LanguageVerdict,
  evidence: string | null,
  analyzedAt: string,
  platform: DetectedPlatform = "unknown"
): void {
  if (!config.cacheEnabled) return; // nothing is stored
  const ck = cacheKey(source, vintedId);
  const entry: CacheEntry = { verdict, evidence, analyzedAt, platform };
  _cache[ck] = entry; // L1
  if (redisEnabled) {
    // Fire-and-forget persistent write; never blocks analysis.
    void redisCmd(["SET", ck, JSON.stringify(entry)]).catch(() => {});
  } else {
    scheduleWrite(); // L3 file
  }
}

// ── Searches + listings (in memory) ────────────────────────────

interface SearchRecord {
  meta: SearchMeta;
  listings: Listing[];
}

// Store the searches map on globalThis so it is shared across route module
// instances. In `next dev`, route handlers can be compiled into separate module
// graphs (and HMR swaps modules on edit), which would otherwise give the POST
// /search route and the GET /status route DIFFERENT in-memory maps — making
// every status poll 404. globalThis is the single shared surface across them.
const globalForDb = globalThis as unknown as {
  __cazapalSearches?: Map<string, SearchRecord>;
};
const searches: Map<string, SearchRecord> =
  globalForDb.__cazapalSearches ?? new Map<string, SearchRecord>();
globalForDb.__cazapalSearches = searches;

export function createSearch(meta: SearchMeta, listings: Listing[]): void {
  // Deep-ish copy so later mutations don't leak references.
  searches.set(meta.id, {
    meta,
    listings: listings.map((l) => ({ ...l })),
  });
}

export function getSearch(searchId: string): SearchMeta | null {
  return searches.get(searchId)?.meta ?? null;
}

export function getListings(searchId: string): Listing[] {
  const rec = searches.get(searchId);
  if (!rec) return [];
  return rec.listings.map((l) => ({ ...l }));
}

/**
 * Update a single listing's verdict inside a search (and the shared cache).
 *
 * `persist` controls whether the verdict is written to the cross-search cache.
 * Pass false for verdicts that came from a TRANSIENT failure (rate limit,
 * network, image download) so the listing is retried on the next search instead
 * of being stuck on a cached error. Genuine verdicts (es/other, or a real
 * front-cover-only inconclusive) persist so we never re-pay to analyze them.
 */
export function updateListingVerdict(
  searchId: string,
  source: MarketSource,
  vintedId: string,
  verdict: LanguageVerdict,
  evidence: string | null,
  analyzedAt: string,
  persist = true,
  platform: DetectedPlatform = "unknown"
): void {
  const rec = searches.get(searchId);
  if (rec) {
    const l = rec.listings.find(
      (x) => x.source === source && x.vintedId === vintedId
    );
    if (l) {
      l.languageVerdict = verdict;
      l.verdictEvidence = evidence;
      l.detectedPlatform = platform;
      l.analyzedAt = analyzedAt;
    }
  }
  if (verdict !== "pending" && persist) {
    setCachedVerdict(source, vintedId, verdict, evidence, analyzedAt, platform);
  }
}

/** Count of listings in a search that already have a non-pending verdict.
 *  Pass a source to count just that marketplace (for the per-source bars). */
export function countAnalyzed(searchId: string, source?: MarketSource): number {
  const rec = searches.get(searchId);
  if (!rec) return 0;
  return rec.listings.filter(
    (l) =>
      l.languageVerdict !== "pending" && (!source || l.source === source)
  ).length;
}
