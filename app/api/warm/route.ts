// GET, a Vercel cron at 04:35 UTC (08:35 Dubai), after the news run and the ads
// sync: every tab's opening view worked out and remembered (lib/warm.ts), so
// the first look of the day opens at once. Needs "Authorization: Bearer
// $CRON_SECRET", like the other crons; proxy.ts lets it through for that.
import { NextResponse } from "next/server";
import { warmCache } from "@/lib/warm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const warmed = await warmCache();
  for (const w of warmed) if (!w.ok) console.error(`[warm] ${w.name} failed: ${w.error}`);
  return NextResponse.json({ ok: warmed.every((w) => w.ok), warmed });
}
