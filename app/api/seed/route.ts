// One-time (idempotent) loader: pushes the bundled press-clipping history into
// Supabase. Runs on Vercel, which can reach Supabase, and writes with the
// service-role key. Protect with SEED_SECRET.
//
//   GET /api/seed?secret=YOUR_SEED_SECRET
import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import mentionsData from "@/data/mentions.json";
import outletsData from "@/data/outlets.json";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RawOutlet = (typeof outletsData)[number];
type RawMentionRow = (typeof mentionsData)[number];

export async function GET(req: Request) {
  const secret = new URL(req.url).searchParams.get("secret");
  if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = adminClient();
  if (!db) {
    return NextResponse.json(
      { error: "Supabase not configured (need SUPABASE_SERVICE_ROLE_KEY)" },
      { status: 500 },
    );
  }

  // 1) outlets
  const { error: oErr } = await db.from("outlets").upsert(
    (outletsData as RawOutlet[]).map((o) => ({
      name: o.outlet,
      tier: o.tier,
      country: o.country,
      language: o.language,
      default_eav: o.default_eav,
      default_reach: o.default_reach,
      clip_count: o.clip_count,
      first_seen: o.first_seen,
      last_seen: o.last_seen,
    })),
    { onConflict: "name" },
  );
  if (oErr) return NextResponse.json({ step: "outlets", error: oErr.message }, { status: 500 });

  const { data: outletRows, error: selErr } = await db.from("outlets").select("id,name");
  if (selErr) return NextResponse.json({ step: "outlet-map", error: selErr.message }, { status: 500 });
  const idByName = new Map((outletRows ?? []).map((r) => [r.name, r.id]));

  // 2) mentions
  const rows = (mentionsData as RawMentionRow[]).map((m) => {
    const url = m.url && String(m.url).startsWith("http") ? m.url : null;
    return {
      id: m.id,
      published_on: m.date,
      tier: m.tier,
      outlet_id: m.outlet ? idByName.get(m.outlet) ?? null : null,
      outlet_name: m.outlet,
      title: m.title,
      url,
      eav: m.eav,
      reach: m.reach,
      brand: m.brand,
      sentiment: m.sentiment,
      media_type: m.media_type ?? "other",
      language: m.language,
      tags: m.tags ?? [],
      metadata: m.metadata ?? {},
      source: "historical_import",
      status: "reviewed",
    };
  });

  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await db.from("mentions").upsert(batch, { onConflict: "id" });
    if (error) {
      return NextResponse.json({ step: "mentions", at: done, error: error.message }, { status: 500 });
    }
    done += batch.length;
  }

  return NextResponse.json({ ok: true, outlets: outletsData.length, mentions: done });
}
