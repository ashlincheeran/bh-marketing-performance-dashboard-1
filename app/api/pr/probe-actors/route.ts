// Compare off-the-shelf Apify news actors against the pipeline we built.
//
// One actor per request: each is billed per article and the function ceiling is
// 300s, so running all five in one call would time out and waste the spend.
// Call with ?actor=0,1,2… and the reply says how many remain.
//
//   GET /api/pr/probe-actors?secret=$CRON_SECRET&actor=0
import { NextResponse } from "next/server";
import { ACTOR_CANDIDATES, probeActor } from "@/lib/actorProbe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const authorised =
    !!secret &&
    (req.headers.get("authorization") === `Bearer ${secret}` || url.searchParams.get("secret") === secret);
  if (!authorised) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
