// The PC's poll for the next Vinted page to fetch (see lib/vintedWorker.ts).
// Long poll: answers with a job as soon as one is queued, or 204 after ~25 s.

import { checkWorkerToken, takeJob } from "@/lib/vintedWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkWorkerToken(req.headers.get("x-worker-token"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const job = await takeJob(25_000);
  if (!job) return new Response(null, { status: 204 });
  return Response.json(job);
}
