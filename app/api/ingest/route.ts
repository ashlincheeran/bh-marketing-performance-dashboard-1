// The old news bot's address, kept working for anything still calling it: a
// second Vercel project still runs this app's old cron against it. The news
// bot itself moved to /api/news (docs/news-pipeline.md), so a call here starts
// a run exactly as the cron there does, and says where the bot went.
//
// It needs the cron secret as "Authorization: Bearer $CRON_SECRET", the way
// Vercel's cron sends it, and nothing else. It no longer takes the secret as
// ?secret=: an address ends up in browser history and request logs, and that
// secret also starts paid runs. A run by hand goes through POST /api/news,
// with the header or both PIN cookies. With CRON_SECRET unset it answers 401,
// and the run's later steps could not be handed on anyway.
import { after, NextResponse, type NextRequest } from "next/server";
import { firstLink, isCronRequest, runLink } from "@/lib/news/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The run's search step works inside this request, as on /api/news.
export const maxDuration = 300;

export function GET(req: NextRequest) {
  if (!isCronRequest(req.headers)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const link = firstLink("cron");
  const origin = req.nextUrl.origin;
  after(() => runLink(link, origin));
  return NextResponse.json(
    {
      ok: true,
      moved: "/api/news",
      note: "The news bot has moved to /api/news. This call started a run, the same as the daily cron there does.",
      started: link.step,
      run: link.runId,
      link: link.link,
    },
    { status: 202 },
  );
}
