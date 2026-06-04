// Seed Supabase with the parsed press-clipping history.
//
//   1. Apply supabase/migrations/0001_pr_media_schema.sql to your project.
//   2. Set SUPABASE_URL and a key (SUPABASE_KEY / SERVICE_ROLE / ANON).
//      Seed before enabling RLS (0002) so the anon key can write.
//   3. node scripts/seed_supabase.mjs
//
// Safe to re-run: outlets upsert on name, mentions upsert on id.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or a Supabase key.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const load = (f) => JSON.parse(readFileSync(join(DATA, f), "utf-8"));
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function main() {
  const outlets = load("outlets.json");
  const mentions = load("mentions.json");

  // 1) Outlets ------------------------------------------------------
  console.log(`Upserting ${outlets.length} outlets…`);
  const { error: oErr } = await db.from("outlets").upsert(
    outlets.map((o) => ({
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
  if (oErr) throw oErr;

  // map outlet name -> id
  const { data: outletRows, error: selErr } = await db.from("outlets").select("id,name");
  if (selErr) throw selErr;
  const idByName = new Map(outletRows.map((r) => [r.name, r.id]));

  // 2) Mentions -----------------------------------------------------
  const rows = mentions.map((m) => ({
    id: m.id,
    published_on: m.date,
    tier: m.tier,
    outlet_id: m.outlet ? idByName.get(m.outlet) ?? null : null,
    outlet_name: m.outlet,
    title: m.title,
    url: m.url && String(m.url).startsWith("http") ? m.url : null,
    eav: m.eav,
    reach: m.reach,
    brand: m.brand,
    sentiment: m.sentiment, // null for history
    media_type: m.media_type ?? "other",
    language: m.language,
    tags: m.tags ?? [],
    metadata: m.metadata ?? {},
    source: "historical_import",
    status: "reviewed",
  }));

  console.log(`Upserting ${rows.length} mentions…`);
  let done = 0;
  for (const batch of chunk(rows, 500)) {
    const { error } = await db.from("mentions").upsert(batch, { onConflict: "id" });
    if (error) throw error;
    done += batch.length;
    console.log(`  …${done}/${rows.length}`);
  }
  console.log("✓ Seed complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
