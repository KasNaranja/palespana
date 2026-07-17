// ─────────────────────────────────────────────────────────────
// Demo mode data: a bundled "Pokémon Esmeralda" search with 12 realistic
// fake listings, mixed verdicts and local SVG box-art. Lets the app be fully
// demoable on first run with no Anthropic key or Vinted access.
// ─────────────────────────────────────────────────────────────

import type { Listing, LanguageVerdict } from "./types";

interface DemoSeed {
  id: string;
  title: string;
  price: number;
  shipping: number | null;
  country: string;
  photos: string[];
  verdict: Exclude<LanguageVerdict, "pending">;
  evidence: string;
}

// Ordered loosely; the app re-sorts by total price ascending anyway.
const SEEDS: DemoSeed[] = [
  {
    id: "demo-es-1",
    title: "Pokémon Esmeralda Game Boy Advance - PAL España",
    price: 14.5,
    shipping: 2.5,
    country: "ES",
    photos: ["/demo/front-es.svg", "/demo/back-es.svg"],
    verdict: "es",
    evidence:
      "La contraportada tiene textos en castellano y el sello 'PAL España — Totalmente en castellano'.",
  },
  {
    id: "demo-fr-1",
    title: "Pokemon Emeraude GBA - version française",
    price: 12.0,
    shipping: 3.0,
    country: "FR",
    photos: ["/demo/front-fr.svg", "/demo/back-fr.svg"],
    verdict: "other",
    evidence:
      "La contraportada está en francés (PAL France) y no menciona el español.",
  },
  {
    id: "demo-inc-1",
    title: "Pokémon Esmeralda - solo cartucho, buen estado",
    price: 9.99,
    shipping: 1.99,
    country: "ES",
    photos: ["/demo/front-neutral.svg"],
    verdict: "inconclusive",
    evidence:
      "Solo hay foto de la portada del cartucho; no se puede confirmar el idioma.",
  },
  {
    id: "demo-es-2",
    title: "Pokemon Esmeralda Advance completo con caja y manual (ESP)",
    price: 18.0,
    shipping: 3.5,
    country: "ES",
    photos: ["/demo/front-es.svg", "/demo/back-es.svg"],
    verdict: "es",
    evidence:
      "En la lista de idiomas de la contraportada aparece 'ES' y hay descripción en castellano.",
  },
  {
    id: "demo-multi-1",
    title: "Atomic Heart PS4 - caja francesa, multi-idioma",
    price: 15.0,
    shipping: 3.0,
    country: "FR",
    photos: ["/demo/front-fr.svg", "/demo/back-fr.svg"],
    verdict: "es_multi",
    evidence:
      "La caja está en francés, pero la lista de idiomas de la contraportada incluye 'ES': el disco se puede jugar en español.",
  },
  {
    id: "demo-uk-1",
    title: "Pokemon Emerald Game Boy Advance UK",
    price: 16.5,
    shipping: 4.0,
    country: "GB",
    photos: ["/demo/front-uk.svg", "/demo/back-uk.svg"],
    verdict: "other",
    evidence:
      "La contraportada está solo en inglés (PAL UK), sin rastro de español.",
  },
  {
    id: "demo-es-3",
    title: "Pokémon Esmeralda - reproducción caja + juego original español",
    price: 22.9,
    shipping: null,
    country: "ES",
    photos: ["/demo/front-es.svg", "/demo/back-es.svg"],
    verdict: "es",
    evidence:
      "La sinopsis de la contraportada está redactada en español y cita la región de Hoenn.",
  },
  {
    id: "demo-de-1",
    title: "Pokémon Smaragd Edition GBA Deutsch",
    price: 19.99,
    shipping: 3.0,
    country: "DE",
    photos: ["/demo/front-de.svg", "/demo/back-de.svg"],
    verdict: "other",
    evidence: "La contraportada está en alemán (PAL Deutschland).",
  },
  {
    id: "demo-inc-2",
    title: "Pokemon Esmeralda GBA - fotos algo borrosas",
    price: 21.0,
    shipping: 2.5,
    country: "ES",
    photos: ["/demo/front-neutral.svg", "/demo/back-blurry.svg"],
    verdict: "inconclusive",
    evidence:
      "La contraportada aparece borrosa y no permite leer la lista de idiomas.",
  },
  {
    id: "demo-es-4",
    title: "Pokémon Esmeralda Advance CIB - PAL ESP impecable",
    price: 25.0,
    shipping: 4.5,
    country: "ES",
    photos: ["/demo/front-es.svg", "/demo/back-es.svg"],
    verdict: "es",
    evidence:
      "Se lee 'Totalmente en castellano' en la contraportada junto al código AGB-BPEE-ES.",
  },
  {
    id: "demo-fr-2",
    title: "Pokemon Emeraude - complet en boite (FRA)",
    price: 27.0,
    shipping: 3.5,
    country: "FR",
    photos: ["/demo/front-fr.svg", "/demo/back-fr.svg"],
    verdict: "other",
    evidence:
      "La lista de idiomas de la contraportada es 'FR · EN · DE', sin español.",
  },
  {
    id: "demo-inc-3",
    title: "Pokémon Esmeralda - foto única de la portada",
    price: 29.0,
    shipping: null,
    country: "ES",
    photos: ["/demo/front-neutral.svg"],
    verdict: "inconclusive",
    evidence:
      "Solo se muestra la carátula frontal; sin la contraportada no se puede confirmar el español.",
  },
  {
    id: "demo-es-5",
    title: "Pokémon Esmeralda español - edición coleccionista con guía",
    price: 34.99,
    shipping: 5.0,
    country: "ES",
    photos: ["/demo/front-es.svg", "/demo/back-es.svg"],
    verdict: "es",
    evidence:
      "La contraportada española incluye clasificación PEGI con textos en castellano y sello PAL España.",
  },
];

/** Listings as returned by the search endpoint: all start as "pending". */
export function getDemoListings(query: string): Listing[] {
  return SEEDS.map((s) => ({
    source: "vinted" as const,
    vintedId: s.id,
    title: s.title,
    price: s.price,
    shippingPrice: s.shipping,
    currency: "EUR",
    photoUrls: s.photos,
    thumbUrl: s.photos[0] ?? null,
    listingUrl:
      "https://www.vinted.es/catalog?search_text=" +
      encodeURIComponent(query || "Pokémon Esmeralda"),
    sellerCountry: s.country,
    languageVerdict: "pending",
    verdictEvidence: null,
    analyzedAt: null,
  }));
}

/** Pre-baked verdicts the demo analyzer reveals progressively. */
export function getDemoVerdict(
  vintedId: string
): { verdict: Exclude<LanguageVerdict, "pending">; evidence: string } | null {
  const seed = SEEDS.find((s) => s.id === vintedId);
  if (!seed) return null;
  return { verdict: seed.verdict, evidence: seed.evidence };
}

export const DEMO_QUERY_LABEL = "Pokémon Esmeralda";
