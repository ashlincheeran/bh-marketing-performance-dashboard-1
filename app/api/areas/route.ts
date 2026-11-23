// The business's areas for the Dashboard's best areas: leads, viewings, deals,
// commission and listings by area, split into sales and leasing, every channel
// (lib/areas.ts).
import { errorMessage } from "@/lib/coerce";
import { getBusinessAreas } from "@/lib/areas";
import { LIVE_MS, wantsLive } from "@/lib/live";

export const dynamic = "force-dynamic";
// A cold year to date counts its leads a month at a time, three at once (about 20 s each beside
// the other queries), well past 90 s; each month is kept as it lands, but at 90 s a cold start ran
// out twice in a row (23 Nov 2026). The SEO and Website routes have the same 300 s.
export const maxDuration = 300;

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
