// ─────────────────────────────────────────────────────────────
// Process health for /api/health: uptime (a low value means Render restarted
// the instance) and memory, including the PEAK seen since start — the free
// instance has 512MB and an out-of-memory kill looks exactly like a restart.
// ─────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const SAMPLE_MS = 2000;

const g = globalThis as unknown as {
  __cazapalRuntime?: { peakRss: number; timer: ReturnType<typeof setInterval> };
};

function sample() {
  const rss = process.memoryUsage().rss;
  if (g.__cazapalRuntime && rss > g.__cazapalRuntime.peakRss) {
    g.__cazapalRuntime.peakRss = rss;
  }
}

/** Start the peak-memory sampler once per process (idempotent). */
export function ensureRuntimeSampler(): void {
  if (g.__cazapalRuntime) return;
  const timer = setInterval(sample, SAMPLE_MS);
  timer.unref?.();
  g.__cazapalRuntime = { peakRss: process.memoryUsage().rss, timer };
}

export function getRuntimeStats() {
  ensureRuntimeSampler();
  sample();
  const m = process.memoryUsage();
  return {
    uptimeMin: Math.round(process.uptime() / 60),
    rssMB: Math.round(m.rss / MB),
    peakRssMB: Math.round((g.__cazapalRuntime?.peakRss ?? m.rss) / MB),
    heapUsedMB: Math.round(m.heapUsed / MB),
  };
}
