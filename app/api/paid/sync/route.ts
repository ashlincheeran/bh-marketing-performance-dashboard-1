// Warms the paid-media cache on a schedule, so the first person to open the
// dashboard each day reads from Supabase instead of waiting on Supermetrics —
// and so the API cost is paid once, by the cron, rather than by whoever happens
// to look first.
//
// Auth mirrors /api/ingest: Vercel's cron sends
// "Authorization: Bearer $CRON_SECRET". proxy.ts exempts this path for the same
// reason it exempts /api/ingest — the scheduler carries no cookies.
import { NextResponse } from "next/server";
import { getPaidData } from "@/lib/paid";

export const dynamic = "force-dynamic";
// Syncing several accounts over a restatement window is the slowest thing the
// app does. Days are banked as each block lands, so a timeout loses progress
// from the current block only and the next run resumes at the gap.
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  const isManual = !!secret && new URL(req.url).searchParams.get("secret") === secret;
  if (!isCron && !isManual) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Campaign level only. The tab can ask for adset/ad, but those are a separate
  // cache grain and warming all three would triple the nightly cost for data
  // most days nobody opens.
  const days = Math.max(1, Number(new URL(req.url).searchParams.get("days") || 90));
  try {
    const data = await getPaidData(undefined, undefined, days, "campaign");
    return NextResponse.json({
      ok: true,
      trigger: isCron ? "cron" : "manual",
      range: `${data.from} → ${data.to}`,
      fetchedDays: data.fetchedDays ?? 0,
      accountsUsed: data.accountsUsed.length,
      failures: data.failures.map((f) => ({ account: f.accountName, reason: f.reason })),
      paused: !!data.paused,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[paid/sync] ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
