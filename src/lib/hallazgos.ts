// ─────────────────────────────────────────────────────────────
// Server side of "Hallazgos": keeps the latest snapshot pushed by the
// strip hunter on the owner's PC (worker/strip-hunter.mjs) and serves it to
// the dashboard. The PC is the source of truth (its state survives Render's
// restarts): when the dashboard asks and the snapshot is stale, the server
// pings the PC through ntfy (like vintedWorker.ts) so it pushes a fresh one,
// and it keeps pushing every few seconds only while someone is watching —
// otherwise Render's free instance can sleep.
// ─────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { config } from "./config";
import type { HuntSnapshot } from "./types";

interface State {
  snapshot: HuntSnapshot | null;
  receivedAt: number;
  lastViewedAt: number;
  lastPingAt: number;
}

const g = globalThis as unknown as { __cazapalHunt?: State };
const state: State = (g.__cazapalHunt ??= {
  snapshot: null,
  receivedAt: 0,
  lastViewedAt: 0,
  lastPingAt: 0,
});

const WATCHING_MS = 120_000; // a dashboard polled this recently is open
const STALE_MS = 15_000;

export function huntTopic(token: string): string {
  return "cazapal-" + createHash("sha256").update("hunt:" + token).digest("hex").slice(0, 32);
}

/** Store the PC's snapshot; tells it whether anyone is watching. */
export function receiveSnapshot(s: HuntSnapshot): { watching: boolean } {
  state.snapshot = s;
  state.receivedAt = Date.now();
  return { watching: Date.now() - state.lastViewedAt < WATCHING_MS };
}

/** For the dashboard: the latest snapshot (pinging the PC if stale). */
export async function viewSnapshot(): Promise<{
  enabled: boolean;
  snapshot: HuntSnapshot | null;
  ageSec: number | null;
}> {
  state.lastViewedAt = Date.now();
  const token = config.vintedWorker.token;
  const stale = Date.now() - state.receivedAt > STALE_MS;
  if (token && stale && Date.now() - state.lastPingAt > 20_000) {
    state.lastPingAt = Date.now();
    void fetch(`https://ntfy.sh/${huntTopic(token)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "report",
      signal: AbortSignal.timeout(8_000),
    }).catch(() => {});
  }
  return {
    enabled: !!token,
    snapshot: state.snapshot,
    ageSec: state.receivedAt ? Math.round((Date.now() - state.receivedAt) / 1000) : null,
  };
}
