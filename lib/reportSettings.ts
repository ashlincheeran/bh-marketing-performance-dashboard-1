// The weekly email's settings, read and written. Server-only.
//
// The list holds colleagues' email addresses, so it lives in report_settings,
// which only the service role can read (migration 0017), and never in
// app_settings, which the public anon key can read.
import { adminClient } from "@/lib/supabase";
import { cleanReportSettings, type ReportSettings } from "@/lib/reportTypes";

export * from "@/lib/reportTypes";

/** The saved settings, or null when the database can't be read. */
export async function getReportSettings(): Promise<ReportSettings | null> {
  const db = adminClient();
  if (!db) return null;
  const { data, error } = await db.from("report_settings").select("payload").eq("id", 1).maybeSingle();
  if (error) return null;
  return cleanReportSettings(data?.payload);
}

async function write(payload: ReportSettings): Promise<string | null> {
  const db = adminClient();
  if (!db) return "SUPABASE_SERVICE_ROLE_KEY not set";
  const { error } = await db
    .from("report_settings")
    .upsert({ id: 1, payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (!error) return null;
  return /relation .*report_settings.* does not exist/i.test(error.message)
    ? "The report_settings table isn't created yet: apply migration 0017."
    : error.message;
}

/** Saves what Settings edits. The send history is kept from the stored row, never from the form. */
export async function saveReportSettings(next: ReportSettings): Promise<string | null> {
  const stored = await getReportSettings();
  const clean = cleanReportSettings(next);
  if (clean.enabled && !clean.recipients.some((r) => r.role === "to")) {
    return "Put at least one person on To before turning the email on.";
  }
  return write({ ...clean, lastSentAt: stored?.lastSentAt ?? null, lastResult: stored?.lastResult ?? null });
}

/** Records an attempt. lastSentAt moves only when an email actually went out. */
export async function recordReportSend(result: string, sentAt: string | null): Promise<void> {
  const stored = await getReportSettings();
  if (!stored) return;
  await write({ ...stored, lastResult: result.slice(0, 300), lastSentAt: sentAt ?? stored.lastSentAt });
}
