// ─────────────────────────────────────────────────────────────
// Vision analysis via Google Gemini (free tier, multimodal).
//
// Given a listing's photos, the model reports what it SEES (see
// visionPrompt.ts) and the rules there turn that into the language / platform
// / seal verdict. Uses the Gemini REST endpoint (no SDK dependency) and forces
// a STRICT JSON reply via responseSchema.
//
// The key stays server-side. Node runtime only.
// ─────────────────────────────────────────────────────────────

import { config, COST_GUARD } from "./config";
import type { VisionResult } from "./types";
import {
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  USER_PROMPT,
  decide,
  parseObservations,
} from "./visionPrompt";

const MAX_BYTES = 5 * 1024 * 1024; // keep well under Gemini limits
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

interface ImagePart {
  mimeType: string;
  data: string; // base64
}

async function downloadImage(url: string): Promise<ImagePart | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    let mt = (res.headers.get("content-type") || "").split(";")[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    if (!ALLOWED.has(mt)) {
      if (buf[0] === 0xff && buf[1] === 0xd8) mt = "image/jpeg";
      else if (buf[0] === 0x89 && buf[1] === 0x50) mt = "image/png";
      else return null;
    }
    return { mimeType: mt, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

// ── Multi-key free-tier limiter ────────────────────────────────
// Each Gemini key (from a separate Google project) has its OWN free daily quota
// and its own per-minute limit. We keep a throttle chain PER key and round-robin
// across them, so N keys give ~N× the throughput AND N× the daily budget. A key
// that returns a daily "quota exhausted" 429 is parked for a while so we stop
// hammering it and lean on the others.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface KeyState {
  key: string;
  lastCallAt: number;
  chain: Promise<void>;
  // Per MODEL: Gemini quotas (per-minute and per-day) are per project AND per
  // model, so a key exhausted on one model is still good on another.
  parkedUntil: Record<string, number>; // model → skip this key until then
}
const keyStates: KeyState[] = config.geminiKeys.map((key) => ({
  key,
  lastCallAt: 0,
  chain: Promise.resolve(),
  parkedUntil: {},
}));
let rrIndex = 0;

// Per-key outcome tallies (by position in GEMINI_API_KEYS — never the key):
// tells a key whose project is broken or throttled apart from a Google-wide
// capacity problem, which hits every key alike.
const keyCounters = keyStates.map(() => ({
  ok: 0,
  r429min: 0,
  r429day: 0,
  r429cap: 0,
  r503: 0,
  timeout: 0,
}));

const CALL_TIMEOUT_MS = 30_000;

/** Space this key's calls by geminiMinIntervalMs (each key independently). */
function throttleKey(ks: KeyState): Promise<void> {
  ks.chain = ks.chain.then(async () => {
    const wait = config.geminiMinIntervalMs - (Date.now() - ks.lastCallAt);
    if (wait > 0) {
      stats.totalWaitMs += wait;
      await sleep(wait);
    }
    ks.lastCallAt = Date.now();
  });
  return ks.chain;
}

// ── Instrumentación (diagnóstico de rendimiento) ───────────────
// Contadores en memoria para ver DÓNDE se va el tiempo: si esperamos por el
// throttle, si Gemini nos limita (429 por minuto / por día) o si las llamadas
// simplemente tardan. Se reinician al redesplegar. No exponen ninguna clave.
const stats = {
  calls: 0, // intentos de llamada
  ok: 0, // respuestas correctas
  r429min: 0, // 429 por minuto (transitorio)
  r429day: 0, // 429 por cuota diaria
  r503: 0, // modelo saturado
  r429cap: 0, // 429 sin cuota: capacidad gratuita agotada (no nuestro cupo)
  timeouts: 0, // llamadas abortadas por CALL_TIMEOUT_MS
  totalCallMs: 0, // suma de duración de llamadas OK
  totalWaitMs: 0, // suma de espera por throttle
  // Último error NO-429/503 visto (para diagnosticar en /api/health sin logs).
  // El detalle nunca contiene la clave (viaja en cabecera, no en la URL/cuerpo).
  lastErrStatus: 0,
  lastErrDetail: "",
  // Which Gemini quota a 429 hit (the metric name from the error, no key in
  // it), and per-phase timings to see where an analysis spends its time.
  last429Metrics: "",
  phases: {
    detail: { n: 0, ms: 0, fail: 0 }, // Vinted item page (gallery)
    download: { n: 0, ms: 0, fail: 0 }, // photos for one listing
    gemini: { n: 0, ms: 0, fail: 0 }, // model call(s) for one listing
  },
};

type Phase = keyof typeof stats.phases;
/** Record one phase run (ms elapsed since `startedAt`, and whether it failed). */
export function notePhase(phase: Phase, startedAt: number, failed: boolean): void {
  const p = stats.phases[phase];
  p.n++;
  p.ms += Date.now() - startedAt;
  if (failed) p.fail++;
}

// ── Model chain ────────────────────────────────────────────────
// A 503 means the MODEL is overloaded for everyone; every key hits the same
// wall. So on a 503 the model is benched for a short while and the next model
// in the chain takes over. Benching is shared by all concurrent analyses, so
// one 503 spares the rest of the search from walking into the same wall.
const MODEL_BENCH_MS = 45_000;
const modelChain: string[] = Array.from(
  new Set([config.geminiModel, ...config.geminiFallbackModels])
);
const benchedUntil = new Map<string, number>();
const modelStats: Record<string, { ok: number; r503: number; r429cap: number }> = {};
for (const m of modelChain) modelStats[m] = { ok: 0, r503: 0, r429cap: 0 };

/** Models to try now, in priority order: non-benched first; if every model is
 *  benched, the whole chain anyway (better a retry than an instant give-up). */
function modelsToTry(): string[] {
  const now = Date.now();
  const fresh = modelChain.filter((m) => (benchedUntil.get(m) ?? 0) <= now);
  return fresh.length > 0 ? fresh : modelChain;
}

export function getVisionStats() {
  const now = Date.now();
  return {
    ...stats,
    avgCallMs: stats.ok ? Math.round(stats.totalCallMs / stats.ok) : 0,
    avgWaitMs: stats.calls ? Math.round(stats.totalWaitMs / stats.calls) : 0,
    minIntervalMs: config.geminiMinIntervalMs,
    models: modelChain.map((m) => ({
      model: m,
      ...modelStats[m],
      benched: (benchedUntil.get(m) ?? 0) > now,
    })),
  };
}

/** Diagnóstico: cuántas claves hay y cuántas están aparcadas ahora mismo por
 *  haber agotado su cuota diaria. NO expone ninguna clave. */
export function getKeyStats(): {
  total: number;
  parked: number;
  active: number;
  perKey: (typeof keyCounters)[number][];
} {
  const now = Date.now();
  const parked = keyStates.filter(
    (k) => (k.parkedUntil[config.geminiModel] ?? 0) > now
  ).length;
  return {
    total: keyStates.length,
    parked,
    active: keyStates.length - parked,
    perKey: keyCounters,
  };
}

/** Next non-parked, not-yet-tried key (round-robin). Null if none available. */
function pickKey(tried: Set<string>, model: string): KeyState | null {
  const now = Date.now();
  for (let i = 0; i < keyStates.length; i++) {
    const ks = keyStates[(rrIndex + i) % keyStates.length];
    if (tried.has(ks.key) || (ks.parkedUntil[model] ?? 0) > now) continue;
    rrIndex = (rrIndex + i + 1) % keyStates.length;
    return ks;
  }
  return null;
}

/**
 * Analyze up to 2 photo URLs and return a verdict. Throws on a hard API error
 * so the caller can degrade to "inconclusive".
 */
export async function analyzeImages(imageUrls: string[]): Promise<VisionResult> {
  if (keyStates.length === 0) {
    throw new Error("Falta GEMINI_API_KEY para el análisis de visión.");
  }

  const dlStart = Date.now();
  const parts = (
    await Promise.all(
      imageUrls.slice(0, COST_GUARD.MAX_IMAGES_PER_LISTING).map(downloadImage)
    )
  ).filter((p): p is ImagePart => p !== null);

  notePhase("download", dlStart, parts.length === 0);
  if (parts.length === 0) {
    // Image download failed — transient. Throw so the caller degrades to a
    // NON-persisted inconclusive (retried next search) rather than caching it.
    throw new Error("image_download_failed");
  }

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        // Numbered so the model can say WHICH photo shows the disc, etc.
        parts: [
          ...parts.flatMap((p, i) => [
            { text: `Foto ${i + 1}:` },
            { inline_data: { mime_type: p.mimeType, data: p.data } },
          ]),
          { text: USER_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 900,
      temperature: 0,
    },
  };
  // Serialized once: with a whole gallery inline it's a few MB, and every
  // retry / fallback model used to build its own copy.
  const bodyJson = JSON.stringify(body);

  // In production the calls go through the pal-relay (US) because Google's
  // free tier geo-blocks Render Frankfurt; locally (no GEMINI_PROXY_URL) the
  // direct Google endpoint is used.
  const base =
    config.geminiProxyUrl.replace(/\/+$/, "") ||
    "https://generativelanguage.googleapis.com";
  const urlFor = (model: string) =>
    `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  // Walk the model chain (see modelsToTry). Within a model, try across the
  // keys: each attempt uses a DIFFERENT key (round-robin). A per-DAY quota 429
  // parks that key (~30 min) so we lean on the others; a per-minute 429 moves
  // to the next key. A 503 benches the MODEL and jumps to the next one right
  // away — retrying other keys against an overloaded model only burns time.
  let res: Response | null = null;
  const gemStart = Date.now();
  for (const model of modelsToTry()) {
    const url = urlFor(model);
    const tried = new Set<string>();
    const maxTries = keyStates.length + 1;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      let ks = pickKey(tried, model);
      if (!ks) {
        if (tried.size === 0) break; // no usable keys at all
        tried.clear(); // second pass over the non-parked keys
        await sleep(1500);
        ks = pickKey(tried, model);
        if (!ks) break;
      }
      tried.add(ks.key);
      await throttleKey(ks);
      const startedAt = Date.now();
      stats.calls++;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-goog-api-key": ks.key,
      };
      // When going through the relay, authenticate against it.
      if (config.geminiProxyUrl) headers["x-relay-token"] = config.relayToken;
      const kc = keyCounters[keyStates.indexOf(ks)];
      let r: Response;
      try {
        // Measured: a free-tier call hung for over 5 minutes (and 23-55 s
        // stalls are common on a busy day). Past this, the next model in the
        // chain is a better bet than waiting.
        r = await fetch(url, {
          method: "POST",
          headers,
          body: bodyJson,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      } catch {
        stats.timeouts++;
        kc.timeout++;
        break; // → next model in the chain
      }
      if (r.ok) {
        stats.ok++;
        modelStats[model].ok++;
        kc.ok++;
        stats.totalCallMs += Date.now() - startedAt;
      }
      if (r.status === 429) {
        const detail = await r.text().catch(() => "");
        const quotaIds = Array.from(
          new Set(Array.from(detail.matchAll(/"quotaId"\s*:\s*"([^"]+)"/g), (m) => m[1]))
        );
        const message = detail.match(/"message"\s*:\s*"([^"]{0,160})/)?.[1] ?? "";
        stats.last429Metrics = quotaIds.length
          ? quotaIds.join(",")
          : `(sin cuota) ${message}`;
        if (quotaIds.length === 0) {
          // No quota named: not OUR per-minute or daily quota but free-tier
          // capacity running out ("Resource has been exhausted", measured at
          // ~23% of calls on a busy day). Rotating keys on the same model hits
          // the same wall, so this request moves to the next model; the key
          // only rests briefly on this model.
          stats.r429cap++;
          kc.r429cap++;
          modelStats[model].r429cap++;
          ks.parkedUntil[model] = Date.now() + 10 * 1000;
          break;
        }
        // Gemini responde RESOURCE_EXHAUSTED tanto para el límite POR MINUTO como
        // para el DIARIO, así que NO se puede usar ese código para decidir. Solo
        // la cuota DIARIA (métrica "...PerDay...") justifica aparcar la clave 30
        // min; un 429 por minuto es transitorio y basta con rotar a otra clave
        // (si se aparcaba, con varias claves en paralelo se aparcaban casi todas
        // y el rendimiento caía al de 1 sola clave).
        if (/per\s*day/i.test(detail)) {
          stats.r429day++;
          kc.r429day++;
          ks.parkedUntil[model] = Date.now() + 30 * 60 * 1000; // cuota diaria agotada
        } else {
          stats.r429min++;
          kc.r429min++;
          // Límite POR MINUTO (ojo: es por PROYECTO, así que varias claves del
          // mismo proyecto se pisan). Pausa corta para que la ventana se recupere:
          // sin ella el motor reintenta en bucle contra claves limitadas y el
          // rendimiento se desploma; con 30 min se aparcaban casi todas.
          ks.parkedUntil[model] = Date.now() + 20 * 1000;
        }
        continue; // move to another key
      }
      if (r.status === 503) {
        stats.r503++;
        kc.r503++;
        modelStats[model].r503++;
        benchedUntil.set(model, Date.now() + MODEL_BENCH_MS);
        break; // overloaded model → next model in the chain
      }
      res = r;
      break;
    }
    if (res) break;
    // No answer from this model (overloaded, or every key rate-limited /
    // out of daily quota FOR THIS MODEL): the next model has its own quotas.
  }

  notePhase("gemini", gemStart, !res || !res.ok);
  if (!res) {
    throw new Error("gemini_all_keys_exhausted");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    stats.lastErrStatus = res.status;
    stats.lastErrDetail = detail.slice(0, 220);
    throw new Error(`gemini_http_${res.status}: ${detail.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text || "")
      .join("") || "";

  const observations = parseObservations(text);
  if (!observations) {
    return {
      verdict: "inconclusive",
      evidence: "El análisis no devolvió un resultado claro sobre el idioma.",
      platform: "unknown",
      sealed: "unknown",
    };
  }
  return decide(observations);
}
