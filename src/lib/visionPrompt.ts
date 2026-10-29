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
  SealStripText,
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
- "sealStrip": en PS4/PS5 PAL, el precinto nuevo lleva una TIRA ESTRECHA de apertura que forma parte del PLÁSTICO transparente del envoltorio. Cruza la portada en HORIZONTAL, de lado a lado, en su parte INFERIOR (a menudo a unos tres cuartos de la altura, a la altura del logo PEGI o justo encima de los logos de abajo), como una fila de letras pequeñas grises o plateadas repetidas muchas veces: el símbolo de PlayStation con "PS4" (o "PS5"), o la palabra "PlayStation". En Switch es una tira roja con "Nintendo Switch". OJO: TODAS las carátulas de PS4/PS5 llevan IMPRESA arriba la banda del logotipo "PS4 / PlayStation 4": eso es diseño de la carátula, NO es la tira de precinto. "visible" solo si ves claramente esa tira del plástico; "not_visible" si ves bien la parte inferior de la portada y no está; "unclear" en otro caso.
- "sealStripText": si la tira es "visible", LEE sus letras repetidas: "PS4" si se repite el símbolo de PlayStation seguido de PS4; "PS5" si se repite con PS5; "PlayStation" si se repite la palabra completa PlayStation; "PS3", "PSP" o "PS Vita" si se repite ese nombre; "Blu-ray Disc" si se repite el logotipo de Blu-ray Disc; "otras_letras" si lees letras que no son ninguna de estas; "sin_letras" si la tira no lleva letras (p. ej. la roja de Switch o una tira lisa); "ilegible" si ves la tira pero no puedes leer sus letras. "no_hay_tira" si "sealStrip" no es "visible". Nunca la confundas con la banda impresa de arriba de la carátula. CUIDADO, "PS4" y "PSP" se confunden: la tira "PS4" lleva DELANTE de cada "PS4" el símbolo de PlayStation (la P y la S superpuestas) y cada grupo TERMINA en el número 4; la tira "PSP" NO lleva ese símbolo, son solo las tres letras P-S-P con la tipografía estirada y redondeada del logo de la PSP, y cada grupo TERMINA en una P (forma cerrada arriba, sin el ángulo del 4). Mira el ÚLTIMO carácter de cada grupo antes de responder: si es una P, es "PSP" aunque la portada diga PS4 en grande.
- "shrinkWrap": plástico que envuelve la caja. "factory" = película retráctil de fábrica, AJUSTADA a la caja como una segunda piel, con pliegues o arrugas, solapas dobladas en esquinas o lomo, o su costura/soldadura. "loose_sleeve" = funda o bolsa protectora SUELTA, más grande que la caja (holgada, con solapa o abertura, típica de tiendas de segunda mano). "not_visible" si la caja se ve claramente sin plástico. "unclear" en otro caso. Un brillo o reflejo de la carátula NO es plástico. MUY IMPORTANTE: TODAS las cajas de PS4/PS5/Switch/Xbox tienen de serie una LÁMINA TRANSPARENTE que cubre la carátula por fuera (es la funda de la propia caja, donde va metida la portada impresa): sus reflejos, brillos y ondulaciones sobre la portada NO son precinto, existen también en copias usadas. El precinto de fábrica envuelve la caja ENTERA y se reconoce en los BORDES y ESQUINAS (pliegues, solapas dobladas, soldadura, el plástico sobresaliendo del borde); si no ves nada de eso en los bordes, responde "not_visible" o "unclear", nunca "factory".
- "usedLabel": true si alguna etiqueta o pegatina (de tienda, de precio o del vendedor) indica que es de SEGUNDA MANO o gradúa su estado: "Estado: Muy bueno/Bueno/Aceptable", "Usado", "Seminuevo", "Segunda mano", "Usato", "Occasion", "Pre-owned", "Pre-played". false en otro caso. Una pegatina de PRECIO de una tienda de juegos nuevos (FNAC, GAME, MediaMarkt, El Corte Inglés, Carrefour, Amazon…) NO es una etiqueta de segunda mano: solo cuenta si su texto dice expresamente usado, seminuevo o un estado de uso.

5) "notes": UNA frase en español con lo más relevante que has visto (qué fotos hay, idioma, precinto).`;

export const USER_PROMPT = `Describe estas fotos siguiendo exactamente el formato pedido.`;

// Appended to SYSTEM_PROMPT when the request carries the magnifier tiles (see
// magnifier.ts), so the model neither misses them nor counts them as photos.
export const MAGNIFIER_NOTE =
  "\n\nLas imágenes rotuladas «Ampliación» son la Foto 1 dividida en cuatro trozos ampliados, para que veas detalles pequeños (como la tira de apertura del plástico y sus letras, o los pliegues del precinto en las esquinas). No son fotos nuevas: no las cuentes en \"photos\".";

export interface ImagePart {
  mimeType: string;
  data: string; // base64
}

/** The user turn: every photo numbered ("Foto 1:"…) so the model can say
 *  WHICH photo shows the disc, then the magnifier tiles of photo 1, labeled. */
export function userParts(
  photos: ImagePart[],
  tiles: { name: string; part: ImagePart }[] = []
): object[] {
  return [
    ...photos.flatMap((p, i) => [
      { text: `Foto ${i + 1}:` },
      { inline_data: { mime_type: p.mimeType, data: p.data } },
    ]),
    ...tiles.flatMap((t) => [
      { text: `Ampliación de la Foto 1 (${t.name}):` },
      { inline_data: { mime_type: t.part.mimeType, data: t.part.data } },
    ]),
    { text: USER_PROMPT },
  ];
}

// Letters the strip can carry (the SealStripText values) and the non-answers.
const STRIP_LETTERS = ["PS4", "PS5", "PlayStation", "PS3", "PSP", "PS Vita", "Blu-ray Disc"] as const;
const STRIP_TEXTS = [...STRIP_LETTERS, "otras_letras", "sin_letras", "ilegible", "no_hay_tira"] as const;

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
    sealStripText: { type: "string", enum: [...STRIP_TEXTS] },
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
    "sealStripText",
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
  sealStripText: string;
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
  let sealReason: VisionResult["sealReason"] = "unknown";
  // Measured on 47 labeled real listings: without the magnifier the models
  // rarely saw the tear strip (3 of 18 sealed copies); with it they read its
  // letters on 21 of 22 where blind reviewers could, never inventing one
  // (gemini-3.5-flash-lite, 74 listings). The factory shrink-wrap is seen
  // reliably either way (18/18).
  // So the wrap counts on its own — as long as nothing says "opened" or
  // "used": a disc/interior/manual photo, a loose shop sleeve instead of the
  // tight factory film, or a shop label grading the condition (the one false
  // positive was a used copy in a loose sleeve tagged "Estado: Muy Bueno").
  if (opened.length > 0) {
    sealed = "no";
    sealReason = "opened";
    sealWhy = `abierto (se ve el disco, el interior o el manual en la foto ${opened.join(", ")})`;
  } else if (obs.usedLabel) {
    sealed = "no";
    sealReason = "used_label";
    sealWhy = "etiqueta de segunda mano o de estado de uso";
  } else if (obs.sealStrip === "visible" || obs.shrinkWrap === "factory") {
    sealed = "yes";
    sealReason = obs.sealStrip === "visible" ? "strip" : "wrap";
    sealWhy =
      obs.sealStrip === "visible"
        ? "precintado (tira de apertura del plástico visible)"
        : "precintado (plástico de fábrica ajustado a la caja)";
  } else if (obs.shrinkWrap === "not_visible" || obs.shrinkWrap === "loose_sleeve") {
    sealed = "no";
    sealReason = obs.shrinkWrap === "loose_sleeve" ? "loose_sleeve" : "no_wrap";
    sealWhy =
      obs.shrinkWrap === "loose_sleeve"
        ? "funda protectora suelta, no precinto de fábrica"
        : "sin plástico de fábrica";
  }

  // The strip's letters, kept only for a copy the photos don't show opened
  // and only when the strip itself was seen (a guess at the letters of an
  // unseen strip must never reach the filter). "PS4" and "PS5" in tiny print
  // follow the box's platform when it's known: a PS4 game never ships in a
  // PS5 strip.
  let stripText: SealStripText | null = null;
  if (sealed !== "no" && obs.sealStrip === "visible") {
    if (obs.sealStripText === "PS4" || obs.sealStripText === "PS5") {
      stripText = platform === "ps4" ? "PS4" : platform === "ps5" ? "PS5" : obs.sealStripText;
    } else if ((STRIP_LETTERS as readonly string[]).includes(obs.sealStripText)) {
      stripText = obs.sealStripText as SealStripText;
    }
  }
  if (stripText && sealReason === "strip") {
    sealWhy = `precintado (tira de apertura del plástico visible, con «${stripText}»)`;
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
      langWhy = `contraportada en ${lang}${quoted}, con español en la lista de idiomas («${listQuote.slice(0, 90)}»)`;
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
  const sawCase = obs.photos.some((p) =>
    ["front_cover", "back_cover", "spine_or_side"].includes(p.content)
  );
  // What the model read on a visible strip, verbatim ("otras_letras" included):
  // the rare-strip hunter wants every non-standard reading, not only the
  // ones the filter has a chip for.
  const stripReading = obs.sealStrip === "visible" ? obs.sealStripText : null;
  return { verdict, evidence, platform, sealed, sealReason, sawCase, stripText, stripReading };
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
    sealStripText: str(o.sealStripText, "no_hay_tira"),
    shrinkWrap: str(o.shrinkWrap, "unclear"),
    usedLabel: o.usedLabel === true,
    notes: str(o.notes, ""),
  };
}
