// Socials Performance benchmark — scheduled run.
//
// Same reasoning as the People Sentiment sync: this only ran when someone
// pressed the button, so the benchmark silently aged. No body, so the stored
// config decides platforms, brands and window.
//
// Scheduled after the sentiment run rather than alongside it: both drive Apify,
// and concurrent actor runs share one memory ceiling that has already produced
// 402s when two things reached for it at once.
import { NextResponse } from "next/server";
import { runPerfIngest } from "@/lib/perfIngest";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  const isManual = !!secret && new URL(req.url).searchParams.get("secret") === secret;
  if (!isCron && !isManual) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await runPerfIngest({});
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await notify("error", "social", "Socials Performance sync failed", error, "perf:sync:failed");
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
