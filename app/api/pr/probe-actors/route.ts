// Compare off-the-shelf Apify news actors against the pipeline we built.
//
// One actor per request: each is billed per article and the function ceiling is
// 300s, so running all five in one call would time out and waste the spend.
// Call with ?actor=0,1,2… and the reply says how many remain.
//
// Protected by the app PIN gate in proxy.ts rather than its own secret: it is
// reachable from a browser that is already unlocked, which is what makes it
// usable. It spends Apify credit, so it sits at the same trust level as the
// "Run now" button — CRON_SECRET is still accepted for calling it from a script.
//
//   GET /api/pr/probe-actors?actor=0
import { NextResponse } from "next/server";
import { ACTOR_CANDIDATES, probeActor } from "@/lib/actorProbe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const index = Number(url.searchParams.get("actor") ?? 0);
  const query = url.searchParams.get("query") || "betterhomes dubai";
  const maxItems = Math.min(30, Math.max(5, Number(url.searchParams.get("max") || 15)));

  const actor = ACTOR_CANDIDATES[index];
  if (!actor) {
    return NextResponse.json(
      { error: `actor index ${index} out of range`, candidates: ACTOR_CANDIDATES },
      { status: 400 },
    );
  }

  const result = await probeActor(actor, query, maxItems);
  return NextResponse.json({
    index,
    of: ACTOR_CANDIDATES.length,
    next: index + 1 < ACTOR_CANDIDATES.length ? `?secret=…&actor=${index + 1}` : null,
    query,
    result,
    howToRead:
      "ok + realUrls === rows + brandInBody > 0 means it returns publisher URLs and bodies our own " +
      "brand check passes, so it could replace the RSS fetch, the batchexecute decoder and the " +
      "per-article crawl. requiredFields empty means wrong input keys fail silently, so rows=0 is " +
      "not evidence the actor found nothing.",
  });
}
