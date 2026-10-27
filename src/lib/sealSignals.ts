// ─────────────────────────────────────────────────────────────
// Seal evidence from the SELLER: what they wrote (title + description) and
// the condition they declared on the marketplace. Combined with what the
// vision model saw (visionPrompt.ts) in combineSeal().
//
// Measured on 48 hand-labeled real listings: sellers state it plainly and in
// their own language — "precintado", "sigillato", "neuf sous blister", "nuovo
// sealed" for sealed copies; "desprecintado pero sin usar", "como nuevo, se ha
// usado 2 veces", "TBE" for opened ones — and the declared condition lines up
// (Wallapop "un_opened", Vinted "Nuevo con etiquetas" on sealed copies).
//
// Audited on 1374 Wallapop listings (500 with their declared condition). The
// goal is ZERO false "sealed": a seal word only counts when it is about THIS
// game and nothing in the text says the seal is broken, removed, re-made or
// that the copy was used. Traps found there and handled below: plural or
// spaced negations ("NO están precintados", "no viene precintado"), torn seals
// ("el precinto tiene una rotura"), home/shop reseals ("precinto puesto por
// mí", "precinto de GAME"), lots where only SOME games are sealed, seal words
// about something else (a keychain, a trade the seller wants, SEO tag blocks,
// a shop's boilerplate about its other stock, the shipping parcel).
// ─────────────────────────────────────────────────────────────

import type { MarketSource, VisionResult } from "./types";

/** Lowercase, no accents, no punctuation: for short labels (conditions). */
function flat(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Like flat(), but clause boundaries (. ; ! ? new line, bullets and spaced
 *  dashes) survive as " | ", so a rule scoped to one clause ("cambio por FC27
 *  precintado") can't reach into the next sentence. */
function clauses(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[.;!?\n\r•·|]+|\s[-–—]+\s|^\s*[-–—]+|\s[-–—]+(?=\S)/g, " | ")
    .replace(/[^a-z0-9|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NUM =
  "(?:\\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince)";

// ── Neutralizers ─────────────────────────────────────────────

// Phrases that LOOK like an opened/used cue but aren't. Removed before any
// rule runs.
const OPEN_NEUTRALIZE: RegExp[] = [
  /\bmundo abierto\b/g, // "juego de mundo abierto" (open-world)
  /\bopen world\b/g,
  /\bmondo aperto\b/g,
  /\bmonde ouvert\b/g,
  /\bedicion completa\b/g,
  /\bcoleccion completa\b/g,
  /\bcollection complete\b/g,
  /\babiert[oa]s? a (ofertas?|cambios?|negocia\w*|propuestas?|preguntas|dudas|consultas|sugerencias|todo tipo|cualquier\w*)\b/g,
  // Shop boilerplate: "¿por qué pagar por uno de segunda mano si…?",
  // "En SwitchVault solo vendemos juegos como nuevos".
  /\bpor que pagar por uno de segunda mano\b/g,
  /\bvendemos (\w+ ){0,2}como nuevos\b/g,
  // Shop disclaimers (plural, about its units in general): "pueden presentar
  // alguna rotura o tara en el precinto". A scuffed wrap is still a factory
  // seal; a singular "puede presentar…" is left alone.
  /\bpueden (presentar|tener|venir con)\b[^|]*/g,
  // Negated damage: "sin roturas ni picotazos", "sin ninguna rotura".
  /\bsin (ningun[oa]? )?(roturas?|aperturas?|aberturas?|desperfectos?|danos?|golpes|marcas|picotazos?|rasgun\w*|rajas?|abolladuras?|aranazos?|rayas|rayones|rallas)( (ni|y|o) (ningun[oa]? )?(roturas?|aperturas?|aberturas?|desperfectos?|danos?|golpes|marcas|picotazos?|rasgun\w*|rajas?|abolladuras?|aranazos?|rayas|rayones|rallas))*\b/g,
  /\bningun[oa]? (rotura|rasguno|desperfecto|dano|abolladura|marca)\b/g,
  // "código sin canjear" (vs "código canjeado").
  /\b(sin|no) (ha sido |esta |estan )?canjead[oa]s?\b/g,
  /\bsin canjear\b/g,
  // "never used / opened" in other languages: neither a seal nor an opening.
  /\b(mai|never|jamais|nie|non|nao|not|pas|pas ete|jamais ete) (usat[oa]|used|utilise|utilisee|apert[oa]|opened|ouvert|ouverte|geoffnet|abert[oa])\b/g,
];

// "Never opened": a sealed claim in other words. Rewritten to "sin abrir"
// (an explicit opening elsewhere still wins: STRONG_OPENED runs first).
const TO_SEALED: [RegExp, string][] = [
  [
    /\b(nunca|no|jamas|ni) (se )?(lo |la |los |las )?(ha |he |han |hemos |fue |fueron |ha sido |han sido |esta |estan |a )?(llegado a )?(abiert[oa]s?|abrir|abri|abrio|desprecintad[oa]s?|desprecintar)( nunca)?\b/g,
    " sin abrir ",
  ],
  [/\bsin (haber |haberlo |haberla |haber sido )(abiert[oa]|abierto|desprecintad[oa])\b/g, " sin abrir "],
  [/\bun ?opened\b/g, " sin abrir "],
];

// Negated "used": "sin usar", "nunca usado", "no lo he jugado" say UNUSED,
// which is neither a seal nor an opening by itself.
const UNUSED =
  /\b(sin|nunca|no|ni|jamas) (se )?(lo |la |los |las )?(ha |he |han |hemos |a |ha sido |han sido |esta |estan |haber |haberlo |haber sido )?(llegado a )?(usar|usad[oa]s?|jugar|jugad[oa]s?|utilizar|utilizad[oa]s?|estrenar|estrenad[oa]s?)( nunca)?\b/g;

// Seal words about something OTHER than this copy. Removed only before
// looking for a SEALED claim: an opened/used cue in the same words still
// counts (a trade clause can't hide "el precinto está roto").
const SCOPE_NEUTRALIZE: RegExp[] = [
  // A shop's boilerplate about the REST of its stock: "MUCHOS JUEGOS EN
  // STOCK | PRODUCTO NUEVO PRECINTADO CON GARANTIA" (the same text sits on
  // that shop's "desprecintado" listings).
  /\b(muchos|mas|otros) (juegos|articulos|productos)( \w+){0,3} (en stock|en mi perfil|en nuestro perfil)\b[^|]*((\s*\|)+\s*producto nuevo precintado con garantia)?/g,
  // The PARCEL is sealed, not the game: "bien empaquetado y precintado".
  // ("embalaje original precintado" is about the game and stays.)
  /\b(empaquetad[oa]|embalad[oa])( \w+){0,2} (y )?precintad[oa]\b/g,
  // Trades: "se acepta cambio por FC27 precintado" is what they WANT.
  /\b(acepto|aceptamos|aceptan|acepta|admito|admitimos|escucho|hago|cambio|cambios|cambiaria|cambiar)\b[^|]{0,20}\b(por|x)\b[^|]*/g,
  // Small extras that come sealed: "el llavero está sin abrir", "steelbook
  // precintado" (not the "Steelbook Edition" of the game itself).
  /\b(llavero|figura|figurita|amiibo|postal|postales|poster|pin|pines|lamina|chapa|(?<!edicion )steelbook(?! (edition|edicion))|funda|estuche|banda sonora)\b[^|]{0,25}\b(sin abrir|precintad[oa]s?|sellad[oa]s?)\b/g,
  // An included game in a console bundle: "incluye un juego precintado".
  /\bincluye (un|el) juego\b[^|]{0,40}\bprecintad[oa]\b/g,
  // "Incluye precinto original": the wrap loose in the box? Ambiguous: no claim.
  /\bincluye (el |su )?precinto( original)?\b/g,
  // Past tense says how it ARRIVED, not how it is: "venía precintado, lo
  // abrí", "lo compré precintado". No claim either way.
  /\b(venia|vino|estaba|llego|compre|comprado|comprada|was|came|etait)( [a-z]+){0,2} (precintad[oa]s?|sealed|sigillat[oa]|sous blister|scelle|versiegelt|sellad[oa]s?)\b/g,
];

// SEO blocks: from "palabras clave:" (or a keyword-stuffing run) on, the text
// is a list of search terms, not a description of this copy.
const TAG_BLOCK: RegExp[] = [
  /\b(palabras? clave|keywords|tags|hashtags?|etiquetas de busqueda|gancho)\b[\s\S]*$/,
  /\b(nuevo nueva|nueva nuevo|precintado precintada|precintada precintado|sellado sellada|brand new sealed brandnew)\b[\s\S]*$/,
];

// ── Rules ────────────────────────────────────────────────────

// Opened / used, beyond doubt. Checked BEFORE the sealed phrases:
// "desprecintado pero sin usar" contains "precintado" but means the seal is
// broken; "precintado pero con una pequeña apertura" is not a seal.
const STRONG_OPENED: RegExp[] = [
  // Negated seal words, with a few function words in between, in any
  // language: "no precintado", "NO están precintados", "no viene precintado",
  // "no es el precinto original", "no longer sealed", "n'est plus sous
  // blister", "non più sigillato", "nicht mehr versiegelt".
  /\b(no|non|not|pas|nicht|nao|nunca|n est|n etait)( (e|es|esta|estan|son|estaba|estaban|viene|vienen|venia|va|van|lleva|llevan|tiene|tienen|trae|traen|conserva|conservan|is|are|was|est|ist|sind|more|longer|anymore|plus|piu|mehr|ja|ya|el|los|su|sus|la|las|il|le|de|en|ha|han|sido|se|encuentra|encuentran))* (precintad[oa]s?|precintos?|sigillat[oa]|sealed|sous blister|scelle|versiegelt|selad[oa]|lacrad[oa]|sellad[oa]s?)\b/,
  /\b(ninguno|ninguna)( de (los|las) \w+| de ellos| de ellas)? (esta |es )?(precintad[oa]|sellad[oa])\b/,
  // Home / shop reseals.
  /\bre ?precintad[oa]s?\b/,
  /\b(precintad[oa]s?|sellad[oa]s?) de nuevo\b/, // "precintado de nuevo con film"
  /\bvuelt[oa] a (precintar|sellar)\b/,
  /\b(plastificad[oa]|retractilad[oa]|envuelt[oa]) (por mi|en casa|de nuevo)\b/,
  /\bprecintos? (puesto|colocado|hecho|pegado) por\b/,
  /\bprecinto casero\b/,
  /\bprecint\w* (de |del |por )?(game|la tienda|tienda|cex)\b/,
  // Seal removed or missing.
  /\bdesprecintad[oa]s?\b/,
  /\bdesprecinte\b/,
  /\b(sin|no tiene|no lleva|no trae) (el |su )?precinto\b/,
  /\bsin precintar\b/,
  /\b(le |les )?(falta|faltan) (el |su )?precinto\b/,
  /\b(perdio|perdido|pierde) (el |su )?precinto\b/,
  /\bunsealed\b/,
  /\b(le )?(quite|quitado|quitamos|retire|retirado|abri|abrimos) (el |su )?precinto\b/,
  /\brestos del precinto\b/,
  /\bguardad[oa] en (el |su )?precinto\b/,
  // Seal broken or open: "el precinto tiene una rotura", "precinto un poco
  // abierto en el lateral", "película con algunas lágrimas".
  /\b(precint\w*|plastico|film|pelicula|blister|envoltorio)\b[^|]{0,40}\b(roto|rota|rotos|rotas|roturas?|abiert[oa]s?|aperturas?|aberturas?|agujeros?|rajad[oa]|rasgad[oa]|lagrimas|cortes?|cortad[oa])\b/,
  /\b(roturas?|aperturas?|aberturas?|agujeros?|rasgad[oa]|lagrimas)\b[^|]{0,15}\b(en |del |de )?(el |la |su )?(precinto|plastico|film|pelicula)\b/,
  /\bprecint\w*\b[\s\S]{0,60}\bpresenta (una|un) (rotura|apertura|abertura|corte|agujero)\b/,
  // Opened, by the seller's own hand or in so many words.
  /\babiert[oa] por (mi|nosotros)\b/,
  /\blo (he )?(abierto|abri)\b/,
  /\b(caja|juego|precinto) abiert[oa]\b/,
  /\b(opened|open box|ouvert|ouverte|geoffnet|aberto|aberta)\b/,
  /\baperto (ma|e|una volta|solo)\b/,
  // Used.
  /\b(usado|jugado) (una|un par|dos|2|3|pocas) (vez|veces)\b/,
  /\b(se ha|lo he|solo) (usado|jugado)\b/,
  /\bcomo nuev[oa]s?\b/,
  /\b(practicamente|casi) nuev[oa]s?\b/,
  /\b(muy )?poco (uso|usad[oa]s?|jugad[oa]s?)\b/,
  /\bapenas (uso|usad[oa]|jugad[oa]|se ha (usado|jugado))\b/,
  /\b(marcas|signos|senales) de uso\b/,
  /\bprobad[oa]s? y funcion\w*\b/,
  /\b(codigo|codigos|dlc|descargables?|pase)\b[^|]{0,30}\bcanjead[oa]s?\b/,
  // Not "10 horas de juego" (a controller's battery life).
  /\b(menos de|apenas|solo|ni|no tiene ni) (una|\d+|dos|pocas|media) horas? de juego\b/,
  /\b(disco|discos|cd|cartucho)\b[^|]{0,20}\b(aranazos?|rayas|rayones|rayad[oa]|rallad[oa]|marcas)\b/,
  /\bcome nuov[oa]\b/,
  /\bcomme neuf\b/,
  /\bwie neu\b/,
  /\blike new\b/,
  /\bas new\b/,
  /\bseminuev[oa]s?\b/,
  /\busat[oa]\b/,
  /\bd occasion\b/,
  /\bgebraucht\b/,
  /\bpre ?owned\b/,
  /\bpre ?played\b/,
  /(?<!\bun )\bsolo (el )?(disco|cartucho)\b/, // not "7 juegos en un solo cartucho"
  /\bsolo (entrego )?(el )?juego\b(?! (precintad|sellad|nuevo))/,
  /\bsin (la )?caja\b/,
  // The bare words last, so the badge quotes the more telling phrase above.
  /\babiert[oa]s?\b/,
  /\b(abri|abrio|abrimos)\b/,
  /\b(usad[oa]|jugad[oa])\b/, // singular: "videojuegos usados" is shop boilerplate
];

// Generic condition words: sealers write them too ("precintado, carátula en
// perfecto estado"), so they only mean "opened" when there is NO seal claim.
const WEAK_OPENED: RegExp[] = [
  /\b(muy )?buen estado\b/,
  /\bperfecto estado\b/,
  /\bexcelente estado\b/,
  /\bestado (excelente|perfecto|impecable)\b/,
  /\b(buenas|perfectas|optimas|excelentes) condiciones\b/,
  /\bcondizioni (perfette|ottime|buone)\b/,
  /\b(ottime|perfette|buone) condizioni\b/,
  /\b(ottimo|perfetto|buono) stato\b/,
  /\b(tres )?bon etat\b/,
  /\btbe\b/,
  /\bsegunda mano\b/,
  /\b(funciona|funcionando) perfectamente\b/,
  /\b(perfettamente funzionante|funziona perfettamente|testat[oa])\b/,
];

const SEALED: RegExp[] = [
  /\bprecintad[oa]s?\b/, // \b keeps "desprecintado" out
  /\bpreciontad[oa]s?\b/, // seen typo
  /\bprecintand[oa]\b/, // seen typo: "Juego Precintando sin estrenar"
  /\bsin desprecintar\b/,
  /\bcon (el |su )?precinto\b/,
  /\ben su precinto\b/,
  /\bcons(er|e)va\w* (el |su )?precinto\b/, // also the typo "conseva precinto"
  /\bprecinto (original|intacto|oficial|de fabrica)\b/,
  /\bsin abrir\b/,
  /\bsellad[oa]s?\b/,
  /\bsigillat[oa]\b/,
  /\bsous (blister|film)\b/,
  /\bscelle\b/,
  /\bsealed\b/,
  /\bversiegelt\b/,
  /\beingeschweisst\b/,
  /\bneu ovp\b/,
  /\bselad[oa]\b/,
  /\blacrad[oa]\b/,
];

// ── Lots ─────────────────────────────────────────────────────

// Several games (or a console bundle) in one listing: "precintado" may be
// about just one of them ("Xenoblade 2 (precintado) - Xenoblade 3").
const BUNDLE_TITLE = /(\+|\bcon\b|\by\b) ?(\d+ )?(mandos?|juegos?|accesorios)\b/;
// What may follow a "+" without making it a second game: "+ Postal
// Promocional", "+ Funda Protectora", "+ Steelbook".
const PLUS_EXTRA =
  /^(\d+ )?(postal|postales|funda|fundas|estuche|llavero|steelbook|poster|pin|pines|set de pines|figura|figurita|cd|banda sonora|ost|soundtrack|lamina|laminas|chapa|chapas|artbook|libro de arte|mapa|tarjeta|manual|guia|dlc|dlcs|pase|pases|codigo|codigos)\b/;

/** A "+" joining two things in the title ("Xenoblade 2 + Xenoblade 3",
 *  "Langrisser 1 + 2", "Bayonetta 1+2"). Not a "+" that is part of a name
 *  ("Tokyo Xanadu eX+"), inside brackets ("Metro Redux (2033 + Last
 *  Light)", one product) or that only adds a small extra ("+ Postal"). */
function plusJoinsItems(title: string): boolean {
  const t = title.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  if (/\d\s*\+\s*\d/.test(t)) return true;
  const re = /(^|\s)\+\s*([^+]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (!PLUS_EXTRA.test(flat(m[2]))) return true;
  }
  return false;
}

const LOT_TITLE: RegExp[] = [
  /\b(lote|lotto|lot|bundle)\b/,
  /\b(pack|coleccion|conjunto) de (juegos|videojuegos)\b/,
  new RegExp(`\\bpack (de )?${NUM}\\b`),
  new RegExp(`\\b${NUM} (juegos|videojuegos|games|giochi|jeux)\\b`),
  /^(juegos|videojuegos)\b/,
];
const LOT_TEXT: RegExp[] = [
  new RegExp(`\\b(lote|conjunto|pack|seleccion|paquete|coleccion) (de )?${NUM} (juegos|videojuegos|titulos)\\b`),
  new RegExp(`(^|\\| )${NUM} (videojuegos|juegos|titulos) (para|de la saga)\\b`),
  /\blote de (juegos|videojuegos)\b/,
];

/** True when the listing sells several games (or a console bundle), so a
 *  seal word or "un_opened" may describe only part of it. */
export function isLot(title: string, text: string): boolean {
  const t = clauses(title);
  if (plusJoinsItems(title)) return true;
  if (LOT_TITLE.some((re) => re.test(t))) return true;
  if (BUNDLE_TITLE.test(title.toLowerCase())) return true;
  const d = clauses(text);
  if (LOT_TEXT.some((re) => re.test(d))) return true;
  // A price list: "1. The Surge 2 precintado - 9€ 2. Yesterday Origins: 11€…"
  if ((text.match(/\d+(?:[.,]\d+)?\s?(?:€|eur\b|euros\b)/gi) ?? []).length >= 3) return true;
  if ((text.match(/\b\d{1,3}[.,]\d{2}\b/g) ?? []).length >= 3) return true;
  return false;
}

// In a lot, a sealed claim counts only when it covers EVERY game: "ambos
// precintados", "todos están precintados" — and not "todos precintados
// menos uno", nor when the text also talks about some / the rest.
const ALL_SEALED =
  /\b(todos|todas|ambos|ambas)( (los|las|juegos|videojuegos|titulos|articulos|productos|ellos|ellas|estan|son|vienen|van|siguen|se|encuentran|nuevos|nuevas|y|completamente|totalmente))* (precintad[oa]s|sellad[oa]s|sin abrir|sealed|en su precinto|con su precinto)\b(?!( \w+){0,2} (menos|excepto|salvo|except|aunque|pero)\b)|\b(precintad[oa]s|sellad[oa]s) (todos|todas|ambos|ambas)\b(?!( \w+){0,2} (menos|excepto|salvo|except|aunque|pero)\b)/;
const PARTIAL =
  /\b(algunos|algunas|alguno|alguna|varios|varias|unos|otros|otras|resto|uno de ellos|uno de los|una de las|excepto|salvo|menos el|menos la|menos uno|menos una|solo uno|solo una|solo el|solo la)\b/;

// ── Text claim ───────────────────────────────────────────────

interface Prepared {
  open: string; // for the opened/used rules
  seal: string; // for the sealed rules (scope + SEO blocks removed)
}

function prepare(text: string): Prepared {
  const base = (t: string): string => {
    for (const re of OPEN_NEUTRALIZE) t = t.replace(re, " ");
    for (const [re, sub] of TO_SEALED) t = t.replace(re, sub);
    return t.replace(UNUSED, " ");
  };
  const c = clauses(text);
  let seal = c;
  for (const re of TAG_BLOCK) seal = seal.replace(re, " ");
  seal = base(seal);
  for (const re of SCOPE_NEUTRALIZE) seal = seal.replace(re, " ");
  return { open: base(c), seal };
}

// "Precintado: no", "¿Sealed? No" (the punctuation is lost after clauses()).
const ANSWERED_NO = /(precintad[oa]s?|sellad[oa]s?|sealed|sigillat[oa])\s*[:?]+\s*no\b/i;

/** What the seller's own text claims about the seal. `title` (default: the
 *  text's first line) is used to tell lots from single games. */
export function textSealClaim(
  text: string,
  title: string = text.split("\n")[0] ?? ""
): "sealed" | "opened" | null {
  if (ANSWERED_NO.test(text)) return "opened";
  const p = prepare(text);
  if (STRONG_OPENED.some((re) => re.test(p.open))) return "opened";
  const weak = WEAK_OPENED.some((re) => re.test(p.open));
  if (SEALED.some((re) => re.test(p.seal))) {
    if (!isLot(title, text)) return "sealed";
    if (ALL_SEALED.test(p.seal) && !PARTIAL.test(p.seal) && !weak) return "sealed";
    return weak ? "opened" : null;
  }
  return weak ? "opened" : null;
}

/** First phrase in the seller's text that settles the seal, for the badge's
 *  explanation ("«desprecintado»", "«sigillato»"…). */
function claimPhrase(text: string, claim: "sealed" | "opened"): string | null {
  if (claim === "opened") {
    const m = text.match(ANSWERED_NO);
    if (m) return m[0];
  }
  const p = prepare(text);
  const lists = claim === "opened" ? [STRONG_OPENED, WEAK_OPENED] : [SEALED];
  const t = claim === "opened" ? p.open : p.seal;
  for (const list of lists) {
    for (const re of list) {
      const m = t.match(re);
      if (m) return m[0].trim();
    }
  }
  return null;
}

// ── Declared condition ───────────────────────────────────────

/** The marketplace condition the seller picked, as seal evidence:
 *  "sealed" (Wallapop "un_opened", Vinted "Nuevo con etiquetas"), "used"
 *  (forces not sealed), "like_new" (Wallapop "as_good_as_new": not a used
 *  declaration, but in 135 audited listings it never went with a sealed
 *  game, so it rules out a seal claim taken from the seller's text). */
export function conditionSealSignal(
  source: MarketSource,
  rawCondition: string | null | undefined
): "sealed" | "used" | "like_new" | null {
  const c = flat(rawCondition ?? "");
  if (!c) return null;
  if (source === "wallapop") {
    if (c === "un opened") return "sealed";
    if (c === "good" || c === "fair" || c === "has given it all") return "used";
    if (c === "as good as new") return "like_new";
    return null; // "new", "in box": seen on both kinds
  }
  if (source === "vinted") {
    if (c.startsWith("nuevo con etiqueta")) return "sealed";
    if (c === "muy bueno" || c === "bueno" || c === "satisfactorio") return "used";
    return null; // "Nuevo sin etiquetas": new-looking but often opened
  }
  return null; // eBay: handled by sellerCondition (conditionId)
}

const CONDITION_NAMES: Record<string, string> = {
  un_opened: "sin abrir",
};

// ── Final verdict ────────────────────────────────────────────

const LANG_CLAUSE_END =
  /;\s*(abierto \(|etiqueta de segunda|precintado|funda protectora|sin plástico)[^;]*\.?$/;

function withSealClause(evidence: string, clause: string): string {
  const base = evidence.replace(LANG_CLAUSE_END, "").replace(/\.\s*$/, "");
  return `${base}; ${clause}.`;
}

/**
 * Final seal verdict: what the photos showed (vision result) combined with
 * what the seller wrote and the condition they declared. Measured on 48
 * hand-labeled listings: photos alone 13/16 (gemini-3.1-flash-lite) and 12/18
 * (gemma-4) sealed copies recognized; photos + seller 15/16 and 16/18, with
 * zero false "sealed" either way.
 *
 * Opened/used evidence ALWAYS wins: a disc or open-case photo, a loose shop
 * sleeve, a second-hand label, a used condition or a seller saying
 * "desprecintado". A seller's sealed claim counts when the photos show the
 * boxed game (not merch, not a lone cover insert), nothing contradicts it and
 * the listing is a single game.
 */
export function combineSeal(
  vision: VisionResult,
  listing: {
    source: MarketSource;
    title?: string;
    sellerCondition?: "new" | "used" | "open_box" | null;
    sellerConditionRaw?: string | null;
    sellerText?: string;
  },
  extra: {
    description?: string;
    condition?: string | null;
    // The declared condition exists but couldn't be read (Wallapop item
    // request failed): it might have said "used", so no seller upgrade.
    conditionUnavailable?: boolean;
  } = {}
): VisionResult {
  const r = { ...vision };
  if (r.sealReason === "opened" || r.sealReason === "loose_sleeve") return r;

  const rawCondition = extra.condition ?? listing.sellerConditionRaw ?? null;
  const cond = conditionSealSignal(listing.source, rawCondition);
  const text = `${listing.sellerText ?? ""}\n${extra.description ?? ""}`;
  const title = listing.title ?? (listing.sellerText ?? "").split("\n")[0] ?? "";
  const claim = textSealClaim(text, title);

  if (cond === "used" || listing.sellerCondition === "used") {
    r.sealed = "no";
    r.evidence = withSealClause(
      r.evidence,
      `el vendedor lo declara usado${rawCondition ? ` («${rawCondition}»)` : ""}, así que no está precintado`
    );
    return r;
  }
  if (listing.sellerCondition === "open_box") {
    // eBay "Nuevo: otro" / "Open box": new, but "possibly in its original
    // packaging and NOT sealed" by eBay's own definition.
    r.sealed = "no";
    r.evidence = withSealClause(
      r.evidence,
      `eBay lo declara «${rawCondition ?? "Nuevo: otro"}» (nuevo pero no precintado)`
    );
    return r;
  }
  if (claim === "opened") {
    const phrase = claimPhrase(text, "opened");
    r.sealed = "no";
    r.evidence = withSealClause(
      r.evidence,
      `el vendedor indica que está abierto o usado${phrase ? ` («${phrase}»)` : ""}`
    );
    return r;
  }
  // A second-hand / condition sticker seen in the photos is opened evidence
  // too: no seller declaration overrides it.
  if (r.sealReason === "used_label") return r;
  if (r.sealed === "yes") return r;
  if (extra.conditionUnavailable) return r;

  const lot = isLot(title, text);
  const textSealed = claim === "sealed" && cond !== "like_new";
  const condSealed = cond === "sealed" && !lot;
  const ebayNew =
    listing.source === "ebay" && listing.sellerCondition === "new" && !lot;
  if (!(textSealed || condSealed || ebayNew) || r.sawCase !== true) return r;

  const phrase = textSealed ? claimPhrase(text, "sealed") ?? "precintado" : "";
  const condName = condSealed
    ? CONDITION_NAMES[flat(rawCondition ?? "").replace(/ /g, "_")] ?? rawCondition
    : "";
  // "no_wrap": the photos showed the box without seeing any factory film.
  // Say so instead of claiming no photo contradicts the seller.
  const clause =
    r.sealReason === "no_wrap"
      ? `precintado según ${
          textSealed
            ? `el vendedor («${phrase}»)`
            : condSealed
              ? `el estado declarado («${condName}»)`
              : "eBay («Nuevo»: sin abrir, en su embalaje original)"
        }, aunque en las fotos no se distingue el plástico de fábrica`
      : `precintado: ${
          textSealed
            ? `el vendedor dice que está precintado («${phrase}»)`
            : condSealed
              ? `estado declarado «${condName}»`
              : "eBay lo declara «Nuevo» (sin abrir, en su embalaje original)"
        } y ninguna foto lo contradice`;
  r.sealed = "yes";
  r.sealReason = "seller";
  r.evidence = withSealClause(r.evidence, clause);
  return r;
}
