// The business's areas for the Dashboard's best areas: leads, viewings, deals
// and commission by area, every channel (lib/areas.ts).
import { errorMessage } from "@/lib/coerce";
import { getBusinessAreas } from "@/lib/areas";
import { LIVE_MS, wantsLive } from "@/lib/live";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // above the 50 s leads query

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  try {
    const data = await getBusinessAreas(searchParams.get("from") || undefined, searchParams.get("to") || undefined, wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {});
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[api/areas] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
