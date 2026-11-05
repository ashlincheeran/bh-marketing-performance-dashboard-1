"use server";

import { cookies } from "next/headers";
import { keepSupported, refreshInsightsCache } from "@/lib/insights";
import { getSovBrands } from "@/lib/competitors";
import { getWebMetrics } from "@/lib/posthog";
import {
  KEPT_NOTE,
  REJECTED_NOTE,
  checkPersonInput,
  getPerfMetrics,
  keepDecision,
  keptPatch,
  keptRow,
  readAllRows,
  rejectedPatch,
} from "@/lib/data";
import { PERF_PLATFORM_META, type PerfPlatform } from "@/lib/perfTypes";
import { adminClient } from "@/lib/supabase";
import { getReportSettings, saveReportSettings, type ReportSettings } from "@/lib/reportSettings";
import { cleanNewsSettings } from "@/lib/appSettings";
import { COOKIES, expectedToken, safeEqual } from "@/lib/gate";
import { loadRegistry } from "@/lib/news/registry";
import { startNewsRun } from "@/lib/news/run";
import { loadOutlets, mentionRowsFor, ourMentionId, type LegacyRow, type MentionRow } from "@/lib/news/write";
import type { ArticleRow, NewsSettings } from "@/lib/news/types";
import { revalidatePath } from "next/cache";

type Db = NonNullable<ReturnType<typeof adminClient>>;

const NO_ADMIN = "SUPABASE_SERVICE_ROLE_KEY not set";

const fail = (error: string) => ({ ok: false as const, error });

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The tables these actions write, and the migration that makes each, so a
 * deployment missing one says which to apply. PostgREST words a missing table
 * two ways, depending on its version.
 */
const MIGRATION_FOR: Record<string, string> = {
  app_settings: "0013",
  tracked_people: "0018",
  news_articles: "0020",
};

function dbHint(message: string): string {
  const table =
    /relation "?(?:public\.)?([a-z_]+)"? does not exist/i.exec(message)?.[1] ??
    /could not find the table '(?:public\.)?([a-z_]+)'/i.exec(message)?.[1];
  const migration = table ? MIGRATION_FOR[table] : undefined;
  return migration ? `The ${table} table isn't created yet: apply migration ${migration}.` : message;
}

// Approve (keep) or reject an item the bot found, from the Bot Activity page.
// The person's verdict goes in metadata.personVerdict as well as the status,
// merged into what the row already holds, because that is the mark the news
// bot checks before it changes a row (lib/news/write.ts, decidedByPerson).
export async function setMentionStatusAction(id: string, status: "new" | "reviewed" | "rejected") {
  const db = adminClient();
  if (!db) return { ok: false as const, error: NO_ADMIN };
  if (status !== "new" && status !== "reviewed" && status !== "rejected") return fail("Unknown status.");
  const { data, error: readError } = await db.from("mentions").select("metadata").eq("id", id).maybeSingle();
  if (readError) return fail(readError.message);
  if (!data) return fail("That story is no longer stored.");
  const metadata = { ...asRecord(data.metadata), personVerdict: status === "rejected" ? "rejected" : "kept" };
  const { error } = await db.from("mentions").update({ status, metadata }).eq("id", id);
  revalidatePath("/bot");
  revalidatePath("/pr");
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Add a keyword the bot should search. kind 'pr' = betterhomes searches,
// 'competitor' = Share-of-Voice + competitor-news searches.
export async function addKeywordAction(kind: "pr" | "competitor", query: string, label?: string) {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  const q = query.trim().slice(0, 120);
  if (!q) return { ok: false as const, error: "Keyword is empty" };
  if (kind !== "pr" && kind !== "competitor") return { ok: false as const, error: "Bad kind" };
  const row = {
    kind,
    query: q,
    label: kind === "competitor" ? (label?.trim() || titleCase(q)) : null,
    active: true,
  };
  const { error } = await db.from("tracked_keywords").upsert(row, { onConflict: "kind,query" });
  revalidatePath("/pr");
  if (error) {
    const hint = /relation .*tracked_keywords.* does not exist/i.test(error.message)
      ? "The tracked_keywords table isn't created yet — apply migration 0006."
      : error.message;
    return { ok: false as const, error: hint };
  }
  return { ok: true as const };
}

// Remove a tracked keyword by id.
export async function removeKeywordAction(id: number) {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  const { error } = await db.from("tracked_keywords").delete().eq("id", id);
  revalidatePath("/pr");
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}

// Regenerate the AI competitive insights on demand (the "↻ Refresh" button on
// the insights panel). Reads the latest competitor + betterhomes headlines and
// asks Gemini for fresh recommendations.
export async function refreshInsightsAction() {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const r = await refreshInsightsCache(db);
    revalidatePath("/pr");
    return r.ok
      ? { ok: true as const }
      : { ok: false as const, error: "No AI key set, or not enough recent news to analyse yet." };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// "Receive Insights" button — asks Gemini for date-range-aware strategic
// recommendations based on ALL the data visible in that period.
export async function receiveInsightsAction(from: string, to: string) {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false as const, error: "No Gemini API key configured — add GEMINI_API_KEY to env vars." };

  const fromDate = `${from}-01`;
  // The month's real last day. "2026-09-31" is not a date: Postgres rejected it
  // (22008) for every 30-day month and February, the errors went unread, and
  // Gemini was told the range had 0 mentions and no competitor data.
  const [toY, toM] = to.split("-").map(Number);
  const toDate = new Date(Date.UTC(toY, toM, 0)).toISOString().slice(0, 10);

  try {
    const [ourRes, compRes, all] = await Promise.all([
      db.from("mentions")
        .select("title,published_on,outlet_name,tier,sentiment")
        .eq("brand", "betterhomes")
        .neq("status", "rejected")
        .gte("published_on", fromDate)
        .lte("published_on", toDate)
        .order("published_on", { ascending: false })
        .limit(300),
      db.from("mentions")
        .select("title,published_on,outlet_name,metadata")
        .eq("source", "competitor_news")
        .neq("status", "rejected")
        .gte("published_on", fromDate)
        .lte("published_on", toDate)
        .order("published_on", { ascending: false })
        .limit(300),
      // The stats need every row in range, not the first 1,000.
      readAllRows((f, t) =>
        db.from("mentions")
          .select("id,published_on,tier,sentiment")
          .eq("brand", "betterhomes")
          .neq("status", "rejected")
          .gte("published_on", fromDate)
          .lte("published_on", toDate)
          .order("id", { ascending: true })
          .range(f, t),
      ),
    ]);
    // A failed read is an error to show, never an empty period to analyse.
    const readError = ourRes.error?.message ?? compRes.error?.message ?? all.error;
    if (readError) return { ok: false as const, error: `Couldn't read this range's coverage: ${readError}` };
    const ourRows = ourRes.data;
    const compRows = compRes.data;
    const allRows = all.rows;

    const total = allRows?.length ?? 0;
    const t1 = allRows?.filter((m: any) => m.tier === "T1-Global" || m.tier === "T1-Local").length ?? 0;
    const scored = allRows?.filter((m: any) => m.sentiment) ?? [];
    const posCount = scored.filter((m: any) => m.sentiment === "positive").length;
    const posPct = scored.length ? Math.round((posCount / scored.length) * 100) : null;

    const byBrand = new Map<string, string[]>();
    for (const r of (compRows ?? []) as { title: string; metadata: { competitor?: string } | null }[]) {
      const b = r.metadata?.competitor ?? "Competitor";
      const arr = byBrand.get(b) ?? [];
      if (arr.length < 30 && r.title) arr.push(r.title);
      byBrand.set(b, arr);
    }
    const ourTitles = ((ourRows ?? []) as { title: string }[]).map((r) => r.title).filter(Boolean).slice(0, 60);

    let corpus = `PERIOD: ${from} → ${to}\n\n`;
    corpus += `BETTERHOMES STATS: ${total} mentions · ${t1} Tier-1 ` +
      `(${total ? Math.round((t1 / total) * 100) : 0}%) · ` +
      `${posPct != null ? `${posPct}% positive sentiment` : "no sentiment scored yet"}\n\n`;
    corpus += `BETTERHOMES HEADLINES (${ourTitles.length}):\n`;
    corpus += ourTitles.length ? ourTitles.map((t) => `- ${t}`).join("\n") : "- (none in this range)";
    // No competitor section at all when there is no competitor data: asked to
    // "name actual competitors" over an empty one, the model invents them.
    const hasRivals = byBrand.size > 0;
    if (hasRivals) corpus += "\n\nCOMPETITOR HEADLINES:\n";
    for (const [brand, titles] of byBrand) {
      corpus += `\n[${brand}] — ${titles.length} stories\n${titles.map((t) => `- ${t}`).join("\n")}\n`;
    }

    const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const prompt =
      `You are a senior PR strategist for "betterhomes", a real-estate brokerage in DUBAI, UAE. ` +
      `The PR manager has selected the period ${from} to ${to} and clicked "Receive Insights". ` +
      `Based on the data below, give specific forward-looking strategy — NOT metric summaries or dashboard recaps. ` +
      (hasRivals
        ? `Every insight must be a concrete action: what to publish, which competitor to counter-program, which topic or outlet to target next, which audience angle is untapped. ` +
          `Be specific — name actual competitors, topics, outlets and audiences you see in the data, and only those. `
        : `Every insight must be a concrete action: what to publish, which topic or outlet to target next, which audience angle is untapped. ` +
          `No competitor coverage is stored for this period, so do NOT name, compare with or describe any other company. ` +
          `Be specific — name topics, outlets and audiences you see in betterhomes' own coverage. `) +
      `\n\n${corpus}\n\n` +
      `Return ONLY a JSON array of 5-6 objects: {"kind":"...","label":"...","text":"..."}. ` +
      `kind: "high" (urgent gap/opportunity), "medium" (worth doing soon), "win" (strength to protect/scale). ` +
      `label: 3-6 word headline. text: 2-3 specific actionable sentences — no generic advice. ` +
      `Never start text with "In the period" or "betterhomes had X mentions" — go straight to the action.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 1600 },
        }),
        cache: "no-store",
      },
    );
    const json = await res.json();
    const rawText = String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const s = cleaned.indexOf("[");
    const e = cleaned.lastIndexOf("]");
    if (s === -1 || e === -1 || e <= s) return { ok: false as const, error: "Gemini returned unexpected format" };
    const arr: { kind?: string; label?: string; text?: string }[] = JSON.parse(cleaned.slice(s, e + 1));
    const ALLOWED = new Set(["high", "medium", "win", "test"]);
    const parsed = arr
      .map((it) => ({
        kind: ALLOWED.has(it?.kind ?? "") ? (it.kind as string) : "medium",
        label: String(it?.label ?? "").slice(0, 60),
        text: String(it?.text ?? "").slice(0, 500),
      }))
      .filter((it) => it.label && it.text);
    if (!parsed.length) return { ok: false as const, error: "No insights returned — try a wider date range." };
    // Any suggestion naming a company this range's data never mentions is dropped.
    const rivals = (await getSovBrands()).filter((b) => !b.isUs).map((b) => b.name);
    const insights = keepSupported(parsed, corpus, rivals, hasRivals);
    if (!insights.length) {
      return { ok: false as const, error: "Every suggestion made claims about companies this range's coverage doesn't include, so none are shown. Try again." };
    }
    return { ok: true as const, insights, from, to };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// Save the People Sentiment config (subjects + per-platform source settings)
// from the tab's editor. Single-row table (id=1).
export async function saveSocialConfigAction(payload: unknown) {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const { error } = await db
      .from("social_config")
      .upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) {
      const hint = /relation .*social_config.* does not exist/i.test(error.message)
        ? "The social_config table isn't created yet — apply migration 0008."
        : error.message;
      return { ok: false as const, error: hint };
    }
    revalidatePath("/people");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// Save the Social Performance benchmark config (brands + per-platform handles +
// actor ids). Stored under the `benchmark` key of the single social_config row
// via read-modify-write, so it never clobbers the sentiment config there.
export async function savePerfConfigAction(benchmark: unknown) {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const { data } = await db.from("social_config").select("payload").eq("id", 1).maybeSingle();
    const payload = { ...((data?.payload as Record<string, unknown>) ?? {}), benchmark };
    const { error } = await db
      .from("social_config")
      .upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) {
      const hint = /relation .*social_config.* does not exist/i.test(error.message)
        ? "The social_config table isn't created yet — apply migration 0008."
        : error.message;
      return { ok: false as const, error: hint };
    }
    revalidatePath("/people");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// "Receive insights" on the Performance benchmark — Gemini reads the per-brand
// metrics for the selected platform and returns competitive, actionable takeaways
// (the live version of the report's closing "what to take from this" slide).
export async function receivePerfInsightsAction(platform: string) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false as const, error: "No Gemini API key configured — add GEMINI_API_KEY to env vars." };
  try {
    const rows = (await getPerfMetrics()).filter((m) => m.platform === platform);
    if (!rows.length) return { ok: false as const, error: "No benchmark data for this platform yet — run the benchmark first." };
    const meta = PERF_PLATFORM_META[platform as PerfPlatform];
    const name = meta?.name ?? platform;
    const playLabel = meta?.playLabel ?? "plays";
    const videoLabel = meta?.videoLabel ?? "videos";

    // Instagram returns each account's latest 12 posts, not a month of them, and
    // a 0-post row is a scrape that came back empty. Unsaid, the model reads the
    // first as "posts less" and the second as "0% engagement".
    const igNote =
      platform === "instagram"
        ? `Note: Instagram returns only each account's latest 12 posts, so post counts and total reach cover a different number of days per brand and are NOT monthly totals. Compare averages and rates, not totals.\n`
        : "";
    let corpus = `PLATFORM: ${name}\nPeriod: ${rows[0].period_label ?? "recent"}\n${igNote}\n`;
    for (const r of rows) {
      if (r.posts === 0) {
        corpus += `${r.brand}${r.is_us ? " (THIS IS US — betterhomes)" : ""}: followers ${r.followers ?? "?"}, no posts returned by the scraper this run (no data, not zero activity)\n`;
        continue;
      }
      corpus +=
        `${r.brand}${r.is_us ? " (THIS IS US — betterhomes)" : ""}: ` +
        `followers ${r.followers ?? "?"}, posts ${r.posts} (${r.reels} ${videoLabel} / ${r.images} static), ` +
        `avg likes ${r.avg_likes}, avg comments ${r.avg_comments}, ` +
        `avg ${playLabel} ${r.avg_plays ?? "n/a"}, total reach ${r.total_plays}, ` +
        `engagement rate ${r.engagement_rate ?? "n/a"}%\n`;
    }

    const prompt =
      `You are a social-media strategist for "betterhomes", a real-estate brokerage in DUBAI, UAE. ` +
      `Below is a ${name} performance benchmark of betterhomes against competitor agencies for ${rows[0].period_label ?? "the period"}. ` +
      `Compare betterhomes to the competitors and give specific, forward-looking actions to close gaps and scale strengths — ` +
      `what format mix to shift to, whose content to study, what to post more/less of, how to lift reach and engagement. ` +
      `Name actual competitors and numbers from the data. Do NOT just restate the metrics.` +
      `\n\n${corpus}\n\n` +
      `Return ONLY a JSON array of 4-6 objects: {"kind":"...","label":"...","text":"..."}. ` +
      `kind: "high" (urgent gap to close), "medium" (worth doing), "win" (strength to protect/scale). ` +
      `label: 3-6 word headline. text: 2-3 specific, actionable sentences.`;

    const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 1600 } }),
        cache: "no-store",
      },
    );
    const json = await res.json();
    const raw = String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const s = cleaned.indexOf("[");
    const e = cleaned.lastIndexOf("]");
    if (s === -1 || e === -1 || e <= s) return { ok: false as const, error: "Gemini returned an unexpected format" };
    const arr: { kind?: string; label?: string; text?: string }[] = JSON.parse(cleaned.slice(s, e + 1));
    const ALLOWED = new Set(["high", "medium", "win", "test"]);
    const insights = arr
      .map((it) => ({ kind: ALLOWED.has(it?.kind ?? "") ? (it.kind as string) : "medium", label: String(it?.label ?? "").slice(0, 60), text: String(it?.text ?? "").slice(0, 500) }))
      .filter((it) => it.label && it.text);
    if (!insights.length) return { ok: false as const, error: "No insights returned — run the benchmark first." };
    const span = platform === "instagram" ? "latest 12 posts per account" : (rows[0].period_label ?? "");
    return { ok: true as const, insights, label: `${name} · ${span}`.trim() };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// "Receive insights" on the SEO tab — Gemini reads the (bot-filtered) web
// analytics for the selected range and returns data-driven recommendations.
export async function receiveWebInsightsAction(days: number, from?: string, to?: string) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false as const, error: "No Gemini API key configured — add GEMINI_API_KEY to env vars." };
  try {
    const m = await getWebMetrics(days, from, to, true); // humans only
    if (!m.connected) return { ok: false as const, error: "PostHog isn't connected (POSTHOG_API_KEY missing)." };
    if (!m.hasData || !m.overview) return { ok: false as const, error: "No website data in this range yet." };

    const chans = m.flow.nodes.filter((n) => n.col === 0).map((n) => `${n.label} ${n.value}`).join(", ");
    // getUserFlow builds only "source" and "page" nodes, so the lookups for
    // "outcome:Bounced" / "Browsed" nodes always came back empty and Gemini was
    // told "0 sessions bounced vs 0 browsed". Browsed = sessions that reached a
    // second page (the flow's second page column, i.e. the links out of the
    // first); bounced = every other session.
    const browsed = m.flow.nodes.filter((n) => n.col === 2).reduce((a, n) => a + n.value, 0);
    const bounced = Math.max(0, m.flow.sessions - browsed);

    let corpus = `PERIOD: ${m.label} (real humans only — ${m.bots.pct}% of raw traffic was bots and is excluded)\n`;
    corpus += `Visitors ${m.overview.visitors} · Pageviews ${m.overview.pageviews} · Sessions ${m.overview.sessions} · Organic-search sessions ${m.overview.organic}\n\n`;
    corpus += `TOP PAGES:\n${m.topPages.map((p) => `- ${p.path} (${p.views})`).join("\n") || "- (none)"}\n\n`;
    corpus += `TOP SOURCES:\n${m.sources.map((s) => `- ${s.source} (${s.sessions})`).join("\n") || "- (none)"}\n\n`;
    corpus += `TOP COUNTRIES:\n${m.countries.map((c) => `- ${c.country} (${c.visitors})`).join("\n") || "- (none)"}\n\n`;
    corpus += `JOURNEYS: entry channels [${chans}] · ${bounced} sessions bounced vs ${browsed} browsed 2+ pages\n`;

    const prompt =
      `You are a senior web & SEO strategist for "betterhomes", a real-estate brokerage in DUBAI, UAE. ` +
      `Based ONLY on the real website analytics below (bots already removed), give specific, forward-looking, data-driven recommendations — what to fix, what to double down on, what to test. ` +
      `Be concrete: name actual pages, sources, and countries from the data. Do NOT just restate the metrics. ` +
      `\n\n${corpus}\n\n` +
      `Return ONLY a JSON array of 5-6 objects: {"kind":"...","label":"...","text":"..."}. ` +
      `kind: "high" (urgent fix/opportunity), "medium" (worth doing), "win" (strength to scale). ` +
      `label: 3-6 word headline. text: 2-3 specific, actionable sentences.`;

    const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 1600 } }),
        cache: "no-store",
      },
    );
    const json = await res.json();
    const raw = String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const s = cleaned.indexOf("[");
    const e = cleaned.lastIndexOf("]");
    if (s === -1 || e === -1 || e <= s) return { ok: false as const, error: "Gemini returned an unexpected format" };
    const arr: { kind?: string; label?: string; text?: string }[] = JSON.parse(cleaned.slice(s, e + 1));
    const ALLOWED = new Set(["high", "medium", "win", "test"]);
    const insights = arr
      .map((it) => ({ kind: ALLOWED.has(it?.kind ?? "") ? (it.kind as string) : "medium", label: String(it?.label ?? "").slice(0, 60), text: String(it?.text ?? "").slice(0, 500) }))
      .filter((it) => it.label && it.text);
    if (!insights.length) return { ok: false as const, error: "No insights returned — try a wider range." };
    return { ok: true as const, insights, label: m.label };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Bot Activity's Run now button: starts a run of the news bot
 * (docs/news-pipeline.md) and returns at once. The run works through its
 * steps on its own, a few minutes in all, and Bot Activity shows its numbers
 * as they come in. No secret reaches the browser: startNewsRun hands the
 * first step to /api/news from here, on the server.
 */
export async function runNewsBotAction() {
  try {
    const r = await startNewsRun("manual");
    revalidatePath("/pr");
    if (!r.started) return fail(r.error ?? "The news bot did not start. A run may already be working: its numbers appear below as it goes.");
    return { ok: true as const, runId: r.runId };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// Save the SEO tab's target keyword list (tracked in GSC). Single-row config.
export async function saveSeoConfigAction(keywords: unknown) {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const clean = (Array.isArray(keywords) ? keywords : [])
      .map((k) => String(k).trim())
      .filter(Boolean)
      .slice(0, 100);
    const { error } = await db
      .from("seo_config")
      .upsert({ id: 1, payload: { keywords: clean }, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) {
      const hint = /relation .*seo_config.* does not exist/i.test(error.message)
        ? "The seo_config table isn't created yet — apply migration 0010."
        : error.message;
      return { ok: false as const, error: hint };
    }
    revalidatePath("/seo");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Save which ad accounts the Digital Performance tab shows.
 *
 * Accepts { google: [{id,name}], meta: [...], linkedin: [...] }. Only the id and
 * name are stored — everything else about an account is read live, so persisting
 * more would just go stale.
 */
export async function savePaidConfigAction(accounts: unknown) {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const src = (accounts ?? {}) as Record<string, unknown>;
    const clean = (k: string) =>
      (Array.isArray(src[k]) ? (src[k] as unknown[]) : [])
        .map((a) => {
          const o = (a ?? {}) as { id?: unknown; name?: unknown };
          return { id: String(o.id ?? "").trim(), name: String(o.name ?? "").trim() };
        })
        .filter((a) => a.id)
        .slice(0, 50);
    const payload = { accounts: { google: clean("google"), meta: clean("meta"), linkedin: clean("linkedin") } };
    const { error } = await db
      .from("paid_config")
      .upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) {
      const hint = /relation .*paid_config.* does not exist/i.test(error.message)
        ? "The paid_config table isn't created yet — apply migration 0012."
        : error.message;
      return { ok: false as const, error: hint };
    }
    revalidatePath("/digital");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Choose where the SEO tab's Search Console figures come from. Admin only.
 *
 * Deployment-wide, like the Supermetrics switch, and behind the same settings
 * PIN — the choice decides whether every viewer's SEO page spends the shared
 * Supermetrics quota, so it cannot be a per-browser preference.
 *
 * "direct" is refused when its credentials are missing. Accepting it would
 * blank the SEO figures for everyone the moment it was saved, and the reason
 * would only be visible to someone who went looking.
 */
export async function setSeoSourceAction(source: "supermetrics" | "direct") {
  if (source !== "supermetrics" && source !== "direct") {
    return { ok: false as const, error: "Unknown source." };
  }
  if (source === "direct" && !(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY)) {
    return {
      ok: false as const,
      error: "GSC_CLIENT_EMAIL and GSC_PRIVATE_KEY aren't set in Vercel yet, so the direct API can't answer. Add them first.",
    };
  }
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const { data } = await db.from("app_settings").select("payload").eq("id", 1).maybeSingle();
    // Merge, so the Supermetrics switch and its note survive this save.
    const payload = { ...((data?.payload as Record<string, unknown>) ?? {}), seoSource: source };
    const { error } = await db
      .from("app_settings")
      .upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) return { ok: false as const, error: error.message };
    for (const p of ["/", "/seo", "/settings"]) revalidatePath(p);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Flip the global Supermetrics switch. Admin only.
 *
 * Reached exclusively from /settings, which proxy.ts puts behind the settings
 * PIN — the action itself is not a second gate, so it must never be linked from
 * anywhere ungated. Every viewer is affected, which is the point: the quota is
 * shared, so pausing it has to be a deployment-wide decision, not a per-browser
 * preference.
 */
export async function setSupermetricsEnabledAction(enabled: boolean, note = "") {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  try {
    const { data } = await db.from("app_settings").select("payload").eq("id", 1).maybeSingle();
    // Merge, so a future switch added alongside this one is not wiped by a save.
    const payload = {
      ...((data?.payload as Record<string, unknown>) ?? {}),
      supermetricsEnabled: !!enabled,
      note: String(note ?? "").slice(0, 200),
    };
    const { error } = await db
      .from("app_settings")
      .upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) {
      const hint = /relation .*app_settings.* does not exist/i.test(error.message)
        ? "The app_settings table isn't created yet — apply migration 0013."
        : error.message;
      return { ok: false as const, error: hint };
    }
    // Every tab reads this, so revalidate the lot rather than guessing which.
    for (const p of ["/", "/digital", "/seo", "/settings", "/company", "/portals", "/website"]) revalidatePath(p);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Save the weekly email's settings. Admin only.
 *
 * Reached exclusively from /settings, which proxy.ts puts behind the settings
 * PIN. Returns the settings as stored, so the form shows what was cleaned up:
 * duplicate and malformed addresses are dropped rather than rejected.
 */
export async function saveReportSettingsAction(next: ReportSettings) {
  try {
    const error = await saveReportSettings(next);
    if (error) return { ok: false as const, error };
    revalidatePath("/settings");
    const stored = await getReportSettings();
    return { ok: true as const, settings: stored };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── The news bot: Keep and Reject, the spokespeople, its settings ─

/** An article id as the store makes it: "na_" and a hash for a found article, "lm_" and the old row's id for an import. */
const ARTICLE_ID = /^[A-Za-z0-9_-]{1,100}$/;

const articleIdOf = (v: unknown): string | null => {
  const id = typeof v === "string" ? v.trim() : "";
  return ARTICLE_ID.test(id) ? id : null;
};

/** A string to match as it is inside a LIKE pattern, where "_" and "%" would otherwise match anything. */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Leave a person's verdict in the article's note, where Bot Activity shows
 * it. Best effort, after the rows are written: the rows are what count, and
 * they carry the verdict too.
 */
async function noteArticle(db: Db, id: string, note: string): Promise<void> {
  const { error } = await db.from("news_articles").update({ note, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error(`[news] could not note ${id} as "${note}": ${error.message}`);
}

/** The old bot's row an imported article came from, as mentionRowsFor reads it, or null. */
async function legacyRowOf(db: Db, article: ArticleRow): Promise<LegacyRow | null> {
  if (!article.legacy_mention_id) return null;
  const { data, error } = await db.from("mentions").select("id,source,metadata").eq("id", article.legacy_mention_id).maybeSingle();
  if (error) throw new Error(`the old bot's row could not be read: ${error.message}`);
  if (!data) return null;
  const competitor = asRecord(data.metadata).competitor;
  return {
    id: String(data.id),
    source: (data.source as string | null) ?? null,
    competitor: typeof competitor === "string" ? competitor : null,
  };
}

/**
 * Write our row for an article a person kept: added when it is new, else
 * changed in place, keeping what the stored row knows. A row a run adds
 * between the read and the write is changed in place on a second go. Returns
 * why it failed, or null.
 */
async function writeKept(db: Db, rowId: string, made: MentionRow, articleId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: stored, error: readError } = await db.from("mentions").select("id,metadata").eq("id", rowId).maybeSingle();
    if (readError) return readError.message;
    if (stored) {
      const { error } = await db.from("mentions").update(keptPatch(stored, made, articleId)).eq("id", rowId);
      return error ? error.message : null;
    }
    const { error } = await db.from("mentions").insert(keptRow(made));
    if (!error) return null;
    if (!/duplicate key|unique/i.test(error.message)) return error.message;
  }
  return "the row kept changing while it was being saved, so try again";
}

/**
 * Keep, from Bot Activity: the PR team says the article is ours. Our row for
 * it counts from now on, reviewed and marked as their verdict, which the bot
 * never overrides (docs/news-pipeline.md, rule 6). The row is made the way
 * the bot makes one (lib/news/write.ts, mentionRowsFor), under the old bot's
 * id when the article came from the old bot's row for us, so the story is
 * still counted once.
 */
export async function keepArticleAction(articleId: string) {
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  const id = articleIdOf(articleId);
  if (!id) return fail("That is not an article the bot stored.");
  try {
    const { data, error } = await db.from("news_articles").select("*").eq("id", id).maybeSingle();
    if (error) return fail(`The article could not be read: ${dbHint(error.message)}`);
    if (!data) return fail("That article is no longer stored.");
    const article = data as ArticleRow;
    // A copy's original is the one that counts: keeping the copy would count the story twice.
    if (article.status === "duplicate") return fail("This is the same article as another one in the list. Keep that one instead.");
    const [reg, outlets, legacy] = await Promise.all([loadRegistry(), loadOutlets(), legacyRowOf(db, article)]);
    const checkedAt = new Date().toISOString();
    const ours = mentionRowsFor(article, keepDecision(article, reg, checkedAt), reg, outlets, checkedAt, legacy).find(
      (r) => r.brand === reg.us.label,
    );
    if (!ours) return fail("The article could not be made into a row for betterhomes.");
    const failed = await writeKept(db, ours.id, ours.row, id);
    if (failed) return fail(`Keeping it failed: ${failed}`);
    await noteArticle(db, id, KEPT_NOTE);
    revalidatePath("/pr");
    return { ok: true as const };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Reject, from Bot Activity: the PR team says the article doesn't count.
 * Every row of it stops counting (ours, each rival's and the old bot's), each
 * marked as their verdict, so no later check counts it again.
 */
export async function rejectArticleAction(articleId: string) {
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  const id = articleIdOf(articleId);
  if (!id) return fail("That is not an article the bot stored.");
  try {
    const { data: article, error } = await db.from("news_articles").select("id,legacy_mention_id").eq("id", id).maybeSingle();
    if (error) return fail(`The article could not be read: ${dbHint(error.message)}`);
    if (!article) return fail("That article is no longer stored.");
    const legacyId = typeof article.legacy_mention_id === "string" ? article.legacy_mention_id : null;
    const [exact, rivals] = await Promise.all([
      db.from("mentions").select("id,metadata").in("id", legacyId ? [ourMentionId(id), legacyId] : [ourMentionId(id)]),
      // A rival's row is nr_<article id>_<label> (rivalMentionId): every one, a rival no longer tracked included.
      db.from("mentions").select("id,metadata").like("id", `${likeLiteral(`nr_${id}_`)}%`),
    ]);
    const readError = exact.error ?? rivals.error;
    if (readError) return fail(`The article's rows could not be read: ${readError.message}`);
    const rows = new Map([...(exact.data ?? []), ...(rivals.data ?? [])].map((r) => [String(r.id), r]));
    for (const [rowId, row] of rows) {
      const { error: writeError } = await db.from("mentions").update(rejectedPatch(row, id)).eq("id", rowId);
      // Rejecting again is harmless, so a retry finishes what this started.
      if (writeError) return fail(`Rejecting it stopped part way, at ${rowId}: ${writeError.message}`);
    }
    await noteArticle(db, id, REJECTED_NOTE);
    revalidatePath("/pr");
    return { ok: true as const };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Add a spokesperson to the news bot's list, as current at their company. The
 * company must be betterhomes or a rival the bot tracks: a person counts only
 * for a company the bot knows (lib/news/registry.ts). The same name at the
 * same company, in any case, is refused rather than added twice.
 */
export async function addPersonAction(input: { name: string; company: string; role: string }) {
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const reg = await loadRegistry();
    const checked = checkPersonInput(input, reg.companies.map((c) => c.label));
    if (!checked.ok) return fail(checked.error);
    const { name, company, role } = checked.person;
    const taken = (active: boolean) =>
      fail(`${name} is already on the list for ${company}${active ? "." : ", as former. Mark them current instead."}`);
    const { data: same, error: readError } = await db
      .from("tracked_people")
      .select("active")
      .eq("company", company)
      .ilike("name", likeLiteral(name))
      .limit(1);
    if (readError) return fail(dbHint(readError.message));
    if (same?.length) return taken(same[0].active !== false);
    const { error } = await db.from("tracked_people").insert({ name, company, role, active: true });
    if (error) return /duplicate key|unique/i.test(error.message) ? taken(true) : fail(dbHint(error.message));
    revalidatePath("/pr");
    return { ok: true as const };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Mark a spokesperson current or former at their company. Former is for
 * someone who has left: they then count for the company only in an article
 * that names it too, so a move doesn't keep crediting the old company.
 */
export async function setPersonActiveAction(id: number, active: boolean) {
  if (!Number.isSafeInteger(id) || id <= 0 || typeof active !== "boolean") return fail("That person could not be found.");
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const { data, error } = await db.from("tracked_people").update({ active }).eq("id", id).select("id");
    if (error) return fail(dbHint(error.message));
    if (!data?.length) return fail("That person is no longer on the list.");
    revalidatePath("/pr");
    return { ok: true as const };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Take a spokesperson off the list altogether. Bot Activity suggests marking someone former instead when they move. */
export async function removePersonAction(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return fail("That person could not be found.");
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const { data, error } = await db.from("tracked_people").delete().eq("id", id).select("id");
    if (error) return fail(dbHint(error.message));
    if (!data?.length) return fail("That person is no longer on the list.");
    revalidatePath("/pr");
    return { ok: true as const };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * True when this request carries both PIN cookies, as proxy.ts requires for
 * /settings. Anything that keeps the cookies from being read counts as locked.
 */
async function settingsUnlocked(): Promise<boolean> {
  try {
    const jar = await cookies();
    for (const scope of ["app", "settings"] as const) {
      const token = jar.get(COOKIES[scope])?.value;
      if (!token || !safeEqual(token, await expectedToken(scope))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Save the news bot's settings (app_settings.payload.news). Admin only.
 *
 * Merged at both levels, so the Supermetrics switch, the SEO source and any
 * news setting this form doesn't show all survive the save. What is stored
 * is cleaned by cleanNewsSettings and returned, so the form shows it. Reached
 * from /settings, behind the settings PIN, and the PIN is checked here too:
 * the model chosen decides what every run costs, and a server action can be
 * posted to from any page.
 */
export async function setNewsSettingsAction(next: NewsSettings) {
  if (!(await settingsUnlocked())) return fail("Settings are locked. Enter the settings PIN and try again.");
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const news = cleanNewsSettings(next);
    const { data, error: readError } = await db.from("app_settings").select("payload").eq("id", 1).maybeSingle();
    // Saving over a row that could not be read would wipe the other switches in it.
    if (readError) return fail(`The current settings could not be read, so nothing was saved: ${dbHint(readError.message)}`);
    const payload = asRecord(data?.payload);
    const { error } = await db
      .from("app_settings")
      .upsert(
        { id: 1, payload: { ...payload, news: { ...asRecord(payload.news), ...news } }, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
    if (error) return fail(dbHint(error.message));
    revalidatePath("/settings");
    revalidatePath("/pr");
    return { ok: true as const, settings: news };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
