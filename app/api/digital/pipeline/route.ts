import { NextResponse } from "next/server";
import { getDigitalPipeline } from "@/lib/digitalPipeline";
import { LIVE_MS, wantsLive } from "@/lib/live";
import { paidRange } from "@/lib/paid";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // above the query's 60 s Metabase timeout

/**
 * The Digital tab's pipeline scorecard (lib/digitalPipeline.ts). POST, because
 * the tab sends the names of its ad campaigns, too many for a URL. Only the CRM
 * is asked: the names come from the ad data the tab already has.
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const body = (await req.json().catch(() => null)) as { from?: unknown; to?: unknown; campaigns?: unknown } | null;
  if (!body || !Array.isArray(body.campaigns)) return NextResponse.json({ error: "campaigns missing" }, { status: 400 });
  const campaigns = body.campaigns.filter((c): c is string => typeof c === "string" && c.length > 0 && c.length <= 500).slice(0, 3000);
  const { from, to } = paidRange(typeof body.from === "string" ? body.from : undefined, typeof body.to === "string" ? body.to : undefined);
  try {
    // live=1: an answer at most a minute old (lib/live.ts), asked of the CRM again when older.
    const data = await getDigitalPipeline(from, to, campaigns, wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {});
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[digital/pipeline] failed", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
