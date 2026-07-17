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
// card instead of the marketplace name — the V and the flower are recognizable
// at a glance and don't clash with the language badges.
const SOURCE_LOGO: Record<MarketSource, string> = {
  vinted: "/logo/vinted.png",
  wallapop: "/logo/wallapop.webp",
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
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-brand-100"
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-stone-100">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={listing.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-stone-300">
            sin foto
          </div>
        )}

        <div className="absolute left-2 top-2">
          <LanguageBadge
            verdict={listing.languageVerdict}
            evidence={listing.verdictEvidence}
          />
        </div>

        <div className="absolute right-2 top-2">
          <button
            type="button"
            onClick={copyLink}
            title="Copiar enlace"
            aria-label="Copiar enlace del anuncio"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-stone-600 shadow-sm backdrop-blur transition hover:bg-white hover:text-brand-700"
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

        <div className="absolute bottom-2 left-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={SOURCE_LOGO[listing.source]}
            alt={MARKET_LABELS[listing.source]}
            title={MARKET_LABELS[listing.source]}
            className="h-8 w-8 rounded-lg shadow-md ring-1 ring-black/5"
            loading="lazy"
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="clamp-2 text-sm font-medium leading-snug text-stone-800">
          {listing.title}
        </h3>

        <div className="mt-auto flex items-end justify-between">
          <div>
            <div className="text-lg font-bold text-stone-900">
              {formatPrice(total, listing.currency)}
            </div>
            <div className="text-xs text-stone-500">
              {formatPrice(listing.price, listing.currency)}
              {listing.shippingPrice != null
                ? ` + ${formatPrice(listing.shippingPrice, listing.currency)} envío`
                : " · envío no indicado"}
            </div>
          </div>
          <span
            className="shrink-0 text-xl"
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
