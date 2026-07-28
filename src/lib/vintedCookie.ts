// ─────────────────────────────────────────────────────────────
// DataDome cookie store — shared server-side state for the Vinted client.
//
// Vinted's API now requires a valid "datadome" cookie (issued by DataDome's
// JS challenge in a real browser, which we cannot run server-side). A GitHub
// Action running Playwright harvests the cookie from vinted.es and POSTs it
// to /api/vinted-cookie. This module keeps the accepted value:
//   • in memory on globalThis, so every route module graph shares it
//     (same pattern as __cazapalSearches in db.ts), and
//   • in a best-effort JSON file, so it survives restarts of the SAME
//     instance. Render's disk is ephemeral: a redeploy still needs a fresh
//     POST from the Action, and that's fine (it runs every 30 min).
//
// Node runtime only.
// ─────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

/** Shape DataDome cookie values match (observed empirically). */
export const DATADOME_VALUE_RE = /^[A-Za-z0-9~_.-]{40,300}$/;

interface DatadomeState {
  value: string | null;
  /** When the current value was accepted (ms epoch). 0 = never. */
  setAt: number;
  /** Last time a Vinted API call succeeded while this value was set. */
  lastOkAt: number;
}

// globalThis so the POST route, the search routes and health all see the
// same store even when Next compiles them into separate module graphs.
const globalForDatadome = globalThis as unknown as {
  __cazapalDatadome?: DatadomeState;
};
const state: DatadomeState = globalForDatadome.__cazapalDatadome ?? {
  value: null,
  setAt: 0,
  lastOkAt: 0,
};
globalForDatadome.__cazapalDatadome = state;

function resolveFile(): string {
  return path.join(process.cwd(), "data", "vinted-cookie.json");
}

let fileLoaded = false;

/** Lazy one-shot load from disk. Memory (globalThis) always wins if set. */
function loadFileOnce(): void {
  if (fileLoaded) return;
  fileLoaded = true;
  if (state.value) return;
  try {
    const file = resolveFile();
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(
      fs.readFileSync(file, "utf8")
    ) as Partial<DatadomeState>;
    if (typeof raw.value === "string" && DATADOME_VALUE_RE.test(raw.value)) {
      state.value = raw.value;
      state.setAt = typeof raw.setAt === "number" ? raw.setAt : Date.now();
      state.lastOkAt = typeof raw.lastOkAt === "number" ? raw.lastOkAt : 0;
    }
  } catch {
    /* best-effort: start without a value */
  }
}

/** Simple synchronous best-effort write (rare event: a new cookie arrived). */
function saveFile(): void {
  try {
    const file = resolveFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        value: state.value,
        setAt: state.setAt,
        lastOkAt: state.lastOkAt,
      }),
      "utf8"
    );
  } catch {
    /* best-effort */
  }
}

/** Current datadome value, or null if we don't have one yet. */
export function getDatadomeCookie(): string | null {
  loadFileOnce();
  return state.value;
}

/** Store a (pre-validated) datadome value. Ignores malformed input. */
export function setDatadomeCookie(value: string): void {
  if (!DATADOME_VALUE_RE.test(value)) return;
  loadFileOnce();
  state.value = value;
  state.setAt = Date.now();
  saveFile();
}

/** Called by the Vinted client after any successful API response, so health
 *  can report whether the cookie is actually working (memory-only: writing
 *  the file on every OK response would be needless churn). */
export function markDatadomeOk(): void {
  loadFileOnce();
  if (!state.value) return;
  state.lastOkAt = Date.now();
}

/** Safe diagnostics for /api/health. Never exposes the value itself. */
export function getDatadomeStatus(): {
  present: boolean;
  ageMinutes: number | null;
  lastOkAgoMinutes: number | null;
} {
  loadFileOnce();
  const present = !!state.value;
  return {
    present,
    ageMinutes:
      present && state.setAt > 0
        ? Math.round((Date.now() - state.setAt) / 60000)
        : null,
    lastOkAgoMinutes:
      present && state.lastOkAt > 0
        ? Math.round((Date.now() - state.lastOkAt) / 60000)
        : null,
  };
}
