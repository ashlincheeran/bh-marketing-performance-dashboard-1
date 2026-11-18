import { NextResponse } from "next/server";
import { getCampaignLeads } from "@/lib/metabase";
import { LIVE_MS, wantsLive } from "@/lib/live";
import { paidRange } from "@/lib/paid";

export const dynamic = "force-dynamic";
// The CRM view is the slow half of the Digital tab (same view the SEO tab
// reads), so it gets the same generous ceiling and is fetched separately from
// the media numbers — a slow CRM must never delay the spend figures. It was 45,
// under the queries' own 60s timeout, so a slow query was killed by the
// platform and the tab got a 504 page instead of the JSON error it can show.
export const maxDuration = 90; // must exceed the 60s Metabase leads timeout

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const { from, to } = paidRange(
    searchParams.get("from") || undefined,
    searchParams.get("to") || undefined,
    Number(searchParams.get("days") || 30),
  );
  try {
    // live=1: an answer at most a minute old (lib/live.ts), asked of the CRM again when older.
    const data = await getCampaignLeads(from, to, wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {});
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[digital/crm] failed", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
