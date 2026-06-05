// Single source the dashboard reads from: Supabase when configured, otherwise
// the bundled JSON seed (so the app still renders before the DB is wired).
import { enrichMentions } from "@/lib/pr";
import { readClient } from "@/lib/supabase";
import type { Mention, Outlet, RawMention, Sentiment, Tier } from "@/lib/types";
import rawMentions from "@/data/mentions.json";
import outletsJson from "@/data/outlets.json";

export interface MentionsResult {
  mentions: Mention[];
  source: "supabase" | "seed";
}

export async function getMentions(): Promise<MentionsResult> {
  const db = readClient();
  if (db) {
    const [mRes, oRes] = await Promise.all([
      db
        .from("mentions")
        .select("id,published_on,tier,outlet_name,title,url,eav,reach,brand,sentiment,source")
        .neq("status", "rejected")
        .order("published_on", { ascending: false, nullsFirst: false })
        .limit(5000),
      db.from("outlets").select("name,tier,default_eav,default_reach"),
    ]);
    if (!mRes.error && !oRes.error && mRes.data) {
      const raw: RawMention[] = mRes.data.map((r) => ({
        id: r.id,
        date: r.published_on,
        year: r.published_on ? Number(String(r.published_on).slice(0, 4)) : null,
        month: r.published_on ? Number(String(r.published_on).slice(5, 7)) : null,
        tier: r.tier as Tier,
        outlet: r.outlet_name,
        title: r.title,
        url: r.url,
        eav: r.eav,
        reach: r.reach,
        brand: r.brand ?? "betterhomes",
        sentiment: r.sentiment as Sentiment,
        source: r.source ?? "historical_import",
      }));
      const outlets: Outlet[] = (oRes.data ?? []).map((o) => ({
        outlet: o.name,
        tier: o.tier as Tier,
        default_eav: o.default_eav,
        default_reach: o.default_reach,
      }));
      return { source: "supabase", mentions: enrichMentions(raw, outlets) };
    }
  }
  return {
    source: "seed",
    mentions: enrichMentions(
      rawMentions as unknown as RawMention[],
      outletsJson as unknown as Outlet[],
    ),
  };
}

export interface IngestRun {
  ran_at: string;
  trigger: string;
  ok: boolean;
  found: number;
  considered: number;
  inserted: number;
  updated: number;
  skipped: number;
  error: string | null;
}

export interface BotActivityItem {
  id: string;
  published_on: string | null;
  outlet_name: string | null;
  title: string | null;
  url: string | null;
  status: string; // 'new' (kept) | 'reviewed' (approved) | 'rejected'
  sentiment: Sentiment;
}

/** Everything the news bot has seen (kept + rejected), newest first, for auditing. */
export async function getBotActivity(limit = 120): Promise<BotActivityItem[]> {
  const db = readClient();
  if (!db) return [];
  const { data, error } = await db
    .from("mentions")
    .select("id,published_on,outlet_name,title,url,status,sentiment")
    .eq("source", "googlenews")
    .order("published_on", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error || !data) return [];
  return data as BotActivityItem[];
}

/** Recent bot-run history for the dashboard status panel. */
export async function getIngestRuns(limit = 5): Promise<IngestRun[]> {
  const db = readClient();
  if (!db) return [];
  const { data, error } = await db
    .from("ingest_runs")
    .select("ran_at,trigger,ok,found,considered,inserted,updated,skipped,error")
    .order("ran_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as IngestRun[];
}
