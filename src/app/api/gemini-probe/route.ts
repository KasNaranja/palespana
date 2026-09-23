import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

// Diagnostic probe: makes ONE tiny text-only Gemini call per (few) keys with a
// given model, FROM THIS SERVER (what matters — Google geo-blocks by request
// origin, so testing from a laptop proves nothing about production). Never
// exposes key values; returns per-key HTTP status + a short error snippet.
//
// NOT public: each hit spends real Gemini quota (through the relay in
// production) and the error snippet can include Google project numbers, so the
// x-probe-secret header must match PROBE_SECRET (set in the Render dashboard).
// While PROBE_SECRET is unset the probe always answers 401 (closed by
// default). The in-memory cooldown is only a second line of defense.

const globalForProbe = globalThis as unknown as { __cazapalProbeAt?: number };

/** Constant-time comparison of x-probe-secret against PROBE_SECRET. */
function probeAuthorized(req: Request): boolean {
  const secret = config.probeSecret;
  if (!secret) return false;
  const a = Buffer.from(req.headers.get("x-probe-secret") ?? "");
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  // Auth BEFORE the cooldown, so strangers can neither burn quota nor reset
  // the cooldown window under the owner's feet.
  if (!probeAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
  // Same base + relay header as vision.ts: the probe must measure the SAME
  // path the app actually uses (relay in production, direct Google locally).
  const base =
    config.geminiProxyUrl.replace(/\/+$/, "") ||
    "https://generativelanguage.googleapis.com";
  for (let i = 0; i < maxKeys; i++) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiKeys[i],
    };
    if (config.geminiProxyUrl) headers["x-relay-token"] = config.relayToken;
    try {
      const r = await fetch(
        `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers,
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
