// The SEO tab's Organic Growth Report: visitors and searches by default,
// `part=crm` for the CRM half (leads and what they led to), asked separately
// so a slow CRM never holds up the rest. `live=1` asks for an answer at most a
// minute old (lib/live.ts).
import { errorMessage } from "@/lib/coerce";
import { LIVE_MS, wantsLive } from "@/lib/live";
import { getGrowthCrmReport, getGrowthReport } from "@/lib/organicGrowth";

export const dynamic = "force-dynamic";
// PostHog answers three questions at a time (lib/posthog.ts): room for the queue to drain.
export const maxDuration = 300;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const live = wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {};
  try {
    const data = searchParams.get("part") === "crm" ? await getGrowthCrmReport(live) : await getGrowthReport(live);
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[api/seo/growth] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
