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
const { analyzeImages, getVisionStats } = lib("vision.js");
const { combineSeal, textSealClaim, conditionSealSignal, isLot } = lib("sealSignals.js");
const { titleNamesConsole } = lib("filter.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SWEEP_PAUSE_MS = 6 * 3600_000;
const STANDARD = new Set(["PS4", "PlayStation"]);
const OTHER_CONSOLE =
  /\b(ps5|ps3|ps2|ps1|psx|switch|xbox|x360|psp|vita|pc|wii|3ds|nds|ds|n64|gba|game ?boy|game ?cube|nintendo|sega|dreamcast|evercade|baraja|cartas|libro|figura|funko|camiseta|poster|guía)(?![a-z])/i;
const isPs4 = (title) => titleNamesConsole(title, "ps4") || !OTHER_CONSOLE.test(title);

// Searches, most promising first. A wrong strip comes from a factory batch
// sealed with leftover film from another line (PSP film was still around in
// 2013–2017), so: titles with known misprints, then that era's best sellers
// (more batches, more chances), then generic searches, and last the late
// titles that almost surely carry the normal strip. No "tira psp"-style
// searches: they mostly bring back games for other consoles.
const KNOWN = ["battlefield 1", "broken sword"];
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
// One search per game (hunter.json "queries" can replace the list), digging
// through every page; only listings of that very game are looked at.
const QUERIES = cfg.queries ?? [...KNOWN, ...ERA];

// Strict match: every word of the game's name in the title ("battlefield 1"
// must not take Battlefield 4 / V / Hardline), or the name written together
// ("FIFA17").
const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", xv: "15" };
const words = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => ROMAN[w] ?? w);
function isGame(title, game) {
  const t = words(title);
  const g = words(game);
  return g.every((w) => t.includes(w)) || t.join("").includes(g.join(""));
}

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
  gameOf: {}, // listing key → the game search that found it first
  items: {}, // sealed listing key → {t: title, u: url, p: photo, $: price}, for the per-game lists
  paused: false,
});
let S = fs.existsSync(STATE_FILE) ? { ...blank(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } : blank();
// Per-source "strips read", rebuilt from the seen map (older state files
// didn't count it).
for (const src of Object.keys(S.bySource)) S.bySource[src].stripRead = 0;
for (const [k, v] of Object.entries(S.seen)) {
  if (v && v !== "-" && v !== "0" && v !== "x") S.bySource[k.split(":")[0]].stripRead++;
}
// Sealed copies analyzed before S.items existed: title from the log (the
// link and photo arrive when a search returns them again, see handle()).
if (Object.keys(S.items).length === 0) {
  for (const file of [path.join(DIR, "hunter.log.old"), path.join(DIR, "hunter.log")]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\S+ ((?:vinted|wallapop|ebay):\S+) .*? · (.+)$/);
      if (m && !(m[1] in S.items)) S.items[m[1]] = { t: m[2] };
    }
  }
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
    games: gameSummary(),
    selection,
    updatedAt: new Date().toISOString(),
  };
}

// Per game, from what each of its listings ended up as (see S.seen).
function gameSummary() {
  const by = new Map(
    QUERIES.map((name, i) => [
      name,
      {
        name,
        status: i < S.sweep.index ? "done" : i === S.sweep.index ? "current" : "pending",
        seen: 0, sealed: 0, ps4: 0, playstation: 0, rare: 0, unread: 0,
      },
    ])
  );
  for (const [key, game] of Object.entries(S.gameOf)) {
    const g = by.get(game);
    if (!g) continue;
    g.seen++;
    const v = S.seen[key];
    if (v === undefined || v === "-" || v === "x") continue;
    g.sealed++;
    if (v === "PS4") g.ps4++;
    else if (v === "PlayStation") g.playstation++;
    else if (v === "" || v === "0") g.unread++;
    else g.rare++;
  }
  return [...by.values()];
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
  } else if (cmd.startsWith("list:")) {
    selection = listGame(cmd.slice(5));
  } else if (cmd === "purge") {
    purgeNotPs4();
  }
  push(true);
}

// The sealed copies of one game, asked for by the dashboard (a click on a
// number of the per-game table).
let selection = null;
function listGame(game) {
  const items = [];
  for (const [key, g] of Object.entries(S.gameOf)) {
    const v = S.seen[key];
    if (g !== game || v === undefined || v === "-" || v === "x") continue;
    const [source, id] = key.split(":");
    const it = S.items[key] ?? {};
    items.push({
      key,
      source,
      title: it.t ?? key,
      url: it.u ?? (source === "vinted" ? `https://www.vinted.es/items/${id}` : null),
      photo: it.p ?? null,
      price: it.$ ?? null,
      strip: v === "" || v === "0" ? null : v,
    });
  }
  return { game, items };
}

/** Drops finds whose title names another console (false positives from
 *  before the console filter worked) and un-counts their strips. */
function purgeNotPs4() {
  const gone = S.finds.filter((f) => !isPs4(f.title));
  for (const f of gone) {
    const strip = S.seen[f.key];
    if (strip && S.counts.byStrip[strip]) {
      if (--S.counts.byStrip[strip] <= 0) delete S.counts.byStrip[strip];
      S.counts.stripRead = Math.max(0, S.counts.stripRead - 1);
      const src = S.bySource[f.source];
      if (src?.stripRead) src.stripRead--;
    }
    S.seen[f.key] = "-";
    delete S.gameOf[f.key];
  }
  S.finds = S.finds.filter((f) => isPs4(f.title));
  S.recent = S.recent.filter((it) => !gone.some((f) => f.key === it.key));
  log(`limpieza pedida desde la web: ${gone.length} hallazgos de otras consolas quitados`);
  save();
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

// "all_keys_exhausted" means no model answered: usually Google being busy
// (503/500, timeouts, free-tier capacity), rarely every key's daily quota. So
// retry soon and back off only while it keeps failing.
const BACKOFF_MIN = [0.5, 0.5, 1, 1, 2, 2, 3, 3, 5, 10, 15];
async function vision(urls) {
  for (let fails = 0; ; fails++) {
    try {
      const r = await analyzeImages(urls);
      if (status === "waiting_quota") status = "running";
      return r;
    } catch (e) {
      if (String(e.message).includes("all_keys_exhausted")) {
        const min = BACKOFF_MIN[Math.min(fails, BACKOFF_MIN.length - 1)];
        status = "waiting_quota";
        const when = min < 1 ? "30 s" : `${min} min`;
        statusText =
          fails < 8
            ? `Los servidores gratuitos de Google están saturados ahora mismo (no es tu cuota); reintento en ${when}.`
            : `La IA lleva rato sin responder (saturación de Google o cuota de hoy agotada); reintento en ${when}.`;
        const st = getVisionStats();
        log(
          `IA sin respuesta (${fails + 1}); espero ${min} min · timeouts ${st.timeouts} 503 ${st.r503} 429cap ${st.r429cap} 429día ${st.r429day} 429min ${st.r429min} · ${st.last429Metrics} · ${urls.length} fotos ${urls[0]}`
        );
        push(true);
        await sleep(min * 60_000);
        continue;
      }
      throw e;
    }
  }
}

const readStrip = (v) => v.stripText ?? (v.stripReading === "otras_letras" ? "otras letras" : null);

// No letters from the first look: the strip may be in another photo. Vinted's
// search gives only the cover, so open the listing for its gallery; then look
// at the other photos one by one (each gets the magnifier).
async function morePhotos(l, key) {
  let photos = l.photoUrls;
  if (l.source === "vinted") {
    try {
      const g = await vinted.fetchListingPhotos(l.vintedId);
      if (g.length) photos = g;
    } catch {}
  }
  const out = { strip: null, raw: null, photo: null };
  const others = photos.filter((p) => p !== l.photoUrls[0]).slice(0, 4);
  for (const p of others) {
    let v2;
    try {
      v2 = await vision([p]);
    } catch {
      break;
    }
    const s2 = readStrip(v2);
    if (s2) return { strip: s2, raw: v2.stripReading, photo: p };
    if (v2.stripReading === "ilegible") out.raw = "ilegible";
  }
  log(`${key} ${others.length} fotos más → nada`);
  return out;
}

// S.seen values: a strip; "-" not a candidate; "x" analyzed, not sealed;
// "0" analyzed, no strip after
// every photo; "" analyzed by an older version on the first photo only, so it
// gets the extra photos the next time a search returns it.
async function handle(l) {
  const key = `${l.source}:${l.vintedId}`;
  if (S.seen[key] === "") return retryMorePhotos(l, key);
  if (key in S.seen) {
    const v = S.seen[key];
    if (v !== "-" && v !== "x" && !S.items[key]?.u) keepItem(l, key);
    return;
  }
  await waitIfPaused();
  S.counts.seen++;
  S.bySource[l.source].seen++;
  const text = `${l.sellerText ?? l.title}`;
  // Only sealed PS4 games: a strip exists only on a sealed copy.
  const ps4 = isPs4(l.title);
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
  let raw = v.stripReading;
  let strip = readStrip(v);
  let stripPhoto = l.photoUrls[0];
  if (!strip && raw !== "sin_letras" && r.sealed !== "no") {
    const m = await morePhotos(l, key);
    if (m.strip) ({ strip, raw, photo: stripPhoto } = m);
    else if (m.raw) raw = m.raw;
  }
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
  record(l, key, strip, reason, r.sealed, stripPhoto);
}

async function retryMorePhotos(l, key) {
  if (!isPs4(l.title)) {
    S.seen[key] = "-";
    return;
  }
  await waitIfPaused();
  const m = await morePhotos(l, key);
  if (!m.strip) {
    S.seen[key] = "0";
    remember({
      key,
      source: l.source,
      title: l.title,
      price: l.price,
      url: l.listingUrl,
      photo: l.thumbUrl ?? l.photoUrls[0] ?? null,
      strip: null,
      reason: m.raw === "ilegible" ? "tira ilegible" : "repasado: sin tira",
      sealed: "yes",
      at: new Date().toISOString(),
    });
    save();
    return;
  }
  log(`${key} leída en otra foto`);
  record(l, key, m.strip, null, "yes", m.photo);
}

function keepItem(l, key) {
  S.items[key] = { t: l.title, u: l.listingUrl, p: l.thumbUrl ?? l.photoUrls[0] ?? null, $: l.price };
  save();
}

function record(l, key, strip, reason, sealed, stripPhoto) {
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
    sealed,
    at: new Date().toISOString(),
  };
  S.seen[key] = strip ?? (sealed === "no" ? "x" : "0");
  if (sealed !== "no") keepItem(l, key);
  remember(item);
  log(`${key} ${strip ?? reason} · ${l.title}`);
  save();
  if (strip && !STANDARD.has(strip)) confirmRare(item, stripPhoto, l.listingUrl);
}

async function confirmRare(item, stripPhoto, url) {
  // Rare: read it again from that photo alone; both must agree.
  let again = null;
  try {
    again = readStrip(await vision([stripPhoto]));
  } catch {}
  const confirmed = again === item.strip;
  S.finds.unshift({
    ...item,
    confirmed,
    note: confirmed ? "Dos lecturas coinciden" : `Segunda lectura: ${again ?? "no se ve la tira"}`,
  });
  log(`*** HALLAZGO ${item.strip} (${confirmed ? "confirmado" : "por confirmar"}) ${url}`);
  push(true);
  save();
}

// ── Sweeps ──
// Every copy of the game: page on until the results run out, or until a whole
// page (sorted by relevance) has no copy of the game left.
const MAX_PAGES = 40;
async function searchSource(source, game) {
  const q = `${game} ps4`;
  let all;
  if (source === "wallapop") all = await wallapop.searchListings(q, "ps4", Infinity, MAX_PAGES);
  else if (source === "ebay") all = await ebay.searchListings(q, "ps4", 200);
  else {
    all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      await waitIfPaused();
      statusText = `Buscando «${game}» en Vinted (página ${page})`;
      const got = await vinted.searchListings(q, "ps4", 96, page);
      all.push(...got);
      if (got.length < 40 || !got.some((l) => isGame(l.title, game))) break;
    }
  }
  return all.filter((l) => isGame(l.title, game));
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
      const where = { vinted: "Vinted", wallapop: "Wallapop", ebay: "eBay" }[source];
      statusText = `«${q}» en ${where}: ${listings.length} anuncios del juego`;
      for (const l of listings) {
        S.gameOf[`${l.source}:${l.vintedId}`] ??= q;
        await handle(l);
      }
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
