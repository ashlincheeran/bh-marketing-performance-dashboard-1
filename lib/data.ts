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
        .select("id,published_on,tier,outlet_name,title,url,eav,reach,brand,sentiment")
        .order("published_on", { ascending: false }),
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
