// ─────────────────────────────────────────────────────────────
// Strip hunter — runs on the owner's PC next to vinted-worker.mjs.
//
// Walks sealed PS4 listings on Vinted and Wallapop and reads the factory
// seal's tear strip with the same vision pipeline as the website (photos +
// magnifier, src/lib/vision.ts). Rare strips on a PS4 game (PSP, Blu-ray
// Disc, PS3, PS5, PS Vita, other letters) are factory errors collectors pay
// a lot for: each one is re-read on its own to confirm, and listed in the
// website's "Hallazgos" tab.
//
// Runs from the PC because Vinted serves a home IP (not Render's) and so its
// progress survives Render's restarts: the state lives in hunter-state.json.
// The website shows a snapshot this program pushes to /api/hallazgos/report:
// every few seconds while the dashboard is open, otherwise only when the
// server asks through ntfy (so Render's free instance can sleep).
//
// Needs ./lib (src/lib compiled to CommonJS: see the README note below) and
// hunter.json: {"server", "token", "geminiKeys": "k1,k2", "queries"?: [...]}.
//   npx tsc src/lib/*.ts --outDir <dir>/lib --module commonjs --target es2020
//     --esModuleInterop --skipLibCheck --moduleResolution node
// ─────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "hunter.json"), "utf8"));
const SERVER = String(cfg.server).replace(/\/+$/, "");
const TOKEN = String(cfg.token);

// The website's lib reads its settings from the environment.
process.env.GEMINI_API_KEYS = cfg.geminiKeys;
// eBay only when its app keys are in hunter.json (same as on Render).
process.env.EBAY_CLIENT_ID = cfg.ebayClientId ?? "";
process.env.EBAY_CLIENT_SECRET = cfg.ebayClientSecret ?? "";
const SOURCES = ["wallapop", "vinted", ...(cfg.ebayClientId && cfg.ebayClientSecret ? ["ebay"] : [])];
process.env.ENABLE_CACHE = "false";
process.env.GEMINI_MIN_INTERVAL_MS ??= "4500";
delete process.env.VINTED_WORKER_TOKEN; // fetch Vinted directly: we ARE home

const require = createRequire(import.meta.url);
const lib = (m) => require(path.join(DIR, "lib", m));
const wallapop = lib("wallapop.js");
const ebay = lib("ebay.js");
const vinted = lib("vinted.js");
const { analyzeImages } = lib("vision.js");
const { combineSeal, textSealClaim, conditionSealSignal, isLot } = lib("sealSignals.js");
const { titleNamesConsole } = lib("filter.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SWEEP_PAUSE_MS = 6 * 3600_000;
const STANDARD = new Set(["PS4", "PlayStation"]);
const OTHER_CONSOLE = /\b(ps5|ps3|ps2|ps1|switch|xbox|psp|vita|pc|wii|3ds|nds|gba|game ?boy|game ?cube|nintendo|sega|evercade|baraja|cartas|libro|figura|funko|camiseta|poster|guía)\b/i;

// Searches, most promising first. A wrong strip comes from a factory batch
// sealed with leftover film from another line (PSP film was still around in
// 2013–2017), so: titles with known misprints and sellers who already say so,
// then that era's best sellers (more batches, more chances), then generic
// searches, and last the late titles that almost surely carry the normal strip.
const KNOWN = ["battlefield 1", "broken sword"];
const HINTS = [
  "tira psp", "precinto psp", "tira blu-ray", "tira bluray", "precinto blu-ray",
  "error precinto", "misprint ps4", "ps4 tira rara",
];
const ERA = [
  "fifa 15", "fifa 16", "fifa 17", "fifa 18", "pes 2015", "pes 2016", "pes 2017", "pes 2018",
  "call of duty advanced warfare", "call of duty black ops 3", "call of duty infinite warfare",
  "call of duty ghosts", "call of duty wwii", "battlefield 4", "battlefield hardline",
  "star wars battlefront", "uncharted 4", "uncharted collection", "the last of us",
  "gta v", "fallout 4", "the witcher 3", "driveclub", "killzone shadow fall", "knack",
  "infamous second son", "bloodborne", "the order 1886", "until dawn", "ratchet clank",
  "little big planet 3", "metal gear solid v", "assassin's creed unity", "assassin's creed syndicate",
  "far cry 4", "far cry primal", "watch dogs", "destiny", "titanfall 2", "need for speed",
  "mad max", "batman arkham knight", "middle earth shadow of mordor", "dragon age inquisition",
  "the evil within", "dying light", "mortal kombat x", "street fighter v", "tekken 7",
  "dark souls 3", "doom", "wolfenstein the new order", "dishonored 2", "rise of the tomb raider",
  "lego", "just dance", "minecraft", "rocket league", "overwatch", "horizon zero dawn",
  "gran turismo sport", "crash bandicoot", "final fantasy xv", "resident evil 7",
];
const LATE = [
  "god of war", "spider-man", "red dead redemption 2", "days gone", "ghost of tsushima",
  "detroit become human", "sekiro", "death stranding", "final fantasy vii remake",
  "kingdom hearts 3", "resident evil 2", "battlefield v", "persona 5", "yakuza", "nioh",
];
const QUERIES = cfg.queries ?? [
  ...KNOWN.map((t) => `${t} ps4 precintado`),
  ...KNOWN.map((t) => `${t} ps4 nuevo`),
  ...HINTS,
  ...ERA.map((t) => `${t} ps4 precintado`),
  "ps4 precintado", "ps4 nuevo precintado", "juego ps4 precintado", "ps4 sin abrir", "ps4 sealed",
  ...LATE.map((t) => `${t} ps4 precintado`),
];

// ── State (persists across restarts) ──
const STATE_FILE = path.join(DIR, "hunter-state.json");
const blank = () => ({
  seen: {}, // key → strip read ("" = analyzed, no strip; "-" = skipped, not a candidate)
  finds: [],
  recent: [],
  counts: { seen: 0, candidates: 0, analyzed: 0, stripRead: 0, byStrip: {}, errors: 0 },
  bySource: {
    vinted: { seen: 0, analyzed: 0, stripRead: 0 },
    wallapop: { seen: 0, analyzed: 0, stripRead: 0 },
    ebay: { seen: 0, analyzed: 0, stripRead: 0 },
  },
  sweep: { index: 0, startedAt: null, nextAt: null },
  paused: false,
});
let S = fs.existsSync(STATE_FILE) ? { ...blank(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } : blank();
// Per-source "strips read", rebuilt from the seen map (older state files
// didn't count it).
for (const src of Object.keys(S.bySource)) S.bySource[src].stripRead = 0;
for (const [k, v] of Object.entries(S.seen)) {
  if (v && v !== "-") S.bySource[k.split(":")[0]].stripRead++;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(S));
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
  }, 500);
}

const LOG = path.join(DIR, "hunter.log");
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2_000_000) fs.renameSync(LOG, LOG + ".old");
    fs.appendFileSync(LOG, line);
  } catch {}
}

// ── Snapshot for the dashboard ──
let status = "running";
let statusText = "Arrancando…";
let current = { text: "", source: null };
let watching = true; // until the server says otherwise
let lastPush = 0;

function snapshot() {
  return {
    status,
    statusText,
    startedAt: S.sweep.startedAt,
    nextSweepAt: S.sweep.nextAt,
    query: { index: S.sweep.index, total: QUERIES.length, text: current.text, source: current.source },
    counts: S.counts,
    bySource: S.bySource,
    sources: SOURCES,
    recent: S.recent.slice(0, 30),
    finds: S.finds,
    updatedAt: new Date().toISOString(),
  };
}

async function push(force = false) {
  if (!force && !watching) return;
  if (!force && Date.now() - lastPush < 4000) return;
  lastPush = Date.now();
  try {
    const r = await fetch(`${SERVER}/api/hallazgos/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": TOKEN },
      body: JSON.stringify(snapshot()),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.ok) watching = (await r.json()).watching === true;
    else if (r.status === 401) log("el servidor rechaza el token (VINTED_WORKER_TOKEN)");
  } catch {}
}
setInterval(() => push(), 5000);

// Commands from the dashboard (the visitor's browser posts them to ntfy):
// "report" = send a fresh snapshot, "play" / "pause" = resume / stop the hunt.
let interrupt = () => {};
function nap(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    interrupt = () => {
      clearTimeout(t);
      r();
    };
  });
}

function onCommand(cmd) {
  watching = true;
  if (cmd === "pause" && !S.paused) {
    S.paused = true;
    status = "paused";
    statusText = "En pausa: pulsa Play para seguir.";
    log("pausa pedida desde la web");
    save();
  } else if (cmd === "play" && (S.paused || status === "sleeping")) {
    S.paused = false;
    S.sweep.nextAt = null; // Play during the rest between sweeps: start now
    status = "running";
    statusText = "Reanudando…";
    log("play pedido desde la web");
    save();
    interrupt();
  }
  push(true);
}

/** Holds the hunt while paused (between listings, never mid-analysis). */
async function waitIfPaused() {
  while (S.paused) {
    status = "paused";
    statusText = "En pausa: pulsa Play para seguir.";
    await nap(3600_000);
  }
  if (status === "paused") status = "running";
}

// The dashboard asks for a fresh snapshot through ntfy when it opens.
const TOPIC = "cazapal-" + createHash("sha256").update("hunt:" + TOKEN).digest("hex").slice(0, 32);
async function listen() {
  for (;;) {
    const ctl = new AbortController();
    let dog = setTimeout(() => ctl.abort(), 100_000);
    try {
      const res = await fetch(`https://ntfy.sh/${TOPIC}/json`, { signal: ctl.signal });
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        clearTimeout(dog);
        dog = setTimeout(() => ctl.abort(), 100_000);
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const ev = JSON.parse(line);
            if (ev.event === "message") onCommand(String(ev.message || "").trim());
          } catch {}
        }
      }
    } catch {}
    clearTimeout(dog);
    await sleep(10_000);
  }
}

// ── One listing ──
function remember(item) {
  S.recent.unshift(item);
  S.recent = S.recent.slice(0, 30);
}

async function vision(urls) {
  for (;;) {
    try {
      return await analyzeImages(urls);
    } catch (e) {
      if (String(e.message).includes("all_keys_exhausted")) {
        status = "waiting_quota";
        statusText = "La IA no responde o se acabó la cuota de hoy; reintento en 15 min.";
        push(true);
        await sleep(15 * 60_000);
        status = "running";
        continue;
      }
      throw e;
    }
  }
}

async function handle(l) {
  const key = `${l.source}:${l.vintedId}`;
  if (key in S.seen) return;
  await waitIfPaused();
  S.counts.seen++;
  S.bySource[l.source].seen++;
  const text = `${l.sellerText ?? l.title}`;
  // Only sealed PS4 games: a strip exists only on a sealed copy.
  const ps4 = titleNamesConsole(l.title, "ps4") || !OTHER_CONSOLE.test(l.title);
  const claim = textSealClaim(text, l.title);
  if (!ps4 || claim === "opened" || isLot(l.title, text) || l.photoUrls.length === 0) {
    S.seen[key] = "-";
    return;
  }
  let condition = l.sellerConditionRaw ?? null;
  if (l.source === "wallapop") condition = (await wallapop.fetchItemCondition(l.vintedId)) ?? null;
  const cond = conditionSealSignal(l.source, condition);
  const ebayNew = l.source === "ebay" && l.sellerCondition === "new";
  if (cond === "used" || (claim !== "sealed" && cond !== "sealed" && !ebayNew)) {
    S.seen[key] = "-";
    return;
  }

  S.counts.candidates++;
  let v;
  try {
    v = await vision(l.photoUrls.slice(0, 8));
  } catch (e) {
    S.counts.errors++;
    log(`error IA ${key}: ${e.message}`);
    return; // not marked seen: retried next sweep
  }
  const r = combineSeal(v, l, { condition });
  S.counts.analyzed++;
  S.bySource[l.source].analyzed++;
  const raw = v.stripReading;
  const strip =
    v.stripText ?? (raw === "otras_letras" ? "otras letras" : null);
  // Why no letters, when none: worth a manual look only if "ilegible".
  const reason = strip
    ? null
    : raw === "ilegible"
      ? "tira ilegible"
      : raw === "sin_letras"
        ? "tira sin letras"
        : r.sealed === "no"
          ? "no precintado"
          : "sin tira visible";
  const bucket = strip ?? reason;
  S.counts.byStrip[bucket] = (S.counts.byStrip[bucket] ?? 0) + 1;
  if (strip) {
    S.counts.stripRead++;
    S.bySource[l.source].stripRead = (S.bySource[l.source].stripRead ?? 0) + 1;
  }
  const item = {
    key,
    source: l.source,
    title: l.title,
    price: l.price,
    url: l.listingUrl,
    photo: l.thumbUrl ?? l.photoUrls[0] ?? null,
    strip,
    reason,
    sealed: r.sealed,
    at: new Date().toISOString(),
  };
  S.seen[key] = strip ?? "";
  remember(item);
  log(`${key} ${strip ?? reason} · ${l.title}`);

  if (strip && !STANDARD.has(strip)) {
    // Rare: read it again from the front photo alone; both must agree.
    let again = null;
    try {
      const v2 = await vision([l.photoUrls[0]]);
      again = v2.stripText ?? (v2.stripReading === "otras_letras" ? "otras letras" : null);
    } catch {}
    const confirmed = again === strip;
    S.finds.unshift({
      ...item,
      confirmed,
      note: confirmed ? "Dos lecturas coinciden" : `Segunda lectura: ${again ?? "no se ve la tira"}`,
    });
    log(`*** HALLAZGO ${strip} (${confirmed ? "confirmado" : "por confirmar"}) ${l.listingUrl}`);
    push(true);
  }
  save();
}

// ── Sweeps ──
async function searchSource(source, q) {
  if (source === "wallapop") return wallapop.searchListings(q, "ps4", 200);
  if (source === "ebay") return ebay.searchListings(q, "ps4", 100);
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const got = await vinted.searchListings(q, "ps4", 96, page);
    out.push(...got);
    if (got.length < 40) break;
  }
  return out;
}

async function sweep() {
  // A changed search list restarts the sweep (already-seen listings are skipped).
  const sig = createHash("sha256").update(QUERIES.join("\n")).digest("hex").slice(0, 12);
  if (!S.sweep.startedAt || S.sweep.index >= QUERIES.length || S.sweep.sig !== sig) {
    S.sweep = { index: 0, startedAt: new Date().toISOString(), nextAt: null, sig };
  }
  status = "running";
  for (; S.sweep.index < QUERIES.length; S.sweep.index++) {
    await waitIfPaused();
    const q = QUERIES[S.sweep.index];
    for (const source of SOURCES) {
      current = { text: q, source };
      statusText = `Buscando «${q}» en ${{ vinted: "Vinted", wallapop: "Wallapop", ebay: "eBay" }[source]}`;
      let listings = [];
      try {
        listings = await searchSource(source, q);
      } catch (e) {
        S.counts.errors++;
        log(`error búsqueda ${source} «${q}»: ${e.message}`);
        if (/limit|429/i.test(e.message)) await sleep(60_000);
        continue;
      }
      for (const l of listings) await handle(l);
    }
    save();
  }
  S.sweep.nextAt = new Date(Date.now() + SWEEP_PAUSE_MS).toISOString();
  save();
}

log(`arrancado; ${QUERIES.length} búsquedas, ${Object.keys(S.seen).length} anuncios ya vistos`);
listen();
for (;;) {
  try {
    await waitIfPaused();
    if (S.sweep.nextAt && Date.parse(S.sweep.nextAt) > Date.now()) {
      status = "sleeping";
      statusText = `Vuelta completada; la siguiente mira solo anuncios nuevos.`;
      push(true);
      await nap(Date.parse(S.sweep.nextAt) - Date.now());
      await waitIfPaused();
    }
    S.sweep.nextAt = null;
    await sweep();
  } catch (e) {
    status = "error";
    statusText = `Error: ${String(e.message).slice(0, 120)}; reintento en 5 min.`;
    log(statusText);
    push(true);
    await sleep(5 * 60_000);
  }
}
