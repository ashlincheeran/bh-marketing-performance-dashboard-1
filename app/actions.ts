"use server";

import { runIngest } from "@/lib/ingest";
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
