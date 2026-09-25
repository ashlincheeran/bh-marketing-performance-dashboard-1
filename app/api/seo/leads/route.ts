// Metabase leads for the SEO tab — a SEPARATE endpoint from the page render so
// the slow, unindexed CRM view can't stall the fast PostHog/GSC queries.
//
// Returns the selected range AND the period it is compared with, because every
// figure on that tab is shown against its comparison, and fetching that
// separately would mean two round trips to the same slow view.
import { getSeoReportLeads } from "@/lib/seoReport";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // must exceed the 60s Metabase leads timeout

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (k: string) => searchParams.get(k);
  try {
    return Response.json(
      await getSeoReportLeads({
        preset: q("preset"), from: q("from"), to: q("to"), month: q("month"),
        prevFrom: q("prevFrom"), prevTo: q("prevTo"),
      }),
    );
  } catch (e) {
    console.error(`[api/seo/leads] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
