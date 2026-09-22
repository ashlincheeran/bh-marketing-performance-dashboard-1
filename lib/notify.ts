// The notification feed. Server-only.
//
// The rule this module exists to enforce: a notification is a statement of fact
// about what the database now contains, not a hopeful message emitted next to a
// write. Success notifications are therefore written from values READ BACK from
// Supabase after the write, never from what the calling code intended to store.
// A cheerful "metrics updated" sitting above unchanged data is worse than
// silence, because it stops anyone looking.
import { adminClient, readClient } from "@/lib/supabase";

export type NotifyKind = "success" | "warning" | "error";

export interface Notification {
  id: number;
  kind: NotifyKind;
  source: string;
  title: string;
  body: string | null;
  count: number;
  firstSeenAt: string;
  createdAt: string;
}

/**
 * Record an event.
 *
 * `dedupeKey` collapses repeats: the same key bumps `count` and `created_at`
 * rather than inserting again, so one broken thing is one line that says how
 * often it happened, instead of a hundred lines saying it once each.
 *
 * Never throws and never blocks the caller's real work — a feed that can break a
 * dashboard is a worse feature than no feed.
 */
export async function notify(
  kind: NotifyKind,
  source: string,
  title: string,
  body: string | null,
  dedupeKey: string,
): Promise<void> {
  const db = adminClient();
  if (!db) return;
  try {
    // Read first so `count` can be incremented: upsert alone would reset it, and
    // "x7" is the part that distinguishes a blip from a persistent fault.
    const { data: existing } = await db
      .from("notifications")
      .select("count")
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();

    await db.from("notifications").upsert(
      {
        kind,
        source,
        title,
        body,
        dedupe_key: dedupeKey,
        count: (existing?.count ?? 0) + 1,
        created_at: new Date().toISOString(),
      },
      { onConflict: "dedupe_key" },
    );
  } catch {
    /* a feed that breaks the page it reports on is not worth having */
  }
}

/**
 * Announce a sync, but ONLY if the database confirms it stored something.
 *
 * `verify` re-reads Supabase and returns what is actually there. If it reports
 * nothing new, nothing is announced — which is what the request for a
 * confirmation from the database itself amounts to.
 */
export async function notifyIfStored(
  source: string,
  title: (n: { rows: number; at: string }) => string,
  body: (n: { rows: number; at: string }) => string,
  dedupeKey: string,
  verify: () => Promise<{ rows: number; at: string | null } | null>,
): Promise<boolean> {
  const confirmed = await verify();
  if (!confirmed || confirmed.rows <= 0 || !confirmed.at) return false;
  const n = { rows: confirmed.rows, at: confirmed.at };
  await notify("success", source, title(n), body(n), dedupeKey);
  return true;
}

/** The most recent notifications, newest first. */
export async function recentNotifications(limit = 40): Promise<Notification[]> {
  const db = readClient();
  if (!db) return [];
  try {
    const { data } = await db
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => ({
      id: Number(r.id),
      kind: r.kind as NotifyKind,
      source: String(r.source),
      title: String(r.title),
      body: (r.body as string) ?? null,
      count: Number(r.count ?? 1),
      firstSeenAt: String(r.first_seen_at),
      createdAt: String(r.created_at),
    }));
  } catch {
    return [];
  }
}

/** Clear a resolved problem, so a fixed fault stops showing as current. */
export async function clearNotification(dedupeKey: string): Promise<void> {
  const db = adminClient();
  if (!db) return;
  try {
    await db.from("notifications").delete().eq("dedupe_key", dedupeKey);
  } catch {
    /* non-fatal */
  }
}
