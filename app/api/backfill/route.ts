// One-time helper: backfill sentiment on existing clips that don't have it yet,
// newest first, in batches. Trigger repeatedly until `remaining` is 0:
//   GET /api/backfill?secret=$CRON_SECRET&limit=40
import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import { assessMention } from "@/lib/sentiment";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (!secret || url.searchParams.get("secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, 60);
  const db = adminClient();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not set" }, { status: 500 });

  const { data } = await db
    .from("mentions")
    .select("id,title,outlet_name")
    .is("sentiment", null)
    .not("title", "is", null)
    .order("published_on", { ascending: false, nullsFirst: false })
    .limit(limit);

  const rows = data ?? [];
  let updated = 0;
  for (const r of rows) {
    const a = await assessMention(String(r.title), String(r.outlet_name ?? ""));
    // These are all curated betterhomes clips, so always set a value
    // (fallback neutral) to guarantee forward progress.
    const sentiment = a.sentiment ?? "neutral";
    await db.from("mentions").update({ sentiment }).eq("id", r.id);
    updated++;
  }

  const remaining =
    (await db.from("mentions").select("id", { count: "exact", head: true }).is("sentiment", null)).count ?? 0;

  return NextResponse.json({ ok: true, processed: rows.length, updated, remaining });
}
