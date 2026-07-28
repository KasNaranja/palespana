import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Diagnostic probe: makes ONE tiny text-only Gemini call per (few) keys with a
// given model, FROM THIS SERVER (what matters — Google geo-blocks by request
// origin, so testing from a laptop proves nothing about production). Never
// exposes key values; returns per-key HTTP status + a short error snippet.
// Guarded by a global cooldown so it can't be used to burn quota.

const globalForProbe = globalThis as unknown as { __cazapalProbeAt?: number };

export async function GET(req: Request) {
  const now = Date.now();
  if (now - (globalForProbe.__cazapalProbeAt ?? 0) < 30_000) {
    return NextResponse.json({ error: "cooldown" }, { status: 429 });
  }
  globalForProbe.__cazapalProbeAt = now;

  const url = new URL(req.url);
  const model = url.searchParams.get("model")?.trim() || config.geminiModel;
  // Sanity: model ids are short slugs; refuse anything else.
  if (!/^[a-z0-9.-]{3,60}$/.test(model)) {
    return NextResponse.json({ error: "bad_model" }, { status: 400 });
  }

  const maxKeys = Math.min(config.geminiKeys.length, 3);
  const results: { key: number; status: number; detail?: string }[] = [];
  for (let i = 0; i < maxKeys; i++) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": config.geminiKeys[i],
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "di hola" }] }],
            generationConfig: { maxOutputTokens: 10 },
          }),
        }
      );
      if (r.ok) {
        results.push({ key: i, status: r.status });
      } else {
        const detail = (await r.text().catch(() => "")).slice(0, 160);
        results.push({ key: i, status: r.status, detail });
      }
    } catch (e) {
      results.push({ key: i, status: 0, detail: (e as Error).message });
    }
  }
  return NextResponse.json({ model, results });
}
