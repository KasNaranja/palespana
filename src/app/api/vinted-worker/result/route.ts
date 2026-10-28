// The PC hands back a fetched Vinted page (see lib/vintedWorker.ts).
// Body: {id, status, body} — status 0 means the PC couldn't reach Vinted.

import { checkWorkerToken, completeJob } from "@/lib/vintedWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!checkWorkerToken(req.headers.get("x-worker-token"))) {
    return new Response("unauthorized", { status: 401 });
  }
  let data: { id?: unknown; status?: unknown; body?: unknown };
  try {
    data = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (typeof data.id !== "string" || typeof data.status !== "number" || typeof data.body !== "string") {
    return new Response("bad request", { status: 400 });
  }
  const known = completeJob(data.id, data.status, data.body);
  return new Response(null, { status: known ? 204 : 410 });
}
