// ─────────────────────────────────────────────────────────────
// POST /api/vinted-cookie — receives a fresh DataDome cookie value.
//
// Fed by a GitHub Action that runs Playwright against vinted.es every ~30 min
// and posts the "datadome" cookie a real browser earned. Before accepting a
// candidate we validate it FOR REAL against Vinted: homepage with the cookie
// must yield session tokens, and the catalog API must then answer 200 with
// items. Only then is the value stored (memory + best-effort file).
//
// This endpoint never reveals the stored value — it only receives candidates.
// A 10s global cooldown between validations keeps third parties from using us
// to hammer Vinted (the repo is public, so the URL is guessable).
// ─────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { DATADOME_VALUE_RE, setDatadomeCookie } from "@/lib/vintedCookie";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 10 * 1024;
const VALIDATION_COOLDOWN_MS = 10_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Cooldown timestamp on globalThis so all module graphs share it (db.ts pattern).
const globalForCooldown = globalThis as unknown as {
  __cazapalCookieValidatedAt?: number;
};

/** Pull the datadome value out of a "a=1; b=2" cookie-header-style string. */
function extractDatadome(cookies: string): string | null {
  for (const kv of cookies.split(";")) {
    const i = kv.indexOf("=");
    if (i <= 0) continue;
    if (kv.slice(0, i).trim() === "datadome") return kv.slice(i + 1).trim();
  }
  return null;
}

/** Merge a response's set-cookie headers into a name→value jar. */
function mergeSetCookiesInto(jar: Map<string, string>, headers: Headers): void {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  const raw =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie") as string]
        : [];
  for (const c of raw) {
    const first = c.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
}

export async function POST(req: Request) {
  // ── Parse + size-limit the body ──────────────────────────────
  // Reject oversized payloads BEFORE buffering the body. A missing or lying
  // Content-Length (e.g. chunked encoding) is still caught by the length
  // check after reading.
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }
  let body: { datadome?: unknown; cookies?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  let candidate: string | null = null;
  if (typeof body.datadome === "string") {
    candidate = body.datadome.trim();
  } else if (typeof body.cookies === "string") {
    candidate = extractDatadome(body.cookies);
  }
  if (!candidate || !DATADOME_VALUE_RE.test(candidate)) {
    return NextResponse.json(
      { ok: false, error: "invalid_format" },
      { status: 400 }
    );
  }

  // ── Global cooldown between validations ──────────────────────
  const now = Date.now();
  const lastAt = globalForCooldown.__cazapalCookieValidatedAt ?? 0;
  if (now - lastAt < VALIDATION_COOLDOWN_MS) {
    return NextResponse.json({ ok: false, error: "cooldown" }, { status: 429 });
  }
  globalForCooldown.__cazapalCookieValidatedAt = now;

  // ── Real validation against Vinted ───────────────────────────
  // 1) Homepage with the candidate datadome: a valid one makes Vinted hand out
  //    access_token_web/refresh_token_web via set-cookie (validated empirically).
  const base = `https://${config.vintedHost}`;
  const jar = new Map<string, string>();
  jar.set("datadome", candidate);
  try {
    const homeRes = await fetch(`${base}/`, {
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9",
        Cookie: `datadome=${candidate}`,
      },
      redirect: "follow",
    });
    // If the response rotates datadome, the rotated value overwrites the
    // candidate in the jar for the API probe (Vinted expects the fresh one).
    mergeSetCookiesInto(jar, homeRes.headers);

    // 2) Catalog API probe with the full jar: 200 + items ⇒ cookie works.
    const cookieHeader = Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const apiRes = await fetch(
      `${base}/api/v2/catalog/items?search_text=zelda&per_page=1&order=relevance`,
      {
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "es-ES,es;q=0.9",
          "X-Requested-With": "XMLHttpRequest",
          Cookie: cookieHeader,
          Referer: `${base}/`,
        },
      }
    );
    if (apiRes.ok) {
      const data = await apiRes.json().catch(() => null);
      const items = (data as { items?: unknown[] } | null)?.items;
      if (Array.isArray(items) && items.length > 0) {
        // Store the ORIGINAL candidate: it's what the harvester's browser
        // earned, and bootstrapSession will pick up any rotation on its own.
        setDatadomeCookie(candidate);
        return NextResponse.json({ ok: true });
      }
    }
    return NextResponse.json(
      { ok: false, status: apiRes.status },
      { status: 422 }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "vinted_unreachable" },
      { status: 502 }
    );
  }
}
