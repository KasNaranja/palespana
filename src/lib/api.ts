// Client-side fetch helpers for the CazaPAL API.
import type {
  ApiError,
  ConsoleKey,
  SearchResponse,
  StatusResponse,
} from "./types";

export class CazaApiError extends Error {
  code: ApiError["code"];
  status: number;
  constructor(message: string, code: ApiError["code"], status: number) {
    super(message);
    this.name = "CazaApiError";
    this.code = code;
    this.status = status;
  }
}

async function asError(res: Response): Promise<CazaApiError> {
  let payload: Partial<ApiError> = {};
  try {
    payload = await res.json();
  } catch {
    /* ignore */
  }
  return new CazaApiError(
    payload.error || "Error de red.",
    (payload.code as ApiError["code"]) || "internal",
    res.status
  );
}

/** `supersedes`: id of the search this one replaces on screen, so the server
 *  stops spending analysis on it. */
export async function postSearch(
  query: string,
  consoleKey: ConsoleKey,
  supersedes?: string
): Promise<SearchResponse> {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, console: consoleKey, supersedes }),
  });
  if (!res.ok) throw await asError(res);
  return res.json();
}

export async function getStatus(searchId: string): Promise<StatusResponse> {
  const res = await fetch(`/api/search/${searchId}/status`, {
    cache: "no-store",
  });
  if (!res.ok) throw await asError(res);
  return res.json();
}
