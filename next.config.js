/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // "standalone" produces a self-contained bundle Electron launches as a child
  // process. A normal server (Render, `next start`) must NOT use standalone, so
  // it's opt-in via NEXT_OUTPUT_STANDALONE=true (set only for Electron builds).
  output:
    process.env.NEXT_OUTPUT_STANDALONE === "true" ? "standalone" : undefined,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.vinted.net" },
      { protocol: "https", hostname: "*.vinted.com" },
      { protocol: "https", hostname: "*.wallapop.com" },
    ],
  },
  // Don't let the browser serve a stale HTML shell (Next defaults static pages to
  // s-maxage + stale-while-revalidate, which made new deploys show "one step
  // behind"). Revalidate the page every load so changes appear immediately. The
  // hashed /_next/static assets keep their long immutable cache.
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
