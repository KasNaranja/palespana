// ─────────────────────────────────────────────────────────────
// Central runtime configuration + cost/rate guards.
// All secrets stay server-side; never import this into a "use client" file.
// ─────────────────────────────────────────────────────────────

export const COST_GUARD = {
  /** Hard cap on how many listings are fetched/analyzed per search, PER SOURCE
   *  (Vinted, Wallapop and eBay each). Each listing = 1 Gemini request; the
   *  free tier gives ~500 requests/day PER PROJECT, and with 10 keys (10
   *  projects) that's ~5.000/day → 50×3 = 150 per search ≈ 33 full searches a
   *  day. Raised from 25 once the dual console search and loose relevance
   *  tier started finding more genuine copies than 25 slots could hold (e.g.
   *  44 real copies on Vinted alone for "dark souls scholar of the first sin"). */
  MAX_LISTINGS_PER_SEARCH: 50,
  /** Hard cap on total images per search across all sources (a sanity bound;
   *  the daily quota counts REQUESTS, not images). MUST cover every listing's
   *  full photo set: 3 sources × 50 × 3 = 450. When it was 150 (sized for 2
   *  sources × 25) the eBay era silently left the priciest ~25 listings of
   *  each search unanalyzed — "inconclusive", hence hidden by "Solo en
   *  español". */
  MAX_IMAGES_PER_SEARCH: 450,
  /** Max images sent per individual listing: front + back + a fallback back. */
  MAX_IMAGES_PER_LISTING: 3,
  /** How many listings to analyze concurrently. Low, because the Gemini free
   *  tier is rate-limited and vision.ts already serializes calls. */
  ANALYSIS_CONCURRENCY: 2,
};

// One or more Gemini keys. Each Google project has its OWN free daily quota, so
// several keys (from several projects) multiply both the daily limit AND the
// throughput (vision.ts round-robins across them in parallel). Set GEMINI_API_KEYS
// as a comma-separated list; falls back to the single GEMINI_API_KEY.
const geminiKeys = (
  process.env.GEMINI_API_KEYS ||
  process.env.GEMINI_API_KEY ||
  ""
)
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

export const config = {
  geminiKeys,
  // The "-latest" alias is QUARANTINED: it broke production twice (silent
  // rotation into a geo-blocked model, then a day of global 503 saturation).
  // The Render service still carries it in its env (blueprint env-value edits
  // don't auto-sync like resource additions do), so we ignore that one value
  // here; any OTHER explicit model in the env still wins over the default.
  geminiModel:
    (() => {
      const m = process.env.GEMINI_VISION_MODEL?.trim();
      return m && m !== "gemini-flash-lite-latest" ? m : "gemini-3.1-flash-lite";
    })(),
  // Models tried, in order, when the main one answers 503 (overloaded). A 503
  // is about the MODEL, not the key, so rotating keys against it is useless;
  // switching model is what works. Each model also has its own free quota per
  // project, so fallbacks add daily capacity too. Explicit ids only (aliases
  // rotate silently). Validated with a real cover: both read platform + seal.
  geminiFallbackModels: (
    process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash-lite"
  )
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),
  // Minimum ms between Gemini requests (free tier ~ a handful per minute).
  geminiMinIntervalMs: Number(process.env.GEMINI_MIN_INTERVAL_MS || "4500"),
  // Gemini relay (pal-relay, Render Oregon): Google geo-blocks the free tier
  // from Render Frankfurt, so in production the calls go through a US relay.
  // Empty (e.g. local dev from Spain) → direct Google endpoint.
  geminiProxyUrl: process.env.GEMINI_PROXY_URL?.trim() || "",
  // Shared secret for the relay; injected by Render via fromService.
  relayToken: process.env.RELAY_TOKEN || "",
  // Secret guarding /api/gemini-probe (the probe spends real Gemini quota, so
  // it must not be public). Set PROBE_SECRET in the Render dashboard; while
  // unset the probe always answers 401 (closed by default).
  probeSecret: process.env.PROBE_SECRET || "",
  vintedEnabled: (process.env.ENABLE_VINTED || "").toLowerCase() === "true",
  vintedHost: process.env.VINTED_HOST?.trim() || "www.vinted.es",
  // Wallapop: on by default in live mode. Its search needs a location; default
  // to the centre of Spain so results are nationwide.
  wallapopEnabled: (process.env.ENABLE_WALLAPOP || "true").toLowerCase() === "true",
  wallapopLat: process.env.WALLAPOP_LAT?.trim() || "40.4168",
  wallapopLng: process.env.WALLAPOP_LNG?.trim() || "-3.7038",
  // eBay Browse API app credentials (developer.ebay.com). eBay is searched only
  // when BOTH are present.
  ebayClientId: process.env.EBAY_CLIENT_ID?.trim() || "",
  ebayClientSecret: process.env.EBAY_CLIENT_SECRET?.trim() || "",
  dbPath: process.env.CAZAPAL_DB_PATH?.trim() || "",
  // Verdict memory OFF by design: every search re-analyzes live, nothing is
  // stored. Set ENABLE_CACHE=true to remember each listing's (permanent)
  // language and save Gemini's daily quota.
  cacheEnabled: (process.env.ENABLE_CACHE || "false").toLowerCase() === "true",
  forcedDemo: (process.env.DEMO_MODE || "").toLowerCase() === "true",
};

/**
 * Demo mode is on when explicitly forced, or when we lack either a Gemini key
 * or live Vinted access. In demo mode the app serves bundled sample data and
 * pre-baked verdicts so it is fully usable on first run.
 */
export function isDemoMode(): boolean {
  if (config.forcedDemo) return true;
  if (config.geminiKeys.length === 0) return true;
  if (!config.vintedEnabled) return true;
  return false;
}

/** Human-readable reason we're in demo mode (for the UI banner). */
export function demoReason(): string | null {
  if (!isDemoMode()) return null;
  if (config.forcedDemo) return "DEMO_MODE está activado.";
  const noKey = config.geminiKeys.length === 0;
  if (noKey && !config.vintedEnabled)
    return "Falta la clave de Gemini y ENABLE_VINTED no está activo.";
  if (noKey) return "Falta la clave de Gemini (GEMINI_API_KEY).";
  return "ENABLE_VINTED no está activo.";
}
