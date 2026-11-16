// Refresh everything, from the button on Settings (components/RefreshEverything.tsx):
// every bot the schedules run, started now. Behind both PINs, like Settings
// (proxy.ts, and checked again here).
//
// - The news bot: a run as Run now starts one (search, read, the AI check),
//   unless one is working already. Its chain runs in /api/news, as always.
// - The ads data for Digital Performance: the last 90 days, as the 08:20 cron
//   syncs them (app/api/paid/sync).
// - The Socials benchmark and People sentiment, as their Monday crons run them
//   (app/api/perf/sync, app/api/social/sync): one after the other, never
//   together, since two Apify jobs at once have run out of Apify's memory.
//
// The weekly email is left out: it sends email. The route answers 202 at once
// with what it started; the ads, Socials and People sentiment run in after(),
// inside this function's 800 seconds, and a failure goes to the notification
// bell. Then every page is marked stale, so the next look reads the new data.
import { revalidatePath } from "next/cache";
import { markAllStale } from "@/lib/cache";
import { warmCache } from "@/lib/warm";
import { after, NextResponse, type NextRequest } from "next/server";
import { errorMessage } from "@/lib/coerce";
import { getNewsRunToday } from "@/lib/data";
import { hasGateCookie } from "@/lib/gate";
import { startNewsRun } from "@/lib/news/run";
import { notify } from "@/lib/notify";
import { getPaidData } from "@/lib/paid";
import { runPerfIngest } from "@/lib/perfIngest";
import { runSocialIngest } from "@/lib/socialIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** One job, with a failure said in the bell rather than lost. */
async function job(name: string, key: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (e) {
    const error = errorMessage(e);
    console.error(`[refresh] ${name} failed: ${error}`);
    await notify("error", "refresh", `Refresh everything: ${name} failed`, error, `refresh:${key}:failed`);
  }
}

export async function POST(req: NextRequest) {
  for (const scope of ["app", "settings"] as const) {
    if (!(await hasGateCookie(req.cookies, scope))) return NextResponse.json({ error: "locked", scope }, { status: 401 });
  }

  // The news bot first, so its own run can start while the rest is queued: one run at a time.
  let news: { started: boolean; note: string };
  if ((await getNewsRunToday())?.running) {
    news = { started: false, note: "A news run is working now, so it was left to finish." };
  } else {
    try {
      const r = await startNewsRun("manual");
      news = r.started ? { started: true, note: "Started." } : { started: false, note: r.error ?? "It did not start." };
    } catch (e) {
      news = { started: false, note: errorMessage(e) };
    }
  }

  after(async () => {
    await Promise.all([
      job("the ads data", "ads", () => getPaidData(undefined, undefined, 90, "campaign")),
      (async () => {
        await job("People sentiment", "people", () => runSocialIngest({}));
        await job("the Socials benchmark", "socials", () => runPerfIngest({}));
      })(),
    ]);
    // Every remembered answer is due for a refresh now, shown meanwhile, and each tab's opening view is worked out again.
    await markAllStale();
    await job("the tabs' opening views", "warm", async () => {
      const failed = (await warmCache()).filter((w) => !w.ok);
      if (failed.length) throw new Error(failed.map((w) => `${w.name}: ${w.error}`).join("; "));
    });
    revalidatePath("/", "layout");
  });

  return NextResponse.json({ news, started: ["ads", "people", "socials"] }, { status: 202 });
}
