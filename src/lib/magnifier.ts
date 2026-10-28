// ─────────────────────────────────────────────────────────────
// The "magnifier": photo 1 (almost always the front cover) cut into its four
// quarters, sent after the photos in the same request. The tear strip of a
// sealed PS4/PS5 copy is a row of tiny repeated "PS4"/"PlayStation" letters
// that the model can't read in a whole-cover phone photo; in a quarter it can,
// and it also sees the shrink-wrap folds at the corners. Measured on 24 real
// Dragon Ball Xenoverse listings: factory wrap seen on 7/7 sealed copies
// (3/7 without), never on the 17 used or doubtful ones.
//
// It rides in the SAME Gemini call (the free tier counts calls, not images).
// Crops only, no upscaling, decoding the photo once: ~15-20 ms of CPU per
// listing instead of ~180 ms, which matters on Render's 0.1-CPU instance.
// Optional by design: if sharp can't load or the photo can't be decoded, the
// analysis simply goes without the magnifier.
// ─────────────────────────────────────────────────────────────

import type { ImagePart } from "./visionPrompt";

type Sharp = (typeof import("sharp"))["default"];

let sharpP: Promise<Sharp | null> | null = null;

function loadSharp(): Promise<Sharp | null> {
  sharpP ??= import("sharp")
    .then((m) => {
      // The constructor (with the static cache/concurrency) is the ESM
      // default; a CommonJS interop may hand it over as the module itself.
      const sharp = m.default ?? (m as unknown as Sharp);
      // One libvips thread and no operation cache: the instance has a tenth
      // of a CPU and 512MB, and each photo is cut exactly once.
      sharp.concurrency(1);
      sharp.cache(false);
      return sharp;
    })
    .catch(() => null);
  return sharpP;
}

const QUARTERS = [
  ["arriba-izquierda", 0, 0],
  ["arriba-derecha", 1, 0],
  ["abajo-izquierda", 0, 1],
  ["abajo-derecha", 1, 1],
] as const;

// Below this a quarter carries no detail the whole photo doesn't.
const MIN_QUARTER_PX = 160;

/** Photo 1's four quarters as JPEGs, or [] when they can't be made. */
export async function magnifierTiles(
  photo: ImagePart
): Promise<{ name: string; part: ImagePart }[]> {
  const sharp = await loadSharp();
  if (!sharp) return [];
  try {
    // rotate() applies the EXIF orientation, so the quarters are upright
    // like the photo the model sees.
    const { data, info } = await sharp(Buffer.from(photo.data, "base64"))
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const w = Math.floor(info.width / 2);
    const h = Math.floor(info.height / 2);
    if (w < MIN_QUARTER_PX || h < MIN_QUARTER_PX) return [];
    const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
    return await Promise.all(
      QUARTERS.map(async ([name, col, row]) => {
        const jpeg = await sharp(data, raw)
          .extract({ left: col * w, top: row * h, width: w, height: h })
          .jpeg({ quality: 85 })
          .toBuffer();
        return { name, part: { mimeType: "image/jpeg", data: jpeg.toString("base64") } };
      })
    );
  } catch {
    return [];
  }
}
