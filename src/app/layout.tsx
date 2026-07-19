import type { Metadata, Viewport } from "next";
import { Anton, Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Display (logotipo, precios, números grandes)
const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
// UI y texto
const archivo = Archivo({
  weight: ["400", "600", "700", "800", "900"],
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});
// Datos, meta, códigos de región
const plexMono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PAL España — copias en español en Vinted, Wallapop y eBay",
  description:
    "Busca un videojuego en Vinted, Wallapop y eBay; PAL España analiza las fotos con IA para mostrarte solo las copias en español, de más barata a más cara.",
};

export const viewport: Viewport = {
  themeColor: "#e63946",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="es"
      className={`${anton.variable} ${archivo.variable} ${plexMono.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
