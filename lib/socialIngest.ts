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

// Plain-English "why it failed + what to do", shown in the run log under the error.
function failureHint(channel: string, msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("timed out"))
    return "the actor ran past its time budget (residential proxy / too many items). Lower Items/platform or disable it; it retries next run.";
  if (m.includes("memory") || m.includes("402"))
    return "Apify's concurrent-memory cap was hit. Let any other Apify runs finish (or lower Items/platform), then re-run.";
  if (m.includes("company url")) return "add the Glassdoor company URL in Advanced → Glassdoor, then Save subjects & sources.";
  if (m.includes("page url")) return "add the Facebook page URL in Advanced → Facebook, then Save subjects & sources.";
  if (m.includes("apify_token")) return "APIFY_TOKEN isn't set in the deployment environment variables.";
  if (m.includes("401") || m.includes("403") || (m.includes("token") && m.includes("invalid")))
    return "Apify rejected the request — check that APIFY_TOKEN is valid and not rotated.";
  if (m.includes("404")) return `the Apify actor ID for ${channel} wasn't found — check it in Advanced → ${channel}.`;
  if (m.includes("http 5")) return "Apify had a server-side error — try running again in a moment.";
  return `check the ${channel} actor ID and settings in Advanced, or try again.`;
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

  const t0 = Date.now();
  // Stay safely under the function's maxDuration (300s). Each actor is given a
  // timeout sized to the time left in the run, so we never overrun — a slow
  // actor aborts cleanly instead of killing the whole function.
  const MAX_TOTAL = Number(process.env.SOCIAL_MAX_MS || 285_000);
  let scored = 0;

  // Platforms run SEQUENTIALLY — only one actor holds Apify memory at a time, so
  // we never trip the account's concurrent-memory cap. Each platform's results
  // are scored + stored before moving on, so a slow/timed-out run keeps progress.
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci];
    const remaining = MAX_TOTAL - (Date.now() - t0);
    if (remaining < 30_000) {
      p(`⏱ Time budget reached — skipping ${channels.slice(ci).join(", ")} (run again to continue).`);
      break;
    }
    // Cap any single actor at 120s, but never more than the time we have left.
    const ctx = { window, maxItems, subjects, p, timeoutMs: Math.min(120_000, remaining - 8_000) };

    p(`▶ ${ch} — scraping…`);
    let items: CollectedItem[] = [];
    try {
      items = await scrapeChannel(ch, cfg, ctx);
      p(`  ✓ ${ch}: ${items.length} items`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      p(`  ✗ ${ch} failed: ${msg}`);
      p(`     why: ${failureHint(ch, msg)}`);
      continue;
    }
    result.found += items.length;

    // Dedupe within the channel; stable row id = channel + external id + subject.
    const byId = new Map<string, CollectedItem>();
    for (const it of items) {
      const ext = it.external_id ?? it.url ?? it.content.slice(0, 60);
      const id = hashId(`${it.channel}|${ext}|${it.subject}`);
      if (!byId.has(id)) byId.set(id, it);
    }
    const ids = [...byId.keys()];
    const existing = new Set<string>();
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await db.from("social_mentions").select("id").in("id", ids.slice(i, i + 300));
      for (const r of data ?? []) existing.add(r.id as string);
    }
    const fresh = [...byId.entries()].filter(([id]) => !existing.has(id));
    if (!fresh.length) {
      p(`  ${ch}: nothing new (${existing.size} already stored)`);
      continue;
    }

    // Score (Gemini, fixed rubric) and store this platform's rows now.
    const rows: Record<string, unknown>[] = [];
    for (const [id, it] of fresh) {
      result.considered++;
      let a = { relevant: true, sentiment: null as any, score: null as number | null, reason: null as string | null, noise: null as string | null };
      if (scored < SCORE_CAP && Date.now() - t0 < MAX_TOTAL - 5_000) {
        a = await assessSocialMention(it.subject, it.subject_kind as "company" | "person", it.channel, it.content);
        scored++;
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
    const { error } = await db.from("social_mentions").upsert(rows, { onConflict: "id" });
    if (error) {
      p(`  ✗ ${ch} store failed: ${error.message}`);
      continue;
    }
    const kept = rows.filter((r) => r.status === "new").length;
    result.inserted += kept;
    p(`  ✓ ${ch}: stored ${rows.length} (${kept} kept, ${rows.length - kept} filtered)`);
  }

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
