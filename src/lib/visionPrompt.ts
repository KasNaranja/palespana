// ─────────────────────────────────────────────────────────────
// What we ask Gemini, and how its answer becomes a verdict.
//
// The model only OBSERVES (what each photo shows, the back cover's language
// with a literal quote, the seal strip, the shrink-wrap); the rules below
// DECIDE. Asking the small free-tier model for the verdict directly made it
// jump to conclusions: on a real listing with an Italian back cover, an open
// case and a disc photo it answered "Spanish edition, sealed", inventing
// "legal text in Spanish" and "cellophane folds". Observations are harder to
// fake, and the rules can't be talked out of "a disc photo means not sealed".
// ─────────────────────────────────────────────────────────────

import type {
  DetectedPlatform,
  LanguageVerdict,
  SealedVerdict,
  VisionResult,
} from "./types";

export const PLATFORMS = [
  "ps1",
  "ps2",
  "ps3",
  "ps4",
  "ps5",
  "switch",
  "xbox",
  "pc",
  "other",
  "unknown",
] as const;

const PHOTO_CONTENTS = [
  "front_cover",
  "back_cover",
  "disc_or_cartridge",
  "case_interior",
  "manual_or_inserts",
  "spine_or_side",
  "other",
] as const;

const LANGS = ["es", "it", "fr", "de", "en", "pt", "nl", "other"] as const;
type Lang = (typeof LANGS)[number];

export const SYSTEM_PROMPT = `Eres un experto en videojuegos físicos del mercado europeo (PAL). Recibes TODAS las fotos de un anuncio de segunda mano, numeradas ("Foto 1", "Foto 2"…). Tu trabajo es OBSERVAR y describir con exactitud lo que se ve, SIN sacar conclusiones ni adivinar. Si algo no se ve, dilo ("not_visible"/"unclear"): inventar un dato es el peor error posible.

1) "photos": para CADA foto, qué muestra principalmente:
- "front_cover" = portada de la caja (con o sin plástico).
- "back_cover" = contraportada (sinopsis, capturas, iconos, textos legales).
- "disc_or_cartridge" = el disco o el cartucho, dentro o fuera de la caja.
- "case_interior" = la caja ABIERTA por dentro (aunque el disco no se vea).
- "manual_or_inserts" = manual, folletos, códigos o papeles sueltos del juego.
- "spine_or_side" = lomo o canto de la caja.
- "other" = cualquier otra cosa (consola, logo de la tienda, dibujo, avatar, varios juegos…).

2) Idioma de la CONTRAPORTADA:
- "backCoverLanguage": idioma en que está redactada la SINOPSIS (el texto grande de marketing) de la contraportada: "es" castellano, "it" italiano, "fr" francés, "de" alemán, "en" inglés, "pt" portugués, "nl" neerlandés, "other" otro, "not_visible" si ninguna foto muestra la contraportada legible.
  LEE las palabras; no te fíes del aspecto. Italiano: "gli", "della", "il", "di", "gioco", "oltre", "sfida". Francés: "le", "les", "des", "vous", "avec", "jeu", "votre". Español: "el", "los", "las", "y", "del", "juego", "tu". Portugués: "o", "os", "do", "da", "jogo", "não". Inglés: "the", "and", "your", "game".
- "backCoverQuote": copia LITERALMENTE de 3 a 8 palabras seguidas de esa sinopsis, tal y como están escritas (mismo idioma, sin traducir). Si no se ve, cadena vacía.
- "languageListHasSpanish": en la lista técnica de idiomas de la caja (filas tipo "EN / FR / IT / DE / ES", o secciones "LANGUAGES"/"VOCI"/"VOIX"/"IDIOMAS"/"AUDIO"/"TEXTO"/"SUBTÍTULOS"), ¿aparece "ES"/"Español"/"Spanish"? "yes", "no" (se ve la lista y no está) o "not_visible" (no hay lista o la letra es demasiado pequeña para leerla: en ese caso NUNCA respondas "yes").
- "languageListQuote": copia LITERALMENTE lo que pone esa lista de idiomas tal y como está impresa (p. ej. "EN FR IT DE ES" o "Audio: English / Texto: Español"). Cadena vacía si no la ves o no la puedes leer.
- "frontLanguage": idioma de las señales de la PORTADA, si las hay: la franja de mejora a PS5 ("Actualización disponible para PS5" = es, "Aggiornamento disponibile per PS5" = it, "Mise à niveau disponible sur PS5" = fr, "Upgrade available" = en), los descriptores del PEGI ("Violencia" es / "Violenza" it / "Violence" fr-en), pegatinas de tienda o de precio. "none" si la portada no tiene ninguna señal de idioma legible.

3) "platform": consola de la caja por su diseño: "ps4" (funda AZUL, banda "PS4"), "ps5" (funda BLANCA, banda "PS5"), "ps3", "ps2", "ps1", "switch" (funda ROJA), "xbox", "pc", "other", "unknown" si dudas.

4) Precinto de fábrica (solo lo que se VE):
- "sealStrip": en PS4/PS5 PAL, el precinto nuevo lleva una TIRA ESTRECHA de apertura que forma parte del PLÁSTICO transparente del envoltorio, en el borde INFERIOR de la portada, con la palabra "PlayStation" (o "PS4"/"PS5") repetida muchas veces en letra pequeña a lo largo de toda la tira; en Switch es una tira roja con "Nintendo Switch". OJO: TODAS las carátulas de PS4/PS5 llevan IMPRESA arriba la banda del logotipo "PS4 / PlayStation 4": eso es diseño de la carátula, NO es la tira de precinto. "visible" solo si ves claramente esa tira del plástico; "not_visible" si ves bien el borde inferior de la portada y no está; "unclear" en otro caso.
- "shrinkWrap": plástico que envuelve la caja. "factory" = película retráctil de fábrica, AJUSTADA a la caja como una segunda piel, con pliegues o arrugas, solapas dobladas en esquinas o lomo, o su costura/soldadura. "loose_sleeve" = funda o bolsa protectora SUELTA, más grande que la caja (holgada, con solapa o abertura, típica de tiendas de segunda mano). "not_visible" si la caja se ve claramente sin plástico. "unclear" en otro caso. Un brillo o reflejo de la carátula NO es plástico.
- "usedLabel": true si alguna etiqueta o pegatina (de tienda, de precio o del vendedor) indica que es de SEGUNDA MANO o gradúa su estado: "Estado: Muy bueno/Bueno/Aceptable", "Usado", "Seminuevo", "Segunda mano", "Usato", "Occasion", "Pre-owned", "Pre-played". false en otro caso.

5) "notes": UNA frase en español con lo más relevante que has visto (qué fotos hay, idioma, precinto).`;

export const USER_PROMPT = `Describe estas fotos siguiendo exactamente el formato pedido.`;

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    photos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          content: { type: "string", enum: [...PHOTO_CONTENTS] },
        },
        required: ["index", "content"],
      },
    },
    backCoverLanguage: { type: "string", enum: [...LANGS, "not_visible"] },
    backCoverQuote: { type: "string" },
    languageListHasSpanish: {
      type: "string",
      enum: ["yes", "no", "not_visible"],
    },
    languageListQuote: { type: "string" },
    frontLanguage: { type: "string", enum: [...LANGS, "none"] },
    platform: { type: "string", enum: [...PLATFORMS] },
    sealStrip: { type: "string", enum: ["visible", "not_visible", "unclear"] },
    shrinkWrap: {
      type: "string",
      enum: ["factory", "loose_sleeve", "not_visible", "unclear"],
    },
    usedLabel: { type: "boolean" },
    notes: { type: "string" },
  },
  required: [
    "photos",
    "backCoverLanguage",
    "backCoverQuote",
    "languageListHasSpanish",
    "languageListQuote",
    "frontLanguage",
    "platform",
    "sealStrip",
    "shrinkWrap",
    "usedLabel",
    "notes",
  ],
};

export interface Observations {
  photos: { index: number; content: string }[];
  backCoverLanguage: string;
  backCoverQuote: string;
  languageListHasSpanish: string;
  languageListQuote: string;
  frontLanguage: string;
  platform: string;
  sealStrip: string;
  shrinkWrap: string;
  usedLabel: boolean;
  notes: string;
}

// Words that only (or overwhelmingly) appear in one of these languages, used
// to double-check the model's claimed back-cover language against the quote
// it copied. Shared words ("la", "de", "con", "una"…) are left out on purpose.
const MARKERS: Partial<Record<Lang, RegExp>> = {
  es: /\b(el|los|las|y|del|juego|tus?|nuevos?|desde|hasta|mundo|contra|donde|cada)\b|ñ|ción\b/gi,
  it: /\b(il|gli|della|delle|degli|nel|nella|di|e|gioco|tua|tuo|oltre|che|sono|alla|questa|nuovi)\b|zione\b/gi,
  fr: /\b(le|les|des|du|et|avec|pour|vous|jeu|votre|dans|est|aux|cette|nouveaux)\b|ç/gi,
  en: /\b(the|and|of|your|with|game|for|is|this|new|from)\b/gi,
  de: /\b(der|die|das|und|mit|für|spiel|ist|dein|eine|neue)\b|ß/gi,
  pt: /\b(o|os|do|dos|das|jogo|não|seu|sua|novos|em)\b|ção\b|ã/gi,
};

/** Language the quote reads as, or null when it's too short/ambiguous. */
export function quoteLanguage(quote: string): Lang | null {
  const scores = Object.entries(MARKERS).map(([lang, re]) => ({
    lang: lang as Lang,
    n: (quote.match(re!) ?? []).length,
  }));
  scores.sort((a, b) => b.n - a.n);
  const [best, second] = scores;
  if (!best || best.n < 2 || best.n === second?.n) return null;
  return best.lang;
}

const FOREIGN = new Set<string>(["it", "fr", "de", "en", "pt", "nl", "other"]);
const LANG_NAMES: Record<string, string> = {
  es: "castellano",
  it: "italiano",
  fr: "francés",
  de: "alemán",
  en: "inglés",
  pt: "portugués",
  nl: "neerlandés",
  other: "otro idioma",
};

/** Apply the rules to the model's observations. */
export function decide(obs: Observations): VisionResult {
  const photoNo = (kinds: string[]) =>
    obs.photos
      .filter((p) => kinds.includes(p.content))
      .map((p) => p.index)
      .sort((a, b) => a - b);

  // ── Seal ──
  // The user's rule: if any photo shows the disc, the open case or the
  // manual, the copy CANNOT be sealed — whatever else the photos suggest.
  const opened = photoNo(["disc_or_cartridge", "case_interior", "manual_or_inserts"]);
  const platform = (PLATFORMS as readonly string[]).includes(obs.platform)
    ? (obs.platform as DetectedPlatform)
    : "unknown";
  let sealed: SealedVerdict = "unknown";
  let sealWhy = "";
  // Measured on 47 labeled real listings: the models rarely manage to see
  // the bottom tear strip even on sealed copies (reported on 3 of 18), but
  // they reliably see a factory shrink-wrap (18/18 on gemini-3.1-flash-lite).
  // So the wrap counts on its own — as long as nothing says "opened" or
  // "used": a disc/interior/manual photo, a loose shop sleeve instead of the
  // tight factory film, or a shop label grading the condition (the one false
  // positive was a used copy in a loose sleeve tagged "Estado: Muy Bueno").
  if (opened.length > 0) {
    sealed = "no";
    sealWhy = `abierto (se ve el disco, el interior o el manual en la foto ${opened.join(", ")})`;
  } else if (obs.usedLabel) {
    sealed = "no";
    sealWhy = "etiqueta de segunda mano o de estado de uso";
  } else if (obs.sealStrip === "visible" || obs.shrinkWrap === "factory") {
    sealed = "yes";
    sealWhy =
      obs.sealStrip === "visible"
        ? "precintado (tira de apertura del plástico visible)"
        : "precintado (plástico de fábrica ajustado a la caja)";
  } else if (obs.shrinkWrap === "not_visible" || obs.shrinkWrap === "loose_sleeve") {
    sealed = "no";
    sealWhy =
      obs.shrinkWrap === "loose_sleeve"
        ? "funda protectora suelta, no precinto de fábrica"
        : "sin plástico de fábrica";
  }

  // ── Language ──
  let back = obs.backCoverLanguage;
  const quote = (obs.backCoverQuote || "").trim();
  let contradicted = false;
  if (back !== "not_visible" && quote) {
    const read = quoteLanguage(quote);
    // The quote contradicts the claimed language: that's the invented-text
    // failure mode. Trust neither — the verdict falls back to the front.
    if (read && read !== back && !(FOREIGN.has(read) && FOREIGN.has(back))) {
      back = "not_visible";
      contradicted = true;
    }
  }
  // "Spanish is in the language list" must be backed by the list as copied:
  // on a real Italian box with unreadable fine print the model claimed ES was
  // listed. No Spanish in the quote → treat the list as unread.
  const listQuote = (obs.languageListQuote || "").trim();
  const listHasEs =
    obs.languageListHasSpanish === "yes" &&
    /(^|[^a-záéíóúñ])(es|esp|español|espanol|spanish|castellano|espagnol|spagnolo|spanisch)(?![a-záéíóúñ])/i.test(listQuote);
  let verdict: LanguageVerdict;
  let langWhy: string;
  const quoted = quote ? ` («${quote.slice(0, 60)}»)` : "";
  if (contradicted && obs.frontLanguage !== "es" && !FOREIGN.has(obs.frontLanguage)) {
    verdict = "inconclusive";
    langWhy = `el texto leído en la contraportada${quoted} no cuadra con el idioma detectado; sin conclusión fiable`;
  } else if (back === "es") {
    verdict = "es";
    langWhy = `contraportada en castellano${quoted}`;
  } else if (FOREIGN.has(back)) {
    const lang = LANG_NAMES[back] ?? "otro idioma";
    if (listHasEs) {
      verdict = "es_multi";
      langWhy = `contraportada en ${lang}${quoted}, con español en la lista de idiomas («${listQuote.slice(0, 50)}»)`;
    } else {
      verdict = "other";
      langWhy =
        obs.languageListHasSpanish === "no"
          ? `contraportada en ${lang}${quoted}, sin ES en la lista de idiomas`
          : `contraportada en ${lang}${quoted}`;
    }
  } else if (obs.frontLanguage === "es") {
    verdict = "es";
    langWhy = "sin contraportada legible; las señales de la portada están en castellano";
  } else if (FOREIGN.has(obs.frontLanguage)) {
    verdict = "other";
    langWhy = `sin contraportada legible; las señales de la portada están en ${LANG_NAMES[obs.frontLanguage] ?? "otro idioma"}`;
  } else {
    verdict = "inconclusive";
    langWhy = "no se ve la contraportada ni ninguna señal de idioma en la portada";
  }

  const evidence =
    `${langWhy[0].toUpperCase()}${langWhy.slice(1)}` +
    (sealWhy ? `; ${sealWhy}.` : ".");
  return { verdict, evidence, platform, sealed };
}

/** Parse the model's JSON reply into observations (null if unusable). */
export function parseObservations(text: string): Observations | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let o: any;
  try {
    o = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v ? v : fallback;
  return {
    photos: Array.isArray(o.photos)
      ? o.photos
          .filter((p: any) => p && typeof p.content === "string")
          .map((p: any) => ({ index: Number(p.index) || 0, content: p.content }))
      : [],
    backCoverLanguage: str(o.backCoverLanguage, "not_visible"),
    backCoverQuote: str(o.backCoverQuote, ""),
    languageListHasSpanish: str(o.languageListHasSpanish, "not_visible"),
    languageListQuote: str(o.languageListQuote, ""),
    frontLanguage: str(o.frontLanguage, "none"),
    platform: str(o.platform, "unknown"),
    sealStrip: str(o.sealStrip, "unclear"),
    shrinkWrap: str(o.shrinkWrap, "unclear"),
    usedLabel: o.usedLabel === true,
    notes: str(o.notes, ""),
  };
}
