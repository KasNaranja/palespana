// ─────────────────────────────────────────────────────────────
// Central runtime configuration + cost/rate guards.
// All secrets stay server-side; never import this into a "use client" file.
// ─────────────────────────────────────────────────────────────

export const COST_GUARD = {
  /** Hard cap on how many listings are fetched/analyzed per search, PER SOURCE
   *  (Vinted and Wallapop each). Kept at 25 because Gemini's FREE tier allows
   *  only ~500 requests/day and each listing = 1 request; 25×2 sources = 50 per
   *  search means ~10 full searches/day fit the free quota. */
  MAX_LISTINGS_PER_SEARCH: 25,
  /** Hard cap on total images per search across all sources (only a sanity
   *  bound; the daily quota counts REQUESTS, not images). 2×25×3 = 150. */
  MAX_IMAGES_PER_SEARCH: 150,
  /** Max images sent per individual listing: front + back + a fallback back. */
  MAX_IMAGES_PER_LISTING: 3,
  /** How many listings to analyze concurrently. Low, because the Gemini free
   *  tier is rate-limited and vision.ts already serializes calls. */
  ANALYSIS_CONCURRENCY: 2,
};

export const config = {
  geminiKey: process.env.GEMINI_API_KEY?.trim() || "",
  geminiModel: process.env.GEMINI_VISION_MODEL?.trim() || "gemini-flash-lite-latest",
  // Minimum ms between Gemini requests (free tier ~ a handful per minute).
  geminiMinIntervalMs: Number(process.env.GEMINI_MIN_INTERVAL_MS || "4500"),
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
  if (!config.geminiKey) return true;
  if (!config.vintedEnabled) return true;
  return false;
}

/** Human-readable reason we're in demo mode (for the UI banner). */
export function demoReason(): string | null {
  if (!isDemoMode()) return null;
  if (config.forcedDemo) return "DEMO_MODE está activado.";
  if (!config.geminiKey && !config.vintedEnabled)
    return "Falta la clave de Gemini y ENABLE_VINTED no está activo.";
  if (!config.geminiKey) return "Falta la clave de Gemini (GEMINI_API_KEY).";
  return "ENABLE_VINTED no está activo.";
}
