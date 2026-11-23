// The range's own organic and AI lead counts, for the Website tab's pop-up
// card, which reads `current.popupTagged` and `current.error`. A separate
// endpoint from the page render so the slow, unindexed CRM view can't stall
// the fast PostHog figures. (The SEO tab's own CRM figures are at
// /api/seo/growth?part=crm.)
import { getSeoLeadsCurrent } from "@/lib/seoReport";
import { LIVE_MS, wantsLive } from "@/lib/live";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // must exceed the 60s Metabase leads timeout

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (k: string) => searchParams.get(k);
  const range = { preset: q("preset"), from: q("from"), to: q("to"), month: q("month") };
  try {
    // live=1: an answer at most a minute old (lib/live.ts), asked of the CRM again when older.
    return Response.json(await getSeoLeadsCurrent(range, wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {}));
  } catch (e) {
    console.error(`[api/seo/leads] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
