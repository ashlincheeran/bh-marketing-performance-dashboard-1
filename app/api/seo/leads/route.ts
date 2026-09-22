// Metabase leads for the SEO tab — a SEPARATE endpoint from the page render so
// the slow, unindexed CRM view can't stall the fast PostHog/GSC queries.
//
// Returns the selected month AND the one before it, because every figure on
// that tab is shown month on month and fetching the comparison separately would
// mean two passes over the same slow view.
import { getSeoReportLeads } from "@/lib/seoReport";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // must exceed the 60s Metabase leads timeout

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || undefined;
  try {
    return Response.json(await getSeoReportLeads(month));
  } catch (e) {
    console.error(`[api/seo/leads] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
