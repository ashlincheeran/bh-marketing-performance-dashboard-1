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
