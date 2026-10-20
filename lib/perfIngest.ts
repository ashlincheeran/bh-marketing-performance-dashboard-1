// Social Performance ingestion. Runs on demand from the tab's "Run benchmark"
// button.
//
//   1. For each platform, scrape each configured brand's account via Apify
//      (platform-major, one account at a time so we never trip Apify's
//      concurrent-memory cap; a completed platform is fully benchmarked even if
//      the run later hits its time budget).
//   2. Compute the report's aggregates (followers, posts, format mix, avg likes /
//      comments, reel plays, engagement rate, total reach) from the posts.
//   3. Upsert social_perf_metrics (brand, platform) + the posts, log the run.
import crypto from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { scrapePerfAccount, type RawPerfPost } from "@/lib/socialPerf";
import {
  DEFAULT_PERF_CONFIG,
  PERF_PLATFORMS,
  isVideoType,
  mergePerfConfig,
  type PerfBrand,
  type PerfConfig,
  type PerfPlatform,
} from "@/lib/perfTypes";
import { WINDOW_LABEL, type TimeWindow } from "@/lib/socialTypes";

export interface PerfRunParams {
  window?: TimeWindow;
  maxItems?: number;
  platforms?: PerfPlatform[];
  brands?: PerfBrand[];
}

export interface PerfIngestResult {
  postsFound: number;
  metricsWritten: number;
}

function hashId(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

async function loadConfig(db: any): Promise<PerfConfig> {
  try {
    const { data } = await db.from("social_config").select("payload").eq("id", 1).maybeSingle();
    return mergePerfConfig((data?.payload as { benchmark?: Partial<PerfConfig> } | null)?.benchmark ?? null);
  } catch {
    return DEFAULT_PERF_CONFIG;
  }
}

// Plain-English "why it failed + what to do", shown under the error in the log.
/**
 * How many simultaneous Apify actor runs we allow.
 *
 * Apify caps the TOTAL memory reserved across an account's running actors (16 GB
 * on the plan this uses) and refuses the next launch with HTTP 402
 * "actor-memory-limit-exceeded" rather than queueing it. At ~4 GB reserved per
 * run that is four at once, so four is the default. Raise it via env if the
 * Apify plan's memory goes up.
 */
const MAX_APIFY_RUNS = Math.max(1, Number(process.env.SOCIAL_MAX_APIFY_RUNS || 4));

/** Actor runs each platform launches per account — Facebook needs page stats too. */
const RUNS_PER_ACCOUNT: Record<PerfPlatform, number> = {
  instagram: 1,
  tiktok: 1,
  facebook: 2,
  linkedin: 1,
};

/** Run `fn` over `items` with at most `limit` in flight. Order of completion is free. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function failureHint(platform: string, msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("timed out")) return "the actor ran past its time budget. Lower Items/platform or disable it; it retries next run.";
  if (m.includes("memory") || m.includes("402")) return "Apify's concurrent-memory cap was hit. Let other runs finish or lower Items/platform, then re-run.";
  if (m.includes("apify_token")) return "APIFY_TOKEN isn't set in the deployment environment variables.";
  if (m.includes("401") || m.includes("403")) return "Apify rejected the request — check APIFY_TOKEN is valid and not rotated.";
  if (m.includes("404")) return `the Apify actor id for ${platform} wasn't found — check it in Advanced → ${platform}.`;
  if (m.includes("http 5")) return "Apify had a server-side error — try again in a moment.";
  return `check the ${platform} actor id and the account handle in Advanced, or try again.`;
}

// Turn a brand's posts + followers into the report's aggregate row.
function aggregate(posts: RawPerfPost[], followers: number | null) {
  const n = posts.length;
  const videos = posts.filter((p) => isVideoType(p.type));
  const reels = videos.length;
  const sum = (f: (p: RawPerfPost) => number) => posts.reduce((a, p) => a + f(p), 0);
  const avgLikes = n ? sum((p) => p.likes) / n : 0;
  const avgComments = n ? sum((p) => p.comments) / n : 0;
  const playVals = videos.map((p) => p.plays).filter((v): v is number => v != null);
  const avgPlays = playVals.length ? playVals.reduce((a, b) => a + b, 0) / playVals.length : null;
  const totalPlays = posts.reduce((a, p) => a + (p.plays ?? 0), 0);
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    posts: n,
    reels,
    images: n - reels,
    avg_likes: round1(avgLikes),
    avg_comments: round1(avgComments),
    avg_plays: avgPlays == null ? null : Math.round(avgPlays),
    total_plays: totalPlays,
    // No posts is no rate, not 0%: Allsopp's Facebook read "0 posts, 0%" on every
    // run since 30 Jul because the scraper returned nothing for the page.
    engagement_rate: n && followers && followers > 0 ? round2(((avgLikes + avgComments) / followers) * 100) : null,
  };
}

export async function runPerfIngest(
  params: PerfRunParams,
  onProgress?: (msg: string) => void,
): Promise<PerfIngestResult> {
  const p = onProgress ?? (() => {});
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN not set — add it to the Vercel environment variables");

  const cfg = await loadConfig(db);
  const window = params.window ?? cfg.defaults.window;
  const maxItems = params.maxItems ?? cfg.defaults.maxItems;
  const brands = params.brands?.length ? params.brands : cfg.brands;
  const platforms = params.platforms?.length ? params.platforms : (PERF_PLATFORMS.map((x) => x.key) as PerfPlatform[]);
  const periodLabel = WINDOW_LABEL[window];

  const result: PerfIngestResult = { postsFound: 0, metricsWritten: 0 };

  p(`Starting · ${periodLabel} · ${maxItems}/account · brands: ${brands.map((b) => b.name).join(", ")}`);
  p(`Platforms: ${platforms.join(", ")}`);
  p(`─────────────────────────────────────`);

  // Log the run first so per-account rows can reference its id (progress survives
  // a mid-run timeout).
  const { data: runRow } = await db
    .from("social_perf_runs")
    .insert({ trigger: "manual", ok: true, time_window: window, brands: brands.length, platforms, params: { maxItems } })
    .select("id")
    .maybeSingle();
  const runId = (runRow?.id as number | undefined) ?? null;

  const t0 = Date.now();
  const MAX_TOTAL = Number(process.env.SOCIAL_MAX_MS || 285_000);

  // One account: scrape it, store its posts, upsert its snapshot. Never throws —
  // a brand that fails is reported and the rest of the platform carries on.
  // An arrow const, not a `function` declaration: declarations hoist above the
  // `if (!db) throw` guard, which loses db's non-null narrowing inside the body.
  const runAccount = async (platform: PerfPlatform, actor: string, brand: PerfBrand, timeoutMs: number) => {
    const handle = (brand.handles[platform] as string).trim();
    const ctx = { window, maxItems, p, timeoutMs };
    let followers: number | null = null;
    let posts: RawPerfPost[] = [];
    try {
      const res = await scrapePerfAccount(platform, actor, handle, ctx);
      followers = res.followers;
      posts = res.posts;
      p(`  ✓ ${brand.name}: ${posts.length} posts · ${followers != null ? followers.toLocaleString() : "?"} followers`);
      // Say why it was empty, so "0 posts" is never ambiguous.
      if (res.note) p(`     note: ${res.note}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      p(`  ✗ ${brand.name} (${platform}) failed: ${msg}`);
      p(`     why: ${failureHint(platform, msg)}`);
      return;
    }
    result.postsFound += posts.length;

    const agg = aggregate(posts, followers);

    // Store the individual posts (top-post cards + audit).
    if (posts.length) {
      const rows = posts.map((it) => {
        const ext = it.external_id ?? it.url ?? (it.caption ?? "").slice(0, 60);
        return {
          id: hashId(`${brand.name}|${platform}|${ext}`),
          brand: brand.name,
          is_us: brand.isUs,
          platform,
          external_id: it.external_id,
          url: it.url,
          type: it.type,
          posted_at: it.posted_at,
          likes: it.likes,
          comments: it.comments,
          shares: it.shares,
          plays: it.plays,
          caption: it.caption?.slice(0, 500) ?? null,
          source_actor: actor,
          run_id: runId,
        };
      });
      const { error } = await db.from("social_perf_posts").upsert(rows, { onConflict: "id" });
      if (error) p(`     ⚠ ${brand.name}: post store failed: ${error.message}`);
    }

    // Upsert the aggregate snapshot for this brand+platform.
    const { error: mErr } = await db.from("social_perf_metrics").upsert(
      {
        brand: brand.name,
        is_us: brand.isUs,
        platform,
        followers,
        ...agg,
        time_window: window,
        period_label: periodLabel,
        source: "live",
        run_id: runId,
        captured_at: new Date().toISOString(),
      },
      { onConflict: "brand,platform" },
    );
    if (mErr) p(`     ⚠ ${brand.name}: metrics store failed: ${mErr.message}`);
    else result.metricsWritten++;
  };

  // Platform-major: finish a whole platform (all brands) before the next, so a
  // completed platform is fully comparable even if we later run out of time.
  //
  // Within a platform the accounts run CONCURRENTLY — they're independent, one
  // upsert each — because running them serially made the job miss its deadline:
  // 16 accounts sharing 285s left ~18s apiece, and one slow Facebook page ate
  // the remainder so later platforms never ran. Concurrency doesn't change the
  // number of actor runs, so it costs no extra Apify credit.
  //
  // But it IS capped, because Apify bills memory across all your simultaneous
  // runs and rejects the next launch with HTTP 402 once they exceed the account
  // limit. So the cap is on concurrent ACTOR RUNS, not accounts — Facebook
  // launches two per account (posts + page stats), so it gets half the fan-out.
  for (const platform of platforms) {
    const actor = cfg.actors[platform];
    const accounts = brands.filter((b) => (b.handles?.[platform] ?? "").trim());
    if (!accounts.length) {
      p(`▶ ${platform}: no handles set — skipped (add them in Advanced).`);
      continue;
    }

    const remaining = MAX_TOTAL - (Date.now() - t0);
    if (remaining < 30_000) {
      p(`⏱ Time budget reached — ${platform} and any platform after it were skipped (run again to continue).`);
      break;
    }

    const limit = Math.max(1, Math.floor(MAX_APIFY_RUNS / RUNS_PER_ACCOUNT[platform]));
    const lanes = Math.min(limit, accounts.length);
    p(`▶ ${platform} — ${accounts.length} account(s) via ${actor}, ${lanes} at a time`);

    // Accounts in a lane get the whole remaining window: they run together, so a
    // wave takes as long as its slowest account rather than the sum.
    const timeoutMs = Math.min(120_000, remaining - 8_000);
    await mapLimit(accounts, lanes, (brand) => runAccount(platform, actor, brand, timeoutMs));
  }

  if (runId != null) {
    await db
      .from("social_perf_runs")
      .update({ posts_found: result.postsFound, metrics_written: result.metricsWritten })
      .eq("id", runId);
  }

  p(`─────────────────────────────────────`);
  p(`Done — ${result.metricsWritten} brand/platform snapshots · ${result.postsFound} posts`);
  return result;
}
