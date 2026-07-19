// Client-safe formatting helpers. No server imports here.
import type { LanguageVerdict } from "./types";

export function formatPrice(amount: number, currency = "EUR"): string {
  try {
    return new Intl.NumberFormat("es-ES", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** ISO-2 country code → flag emoji (e.g. "ES" → 🇪🇸). */
export function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return "🏳️";
  const base = 0x1f1e6;
  const cc = code.toUpperCase();
  return String.fromCodePoint(
    base + (cc.charCodeAt(0) - 65),
    base + (cc.charCodeAt(1) - 65)
  );
}

export function countryName(code: string | null): string {
  if (!code) return "País desconocido";
  try {
    const dn = new Intl.DisplayNames(["es"], { type: "region" });
    return dn.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

export interface VerdictMeta {
  label: string;
  short: string;
  className: string; // badge bg/text classes
  dotClassName: string;
}

export function verdictMeta(v: LanguageVerdict): VerdictMeta {
  switch (v) {
    case "es":
      return {
        label: "✓ Edición española",
        short: "Edición española",
        className: "bg-verdict-esBg text-verdict-es border-verdict-esBorder",
        dotClassName: "bg-verdict-es",
      };
    case "es_multi":
      return {
        label: "✓ Jugable en español",
        short: "Jugable en español",
        className:
          "bg-verdict-esMultiBg text-verdict-esMulti border-verdict-esMultiBorder",
        dotClassName: "bg-verdict-esMulti",
      };
    case "other":
      return {
        label: "✗ Otro idioma",
        short: "Otro idioma",
        className:
          "bg-verdict-otherBg text-verdict-other border-verdict-otherBorder",
        dotClassName: "bg-verdict-other",
      };
    case "inconclusive":
      return {
        label: "? No concluyente",
        short: "No concluyente",
        className:
          "bg-verdict-inconcBg text-verdict-inconc border-verdict-inconcBorder",
        dotClassName: "bg-verdict-inconc",
      };
    default:
      return {
        label: "Analizando…",
        short: "Analizando…",
        className:
          "bg-verdict-pendingBg text-verdict-pending border-verdict-pendingBorder",
        dotClassName: "bg-verdict-pending",
      };
  }
}
