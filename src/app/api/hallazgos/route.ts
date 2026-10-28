// Dashboard read: the strip hunter's latest snapshot (see lib/hallazgos.ts).

import { viewSnapshot } from "@/lib/hallazgos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await viewSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
