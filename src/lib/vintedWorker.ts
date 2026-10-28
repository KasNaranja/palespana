// ─────────────────────────────────────────────────────────────
// Vinted through the owner's PC. Vinted answers 403 to Render's datacenter IP
// but serves a home connection fine, so a small program on the PC
// (worker/vinted-worker.mjs) fetches the pages for us:
//
//   server: a search needs a Vinted page → queues a job
//   PC:     GET  /api/vinted-worker/next   → gets {id, host, path}
//           fetches it from home, POST /api/vinted-worker/result → HTML back
//
// The PC only calls OUT: nothing on it is exposed. And it doesn't poll while
// idle (polling would keep Render's free instance awake around the clock and
// burn the monthly hours): it listens on a private ntfy.sh topic, and this
// server posts "wake" there when a search needs Vinted and the PC hasn't
// polled recently. The topic name is derived from the shared token, so it's
// unguessable and needs no extra setting.
// ─────────────────────────────────────────────────────────────

import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export interface WorkerJob {
  id: string;
  host: string;
  path: string;
}

interface PendingJob extends WorkerJob {
  resolve: (r: { status: number; body: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface State {
  queue: PendingJob[]; // waiting for the PC to take them
  inFlight: Map<string, PendingJob>; // taken, waiting for the result
  waiters: ((job: PendingJob | null) => void)[]; // PC polls waiting for a job
  lastSeen: number; // last poll from the PC
  seq: number;
  stats: { ok: number; fail: number; wakes: number; lastError: string; lastWake: string };
}

// globalThis: the search route and the worker routes may be separate module
// instances (see db.ts).
const g = globalThis as unknown as { __cazapalVintedWorker?: State };
const state: State = (g.__cazapalVintedWorker ??= {
  queue: [],
  inFlight: new Map(),
  waiters: [],
  lastSeen: 0,
  seq: 0,
  stats: { ok: 0, fail: 0, wakes: 0, lastError: "", lastWake: "" },
});

// A PC that polled this recently is listening; otherwise it's asleep (or off).
const ONLINE_MS = 40_000;
// How long a search waits for a sleeping PC to wake up and start polling.
const WAKE_WAIT_MS = 20_000;
// One page: the PC fetches it in a second or two; Vinted's own pacing is
// applied before the job is queued (vinted.ts's page limiter).
const JOB_TIMEOUT_MS = 60_000;

export function workerEnabled(): boolean {
  return !!config.vintedWorker.token;
}

/** The ntfy.sh topic the PC listens on, derived from the shared token. */
export function wakeTopic(token: string): string {
  return "cazapal-" + createHash("sha256").update("wake:" + token).digest("hex").slice(0, 32);
}

export function checkWorkerToken(given: string | null): boolean {
  const want = config.vintedWorker.token;
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function getVintedWorkerStats() {
  return {
    enabled: workerEnabled(),
    online: Date.now() - state.lastSeen < ONLINE_MS,
    lastSeenSecAgo: state.lastSeen ? Math.round((Date.now() - state.lastSeen) / 1000) : null,
    queued: state.queue.length,
    inFlight: state.inFlight.size,
    ...state.stats,
  };
}

let wakeInFlight: Promise<boolean> | null = null;

/** Make sure the PC is polling: wake it through ntfy and wait for its first
 *  poll. False if it doesn't show up (PC off or program not running). */
function ensureOnline(): Promise<boolean> {
  if (Date.now() - state.lastSeen < ONLINE_MS) return Promise.resolve(true);
  wakeInFlight ??= (async () => {
    try {
      state.stats.wakes++;
      // Recorded in /api/health: a wake that never reaches ntfy otherwise
      // looks exactly like a PC that is off.
      try {
        const r = await fetch(`https://ntfy.sh/${wakeTopic(config.vintedWorker.token)}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "wake",
          signal: AbortSignal.timeout(8_000),
        });
        state.stats.lastWake = `${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`;
      } catch (e) {
        state.stats.lastWake = `error ${(e as Error).message}`.slice(0, 160);
      }
      const until = Date.now() + WAKE_WAIT_MS;
      while (Date.now() < until) {
        if (Date.now() - state.lastSeen < ONLINE_MS) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    } finally {
      wakeInFlight = null;
    }
  })();
  return wakeInFlight;
}

/** Fetch one Vinted page through the PC. Resolves with Vinted's status and
 *  body; rejects (plain Error) when the PC isn't reachable. */
export async function workerGet(
  host: string,
  path: string
): Promise<{ status: number; body: string }> {
  if (!(await ensureOnline())) {
    state.stats.fail++;
    state.stats.lastError = "pc_offline";
    throw new Error("pc_offline");
  }
  return new Promise((resolve, reject) => {
    const id = `${Date.now().toString(36)}-${(state.seq++).toString(36)}`;
    const job: PendingJob = {
      id,
      host,
      path,
      resolve,
      reject,
      timer: setTimeout(() => {
        state.queue = state.queue.filter((j) => j !== job);
        state.inFlight.delete(id);
        state.stats.fail++;
        state.stats.lastError = "timeout";
        reject(new Error("pc_timeout"));
      }, JOB_TIMEOUT_MS),
    };
    const waiter = state.waiters.shift();
    if (waiter) {
      state.inFlight.set(id, job);
      waiter(job);
    } else {
      state.queue.push(job);
    }
  });
}

/** A poll from the PC: the next job, waiting up to `waitMs` for one. */
export function takeJob(waitMs: number): Promise<WorkerJob | null> {
  state.lastSeen = Date.now();
  const next = state.queue.shift();
  if (next) {
    state.inFlight.set(next.id, next);
    return Promise.resolve(publicJob(next));
  }
  return new Promise((resolve) => {
    const waiter = (job: PendingJob | null) => {
      clearTimeout(t);
      resolve(job ? publicJob(job) : null);
    };
    const t = setTimeout(() => {
      state.waiters = state.waiters.filter((w) => w !== waiter);
      state.lastSeen = Date.now();
      resolve(null);
    }, waitMs);
    state.waiters.push(waiter);
  });
}

function publicJob(j: PendingJob): WorkerJob {
  return { id: j.id, host: j.host, path: j.path };
}

/** The PC's answer for a job. False if the job is unknown (timed out). */
export function completeJob(id: string, status: number, body: string): boolean {
  state.lastSeen = Date.now();
  const job = state.inFlight.get(id);
  if (!job) return false;
  state.inFlight.delete(id);
  clearTimeout(job.timer);
  if (status > 0) state.stats.ok++;
  else {
    state.stats.fail++;
    state.stats.lastError = "pc_fetch_failed";
  }
  job.resolve({ status, body });
  return true;
}
