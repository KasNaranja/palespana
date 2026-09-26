import { NextResponse } from "next/server";
import { countAnalyzed, getListings, getSearch, touchSearch } from "@/lib/db";
import { startAnalysis } from "@/lib/analyzer";
import { MARKET_SOURCES } from "@/lib/types";
import type {
  ApiError,
  MarketSource,
  SourceProgress,
  StatusResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
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

  const listings = getListings(params.id);
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
    analyzed,
    total: search.total,
    done,
    sources,
  };
  return NextResponse.json(res, { status: 200 });
}
