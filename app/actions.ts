"use server";

import { runIngest } from "@/lib/ingest";
import { refreshInsightsCache } from "@/lib/insights";
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
