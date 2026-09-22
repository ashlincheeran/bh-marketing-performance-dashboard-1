// People Sentiment — scheduled run.
//
// The tab only ever refreshed when someone clicked "Run", so it quietly aged
// between visits and nobody could tell stale data from no data. This is the
// same pipeline the button drives, with no body, so it uses the stored config.
//
// Weekly rather than daily on purpose: social sentiment moves slowly, each run
// costs Apify compute, and the account is on a plan with a monthly ceiling that
// the daily news bot already draws on.
import { NextResponse } from "next/server";
import { runSocialIngest } from "@/lib/socialIngest";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  const isManual = !!secret && new URL(req.url).searchParams.get("secret") === secret;
  if (!isCron && !isManual) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await runSocialIngest({});
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A scheduled job that fails silently is the failure mode this whole
    // project keeps hitting, so say so in the notification feed.
    await notify("error", "social", "People Sentiment sync failed", error, "social:sync:failed");
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
