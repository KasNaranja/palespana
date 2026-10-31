import { NextResponse } from "next/server";
import { countAnalyzed, getListingsSince, getSearch, touchSearch } from "@/lib/db";
import { startAnalysis } from "@/lib/analyzer";
import { MARKET_SOURCES, publicListing } from "@/lib/types";
import type {
  ApiError,
  MarketSource,
  SourceProgress,
  StatusResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const search = getSearch(params.id);
  if (!search) {
    return NextResponse.json<ApiError>(
      { error: "Búsqueda no encontrada.", code: "not_found" },
      { status: 404 }
    );
  }

  // Someone is watching this search: keeps its analysis running (and resumes
  // it if it had been paused as abandoned — see the self-heal below).
  touchSearch(params.id);

  // ?since=<rev> → only the listings that changed after that poll: sending
  // the whole list every 1.5 s burned Render's monthly bandwidth.
  const sinceRaw = new URL(req.url).searchParams.get("since");
  const since = sinceRaw === null ? -1 : Number(sinceRaw) || 0;
  const { listings: raw, rev } = getListingsSince(params.id, since);
  const listings = raw.map(publicListing);
  const analyzed = countAnalyzed(params.id);
  const done = analyzed >= search.total;

  // Self-heal: if the server restarted mid-analysis (background task lost),
  // re-kick it. Idempotent while already running.
  if (!done) {
    void startAnalysis(params.id);
  }

  const sources = MARKET_SOURCES.reduce(
    (acc, src) => {
      acc[src] = {
        total: search.sources[src].total,
        analyzed: countAnalyzed(params.id, src),
        error: search.sources[src].error,
      };
      return acc;
    },
    {} as Record<MarketSource, SourceProgress>
  );

  const res: StatusResponse = {
    search,
    listings,
    rev,
    partial: since >= 0,
    analyzed,
    total: search.total,
    done,
    sources,
  };
  return NextResponse.json(res, { status: 200 });
}
