"use client";

import { LanguageBadge } from "./LanguageBadge";
import { formatPrice } from "@/lib/format";
import { useFavorites } from "@/lib/useFavorites";
import {
  MARKET_LABELS,
  totalPrice,
  type Listing,
  type MarketSource,
} from "@/lib/types";

// Marketplace logos (served from /public/logo). Shown as a small icon on each
// card instead of the marketplace name. Sources without a logo file fall back to
// a text pill, so a new source works before its logo is added.
const SOURCE_LOGO: Partial<Record<MarketSource, string>> = {
  vinted: "/logo/vinted.png",
  wallapop: "/logo/wallapop.webp",
  ebay: "/logo/ebay.webp",
};

// Logos that are transparent inside (eBay's "ebay" wordmark in a ring) vanish on
// the dark card — give those a white plate + a little padding so they read.
const LOGO_PLATE: Partial<Record<MarketSource, string>> = {
  ebay: "bg-white p-0.5",
};

export function ListingCard({ listing }: { listing: Listing }) {
  const { isFavorite, toggle } = useFavorites();
  const fav = isFavorite(listing.source, listing.vintedId);
  const total = totalPrice(listing);
  // Prefer the light thumbnail for the card; fall back to the full photo.
  const photo = listing.thumbUrl ?? listing.photoUrls[0];

  function open() {
    window.open(listing.listingUrl, "_blank", "noopener,noreferrer");
  }

  function onFav(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    toggle(listing);
  }

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-card border border-borde bg-panel transition hover:-translate-y-0.5 hover:border-borde-fuerte focus:outline-none focus:ring-2 focus:ring-brand-500/60"
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-carbon">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={listing.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm text-texto-3">
            sin foto
          </div>
        )}

        {/* Source logo — top-left (guía §5) */}
        <div className="absolute left-1.5 top-1.5">
          {SOURCE_LOGO[listing.source] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={SOURCE_LOGO[listing.source]}
              alt={MARKET_LABELS[listing.source]}
              title={MARKET_LABELS[listing.source]}
              className={[
                "h-7 w-7 rounded-lg object-contain shadow-md ring-1 ring-black/20 sm:h-8 sm:w-8",
                LOGO_PLATE[listing.source] ?? "",
              ].join(" ")}
              loading="lazy"
            />
          ) : (
            <span
              title={MARKET_LABELS[listing.source]}
              className="inline-flex h-7 items-center rounded-lg bg-black/70 px-1.5 text-[11px] font-bold text-white shadow-md sm:h-8 sm:px-2 sm:text-xs"
            >
              {MARKET_LABELS[listing.source]}
            </span>
          )}
        </div>

        {/* Favorite (heart) — top-right. Vinted-style, but the brand red when
            saved: white outline → filled #e63946 heart on tap. */}
        <div className="absolute right-1.5 top-1.5">
          <button
            type="button"
            onClick={onFav}
            aria-pressed={fav}
            title={fav ? "Quitar de favoritos" : "Guardar en favoritos"}
            aria-label={fav ? "Quitar de favoritos" : "Guardar en favoritos"}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 shadow-sm backdrop-blur transition hover:bg-black/75 active:scale-90"
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              aria-hidden
              fill={fav ? "currentColor" : "none"}
              className={[
                "transition-transform duration-150",
                fav ? "scale-110 text-brand-500" : "text-white",
              ].join(" ")}
            >
              <path
                d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* AI seals — bottom-left (guía §5): factory-seal badge (gualda, always
            shown when detected, filter or not) stacked over the language badge. */}
        <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-col items-start gap-1">
          {listing.sealed === "yes" && (
            // Filled gualda pill + padlock (NOT the dot-pill anatomy of the
            // language badges, so it can't be confused with the amber
            // "No concluyente" verdict): a physical-state tag, not a verdict.
            <span
              title="Copia nueva con el precinto de fábrica intacto"
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-transparent bg-gold-500 px-1.5 py-0.5 text-[11px] font-bold text-carbon shadow-sm sm:gap-1.5 sm:px-2.5 sm:py-1 sm:text-xs"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
                className="shrink-0"
              >
                <rect
                  x="4"
                  y="10.5"
                  width="16"
                  height="10.5"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="2.5"
                />
                <path
                  d="M8 10.5V7a4 4 0 0 1 8 0v3.5"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
              <span className="truncate">Precintado</span>
            </span>
          )}
          <LanguageBadge
            verdict={listing.languageVerdict}
            evidence={listing.verdictEvidence}
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-2 sm:gap-2 sm:p-3">
        <h3 className="clamp-2 text-xs font-bold leading-snug text-texto-1 sm:text-sm">
          {listing.title}
        </h3>

        <div className="mt-auto flex items-end justify-between gap-1">
          <div className="font-display text-xl leading-none text-white sm:text-2xl">
            {formatPrice(total, listing.currency)}
          </div>
          {/* Spain flag ONLY on Spanish editions (PAL España); nothing on
              playable-in-Spanish / other-language copies. */}
          {listing.languageVerdict === "es" && (
            <span
              className="shrink-0 text-base sm:text-xl"
              title="Edición española (PAL España)"
              aria-label="Edición española"
            >
              🇪🇸
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
