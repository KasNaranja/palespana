import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // PAL España — bandera roja y gualda sobre neutro oscuro (tema carbón).
        brand: {
          50: "#fef2f3",
          100: "#fde0e3",
          200: "#fbc5cb",
          300: "#f79aa4",
          400: "#f0687a",
          500: "#e63946",
          600: "#d81e2f",
          700: "#b51826",
          800: "#921521",
          900: "#7a1620",
        },
        // Amarillo gualda de la bandera (acento secundario).
        gold: {
          400: "#f7d24a",
          500: "#f5c518",
          600: "#d9a90a",
        },
        // Neutros del tema oscuro (tokens de la guía).
        carbon: "#0e0e10",
        panel: "#161619",
        panel2: "#1c1c21",
        borde: "#26262b",
        "borde-fuerte": "#3a3a42",
        texto: {
          1: "#ececed",
          2: "#a9a9b0",
          3: "#77777e",
        },
        // Origen del anuncio (acento; se muestra con el logo real).
        src: {
          vinted: "#09b1ba",
          wallapop: "#13c1ac",
          ebay: "#e53238",
        },
        // Veredictos de idioma (3 estados) sobre fondo oscuro.
        verdict: {
          es: "#7ed0aa",
          esBg: "#16231c",
          esBorder: "#2f4a3a",
          esMulti: "#8ab4f8",
          esMultiBg: "#172033",
          esMultiBorder: "#2e415f",
          other: "#f19aa2",
          otherBg: "#2a181b",
          otherBorder: "#4a2830",
          inconc: "#e8c65a",
          inconcBg: "#262218",
          inconcBorder: "#4a4020",
          pending: "#a9a9b0",
          pendingBg: "#1c1c21",
          pendingBorder: "#2e2e35",
        },
      },
      fontFamily: {
        sans: ["var(--font-ui)", "system-ui", "-apple-system", "sans-serif"],
        display: ["var(--font-display)", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        badge: "8px",
        input: "14px",
        card: "16px",
      },
      keyframes: {
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        spinPulse: {
          "0%": { transform: "rotate(0deg)", opacity: "0.85" },
          "50%": { opacity: "1" },
          "100%": { transform: "rotate(360deg)", opacity: "0.85" },
        },
      },
      animation: {
        pulseSoft: "pulseSoft 1.4s ease-in-out infinite",
        spinPulse: "spinPulse 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
