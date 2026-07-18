// ─────────────────────────────────────────────────────────────
// Vision analysis via Google Gemini (free tier, multimodal).
//
// Given up to 2 photos of a physical game copy, decide whether the copy is in
// Spanish. Uses the Gemini REST endpoint (no SDK dependency, easier to package
// inside Electron) and forces a STRICT JSON reply via responseSchema.
//
// The key stays server-side. Node runtime only.
// ─────────────────────────────────────────────────────────────

import { config, COST_GUARD } from "./config";
import type { VisionResult } from "./types";

const SYSTEM_PROMPT = `Eres un experto en videojuegos físicos del mercado europeo (PAL) e identificas, a partir de las fotos de la carátula y la contraportada, si una copia está en español y de qué forma.

Debes clasificar la copia en UNA de estas cuatro categorías:

1) "es" = EDICIÓN ESPAÑOLA. La propia carátula/contraportada está en español: la descripción o sinopsis del reverso está redactada en castellano, o lleva sello "PAL España"/"PAL ESP"/"Totalmente en castellano", o distribuidora española (Sony España, Nintendo Ibérica, Proein, Erbe, FX Interactive). Es una copia pensada para el mercado español.

2) "es_multi" = OTRO IDIOMA EN LA CAJA, PERO INCLUYE ESPAÑOL. El texto de marketing/sinopsis de la contraportada está en OTRO idioma (francés, italiano, alemán, inglés…), PERO en la lista técnica de idiomas del juego (secciones "VOIX"/"VOCI"/"LANGUAGES"/"IDIOMAS"/"VOZ"/"TEXTO"/"AUDIO"/"SUBTÍTULOS") aparece "ES" o "Español". Es un disco multi-idioma que SE PUEDE JUGAR en español aunque la caja no sea la edición española. Típico en juegos modernos de PS4/PS5/Switch/Xbox.

3) "other" = SIN ESPAÑOL. La contraportada está en otro idioma y NO aparece "ES"/"Español" por ninguna parte (ni en el texto ni en la lista de idiomas).

4) "inconclusive" = no se puede determinar: fotos borrosas/cortadas, o no hay NINGÚN texto legible que revele el idioma (ni en la portada ni en la contraportada).

SEÑALES DE LA PORTADA (FRONTAL) — MUY IMPORTANTE, úsalas aunque no haya contraportada:
La carátula frontal de los juegos modernos SÍ revela el idioma de la edición. Míralas siempre:
- La FRANJA/BANDA AZUL de PlayStation (arriba a la izquierda, junto al PEGI) con el aviso de mejora a PS5: su idioma indica la edición.
  · "Actualización disponible para PS5" / "Se requiere..." → ESPAÑOL (señal de "es").
  · "Aggiornamento disponibile per PS5" → ITALIANO (→ "other", salvo que veas ES en la lista de idiomas del reverso).
  · "Mise à niveau disponible sur PS5" → FRANCÉS (→ "other", salvo ES en la lista).
  · "Upgrade available for PS5" / "Free upgrade" → INGLÉS.
- El texto del PEGI y los descriptores ("Violencia"/"Violence"/"Violenza"; "Lenguaje soez"/"Bad Language"/"Linguaggio scurrile").
- Pegatinas de tienda/precio: una etiqueta española (p. ej. "PVP", "€", tienda española) apoya "es"; "DEST. VENDITA" u otras en italiano apuntan a edición italiana.
Si SOLO tienes la portada pero esa franja/PEGI/pegatina se lee claramente en un idioma, clasifícala por ese idioma (no la dejes en "inconclusive"). Solo usa "inconclusive" si de verdad no se lee nada.

REGLAS CLAVE:
- Distingue idiomas de verdad LEYENDO las palabras. El francés se parece al español pero NO es español: "JEU", "LANGUE", "Bienvenue", "monde", "vous", "avec", "ATTENTION", "disponible", "ans", acentos à/è/ç → francés. Italiano: "GIOCO", "lingua", "Benvenuto", "gli". Alemán: "SPIEL", "Sprache", "und", "für", "ß".
- La diferencia entre "es" y "es_multi" es DÓNDE está el español: si el TEXTO de la contraportada está en castellano → "es". Si el texto está en otro idioma pero la LISTA de idiomas incluye ES → "es_multi".
- Busca activamente la fila de idiomas: suele ser una línea tipo "EN / FR / IT / DE / ES / PT" cerca de los iconos de jugadores/tamaño. Si ves "ES" ahí y el resto de la caja es de otro idioma → "es_multi".
- Ante duda entre "es" y "es_multi", elige "es_multi". Ante duda de si hay español o no, y no lo ves claro → "other" o "inconclusive"; no inventes.

El campo "evidence" debe ser UNA sola frase en español citando la evidencia concreta vista (qué palabras, en qué idioma, y si viste "ES" en la lista de idiomas).`;

const USER_PROMPT = `Analiza estas fotos de una copia de un videojuego a la venta. ¿Está en español?`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["es", "es_multi", "other", "inconclusive"],
    },
    evidence: { type: "string" },
  },
  required: ["verdict", "evidence"],
};

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
  parkedUntil: number; // while Date.now() < this, skip the key
}
const keyStates: KeyState[] = config.geminiKeys.map((key) => ({
  key,
  lastCallAt: 0,
  chain: Promise.resolve(),
  parkedUntil: 0,
}));
let rrIndex = 0;

/** Space this key's calls by geminiMinIntervalMs (each key independently). */
function throttleKey(ks: KeyState): Promise<void> {
  ks.chain = ks.chain.then(async () => {
    const wait = config.geminiMinIntervalMs - (Date.now() - ks.lastCallAt);
    if (wait > 0) await sleep(wait);
    ks.lastCallAt = Date.now();
  });
  return ks.chain;
}

/** Next non-parked, not-yet-tried key (round-robin). Null if none available. */
function pickKey(tried: Set<string>): KeyState | null {
  const now = Date.now();
  for (let i = 0; i < keyStates.length; i++) {
    const ks = keyStates[(rrIndex + i) % keyStates.length];
    if (tried.has(ks.key) || ks.parkedUntil > now) continue;
    rrIndex = (rrIndex + i + 1) % keyStates.length;
    return ks;
  }
  return null;
}

function parseVerdict(text: string): VisionResult | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const v = obj?.verdict;
  if (v !== "es" && v !== "es_multi" && v !== "other" && v !== "inconclusive")
    return null;
  const evidence =
    typeof obj?.evidence === "string" && obj.evidence.trim()
      ? obj.evidence.trim()
      : v === "es"
        ? "La contraportada muestra textos en español (edición española)."
        : v === "es_multi"
          ? "La caja es de otro idioma, pero la lista de idiomas incluye español (ES)."
          : v === "other"
            ? "La copia está en otro idioma según las fotos."
            : "No hay evidencia suficiente para confirmar el idioma.";
  return { verdict: v, evidence };
}

/**
 * Analyze up to 2 photo URLs and return a verdict. Throws on a hard API error
 * so the caller can degrade to "inconclusive".
 */
export async function analyzeImages(imageUrls: string[]): Promise<VisionResult> {
  if (keyStates.length === 0) {
    throw new Error("Falta GEMINI_API_KEY para el análisis de visión.");
  }

  const parts = (
    await Promise.all(
      imageUrls.slice(0, COST_GUARD.MAX_IMAGES_PER_LISTING).map(downloadImage)
    )
  ).filter((p): p is ImagePart => p !== null);

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
        parts: [
          ...parts.map((p) => ({
            inline_data: { mime_type: p.mimeType, data: p.data },
          })),
          { text: USER_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 300,
      temperature: 0,
    },
  };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.geminiModel)}:generateContent`;

  // Try across the keys: each attempt uses a DIFFERENT key (round-robin). A
  // per-DAY quota 429 parks that key (~30 min) so we lean on the others; a
  // per-minute 429 / 503 just moves to the next key. After every non-parked key
  // is tried, one backoff pass is allowed for transient blips.
  const tried = new Set<string>();
  let res: Response | null = null;
  const maxTries = keyStates.length + 1;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    let ks = pickKey(tried);
    if (!ks) {
      if (tried.size === 0) break; // no usable keys at all
      tried.clear(); // second pass over the non-parked keys
      await sleep(1500);
      ks = pickKey(tried);
      if (!ks) break;
    }
    tried.add(ks.key);
    await throttleKey(ks);
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": ks.key,
      },
      body: JSON.stringify(body),
    });
    if (r.status === 429) {
      const detail = await r.text().catch(() => "");
      if (/per\s*day|resource_exhausted/i.test(detail)) {
        ks.parkedUntil = Date.now() + 30 * 60 * 1000; // daily quota → park
      }
      continue; // move to another key
    }
    if (r.status === 503) continue; // overloaded → another key
    res = r;
    break;
  }

  if (!res) {
    throw new Error("gemini_all_keys_exhausted");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`gemini_http_${res.status}: ${detail.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text || "")
      .join("") || "";

  const parsed = parseVerdict(text);
  if (!parsed) {
    return {
      verdict: "inconclusive",
      evidence: "El análisis no devolvió un resultado claro sobre el idioma.",
    };
  }
  return parsed;
}
