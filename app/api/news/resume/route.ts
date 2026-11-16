// GET, a Vercel cron every 10 minutes (vercel.json): carries on today's news
// run when it paused at Vercel's limit on a run starting itself (HTTP 508),
// with work still waiting (lib/data.ts carriesOn). A run hands each step to
// the next by calling /api/news, and Vercel stops that after a few calls in a
// row as a possible endless loop. This call comes from Vercel's scheduler, not
// from the run, so the chain it starts begins afresh: at the read step, which
// takes up what the paused run left, then the check and the publish, as a
// morning's run goes on after its search. Most calls find nothing paused and
// only read the run log. Needs "Authorization: Bearer $CRON_SECRET", like the
// other crons; proxy.ts lets it through for that.
import { after, NextResponse, type NextRequest } from "next/server";
import { getNewsSettings } from "@/lib/appSettings";
import { claudeConfigured } from "@/lib/claude";
import { errorMessage } from "@/lib/coerce";
import { carriesOn, getNewsRunToday } from "@/lib/data";
import { firstLink, isCronRequest, runLink } from "@/lib/news/run";
import { waitingForRun } from "@/lib/news/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!isCronRequest(req.headers)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // A deployment with no Claude key stands down, as the morning's run does (app/api/news/route.ts).
  if (!claudeConfigured()) return NextResponse.json({ skipped: "no Claude key on this deployment" });
  try {
    if (!carriesOn(await getNewsRunToday())) return NextResponse.json({ skipped: "no paused run to carry on" });
    const { countOnPrTab } = await getNewsSettings();
    const { due } = await waitingForRun(countOnPrTab);
    if (!due) return NextResponse.json({ skipped: "nothing waiting" });
    const link = firstLink("cron", "read");
    // Read now: the request is gone by the time the work runs.
    const origin = req.nextUrl.origin;
    after(() => runLink(link, origin));
    return NextResponse.json({ started: link.step, run: link.runId, waiting: due }, { status: 202 });
  } catch (e) {
    console.error(`[news] the paused run could not be carried on: ${errorMessage(e)}`);
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
