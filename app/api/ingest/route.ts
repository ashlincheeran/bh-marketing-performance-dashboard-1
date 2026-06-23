// News ingestion endpoint (manual / on-demand — no daily cron).
// - "Run now" button → server action → runIngest('manual')
// - Direct call: GET /api/ingest?secret=$CRON_SECRET (or Bearer header)
import { NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Apify body extraction can take a while (Pro plan)

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  const isManual = !!secret && new URL(req.url).searchParams.get("secret") === secret;
  if (!isCron && !isManual) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runIngest(isCron ? "cron" : "manual");
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
