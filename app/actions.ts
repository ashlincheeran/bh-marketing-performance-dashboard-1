"use server";

import { runIngest } from "@/lib/ingest";
import { refreshInsightsCache } from "@/lib/insights";
import { getWebMetrics } from "@/lib/posthog";
import { getPerfMetrics } from "@/lib/data";
import { PERF_PLATFORM_META, type PerfPlatform } from "@/lib/perfTypes";
import { adminClient } from "@/lib/supabase";
import { revalidatePath } from "next/cache";

// Approve (keep) or reject an item the bot found, from the Bot Activity page.
export async function setMentionStatusAction(id: string, status: "new" | "reviewed" | "rejected") {
  const db = adminClient();
  if (!db) return { ok: false as const, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
  const { error } = await db.from("mentions").update({ status }).eq("id", id);
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
  const toDate = `${to}-31`;

  try {
    const [{ data: ourRows }, { data: compRows }, { data: allRows }] = await Promise.all([
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
      db.from("mentions")
        .select("id,published_on,tier,sentiment")
        .eq("brand", "betterhomes")
        .neq("status", "rejected")
        .gte("published_on", fromDate)
        .lte("published_on", toDate),
    ]);

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
    corpus += "\n\nCOMPETITOR HEADLINES:\n";
    for (const [brand, titles] of byBrand) {
      corpus += `\n[${brand}] — ${titles.length} stories\n${titles.map((t) => `- ${t}`).join("\n")}\n`;
    }
    if (byBrand.size === 0) corpus += "(no competitor data for this period yet)\n";

    const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    const prompt =
      `You are a senior PR strategist for "betterhomes", a real-estate brokerage in DUBAI, UAE. ` +
      `The PR manager has selected the period ${from} to ${to} and clicked "Receive Insights". ` +
      `Based on the data below, give specific forward-looking strategy — NOT metric summaries or dashboard recaps. ` +
      `Every insight must be a concrete action: what to publish, which competitor to counter-program, which topic or outlet to target next, which audience angle is untapped. ` +
      `Be specific — name actual competitors, topics, outlets and audiences you see in the data. ` +
      `If competitor data is thin, still give strong actionable advice from betterhomes' own coverage pattern. ` +
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
    const insights = arr
      .map((it) => ({
        kind: ALLOWED.has(it?.kind ?? "") ? (it.kind as string) : "medium",
        label: String(it?.label ?? "").slice(0, 60),
        text: String(it?.text ?? "").slice(0, 500),
      }))
      .filter((it) => it.label && it.text);
    if (!insights.length) return { ok: false as const, error: "No insights returned — try a wider date range." };
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

    let corpus = `PLATFORM: ${name}\nPeriod: ${rows[0].period_label ?? "recent"}\n\n`;
    for (const r of rows) {
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
    return { ok: true as const, insights, label: `${name} · ${rows[0].period_label ?? ""}`.trim() };
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
    const bounced = m.flow.nodes.find((n) => n.kind === "outcome:Bounced")?.value ?? 0;
    const browsed = m.flow.nodes.find((n) => n.kind.includes("Browsed"))?.value ?? 0;

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

// Powers the dashboard's "Run now" button. Runs ingestion server-side
// (no secret exposed to the browser) and refreshes the page data.
export async function triggerIngestAction() {
  try {
    const r = await runIngest("manual");
    revalidatePath("/pr");
    return { ok: true as const, inserted: r.inserted, updated: r.updated, considered: r.considered, found: r.found };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
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
