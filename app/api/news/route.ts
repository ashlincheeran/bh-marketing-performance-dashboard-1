// The news bot (docs/news-pipeline.md). Every link of a run's chain is one
// call here.
//
//   GET   Vercel cron, daily at 04:00 UTC (08:00 Dubai). Starts a new run at
//         search. Needs "Authorization: Bearer $CRON_SECRET", like the other crons.
//         A deployment with no Claude key starts nothing (see GET).
//   POST  Runs one link and hands on the next:
//           ?step=search|read|check|publish|seed|recheck&run=<id>&link=<n>
//         plus &kind=unchecked_ours|pending_reread|rivals for a recheck, and
//         &trigger=cron|manual, which the chain's own hand-offs carry along.
//         Without a run id it starts a new run there. publish writes what
//         test mode held, once counting is switched back on; seed imports the
//         old bot's stories, once; recheck sends one kind of them back through
//         read and check. The chain calls it with the cron secret; an admin
//         can drive it from a browser with both PIN cookies, checked here
//         because proxy.ts lets /api/news through for the cron.
//
// Both answer 202 at once and do the work in after(), inside this route's 300
// seconds: a step claims work for 200 of them, then waits at most 20 for the
// next link to answer. In production the next link is called at the public
// domain, which Vercel's login does not stand in front of. The link that ends
// a chain writes its summary and refreshes the PR insights, within the same
// 300 seconds.
import { after, NextResponse, type NextRequest } from "next/server";
import { claudeConfigured } from "@/lib/claude";
import { hasGateCookie, type Scope } from "@/lib/gate";
import { firstLink, isCronRequest, parseLinkRequest, runLink, type LinkRequest } from "@/lib/news/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A valid cookie for this door, issued within its MAX_AGE (lib/gate.ts). */
const unlocked = (req: NextRequest, scope: Scope) => hasGateCookie(req.cookies, scope);

function start(req: NextRequest, link: LinkRequest) {
  // Read now: the request is gone by the time the work runs.
  const origin = req.nextUrl.origin;
  after(() => runLink(link, origin));
  return NextResponse.json({ started: link.step, run: link.runId, link: link.link }, { status: 202 });
}

export function GET(req: NextRequest) {
  if (!isCronRequest(req.headers)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // A deployment with no Claude key can search and read but never check, so its
  // morning run would only repeat the work and log a failure. A second Vercel
  // project, in an account nobody here can reach, deploys this repo without the
  // key and runs this cron on the same database at about 08:16 Dubai: it stands
  // down here, before anything is written. The live dashboard has the key, and
  // PR & Media settings shows whether it does, so a key gone missing there is
  // still seen. Run now is not stopped: a person pressing it sees what happens.
  if (!claudeConfigured()) {
    console.warn("[news] the morning run did not start: this deployment has no Claude key (ANTHROPIC_API_KEY)");
    return NextResponse.json({ skipped: "no Claude key on this deployment" });
  }
  return start(req, firstLink("cron"));
}

export async function POST(req: NextRequest) {
  const fromCron = isCronRequest(req.headers);
  if (!fromCron) {
    // App first, then settings, the order the PIN prompts come in.
    for (const scope of ["app", "settings"] as const) {
      if (!(await unlocked(req, scope))) return NextResponse.json({ error: "locked", scope }, { status: 401 });
    }
  }
  const link = parseLinkRequest(req.nextUrl.searchParams, fromCron ? "cron" : "manual");
  if ("error" in link) return NextResponse.json({ error: link.error }, { status: 400 });
  return start(req, link);
}
