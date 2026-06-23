// People Sentiment ingestion. Runs on demand from the tab's "Run" button.
//
//   1. Scrape each enabled platform via Apify (in parallel — total time ≈ the
//      slowest platform, not the sum; one platform failing is non-fatal).
//   2. Dedupe by channel + external id + subject.
//   3. Skip items already stored, score the rest with Gemini on a fixed rubric.
//   4. Upsert into social_mentions and log the run.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { scrapeChannel, type CollectedItem } from "@/lib/social";
import { assessSocialMention } from "@/lib/sentiment";
import { mergeConfig, DEFAULT_SOCIAL_CONFIG, WINDOW_LABEL } from "@/lib/socialTypes";
import type { SocialChannel, SocialConfig, Subject, TimeWindow } from "@/lib/socialTypes";

// Cap Gemini calls per run so a big scrape can't blow the function time budget.
const SCORE_CAP = Number(process.env.SOCIAL_SCORE_MAX || 60);

export interface SocialRunParams {
  window?: TimeWindow;
  maxItems?: number;
  channels?: SocialChannel[];
  subjects?: Subject[];
}

export interface SocialIngestResult {
  found: number;
  considered: number;
  inserted: number;
  skipped: number;
}

function hashId(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

async function loadConfig(db: any): Promise<SocialConfig> {
  try {
    const { data } = await db.from("social_config").select("payload").eq("id", 1).maybeSingle();
    return mergeConfig(data?.payload ?? null);
  } catch {
    return DEFAULT_SOCIAL_CONFIG;
  }
}

export async function runSocialIngest(
  params: SocialRunParams,
  onProgress?: (msg: string) => void,
): Promise<SocialIngestResult> {
  const p = onProgress ?? (() => {});
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN not set — add it to the Vercel environment variables");

  const cfg = await loadConfig(db);
  const window = params.window ?? cfg.defaults.window;
  const maxItems = params.maxItems ?? cfg.defaults.maxItems;
  const subjects = params.subjects?.length ? params.subjects : cfg.subjects;
  const channels =
    params.channels?.length
      ? params.channels
      : (Object.keys(cfg.platforms) as SocialChannel[]).filter((c) => cfg.platforms[c].enabled);

  const result: SocialIngestResult = { found: 0, considered: 0, inserted: 0, skipped: 0 };

  p(`Starting · ${WINDOW_LABEL[window]} · ${maxItems}/platform · subjects: ${subjects.map((s) => s.name).join(", ")}`);
  p(`Platforms: ${channels.join(", ")}`);
  p(`─────────────────────────────────────`);

  const ctx = { window, maxItems, subjects, p };

  // Scrape all platforms in parallel; failures log and yield [].
  const settled = await Promise.allSettled(
    channels.map(async (ch) => {
      p(`▶ ${ch} — scraping…`);
      try {
        const items = await scrapeChannel(ch, cfg, ctx);
        p(`  ✓ ${ch}: ${items.length} items`);
        return items;
      } catch (e) {
        p(`  ✗ ${ch} failed: ${e instanceof Error ? e.message : String(e)}`);
        return [] as CollectedItem[];
      }
    }),
  );

  const collected: CollectedItem[] = [];
  for (const s of settled) if (s.status === "fulfilled") collected.push(...s.value);
  result.found = collected.length;

  p(`─────────────────────────────────────`);
  p(`Collected ${collected.length} items`);

  // Dedupe by channel + external id + subject; compute a stable row id.
  const byId = new Map<string, CollectedItem>();
  for (const it of collected) {
    const ext = it.external_id ?? it.url ?? it.content.slice(0, 60);
    const id = hashId(`${it.channel}|${ext}|${it.subject}`);
    if (!byId.has(id)) byId.set(id, it);
  }

  // Skip rows we already have (so re-runs don't re-score the same posts).
  const ids = [...byId.keys()];
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await db.from("social_mentions").select("id").in("id", ids.slice(i, i + 300));
    for (const r of data ?? []) existing.add(r.id as string);
  }
  const fresh = [...byId.entries()].filter(([id]) => !existing.has(id));
  p(`${fresh.length} new to assess · ${existing.size} already stored`);

  // Score with Gemini (capped) and build rows.
  const rows: Record<string, unknown>[] = [];
  let scored = 0;
  for (const [id, it] of fresh) {
    result.considered++;
    let a = { relevant: true, sentiment: null as any, score: null as number | null, reason: null as string | null, noise: null as string | null };
    if (scored < SCORE_CAP) {
      a = await assessSocialMention(it.subject, it.subject_kind as "company" | "person", it.channel, it.content);
      scored++;
      if (scored % 10 === 0) p(`  scored ${scored}/${Math.min(fresh.length, SCORE_CAP)}…`);
    }
    const keep = a.relevant && !a.noise;
    if (!keep) result.skipped++;
    rows.push({
      id,
      channel: it.channel,
      subject: it.subject,
      subject_kind: it.subject_kind,
      external_id: it.external_id,
      url: it.url,
      author: it.author,
      posted_at: it.posted_at,
      content: it.content.slice(0, 4000),
      rating: it.rating,
      likes: it.likes,
      comments: it.comments,
      shares: it.shares,
      sentiment: a.sentiment,
      sentiment_score: a.score,
      sentiment_reason: a.reason,
      noise_class: a.noise,
      status: keep ? "new" : "rejected",
      source_actor: it.source_actor,
      query: it.query,
      raw: { likes: it.likes, comments: it.comments, shares: it.shares },
    });
  }

  if (rows.length) {
    const { error } = await db.from("social_mentions").upsert(rows, { onConflict: "id" });
    if (error) throw new Error("insert failed: " + error.message);
  }
  result.inserted = rows.filter((r) => r.status === "new").length;

  await db.from("social_runs").insert({
    trigger: "manual",
    ok: true,
    found: result.found,
    considered: result.considered,
    inserted: result.inserted,
    skipped: result.skipped,
    params: { window, maxItems, channels, subjects: subjects.map((s) => s.name) },
  });

  p(`─────────────────────────────────────`);
  p(`Done — ${result.inserted} kept · ${result.skipped} filtered out · ${result.found} seen`);
  return result;
}
