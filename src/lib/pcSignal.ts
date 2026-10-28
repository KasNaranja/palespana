// Client-side: send a one-word signal to the owner's PC through ntfy.sh
// (see /api/pc for why the browser, not the server, sends it).

let topicsP: Promise<{ wake: string; hunt: string } | null> | null = null;

function topics() {
  topicsP ??= fetch("/api/pc", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return topicsP;
}

/** Fire-and-forget: "wake" the Vinted worker, or "report" / "play" / "pause"
 *  for the strip hunter. Never throws. */
export async function signalPc(target: "wake" | "hunt", message: string): Promise<void> {
  try {
    const t = await topics();
    if (!t) return;
    await fetch(`https://ntfy.sh/${t[target]}`, { method: "POST", body: message });
  } catch {
    /* best effort */
  }
}
