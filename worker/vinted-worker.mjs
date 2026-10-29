// ─────────────────────────────────────────────────────────────
// Vinted worker — runs on the owner's PC (Node 18+, no dependencies).
//
// Vinted blocks the web server's datacenter IP but not a home connection.
// This program fetches Vinted pages from home on the server's behalf:
//   - idle: listens on a private ntfy.sh topic (no traffic to the server, so
//     Render's free instance can sleep);
//   - on "wake" (a search needs Vinted) and at start-up: polls the server for
//     page jobs, fetches each from www.vinted.*, posts the HTML back;
//   - back to idle after 10 minutes without jobs.
// It only calls out (nothing on the PC is exposed) and only ever fetches
// Vinted pages.
//
// Config: config.json next to this file: {"server": "https://…", "token": "…"}
// (the token must equal VINTED_WORKER_TOKEN on the server).
// ─────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const SERVER = String(cfg.server).replace(/\/+$/, "");
const TOKEN = String(cfg.token);
const TOPIC = "cazapal-" + createHash("sha256").update("wake:" + TOKEN).digest("hex").slice(0, 32);

const POLLERS = 3;
const IDLE_AFTER_MS = 10 * 60_000;
const MAX_BODY = 8 * 1024 * 1024;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG = path.join(DIR, "worker.log");
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1_000_000) fs.renameSync(LOG, LOG + ".old");
    fs.appendFileSync(LOG, line);
  } catch {}
  process.stdout.write(line);
}

// ── Vinted, from home ──
let cookieJar = "";
function mergeCookies(headers) {
  const set = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (!set.length) return;
  const pairs = new Map(cookieJar.split("; ").filter(Boolean).map((kv) => [kv.split("=")[0], kv]));
  for (const c of set) {
    const kv = c.split(";")[0].trim();
    const name = kv.split("=")[0];
    if (name) pairs.set(name, kv);
  }
  cookieJar = [...pairs.values()].join("; ");
}

// A real catalog or item page weighs over 1 MB. A ~19 KB 200 is Vinted's
// stripped page for a session it distrusts: once it starts, every request with
// those cookies gets it, so drop them and ask again with a fresh session.
const STRIPPED_MAX = 100_000;

async function fetchVinted(host, p) {
  const r = await fetchVintedOnce(host, p);
  if (r.status === 200 && r.body.length < STRIPPED_MAX && /^\/(catalog|items)/.test(p) && cookieJar) {
    log(`página recortada (${Math.round(r.body.length / 1024)} KB): cookies nuevas y reintento`);
    cookieJar = "";
    return fetchVintedOnce(host, p);
  }
  return r;
}

async function fetchVintedOnce(host, p) {
  // Only Vinted, only a path on it.
  if (!/^www\.vinted\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) || !p.startsWith("/") || p.startsWith("//")) {
    return { status: 0, body: "" };
  }
  try {
    const res = await fetch(`https://${host}${p}`, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
        Referer: `https://${host}/`,
        ...(cookieJar ? { Cookie: cookieJar } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    mergeCookies(res.headers);
    let body = await res.text();
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
    return { status: res.status, body };
  } catch (e) {
    log(`vinted error ${p.slice(0, 80)}: ${e.message}`);
    return { status: 0, body: "" };
  }
}

// ── Server ──
const auth = { "x-worker-token": TOKEN };
let active = false;
let lastJobAt = 0;

async function poller(n) {
  while (active) {
    if (Date.now() - lastJobAt > IDLE_AFTER_MS) {
      if (active) log("sin trabajo hace 10 min: a dormir hasta el próximo aviso");
      active = false;
      break;
    }
    let job = null;
    try {
      const r = await fetch(`${SERVER}/api/vinted-worker/next`, { headers: auth, signal: AbortSignal.timeout(60_000) });
      if (r.status === 401) {
        log("el servidor rechaza el token: revisa VINTED_WORKER_TOKEN en Render");
        await sleep(60_000);
        continue;
      }
      if (r.status === 200) job = await r.json();
      else if (r.status !== 204) await sleep(5_000); // waking up / deploying
    } catch {
      await sleep(5_000);
      continue;
    }
    if (!job) continue;
    lastJobAt = Date.now();
    const t0 = Date.now();
    const { status, body } = await fetchVinted(job.host, job.path);
    log(`[${n}] ${status} ${job.path.slice(0, 90)} (${Date.now() - t0} ms, ${Math.round(body.length / 1024)} KB)`);
    try {
      await fetch(`${SERVER}/api/vinted-worker/result`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, status, body }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      log(`no se pudo entregar el resultado: ${e.message}`);
    }
  }
}

function wake(reason) {
  lastJobAt = Date.now();
  if (active) return;
  active = true;
  log(`despierto (${reason})`);
  for (let i = 1; i <= POLLERS; i++) poller(i);
}

// ── Idle: wait for the server's "wake" on ntfy ──
// ntfy sends a keepalive every ~45 s; silence longer than this means the
// connection died quietly (sleep, Wi-Fi change…) and must be reopened.
const SILENCE_MS = 100_000;

async function listen() {
  // On reconnect, ask for anything posted while we were away.
  let since = "";
  for (;;) {
    const ctl = new AbortController();
    let watchdog = setTimeout(() => ctl.abort(), SILENCE_MS);
    try {
      const res = await fetch(`https://ntfy.sh/${TOPIC}/json${since ? `?since=${since}` : ""}`, { signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`ntfy ${res.status}`);
      let buf = "";
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ctl.abort(), SILENCE_MS);
        since = String(Math.floor(Date.now() / 1000) - 5);
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            if (JSON.parse(line).event === "message") wake("aviso de búsqueda");
          } catch {}
        }
      }
    } catch (e) {
      log(`aviso desconectado (${e.message}); reconecto en 10 s`);
    } finally {
      clearTimeout(watchdog);
    }
    await sleep(10_000);
  }
}

log(`arrancado; servidor ${SERVER}`);
listen();
wake("arranque");
