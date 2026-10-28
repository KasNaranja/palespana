// The strip hunter on the owner's PC pushes its snapshot here (same token as
// the Vinted worker). Answers {watching} so it only keeps pushing while the
// dashboard is open.

import { receiveSnapshot } from "@/lib/hallazgos";
import type { HuntSnapshot } from "@/lib/types";
import { checkWorkerToken } from "@/lib/vintedWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!checkWorkerToken(req.headers.get("x-worker-token"))) {
    return new Response("unauthorized", { status: 401 });
  }
  let s: HuntSnapshot;
  try {
    s = (await req.json()) as HuntSnapshot;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!s || typeof s !== "object" || !s.counts || !Array.isArray(s.finds)) {
    return new Response("bad request", { status: 400 });
  }
  return Response.json(receiveSnapshot(s));
}
