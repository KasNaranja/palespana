// Watches Amazon product pages and pushes a phone notification (ntfy) the
// moment any offer drops to the target price. Runs on the user's PC:
//
//   node amazon-watch.mjs
//
// amazon-watch.json (next to this file, never committed — the topic is the
// only thing keeping the alerts private):
//   {"topic": "<ntfy topic>", "products": [{"asin": "B0F2TN43GH", "max": 550}]}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, "amazon-watch.json"), "utf8"));
const EVERY_MS = 60_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(new Date().toISOString(), m);

async function notify(title, message, url, priority = "urgent") {
  await fetch(`https://ntfy.sh/${CFG.topic}`, {
    method: "POST",
    body: message,
    headers: {
      Title: encodeURIComponent(title),
      Priority: priority,
      Tags: "rotating_light",
      Click: url,
      "X-Title-Encoding": "uri",
    },
  }).catch((e) => log(`ntfy falló: ${e.message}`));
}

/** Offers listed in Amazon's "all buying options" panel: [{price, seller}].
 *  null when Amazon answered with a captcha or an error. */
async function offers(asin) {
  const r = await fetch(`https://www.amazon.es/gp/product/ajax/aodAjaxMain/?asin=${asin}&pc=dp`, {
    headers: { "User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9" },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await r.text();
  if (!r.ok || /captcha/i.test(html)) return null;
  // Each offer block holds its price and, after it, its seller.
  const blocks = html.split(/id="aod-(?:pinned-)?offer"/).slice(1);
  const out = [];
  for (const b of blocks) {
    const whole = b.match(/a-price-whole">([\d.]+)/);
    if (!whole) continue;
    const frac = b.match(/a-price-fraction">(\d+)/);
    const price = Number(whole[1].replace(/\./g, "")) + (frac ? Number(frac[1]) / 100 : 0);
    const seller =
      b.match(/aria-label="([^"]+?)\. Abre una nueva página/)?.[1] ??
      (/Amazon\.es/.test(b) ? "Amazon.es" : "?");
    out.push({ price, seller });
  }
  return out;
}

// Offers already announced (asin|seller|price) — re-announced only after
// they disappear and come back.
let announced = new Set();

async function check() {
  const now = new Set();
  for (const p of CFG.products) {
    let list;
    try {
      list = await offers(p.asin);
    } catch (e) {
      log(`${p.asin}: ${e.message}`);
      continue;
    }
    if (!list) {
      log(`${p.asin}: Amazon pide captcha, espero 10 min`);
      await sleep(10 * 60_000);
      continue;
    }
    const url = `https://www.amazon.es/dp/${p.asin}`;
    for (const o of list.filter((o) => o.price <= p.max)) {
      const key = `${p.asin}|${o.seller}|${o.price}`;
      now.add(key);
      if (announced.has(key)) continue;
      log(`*** ${p.asin} a ${o.price} € (${o.seller})`);
      await notify(`¡${o.price.toFixed(2)} € en Amazon!`, `${p.name ?? p.asin} — vendido por ${o.seller}. Toca para abrir.`, url);
    }
    const best = list.length ? Math.min(...list.map((o) => o.price)) : null;
    log(`${p.asin}: ${list.length} ofertas, mejor ${best ?? "—"} €`);
  }
  announced = now;
}

log(`vigilando ${CFG.products.map((p) => `${p.asin} ≤ ${p.max} €`).join(", ")}`);
if (process.argv.includes("--test")) {
  await notify("Prueba de CazaPAL", "Si ves esto, los avisos de Amazon funcionan.", `https://www.amazon.es/dp/${CFG.products[0].asin}`, "default");
  process.exit(0);
}
for (;;) {
  await check().catch((e) => log(`error: ${e.message}`));
  await sleep(EVERY_MS + Math.random() * 15_000);
}
