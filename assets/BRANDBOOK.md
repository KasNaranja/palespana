# PAL España — Guía de diseño para desarrollo

> Documento de referencia para implementar la UI. Pensado para lectura por humanos y por Claude Code.
> Producto: **buscador/agregador** (NO marketplace). Rastrea Vinted, Wallapop y eBay, usa IA para detectar copias en **castellano (PAL/ES)** y las ordena de más barata a más cara.
>
> Ajustado el 2026-07-19 a las decisiones de producto vigentes: **se usan los logos reales de cada marketplace**, **tres estados de idioma** (no dos) y **sin porcentaje de confianza**.

---

## 1. Assets (carpeta `brand/` en el repo)

| Archivo | Uso | Formato |
|---|---|---|
| `palespana-logo.png` | Logo principal (header/home). Mirilla + `PAL ES PA ÑA` | PNG 3x, fondo transparente |
| `cazapalespana-logo.png` | Variante con `CAZA` delante | PNG 3x, transparente |
| `caza-logo.png` | Botón/sección "Caza" (buscador) — footer | PNG 3x, transparente |
| `precios-logo.png` | Botón/sección "Precios" — footer | PNG 3x, transparente |
| `mirilla-mark.svg` | Icono/marca sola. Favicon, app icon, spinner de carga | SVG vectorial |

Reglas del logotipo:
- Texto blanco (`#F5F5F5`) sobre fondo oscuro; sobre fondo claro usar negro `#111` y amarillo oscurecido `#D4A017`.
- `ES`/`ÑA` en rojo, `PA` en gualda (guiño a la bandera sin usar la bandera literal).
- No estirar, no rotar, no cambiar los colores del split.

---

## 2. Color (tokens)

| Token | Hex | Uso |
|---|---|---|
| `--rojo` | `#E63946` | Marca, chip activo, CTA principal |
| `--gualda` | `#F5C518` | Acento, CTA secundario |
| `--gualda-dark` | `#D4A017` | Amarillo sobre fondo claro |
| `--blanco` | `#F5F5F5` | Texto principal / logo |
| `--carbon` | `#0E0E10` | Fondo base |
| `--panel` | `#161619` | Tarjetas y paneles |
| `--borde` | `#26262B` | Bordes sutiles |
| `--borde-fuerte` | `#3A3A42` | Bordes de inputs/chips inactivos |
| `--texto-1` | `#ECECED` | Texto principal |
| `--texto-2` | `#A9A9B0` | Texto secundario |
| `--texto-3` | `#77777E` | Texto terciario / captions |

**Estados de idioma (3 estados, ver §5):**

| Estado | Texto | Fondo | Borde |
|---|---|---|---|
| 🟢 Edición española (`es`) | `#7ED0AA` | `#16231C` | `#2F4A3A` |
| 🔵 Jugable en español (`es_multi`) | `#8AB4F8` | `#172033` | `#2E415F` |
| 🔴 Otro idioma (`other`) | `#F19AA2` | `#2A181B` | `#4A2830` |
| 🟡 No concluyente (`inconclusive`) | `#E8C65A` | `#262218` | `#4A4020` |
| ⚪ Analizando (`pending`) | `#A9A9B0` | `#1C1C21` | `#2E2E35` |

Colores de fuente (acento/fallback, **el origen se muestra con el LOGO real**, ver §5):
`Vinted #09B1BA` · `Wallapop #13C1AC` · `eBay #E53238`.

---

## 3. Tipografía

- **Anton** — display, logotipo, precios, números grandes. (`font-family:'Anton',sans-serif`)
- **Archivo** — UI y texto. Pesos 400/600/700/800/900.
- **IBM Plex Mono** — datos, códigos de región (PAL/ES), IDs, meta de la tarjeta.

Cargadas con `next/font/google` (auto-hospedadas en build, sin petición externa en runtime).

---

## 4. Sistema

- Radios: inputs/chips `14px`, tarjetas `16px`, badges `8px`, pills `999px`.
- Altura: inputs y CTA `48–52px`; chips `34px`; controles táctiles mínimo `44px`.
- Espaciado base múltiplos de 4; gaps de 12–20px.
- Fondo carbón, paneles un tono por encima, borde 1px.

---

## 5. Componentes

### Buscador
Input 52px, fondo `--carbon`, borde `--borde-fuerte`, radio 14px, icono `⌕` + placeholder. Botón "Buscar" rojo sólido a la derecha. Control de orden con estado visible (`Precio total ↑` / `Precio artículo ↑`).

### Chip de plataforma
Activo: fondo `--rojo`, texto blanco, sin borde.
Inactivo: fondo `--carbon`, borde 1.5px `--borde-fuerte`, texto `--texto-2`.
Set: Todas · PS1 · PS2 · PS3 · PS4 · PS5 · Switch · Game Boy/DS · Xbox · Otras.
En móvil: una sola fila con scroll horizontal (como la app de Vinted).

### Etiqueta de fuente (origen del anuncio)
**Se usa el LOGO real del marketplace** como icono pequeño (28–32px, esquina de la tarjeta): Vinted / Wallapop / eBay, servidos desde `/public/logo/`. Si una fuente aún no tiene logo, fallback a una pastilla de texto con el nombre sobre fondo oscuro. Los colores `--src-*` quedan solo como acento de referencia; **no** sustituyen al logo.

### Sello de IA (mejora clave) — 3 estados, sin porcentaje
El veredicto se acompaña de una **frase de evidencia** (ej. "contraportada en español"), no de un número — transparencia sin prometer una cifra de certeza.

- 🟢 **Edición española** (`es`) — `✓ Edición española` — fondo `#16231C`, texto `#7ED0AA`, borde verde. La carátula/contraportada está en español (PAL España).
- 🔵 **Jugable en español** (`es_multi`) — `✓ Jugable en español` — fondo `#172033`, texto `#8AB4F8`, borde azul. Caja en otro idioma pero el disco es multi-idioma e incluye ES.
- 🔴 **Otro idioma** (`other`) — `✗ Otro idioma` — fondo `#2A181B`, texto `#F19AA2`, borde rojo.
- 🟡 **No concluyente** (`inconclusive`) / ⚪ **Analizando** (`pending`) — gualda/gris neutro.

Al tocar el sello se muestra la frase de evidencia de la IA.

### Tarjeta de resultado
Foto (anuncio externo) + **logo de la fuente arriba-izq** + **sello de IA abajo-izq**. Cuerpo: título (Archivo 700), meta mono (`PS4 · PAL/ES`), precio (Anton, grande) y toda la tarjeta **enlaza al anuncio original** (CTA implícito "Ver anuncio →"). Orden por defecto: más barata primero; agrupado 🟢 → 🔵 → resto.

### Estados
- Carga: mirilla (`mirilla-mark.svg`) con rotación/pulso.
- Vacío: mirilla + "No hay copias en castellano ahora mismo".

---

## 6. Voz

- Directo y útil: "solo copias en castellano, de barata a cara".
- Transparente con la IA: se muestra la **frase de evidencia** del veredicto, sin prometer certeza ni porcentajes.
- Somos buscador, no tienda: siempre enlazar al anuncio original.
- Precios siempre "orientativos / de mercado".

---

## 7. Meta

`theme-color: #E63946` · viewport responsive. Favicon = `mirilla-mark.svg` (`src/app/icon.svg`).
