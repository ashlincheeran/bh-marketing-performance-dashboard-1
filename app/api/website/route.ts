// The Website tab for a period: visits by default, `part=crm` for the CRM half
// (enquiries and what they led to), asked separately so a slow CRM never holds
// up the rest, and `path=/en/buy&days=30` for one page's look-up. `live=1` asks
// for an answer at most a minute old (lib/live.ts).
import { errorMessage } from "@/lib/coerce";
import { LIVE_MS, wantsLive } from "@/lib/live";
import { LOOKUP_DAYS, lookupPath } from "@/lib/website";
import { getPageLookup, getWebsiteCrmReport, getWebsiteReport } from "@/lib/websiteGrowth";

export const dynamic = "force-dynamic";
// PostHog answers three questions at a time (lib/posthog.ts): room for the queue to drain.
export const maxDuration = 300;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const live = wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {};
  // preset=last6, or from=2026-05&to=2026-10 (lib/growthPeriod.ts); none is the last 3 months.
  const q = { preset: searchParams.get("preset"), from: searchParams.get("from"), to: searchParams.get("to") };
  try {
    if (searchParams.has("path")) {
      const path = lookupPath(searchParams.get("path"));
      const days = Number(searchParams.get("days"));
      if (path == null) return Response.json({ error: "Enter a bhomes.com link or a path such as /en/buy." }, { status: 400 });
      if (!(LOOKUP_DAYS as readonly number[]).includes(days)) return Response.json({ error: `days must be one of ${LOOKUP_DAYS.join(", ")}` }, { status: 400 });
      return Response.json(await getPageLookup(path, days), { headers: { "cache-control": "no-store" } });
    }
    const data = searchParams.get("part") === "crm" ? await getWebsiteCrmReport(q, live) : await getWebsiteReport(q, live);
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[api/website] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
