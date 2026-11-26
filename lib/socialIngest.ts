// People Sentiment ingestion: the weekly cron, the tab's "Run" button and
// Settings' refresh all drive it.
//
//   1. Scrape each enabled platform via Apify, one after another; one platform
//      failing is non-fatal, and its reason goes in the run log.
//   2. Dedupe by channel + external id + subject.
//   3. Skip items already stored, score the rest with Claude on a fixed rubric.
//   4. Upsert into social_mentions and log the run. A run that went wrong
//      raises a notification, so it can't pass for a quiet week again.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { errorMessage } from "@/lib/coerce";
import { notify } from "@/lib/notify";
import { DEFAULT_NEWS_SETTINGS, getNewsSettings } from "@/lib/appSettings";
import { scrapeChannel, type CollectedItem } from "@/lib/social";
import { assessSocialMention } from "@/lib/sentiment";
import { mergeConfig, WINDOW_LABEL } from "@/lib/socialTypes";
import type { SocialChannel, SocialConfig, Subject, TimeWindow } from "@/lib/socialTypes";

// Cap AI calls per run so a big scrape can't blow the function time budget.
const SCORE_CAP = Number(process.env.SOCIAL_SCORE_MAX || 60);
/** Posts scored at once: Claude takes a few seconds a post, and 60 one by one would eat the run's 5 minutes. */
const SCORE_AT_ONCE = 5;

export interface SocialRunParams {
  window?: TimeWindow;
  maxItems?: number;
  channels?: SocialChannel[];
  subjects?: Subject[];
  /** Who started it, for the run log: the weekly cron, or a person. */
  trigger?: "cron" | "manual";
}

export interface SocialIngestResult {
  found: number;
  considered: number;
  inserted: number;
  skipped: number;
  /** The run log's verdict: false when every platform failed, the AI stopped, or new posts came back and none could be stored. */
  ok: boolean;
  /** Why, in the words the run log keeps; null when all went well. */
  error: string | null;
}

function hashId(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** The Items / platform box's range on the People Sentiment tab. */
const ITEMS_MIN = 5;
const ITEMS_MAX = 100;

/**
 * Items per platform for one run, kept to the Items box's range of 5 to 100.
 *
 * The run's settings come from the request body, which can hold any number,
 * and every item asked for is scraped and billed by Apify. A value that is not
 * a number falls back to the stored default, kept to the same range.
 */
export function itemsPerPlatform(asked: unknown, fallback: unknown): number {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);
  const n = [num(asked), num(fallback)].find(Number.isFinite) ?? ITEMS_MIN;
  return Math.min(ITEMS_MAX, Math.max(ITEMS_MIN, Math.round(n)));
}

/** The saved settings. A read that fails stops the run: scraping with the defaults would track the wrong subjects. */
async function loadConfig(db: any): Promise<SocialConfig> {
  const { data, error } = await db.from("social_config").select("payload").eq("id", 1).maybeSingle();
  if (error) throw new Error(`the People sentiment settings could not be read (${error.message})`);
  return mergeConfig(data?.payload ?? null);
}

// Plain-English "why it failed + what to do", shown in the run log under the error.
export function failureHint(channel: string, msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("timed out"))
    return "the actor ran past its time budget (residential proxy / too many items). Lower Items/platform or disable it; it retries next run.";
  // Apify's monthly allowance, which ran out in October 2026 and left every platform empty for three weeks.
  if (m.includes("monthly usage") || m.includes("usage limit") || m.includes("not-enough-usage"))
    return "Apify's monthly allowance has run out. Runs work again when it renews, or once the Apify plan is raised.";
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

/** A platform's failure as the run log keeps it: its name and Apify's own words, cut short. */
const failedLine = (ch: string, msg: string) => `${ch} (${msg.replace(/\s+/g, " ").trim().slice(0, 160)})`;

/**
 * The run log's verdict, and the reason it gives.
 *
 * Until 20 Nov 2026 every run was logged as fine. So 26 Oct to 9 Nov, when
 * Apify's monthly allowance had run out and every platform came back empty,
 * read as three quiet weeks; and from 16 Nov, when Gemini was out of credit
 * and no post could be scored, as runs that found nothing new to keep.
 */
export function runVerdict(v: {
  /** Platforms the run set out to scrape. */
  channels: number;
  /** The platforms that failed, as failedLine writes them. */
  failed: string[];
  /** New posts the scrapes brought back, and how many of them were stored. */
  fresh: number;
  stored: number;
  /** Why the AI stopped the run (no key, no credit, a refused key, a model it can't use), if it did. */
  aiStopped: string | null;
  /** The last AI failure that did not stop the run, for when nothing could be stored. */
  aiError: string | null;
}): { ok: boolean; error: string | null } {
  const allFailed = v.channels > 0 && v.failed.length >= v.channels;
  const nothingStored = v.fresh > 0 && v.stored === 0;
  const reasons: string[] = [];
  if (v.aiStopped) reasons.push(`the AI could not score posts: ${v.aiStopped}`);
  if (v.failed.length) reasons.push(`${allFailed ? "every platform failed" : "failed"}: ${v.failed.join("; ")}`);
  if (nothingStored && !v.aiStopped) {
    reasons.push(`${v.fresh} new post${v.fresh === 1 ? "" : "s"} could not be scored or stored${v.aiError ? ` (last AI error: ${v.aiError})` : ""}`);
  }
  return { ok: !v.aiStopped && !allFailed && !nothingStored, error: reasons.length ? reasons.join(" · ") : null };
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
  // The Claude model chosen in PR & People Sentiment settings, as the news bot uses.
  const model = await getNewsSettings().then((s) => s.model, () => DEFAULT_NEWS_SETTINGS.model);
  const window = params.window ?? cfg.defaults.window;
  const maxItems = itemsPerPlatform(params.maxItems, cfg.defaults.maxItems);
  const subjects = params.subjects?.length ? params.subjects : cfg.subjects;
  const channels =
    params.channels?.length
      ? params.channels
      : (Object.keys(cfg.platforms) as SocialChannel[]).filter((c) => cfg.platforms[c].enabled);

  const result: SocialIngestResult = { found: 0, considered: 0, inserted: 0, skipped: 0, ok: true, error: null };

  p(`Starting · ${WINDOW_LABEL[window]} · ${maxItems}/platform · subjects: ${subjects.map((s) => s.name).join(", ")}`);
  p(`Platforms: ${channels.join(", ")}`);
  p(`─────────────────────────────────────`);

  const t0 = Date.now();
  // Stay safely under the function's maxDuration (300s). Each actor is given a
  // timeout sized to the time left in the run, so we never overrun — a slow
  // actor aborts cleanly instead of killing the whole function.
  const MAX_TOTAL = Number(process.env.SOCIAL_MAX_MS || 285_000);
  let scored = 0;
  /** Platforms whose scrape or store failed, with the reason: the run log's verdict. */
  const failedChannels: string[] = [];
  let freshTotal = 0;
  let storedTotal = 0;
  let aiStopped: string | null = null;
  let aiError: string | null = null;

  // Platforms run SEQUENTIALLY — only one actor holds Apify memory at a time, so
  // we never trip the account's concurrent-memory cap. Each platform's results
  // are scored + stored before moving on, so a slow/timed-out run keeps progress.
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci];
    if (aiStopped) {
      // Nothing more could be scored, so scraping on would only spend Apify credit.
      p(`⏹ Stopping before ${channels.slice(ci).join(", ")}: the AI can't score posts this run.`);
      break;
    }
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
      const msg = errorMessage(e);
      p(`  ✗ ${ch} failed: ${msg}`);
      p(`     why: ${failureHint(ch, msg)}`);
      failedChannels.push(failedLine(ch, msg));
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
    freshTotal += fresh.length;
    if (!fresh.length) {
      p(`  ${ch}: nothing new (${existing.size} already stored)`);
      continue;
    }

    // Score (Claude, fixed rubric), a few posts at a time, and store this
    // platform's rows now: only the ones actually scored. A post past the score
    // cap or the time budget, or one the AI gave no answer for, is left
    // unstored, so the next run sees it as new and scores it. Stored unscored,
    // 101 of 272 kept rows on 20 Oct had never been looked at, Build-A-Bear and
    // Florida roofing posts among them.
    const rows: Record<string, unknown>[] = [];
    let deferred = 0;
    let next = 0;
    while (next < fresh.length) {
      const room = Math.min(SCORE_AT_ONCE, SCORE_CAP - scored);
      // A batch can take a minute when Claude is slow (two tries of 30 s), so none starts without that much time left.
      if (aiStopped || room <= 0 || MAX_TOTAL - (Date.now() - t0) < 70_000) break;
      const batch = fresh.slice(next, next + room);
      next += batch.length;
      scored += batch.length;
      result.considered += batch.length;
      const answers = await Promise.all(
        batch.map(([, it]) => assessSocialMention(it.subject, it.subject_kind as "company" | "person", it.channel, it.content, model)),
      );
      answers.forEach((a, k) => {
        const [id, it] = batch[k];
        if ("failure" in a) {
          if (a.failure.stopRun) aiStopped ??= a.failure.message;
          else aiError = a.failure.message;
          deferred++;
          return;
        }
        const v = a.verdict;
        const keep = v.relevant && !v.noise;
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
          sentiment: v.sentiment,
          sentiment_score: v.score,
          sentiment_reason: v.reason,
          noise_class: v.noise,
          status: keep ? "new" : "rejected",
          source_actor: it.source_actor,
          query: it.query,
          raw: { likes: it.likes, comments: it.comments, shares: it.shares },
        });
      });
    }
    deferred += fresh.length - next;
    if (aiStopped) p(`  ✗ the AI stopped: ${aiStopped}`);
    if (deferred) p(`  ${ch}: ${deferred} left unscored for the next run (score cap, time, or no AI answer)`);
    if (!rows.length) continue;
    const { error } = await db.from("social_mentions").upsert(rows, { onConflict: "id" });
    if (error) {
      p(`  ✗ ${ch} store failed: ${error.message}`);
      failedChannels.push(failedLine(ch, `store failed: ${error.message}`));
      continue;
    }
    storedTotal += rows.length;
    const kept = rows.filter((r) => r.status === "new").length;
    result.inserted += kept;
    p(`  ✓ ${ch}: stored ${rows.length} (${kept} kept, ${rows.length - kept} filtered)`);
  }

  const verdict = runVerdict({ channels: channels.length, failed: failedChannels, fresh: freshTotal, stored: storedTotal, aiStopped, aiError });
  result.ok = verdict.ok;
  result.error = verdict.error;
  await db.from("social_runs").insert({
    trigger: params.trigger ?? "manual",
    ok: verdict.ok,
    error: verdict.error,
    found: result.found,
    considered: result.considered,
    inserted: result.inserted,
    skipped: result.skipped,
    params: { window, maxItems, channels, subjects: subjects.map((s) => s.name), model },
  });
  // Say so where people look, whoever started the run.
  if (verdict.error) {
    await notify("error", "social", verdict.ok ? "People sentiment: a platform failed" : "People sentiment run failed", verdict.error, "social:sync:failed");
  }

  p(`─────────────────────────────────────`);
  if (verdict.error) p(`⚠ ${verdict.error}`);
  p(`Done — ${result.inserted} kept · ${result.skipped} filtered out · ${result.found} seen`);
  return result;
}
