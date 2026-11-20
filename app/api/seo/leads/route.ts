// Metabase leads for the SEO tab — a SEPARATE endpoint from the page render so
// the slow, unindexed CRM view can't stall the fast PostHog/GSC queries.
//
// Returns the selected range AND the period it is compared with, because every
// figure on that tab is shown against its comparison, and fetching that
// separately would mean two round trips to the same slow view.
//
// `lite=1` returns `{ current }` alone — the range's own counts, for the
// Website tab's pop-up card, which reads `current.popupTagged` and `current.error`.
import { getSeoLeadsCurrent, getSeoReportLeads } from "@/lib/seoReport";
import { LIVE_MS, wantsLive } from "@/lib/live";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // must exceed the 60s Metabase leads timeout

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (k: string) => searchParams.get(k);
  const range = { preset: q("preset"), from: q("from"), to: q("to"), month: q("month") };
  try {
    // live=1: an answer at most a minute old (lib/live.ts), asked of the CRM again when older.
    const live = wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {};
    if (q("lite") === "1") return Response.json(await getSeoLeadsCurrent(range, live));
    return Response.json(await getSeoReportLeads({ ...range, prevFrom: q("prevFrom"), prevTo: q("prevTo") }, live));
  } catch (e) {
    console.error(`[api/seo/leads] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
