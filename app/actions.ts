"use server";

import { cookies } from "next/headers";
import { insightsForRange } from "@/lib/insights";
import { getWebMetrics } from "@/lib/posthog";
import {
  PERSON_CHECK,
  checkPersonInput,
  getCompetitorNews,
  getMentions,
  getPerfMetrics,
  keepDecision,
  keptPatch,
  keptRow,
  rejectedDecision,
  rejectedPatch,
  setAsideRow,
  stillOpen,
} from "@/lib/data";
import { PERF_PLATFORM_META, type PerfPlatform } from "@/lib/perfTypes";
import { adminClient } from "@/lib/supabase";
import { getReportSettings, saveReportSettings, type ReportSettings } from "@/lib/reportSettings";
import { cleanNewsSettings } from "@/lib/appSettings";
import { asRecord, errorMessage, oneLine } from "@/lib/coerce";
import { askGemini, geminiKey } from "@/lib/gemini";
import { COOKIES, tokenValid } from "@/lib/gate";
import { namesBetterhomes } from "@/lib/match";
import { checkCompanyChange } from "@/lib/news/companyChange";
import { ownSiteIn } from "@/lib/news/ownSite";
import { COMPANY_COLUMNS, aliasList, companyNamed, loadRegistry, registryFromRows, siteList } from "@/lib/news/registry";
import { startNewsRun, startNewsStep } from "@/lib/news/run";
import { KEPT_NOTE, REJECTED_NOTE } from "@/lib/news/store";
import { loadOutlets, mentionRowsFor, ourMentionId, type LegacyRow, type MentionRow } from "@/lib/news/write";
import type { ArticleRow, Decision, NewsSettings } from "@/lib/news/types";
import { revalidatePath } from "next/cache";

type Db = NonNullable<ReturnType<typeof adminClient>>;

const NO_ADMIN = "SUPABASE_SERVICE_ROLE_KEY not set";

const fail = (error: string) => ({ ok: false as const, error });

/**
 * What an action behind the settings PIN answers without it. PR & Media
 * settings changes what counts for everyone and what a run costs, and a
 * server action can be posted to from any page, so each one checks the PIN
 * itself (settingsUnlocked) rather than trust that only /pr/settings calls it.
 */
const LOCKED = "Settings are locked. Enter the settings PIN and try again.";

/**
 * The tables these actions write, and the migration that makes each, so a
 * deployment missing one says which to apply. PostgREST words a missing table
 * two ways, depending on its version.
 */
const MIGRATION_FOR: Record<string, string> = {
  tracked_keywords: "0006",
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

// Approve (keep) or reject an item the bot found, from PR & Media settings.
// The person's verdict goes in metadata.personVerdict as well as the status,
// merged into what the row already holds, because that is the mark the news
// bot checks before it changes a row (lib/news/write.ts, decidedByPerson).
export async function setMentionStatusAction(id: string, status: "new" | "reviewed" | "rejected") {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  if (status !== "new" && status !== "reviewed" && status !== "rejected") return fail("Unknown status.");
  const { data, error: readError } = await db.from("mentions").select("metadata").eq("id", id).maybeSingle();
  if (readError) return fail(readError.message);
  if (!data) return fail("That story is no longer stored.");
  const metadata = { ...asRecord(data.metadata), personVerdict: status === "rejected" ? "rejected" : "kept" };
  const { error } = await db.from("mentions").update({ status, metadata }).eq("id", id);
  revalidatePath("/bot");
  revalidatePrPages();
  return error ? fail(error.message) : { ok: true as const };
}

/**
 * The PR tab and its settings page, which between them show what the news bot
 * found and counted, and the companies and people it looks for.
 */
function revalidatePrPages() {
  revalidatePath("/pr");
  revalidatePath("/pr/settings");
}

/**
 * Add a keyword the bot should search. kind 'pr' = betterhomes searches,
 * 'competitor' = a rival company, for Share of Voice and the competitor feed.
 *
 * A rival needs its company name as well as its search. The label is the
 * company everywhere the bot uses it (the registry the AI sorts by, the
 * metadata.competitor of its stories, Share of Voice), so it is asked for and
 * never made from the search: "haus and haus dubai" became "Haus And Haus
 * Dubai", a company no spelling matched. A name that is a rival already
 * tracked, written another way ("Engel and Volkers" for Engel & Völkers) or as
 * one of its other spellings ("Luxhabitat" for Sotheby's), is refused, as is
 * our own name and a search another rival already uses.
 */
export async function addKeywordAction(kind: "pr" | "competitor", query: string, label?: string) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  if (kind !== "pr" && kind !== "competitor") return fail("Bad kind");
  const q = (typeof query === "string" ? query : "").trim().slice(0, 120);
  if (!q) return fail("Keyword is empty");
  let name: string | null = null;
  if (kind === "competitor") {
    name = oneLine(label);
    if (name.length < 2 || name.length > 60) return fail("Give the rival's company name, 2 to 60 characters, as well as its search.");
    if (namesBetterhomes(name)) return fail("That name is betterhomes, which is always tracked. Add rival companies here.");
    const { data, error: readError } = await db
      .from("tracked_keywords")
      .select(COMPANY_COLUMNS)
      .eq("kind", "competitor")
      .eq("active", true);
    if (readError) return fail(`The rival list could not be read, so nothing was added: ${dbHint(readError.message)}`);
    const rivals = (data ?? []).map((r) => ({ label: String(r.label ?? r.query), query: String(r.query) }));
    const same = companyNamed(registryFromRows(data ?? [], []), name);
    if (same?.isUs) return fail("That name is betterhomes, which is always tracked. Add rival companies here.");
    if (same) return fail(same.label === name ? `${name} is already tracked.` : `${name} is already tracked, as ${same.label}.`);
    const searched = rivals.find((r) => r.query.toLowerCase() === q.toLowerCase());
    if (searched) return fail(`The search "${searched.query}" is already used for ${searched.label}.`);
  }
  const { error } = await db
    .from("tracked_keywords")
    .upsert({ kind, query: q, label: name, active: true }, { onConflict: "kind,query" });
  revalidatePrPages();
  return error ? fail(dbHint(error.message)) : { ok: true as const };
}

// Remove a tracked keyword by id. betterhomes' own row (kind 'us') is not a
// search: it holds our websites, so it is never removed.
export async function removeKeywordAction(id: number) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  const { error } = await db.from("tracked_keywords").delete().eq("id", id).neq("kind", "us");
  revalidatePrPages();
  return error ? fail(error.message) : { ok: true as const };
}

/** A company's lists as the bot reads them (lib/news/registry.ts), so two copies of one compare equal. */
const SAME_LIST = { aliases: aliasList, sites: siteList } as const;

/**
 * Save a company's other spellings or its own websites, from PR & Media
 * settings. Each list given replaces the stored one, once checkCompanyChange
 * (lib/news/companyChange.ts) has cleaned it: a rival takes both, and
 * betterhomes' row (kind 'us') takes websites only. The bot's next step reads
 * them (lib/news/registry.ts loadRegistry).
 *
 * `shown` is the list the page changed. When the stored one is no longer
 * that, someone saved a change since the page loaded, and saving over it
 * would lose theirs without a word, so nothing is saved. A spelling that
 * already names another tracked company is refused: the bot would credit
 * one company's stories to both.
 */
export async function updateCompanyAction(
  id: number,
  change: { aliases?: string[]; sites?: string[] },
  shown?: { aliases?: string[]; sites?: string[] },
) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  if (!Number.isSafeInteger(id) || id <= 0) return fail("That company could not be found.");
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const { data, error: readError } = await db.from("tracked_keywords").select("kind,label,query,aliases,sites").eq("id", id).maybeSingle();
    if (readError) return fail(dbHint(readError.message));
    if (!data) return fail("That company is no longer on the list.");
    const checked = checkCompanyChange(change, data.kind);
    if (!checked.ok) return fail(checked.error);
    for (const field of ["aliases", "sites"] as const) {
      const before = shown?.[field];
      if (!checked.patch[field] || before === undefined) continue;
      if (JSON.stringify(SAME_LIST[field](before)) !== JSON.stringify(SAME_LIST[field](data[field]))) {
        const what = field === "aliases" ? "spellings" : "websites";
        return fail(`These ${what} were changed since this page loaded, so nothing was saved. Reload the page and try again.`);
      }
    }
    if (checked.patch.aliases?.length) {
      const others = await db.from("tracked_keywords").select(COMPANY_COLUMNS).in("kind", ["competitor", "us"]).eq("active", true).neq("id", id);
      if (others.error) return fail(`The other companies could not be read, so nothing was saved: ${dbHint(others.error.message)}`);
      const reg = registryFromRows(others.data ?? [], []);
      for (const alias of checked.patch.aliases) {
        const owner = companyNamed(reg, alias);
        if (owner) return fail(`"${alias}" is already a spelling of ${owner.label}, so it can't be ${String(data.label || data.query)}'s too.`);
      }
    }
    const { data: saved, error } = await db.from("tracked_keywords").update(checked.patch).eq("id", id).select("id");
    if (error) return fail(dbHint(error.message));
    if (!saved?.length) return fail("That company is no longer on the list.");
    revalidatePrPages();
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/** A month as the PR tab's range picker gives it: "2026-11". */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * "Receive Insights" on the PR tab: Claude's strategy for the months the PR
 * team picked (lib/insights.ts, insightsForRange), from the same rows the page
 * counts: every brand line of ours and the rivals' stories, each one per
 * placement.
 *
 * A failed read is an error to show, never an empty period to analyse. With
 * the rivals' stories missing, the AI would be told no competitor coverage
 * exists and write cards that say so; with the live mentions missing, it would
 * analyse the clipping file bundled with the app, which ends months ago.
 */
export async function receiveInsightsAction(from: string, to: string) {
  if (typeof from !== "string" || typeof to !== "string" || !MONTH.test(from) || !MONTH.test(to) || from > to) {
    return fail("Pick a valid date range first: a start month no later than the end month.");
  }
  try {
    const [ours, rivals] = await Promise.all([getMentions(), getCompetitorNews()]);
    if (ours.source !== "supabase") {
      return fail(`Live press data could not be loaded (${ours.error ?? "unknown error"}), so no insights were asked for. Try again in a minute.`);
    }
    if (rivals.error) {
      return fail(`Rival coverage could not be read just now (${rivals.error}), so no insights were asked for. Try again in a minute.`);
    }
    return await insightsForRange(from, to, { mentions: ours.mentions, competitorNews: rivals.items });
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Save `payload` as the one row (id 1) of a settings table. Returns why it
 * failed, or null; a table not made yet is named with the migration that
 * makes it. Kept apart from dbHint, which words that message differently.
 */
async function saveSettingsRow(db: Db, table: string, migration: string, payload: unknown): Promise<string | null> {
  const { error } = await db.from(table).upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (!error) return null;
  return new RegExp(`relation .*${table}.* does not exist`, "i").test(error.message)
    ? `The ${table} table isn't created yet — apply migration ${migration}.`
    : error.message;
}

// Save the People Sentiment config (subjects + per-platform source settings)
// from the tab's editor. Single-row table (id=1).
export async function saveSocialConfigAction(payload: unknown) {
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const error = await saveSettingsRow(db, "social_config", "0008", payload);
    if (error) return fail(error);
    revalidatePath("/people");
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// Save the Social Performance benchmark config (brands + per-platform handles +
// actor ids). Stored under the `benchmark` key of the single social_config row
// via read-modify-write, so it never clobbers the sentiment config there.
export async function savePerfConfigAction(benchmark: unknown) {
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const { data } = await db.from("social_config").select("payload").eq("id", 1).maybeSingle();
    const payload = { ...((data?.payload as Record<string, unknown>) ?? {}), benchmark };
    const error = await saveSettingsRow(db, "social_config", "0008", payload);
    if (error) return fail(error);
    revalidatePath("/people");
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/** An insight card as Gemini's answer gives it, cut to size. */
type GeminiCard = { kind: string; label: string; text: string };

/**
 * Ask Gemini for insight cards, as Socials Performance and the Website tab
 * both do: the cards it gave, or why its answer could not be read. A request
 * that never reaches Gemini, or an answer that isn't JSON, throws, for the
 * action's own catch to answer.
 */
async function askGeminiForCards(key: string, prompt: string): Promise<{ cards: GeminiCard[] } | { error: string }> {
  const cleaned = await askGemini(key, prompt, { temperature: 0.5, maxOutputTokens: 1600 });
  const s = cleaned.indexOf("[");
  const e = cleaned.lastIndexOf("]");
  if (s === -1 || e === -1 || e <= s) return { error: "Gemini returned an unexpected format" };
  const arr: { kind?: string; label?: string; text?: string }[] = JSON.parse(cleaned.slice(s, e + 1));
  const ALLOWED = new Set(["high", "medium", "win", "test"]);
  const cards = arr
    .map((it) => ({ kind: ALLOWED.has(it?.kind ?? "") ? (it.kind as string) : "medium", label: String(it?.label ?? "").slice(0, 60), text: String(it?.text ?? "").slice(0, 500) }))
    .filter((it) => it.label && it.text);
  return { cards };
}

// "Receive insights" on the Performance benchmark — Gemini reads the per-brand
// metrics for the selected platform and returns competitive, actionable takeaways
// (the live version of the report's closing "what to take from this" slide).
export async function receivePerfInsightsAction(platform: string) {
  const key = geminiKey();
  if (!key) return fail("No Gemini API key configured — add GEMINI_API_KEY to env vars.");
  try {
    const rows = (await getPerfMetrics()).filter((m) => m.platform === platform);
    if (!rows.length) return fail("No benchmark data for this platform yet — run the benchmark first.");
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

    const answer = await askGeminiForCards(key, prompt);
    if ("error" in answer) return fail(answer.error);
    const insights = answer.cards;
    if (!insights.length) return fail("No insights returned — run the benchmark first.");
    const span = platform === "instagram" ? "latest 12 posts per account" : (rows[0].period_label ?? "");
    return { ok: true as const, insights, label: `${name} · ${span}`.trim() };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// "Receive insights" on the SEO tab — Gemini reads the (bot-filtered) web
// analytics for the selected range and returns data-driven recommendations.
export async function receiveWebInsightsAction(days: number, from?: string, to?: string) {
  const key = geminiKey();
  if (!key) return fail("No Gemini API key configured — add GEMINI_API_KEY to env vars.");
  try {
    const m = await getWebMetrics(days, from, to, true); // humans only
    if (!m.connected) return fail("PostHog isn't connected (POSTHOG_API_KEY missing).");
    if (!m.hasData || !m.overview) return fail("No website data in this range yet.");

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

    const answer = await askGeminiForCards(key, prompt);
    if ("error" in answer) return fail(answer.error);
    const insights = answer.cards;
    if (!insights.length) return fail("No insights returned — try a wider range.");
    return { ok: true as const, insights, label: m.label };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Run now, on PR & Media settings: starts a run of the news bot
 * (docs/news-pipeline.md) and returns at once. The run works through its
 * steps on its own, a few minutes in all, and This morning's run shows its
 * numbers as they come in. No secret reaches the browser: startNewsRun hands
 * the first step to /api/news from here, on the server.
 */
export async function runNewsBotAction() {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  try {
    const r = await startNewsRun("manual");
    revalidatePrPages();
    if (!r.started) return fail(r.error ?? "The news bot did not start. A run may already be working: its numbers appear below as it goes.");
    return { ok: true as const, runId: r.runId };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Save which ad accounts the Digital Performance tab shows. Admin only.
 *
 * Accepts { google: [{id,name}], meta: [...], linkedin: [...] }. Only the id and
 * name are stored — everything else about an account is read live, so persisting
 * more would just go stale.
 *
 * The list decides how much Supermetrics quota every page load spends, which
 * is why it sits behind the settings PIN (lib/gate.ts). The editor is on the
 * Digital tab, behind the app PIN only, so the settings PIN is checked here,
 * as setNewsSettingsAction checks it: a server action can be posted to from
 * any page.
 */
export async function savePaidConfigAction(accounts: unknown) {
  if (!(await settingsUnlocked())) {
    return fail("The ad-account list is behind the settings PIN. Open Settings, enter the PIN, then save again.");
  }
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
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
    const error = await saveSettingsRow(db, "paid_config", "0012", payload);
    if (error) return fail(error);
    revalidatePath("/digital");
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
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
    return fail("Unknown source.");
  }
  if (source === "direct" && !(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY)) {
    return fail("GSC_CLIENT_EMAIL and GSC_PRIVATE_KEY aren't set in Vercel yet, so the direct API can't answer. Add them first.");
  }
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const { data } = await db.from("app_settings").select("payload").eq("id", 1).maybeSingle();
    // Merge, so the Supermetrics switch and its note survive this save.
    const payload = { ...((data?.payload as Record<string, unknown>) ?? {}), seoSource: source };
    const { error } = await db
      .from("app_settings")
      .upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) return fail(error.message);
    for (const p of ["/", "/seo", "/settings"]) revalidatePath(p);
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
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
  if (!db) return fail(NO_ADMIN);
  try {
    const { data } = await db.from("app_settings").select("payload").eq("id", 1).maybeSingle();
    // Merge, so a future switch added alongside this one is not wiped by a save.
    const payload = {
      ...((data?.payload as Record<string, unknown>) ?? {}),
      supermetricsEnabled: !!enabled,
      note: String(note ?? "").slice(0, 200),
    };
    const error = await saveSettingsRow(db, "app_settings", "0013", payload);
    if (error) return fail(error);
    // Every tab reads this, so revalidate the lot rather than guessing which.
    for (const p of ["/", "/digital", "/seo", "/settings", "/company", "/portals", "/website"]) revalidatePath(p);
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
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
    if (error) return fail(error);
    revalidatePath("/settings");
    const stored = await getReportSettings();
    return { ok: true as const, settings: stored };
  } catch (e) {
    return fail(errorMessage(e));
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
 * Leave a person's verdict in the article's note, where Bot Activity shows it
 * and the bot's re-checks look for it, with any other change to the article.
 * Returns why it failed, or null; the failure is logged either way, since a
 * caller whose rows carry the verdict goes on without it.
 */
async function noteArticle(db: Db, id: string, note: string, patch: Partial<ArticleRow> = {}): Promise<string | null> {
  const { error } = await db
    .from("news_articles")
    .update({ ...patch, note, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error(`[news] could not note ${id} as "${note}": ${error.message}`);
  return error ? error.message : null;
}

/** True for the decision a person's Reject leaves on an article (rejectedDecision): no company, decided by a person. */
const rejectedByPerson = (d: Decision | null | undefined): boolean =>
  !!d && d.model === PERSON_CHECK && !(Array.isArray(d.mentions) && d.mentions.length);

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
 * Write a company's row for an article as a person decided it: kept, so it
 * counts, reviewed, or set aside (Not about), so it doesn't. Added when it is
 * new, else changed in place, keeping what the stored row knows. A row a run
 * adds between the read and the write is changed in place on a second go.
 * Returns why it failed, or null.
 */
async function writePersonRow(
  db: Db,
  rowId: string,
  made: MentionRow,
  articleId: string,
  verdict: "kept" | "rejected",
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: stored, error: readError } = await db.from("mentions").select("id,metadata").eq("id", rowId).maybeSingle();
    if (readError) return readError.message;
    if (stored) {
      const patch = verdict === "kept" ? keptPatch(stored, made, articleId) : rejectedPatch(stored, articleId);
      const { error } = await db.from("mentions").update(patch).eq("id", rowId);
      return error ? error.message : null;
    }
    const { error } = await db.from("mentions").insert(verdict === "kept" ? keptRow(made) : setAsideRow(made));
    if (!error) return null;
    if (!/duplicate key|unique/i.test(error.message)) return error.message;
  }
  return "the row kept changing while it was being saved, so try again";
}

/**
 * The article's row for one company, as a person's word on it writes it,
 * with the registry and the company: betterhomes when `company` is left out,
 * else the tracked company it names, resolved the way the bot reads a name
 * (lib/news/registry.ts companyNamed), or none. The row is made the way the
 * bot makes one (lib/news/write.ts, mentionRowsFor), under the old bot's id
 * when the article came from the old bot's row for that company, so the story
 * is still one row.
 */
async function rowForCompany(db: Db, article: ArticleRow, company: string | undefined) {
  const [reg, outlets, legacy] = await Promise.all([loadRegistry(), loadOutlets(), legacyRowOf(db, article)]);
  const target = company == null ? reg.us : companyNamed(reg, company);
  if (!target) return { reg, target: null };
  const checkedAt = new Date().toISOString();
  const decision = keepDecision(article, reg, checkedAt, target.label);
  const made = mentionRowsFor(article, decision, reg, outlets, checkedAt, legacy).find((r) => r.brand === target.label);
  return { reg, target, decision, made };
}

/** What Count says of a company the bot doesn't track, by the name it was given when there is one. */
const notTracked = (name: unknown) =>
  fail(
    `${oneLine(name).slice(0, 60) || "That"} is not a company the bot tracks, so nothing was counted. Count it for betterhomes or one of the tracked rivals.`,
  );

/** What Not about says of a company the bot doesn't track. */
const notTrackedToSetAside = (name: unknown) =>
  fail(`${oneLine(name).slice(0, 60) || "That"} is not a company the bot tracks, so nothing was changed.`);

/**
 * Clear an unreadable article's next try, so the morning's re-queue passes it
 * by: a person has decided it by hand, and its site turns the bot away
 * anyway. Best effort, as the note is: the failure is logged.
 */
async function stopTries(db: Db, id: string): Promise<void> {
  const { error } = await db
    .from("news_articles")
    .update({ next_try_at: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "unreadable");
  if (error) console.error(`[news] could not stop the bot's tries on ${id}: ${error.message}`);
}

/**
 * Keep, from PR & Media settings: the PR team says the article is about a
 * company. That is betterhomes when `company` is left out (Keep), or the
 * tracked company it names (Count for Knight Frank, from Check by hand),
 * resolved the way the bot reads a company's name (lib/news/registry.ts
 * companyNamed); anything else is refused. The company's row for it counts
 * from now on, reviewed and marked as their verdict, which the bot never
 * overrides (docs/news-pipeline.md, rule 6): ours, or a rival's
 * competitor_news row, which the competitor feed, Share of Voice and Press
 * mentions count. The row is made the way the bot makes one (lib/news/write.ts,
 * mentionRowsFor), under the old bot's id when the article came from the old
 * bot's row for that company, so the story is still counted once.
 *
 * A company's own website is never its coverage (rule 10), so an article on it
 * is refused for that company. The article keeps its status under the person's
 * note, as a Keep always left it, and one the bot could not read is not tried
 * again: its next try is cleared, so the morning's re-queue passes it by.
 */
export async function keepArticleAction(articleId: string, company?: string) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  const id = articleIdOf(articleId);
  if (!id) return fail("That is not an article the bot stored.");
  // Not a name at all: refused before anything is read.
  if (company != null && typeof company !== "string") return notTracked(company);
  try {
    const { data, error } = await db.from("news_articles").select("*").eq("id", id).maybeSingle();
    if (error) return fail(`The article could not be read: ${dbHint(error.message)}`);
    if (!data) return fail("That article is no longer stored.");
    const article = data as ArticleRow;
    // A copy's original is the one that counts: keeping the copy would count the story twice.
    if (article.status === "duplicate") return fail("This is the same article as another one in the list. Keep that one instead.");
    const found = await rowForCompany(db, article, company);
    if (found.target === null) return notTracked(company);
    const { reg, target, decision, made } = found;
    if (ownSiteIn(article, reg) === target.label) {
      return fail(`Nothing was counted for ${target.label}: the article is on its own website, which never counts as its coverage.`);
    }
    if (!made) return fail(`The article could not be made into a row for ${target.label}.`);
    const failed = await writePersonRow(db, made.id, made.row, id, "kept");
    if (failed) return fail(`Keeping it failed: ${failed}`);
    // The row now carries the verdict, so the note is best effort. A person's
    // own earlier Reject is replaced by this decision, or the article would go
    // on reading "a person rejected it" beside the Keep.
    await noteArticle(db, id, KEPT_NOTE, {
      ...(rejectedByPerson(article.decision) ? { decision } : {}),
      ...(article.status === "unreadable" ? { next_try_at: null } : {}),
    });
    revalidatePrPages();
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Close an article a later run could still take (stillOpen) as a person's
 * Reject: decided, about no company, with their note, and let go of any run's
 * claim on it. Only while it is still in `status`, the one just read: a run
 * may have moved it on since. Returns "closed", "moved" when it was no longer
 * in that status, or why the write failed.
 */
async function closeRejected(db: Db, id: string, status: string): Promise<"closed" | "moved" | { error: string }> {
  const { data, error } = await db
    .from("news_articles")
    .update({
      status: "decided",
      decision: rejectedDecision(new Date().toISOString()),
      note: REJECTED_NOTE,
      error: null,
      next_try_at: null,
      claimed_at: null,
      claimed_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", status)
    .select("id");
  if (error) {
    console.error(`[news] could not close ${id} as rejected by a person: ${error.message}`);
    return { error: error.message };
  }
  return data?.length ? "closed" : "moved";
}

/** How many times Reject looks again at an article a run keeps moving on before it gives up and asks for another go. */
const REJECT_TRIES = 3;

/**
 * Not about one company, from Check by hand, where the article counts for
 * another company already: it is not about `company`. Its row for that
 * company is written the way the bot writes one, or marked when it has one,
 * as rejected with the person's verdict, so no check counts it for that
 * company again (docs/news-pipeline.md, rule 6). Nothing else of it changes:
 * what counts for another company goes on counting, which a Reject of the
 * whole article would take away. One the bot could not read is not tried
 * again, as after a Count. The caller has checked the PIN and the id.
 */
async function setAsideFor(db: Db, id: string, company: unknown) {
  if (typeof company !== "string") return notTrackedToSetAside(company);
  try {
    const { data, error } = await db.from("news_articles").select("*").eq("id", id).maybeSingle();
    if (error) return fail(`The article could not be read: ${dbHint(error.message)}`);
    if (!data) return fail("That article is no longer stored.");
    const article = data as ArticleRow;
    if (article.status === "duplicate") return fail("This is the same article as another one in the list. Decide that one instead.");
    const found = await rowForCompany(db, article, company);
    if (found.target === null) return notTrackedToSetAside(company);
    const { target, made } = found;
    if (!made) return fail(`The article could not be made into a row for ${target.label}.`);
    const failed = await writePersonRow(db, made.id, made.row, id, "rejected");
    if (failed) return fail(`Setting it aside failed: ${failed}`);
    if (article.status === "unreadable") await stopTries(db, id);
    revalidatePrPages();
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Reject, from PR & Media settings: the PR team says the article doesn't
 * count. Every row of it stops counting (ours, each rival's and the old
 * bot's), each marked as their verdict, so no later check counts it again.
 * With `company`, it is Not about that one company instead (setAsideFor).
 *
 * An article a later run could still sort, publish or retry (stillOpen) is
 * also closed: saved as decided, about no company, by a person. Its rows can
 * only carry the verdict for the companies they are for, and there may be
 * none yet: a held article would be published, rival rows and all, and a
 * failed or unread one sorted again. The note says who decided either way.
 *
 * The close comes first, before any row, and lets go of any run's claim, so
 * their Reject wins over a run that holds the article (docs/news-pipeline.md,
 * rule 6). From then on no step saves over it: each saves only while its claim
 * or the held status is still in place, and looks again before it writes to
 * mentions. Rows a step wrote before the sweep below reads them are marked
 * here; one it writes after that has its save refused, and takes them back
 * itself (lib/news/run.ts).
 */
export async function rejectArticleAction(articleId: string, company?: string) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  const id = articleIdOf(articleId);
  if (!id) return fail("That is not an article the bot stored.");
  if (company != null) return setAsideFor(db, id, company);
  try {
    let article: { status: unknown; legacy_mention_id: unknown } | null = null;
    let closed = false;
    for (let tries = 1; !closed; tries++) {
      const { data, error } = await db.from("news_articles").select("id,status,legacy_mention_id").eq("id", id).maybeSingle();
      if (error) return fail(`The article could not be read: ${dbHint(error.message)}`);
      if (!data) return fail("That article is no longer stored.");
      article = data;
      const status = String(data.status ?? "");
      if (!stillOpen(status)) break;
      const outcome = await closeRejected(db, id, status);
      if (outcome === "closed") closed = true;
      // Here the article is what holds the verdict, so this one has to land.
      else if (outcome !== "moved") {
        return fail(`Rejecting it stopped part way: the article could not be marked as decided (${outcome.error}). Reject it again to finish.`);
      } else if (tries >= REJECT_TRIES) {
        return fail("The bot is moving this article on right now. Reject it again in a minute.");
      }
    }
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
      // Rejecting again is harmless, so a retry finishes what this started:
      // the article is closed by then, and only its rows are left to mark.
      if (writeError) return fail(`Rejecting it stopped part way, at ${rowId}: ${writeError.message}`);
    }
    // A closed article carries the note already; a final one gets it now.
    if (!closed) await noteArticle(db, id, REJECTED_NOTE);
    revalidatePrPages();
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Add a spokesperson to the news bot's list, as current at their company. The
 * company must be betterhomes or a rival the bot tracks: a person counts only
 * for a company the bot knows (lib/news/registry.ts). The same name at the
 * same company, in any case, is refused rather than added twice.
 */
export async function addPersonAction(input: { name: string; company: string; role: string }) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
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
    revalidatePrPages();
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Mark a spokesperson current or former at their company. Former is for
 * someone who has left: they then count for the company only in an article
 * that names it too, so a move doesn't keep crediting the old company.
 */
export async function setPersonActiveAction(id: number, active: boolean) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof active !== "boolean") return fail("That person could not be found.");
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const { data, error } = await db.from("tracked_people").update({ active }).eq("id", id).select("id");
    if (error) return fail(dbHint(error.message));
    if (!data?.length) return fail("That person is no longer on the list.");
    revalidatePrPages();
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * Take a spokesperson off the list altogether. PR & Media settings suggests
 * marking someone former instead when they move.
 */
export async function removePersonAction(id: number) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  if (!Number.isSafeInteger(id) || id <= 0) return fail("That person could not be found.");
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const { data, error } = await db.from("tracked_people").delete().eq("id", id).select("id");
    if (error) return fail(dbHint(error.message));
    if (!data?.length) return fail("That person is no longer on the list.");
    revalidatePrPages();
    return { ok: true as const };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * True when this request carries both PIN cookies, as proxy.ts requires for
 * /settings and /pr/settings, each issued within its MAX_AGE (lib/gate.ts).
 * Anything that keeps the cookies from being read counts as locked.
 */
async function settingsUnlocked(): Promise<boolean> {
  try {
    const jar = await cookies();
    for (const scope of ["app", "settings"] as const) {
      if (!(await tokenValid(scope, jar.get(COOKIES[scope])?.value))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Whether the publish step started, after counting was turned back on. */
type PublishStart = { started: boolean; uncertain?: boolean; error?: string };

/**
 * Start the news bot's publish step, which writes every held decision to the
 * PR tab (docs/news-pipeline.md). Never throws: the settings are saved by then,
 * and the form says whether the publish is under way.
 */
async function startPublish(): Promise<PublishStart> {
  try {
    const r = await startNewsStep("publish", "manual");
    if (r.started) return { started: true };
    // No answer is not a refusal: the publish may be running, and starting another would race it.
    return r.uncertain
      ? { started: false, uncertain: true, error: r.error ?? "the publish step did not confirm that it started" }
      : { started: false, error: r.error ?? "the publish step did not start" };
  } catch (e) {
    return { started: false, error: errorMessage(e) };
  }
}

/**
 * Save the news bot's settings (app_settings.payload.news). Admin only.
 *
 * Merged at both levels, so the Supermetrics switch, the SEO source and any
 * news setting this form doesn't show all survive the save. What is stored
 * is cleaned by cleanNewsSettings and returned, so the form shows it. Reached
 * from PR & Media settings (/pr/settings), behind the settings PIN, and the
 * PIN is checked here too: the model chosen decides what every run costs, and
 * a server action can be posted to from any page.
 *
 * Turning counting on the PR tab back on (countOnPrTab from false to true)
 * ends test mode: once the save is in, the publish step starts, and `publish`
 * says whether it did. It is null when no publish was due.
 */
export async function setNewsSettingsAction(next: NewsSettings, countingShown?: boolean) {
  if (!(await settingsUnlocked())) return fail(LOCKED);
  const db = adminClient();
  if (!db) return fail(NO_ADMIN);
  try {
    const news = cleanNewsSettings(next);
    const { data, error: readError } = await db.from("app_settings").select("payload").eq("id", 1).maybeSingle();
    // Saving over a row that could not be read would wipe the other switches in it.
    if (readError) return fail(`The current settings could not be read, so nothing was saved: ${dbHint(readError.message)}`);
    const payload = asRecord(data?.payload);
    // Read the way every run reads it: only an explicit false was off.
    const countingStored = cleanNewsSettings(payload.news).countOnPrTab;
    // A tab opened before someone else switched counting would save its old
    // value back: turning test mode off (and publishing everything held), or
    // on, without anyone meaning to.
    if (countingShown !== undefined && countingShown !== countingStored) {
      return fail("Counting on the PR tab was changed since this page loaded, so nothing was saved. Reload the page and try again.");
    }
    const publishDue = !countingStored && news.countOnPrTab;
    const { error } = await db
      .from("app_settings")
      .upsert(
        { id: 1, payload: { ...payload, news: { ...asRecord(payload.news), ...news } }, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
    if (error) return fail(dbHint(error.message));
    const publish = publishDue ? await startPublish() : null;
    revalidatePrPages();
    return { ok: true as const, settings: news, publish };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
