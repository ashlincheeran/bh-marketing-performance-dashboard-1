// Compare off-the-shelf Apify news actors against the pipeline we built.
//
// One actor per request: each is billed per article and the function ceiling is
// 300s, so running all five in one call would time out and waste the spend.
// Call with ?actor=0,1,2… and the reply says how many remain.
//
// POST only. Each call starts a billed Apify run with a query the caller
// chooses, and browsers send the app cookie (SameSite=Lax) on a link followed
// from another site, so a plain GET from an email or a web page must never
// start one. Accepted with "Authorization: Bearer $CRON_SECRET" from a script,
// or with both PIN cookies from a browser: spending money is a settings-level
// act. The secret is checked here because proxy.ts only knows the cookies.
//
//   POST /api/pr/probe-actors?actor=0&query=betterhomes%20dubai&max=15
import { NextResponse, type NextRequest } from "next/server";
import { COOKIES, expectedToken, safeEqual, type Scope } from "@/lib/gate";
import { ACTOR_CANDIDATES, probeActor } from "@/lib/actorProbe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const hasCookie = async (req: NextRequest, scope: Scope) => {
  const token = req.cookies.get(COOKIES[scope])?.value;
  return !!token && safeEqual(token, await expectedToken(scope));
};

async function authorised(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return true;
  return (await hasCookie(req, "app")) && (await hasCookie(req, "settings"));
}

export async function GET() {
  return NextResponse.json(
    { error: "method not allowed", message: "This starts a paid Apify run, so it only answers POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: "locked", scope: "settings" }, { status: 401 });
  }

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
    next: index + 1 < ACTOR_CANDIDATES.length ? `POST ?actor=${index + 1}` : null,
    query,
    result,
    howToRead:
      "ok + realUrls === rows + brandInBody > 0 means it returns publisher URLs and bodies our own " +
      "brand check passes, so it could replace the RSS fetch, the batchexecute decoder and the " +
      "per-article crawl. requiredFields empty means wrong input keys fail silently, so rows=0 is " +
      "not evidence the actor found nothing.",
  });
}
