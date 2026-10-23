// Re-runs the press fact check on stored bot-found mentions, a batch per call.
//
// POST only and behind the app PIN (proxy.ts): it re-reads articles through
// Apify and can move a mention out of the count, so a link click or a crawler
// must never set it off. Call it again until `remaining` reads 0.
import { NextResponse } from "next/server";
import { recheckStoredMentions } from "@/lib/prFactcheck";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const limit = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get("limit") || 12)));
  try {
    return NextResponse.json(await recheckStoredMentions(limit));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
