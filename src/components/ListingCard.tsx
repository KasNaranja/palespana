"use client";

import { useState } from "react";
import { LanguageBadge } from "./LanguageBadge";
import { countryFlag, countryName, formatPrice } from "@/lib/format";
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

export function ListingCard({ listing }: { listing: Listing }) {
  const [copied, setCopied] = useState(false);
  const total = totalPrice(listing);
  // Prefer the light thumbnail for the card; fall back to the full photo.
  const photo = listing.thumbUrl ?? listing.photoUrls[0];

  function open() {
    window.open(listing.listingUrl, "_blank", "noopener,noreferrer");
  }

  async function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(listing.listingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; ignore */
    }
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
              className="h-7 w-7 rounded-lg shadow-md ring-1 ring-black/20 sm:h-8 sm:w-8"
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

        {/* Copy link — top-right */}
        <div className="absolute right-1.5 top-1.5">
          <button
            type="button"
            onClick={copyLink}
            title="Copiar enlace"
            aria-label="Copiar enlace del anuncio"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-texto-1 shadow-sm backdrop-blur transition hover:bg-black/75 hover:text-white"
          >
            {copied ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="m5 13 4 4L19 7"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect
                  x="9"
                  y="9"
                  width="11"
                  height="11"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M5 15V5a2 2 0 0 1 2-2h10"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>

        {/* AI seal (language verdict) — bottom-left (guía §5) */}
        <div className="absolute bottom-1.5 left-1.5 right-1.5">
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
          <div className="min-w-0">
            <div className="font-display text-xl leading-none text-white sm:text-2xl">
              {formatPrice(total, listing.currency)}
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-texto-3 sm:text-[11px]">
              {formatPrice(listing.price, listing.currency)}
              {listing.shippingPrice != null
                ? ` + ${formatPrice(listing.shippingPrice, listing.currency)} envío`
                : " · envío no indicado"}
            </div>
          </div>
          <span
            className="shrink-0 text-base sm:text-xl"
            title={countryName(listing.sellerCountry)}
            aria-label={countryName(listing.sellerCountry)}
          >
            {countryFlag(listing.sellerCountry)}
          </span>
        </div>
      </div>
    </div>
  );
}
