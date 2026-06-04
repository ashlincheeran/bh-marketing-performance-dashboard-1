// Daily ingestion: find new betterhomes press mentions via NewsData.io,
// enrich them from the outlet table, optionally tag sentiment with Claude,
// and store new ones in Supabase marked `new` for review.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { classifySentiment } from "@/lib/sentiment";
import type { Tier } from "@/lib/types";

const QUERY = process.env.PR_QUERY || "betterhomes";

function hashId(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function deriveTags(title: string): string[] {
  const t = (title || "").toLowerCase();
  const tags = new Set<string>();
  if (/rent|tenant|lease|leasing/.test(t)) tags.add("leasing");
  if (/report/.test(t)) tags.add("market-report");
  if (/ceo|appoint|steps down|director|leadership/.test(t)) tags.add("leadership");
  if (/off-plan|off plan|offplan/.test(t)) tags.add("off-plan");
  if (/top 50/.test(t)) tags.add("top-50");
  if (/ramadan/.test(t)) tags.add("ramadan");
  return [...tags];
}

export interface IngestResult {
  fetched: number;
  relevant: number;
  inserted: number;
  sample: string[];
}

export async function runIngest(): Promise<IngestResult> {
  const apikey = process.env.NEWSDATA_API_KEY;
  if (!apikey) throw new Error("NEWSDATA_API_KEY not set");
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

  // 1) fetch latest matching news
  const url = `https://newsdata.io/api/1/latest?apikey=${apikey}&q=${encodeURIComponent(QUERY)}&language=en`;
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error("NewsData error: " + JSON.stringify(data).slice(0, 300));
  }
  const articles: any[] = data.results ?? [];

  // 2) keep only true brand mentions (avoids generic "better homes" noise)
  const relevant = articles.filter((a) => {
    const hay = `${a.title ?? ""} ${a.description ?? ""}`.toLowerCase();
    return hay.includes("betterhomes");
  });

  // 3) outlet lookup for tier / EAV / reach
  const { data: outlets } = await db
    .from("outlets")
    .select("id,name,tier,default_eav,default_reach");
  const byName = new Map(
    (outlets ?? []).map((o) => [String(o.name).toLowerCase(), o]),
  );

  // 4) build rows
  type Row = Record<string, unknown> & { id: string };
  const rows: Row[] = [];
  for (const a of relevant) {
    const link: string | undefined = a.link;
    if (!link) continue;
    const outletName: string = a.source_name || a.source_id || "";
    const match = byName.get(outletName.toLowerCase());
    rows.push({
      id: hashId(link),
      published_on: (a.pubDate ?? "").slice(0, 10) || null,
      tier: (match?.tier as Tier) ?? "Other",
      outlet_id: match?.id ?? null,
      outlet_name: outletName || null,
      title: a.title ?? null,
      url: link,
      eav: null, // modeled from the outlet rate card in the view
      reach: null,
      brand: "betterhomes",
      sentiment: null,
      media_type: "online",
      tags: deriveTags(a.title ?? ""),
      source: "newsdata",
      status: "new",
      raw: a,
    });
  }

  // 5) drop ones we already have
  const ids = rows.map((r) => r.id);
  const existing = ids.length
    ? (await db.from("mentions").select("id").in("id", ids)).data ?? []
    : [];
  const have = new Set(existing.map((e) => e.id));
  const fresh = rows.filter((r) => !have.has(r.id));

  // 6) sentiment (no-op until ANTHROPIC_API_KEY is set)
  for (const r of fresh) {
    r.sentiment = await classifySentiment(String(r.title ?? ""));
  }

  // 7) insert
  if (fresh.length) {
    const { error } = await db.from("mentions").upsert(fresh, { onConflict: "id" });
    if (error) throw new Error("insert failed: " + error.message);
  }

  return {
    fetched: articles.length,
    relevant: relevant.length,
    inserted: fresh.length,
    sample: fresh.slice(0, 5).map((r) => String(r.title ?? "")),
  };
}
