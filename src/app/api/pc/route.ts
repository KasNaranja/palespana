// The ntfy topics the owner's PC listens on (Vinted worker, strip hunter).
// The BROWSER posts the wake-ups: Render's shared datacenter IP keeps hitting
// ntfy.sh's anonymous daily quota (429), a visitor's own connection doesn't.
// The names derive one-way from the token; knowing them only lets someone
// wake the PC or pause/resume the hunter.

import { config } from "@/lib/config";
import { huntTopic } from "@/lib/hallazgos";
import { wakeTopic } from "@/lib/vintedWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = config.vintedWorker.token;
  return Response.json(
    token ? { wake: wakeTopic(token), hunt: huntTopic(token) } : null,
    { headers: { "Cache-Control": "no-store" } }
  );
}
