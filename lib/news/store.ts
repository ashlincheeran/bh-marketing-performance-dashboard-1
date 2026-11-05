// The article store's reads and writes (news_articles, news_runs). Server-only.
//
// Every step goes through here, so the rules that keep the bot honest live in
// one place: a repeat is never stored twice, an article is worked on by one
// run at a time (claim_news_articles), and every step leaves a log row.
import { adminClient } from "@/lib/supabase";
import { articleId, outletKey, titleKey, urlKey } from "@/lib/news/keys";
import type { ArticleRow, ArticleStatus, FoundItem, StepCounts } from "@/lib/news/types";

const CHUNK = 200;

function db() {
  const c = adminClient();
  if (!c) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return c;
}

const chunks = <T>(xs: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Today in Dubai, YYYY-MM-DD: the day a run belongs to. */
export function dubaiDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Store what the searches found, minus anything already stored.
 *
 * Repeats are checked three ways before a row is written: the same result
 * twice in this batch, the same Google link, and the same headline at the same
 * outlet. The address check comes later, once the link is unwrapped.
 */
export async function insertFound(items: FoundItem[]): Promise<{ fresh: number; repeats: number; skipped: number }> {
  type Pending = { item: FoundItem; tkey: string; okey: string; queries: Set<string> };
  const batch = new Map<string, Pending>();
  const byLink = new Map<string, Pending>();
  for (const item of items) {
    const tkey = titleKey(item.title, item.outlet);
    if (!tkey) continue;
    const okey = outletKey(item.outlet);
    const k = `${tkey}|${okey}`;
    const prev = batch.get(k) ?? (item.link ? byLink.get(item.link) : undefined);
    if (prev) {
      prev.queries.add(item.query);
      continue;
    }
    const entry = { item, tkey, okey, queries: new Set([item.query]) };
    batch.set(k, entry);
    if (item.link) byLink.set(item.link, entry);
  }
  const pending = [...batch.values()];
  if (!pending.length) return { fresh: 0, repeats: items.length, skipped: 0 };

  const seenLinks = new Set<string>();
  const seenTitles = new Set<string>();
  for (const part of chunks([...new Set(pending.map((p) => p.item.link).filter(Boolean))])) {
    const { data, error } = await db().from("news_articles").select("google_link").in("google_link", part);
    if (error) throw new Error(`repeat check failed: ${error.message}`);
    for (const r of data ?? []) seenLinks.add(String(r.google_link));
  }
  for (const part of chunks([...new Set(pending.map((p) => p.tkey))])) {
    const { data, error } = await db().from("news_articles").select("title_key,outlet_key").in("title_key", part);
    if (error) throw new Error(`repeat check failed: ${error.message}`);
    for (const r of data ?? []) seenTitles.add(`${r.title_key}|${r.outlet_key}`);
  }

  const rows = pending
    .filter((p) => !seenLinks.has(p.item.link) && !seenTitles.has(`${p.tkey}|${p.okey}`))
    .map((p) => ({
      id: articleId({ googleLink: p.item.link, titleKey: p.tkey, outletKey: p.okey }),
      google_link: p.item.link || null,
      title: p.item.title,
      title_key: p.tkey,
      outlet: p.item.outlet,
      outlet_key: p.okey,
      published_on: p.item.publishedOn,
      found_by: [...p.queries].slice(0, 20),
      status: (p.item.skip ? "skipped" : "queued") as ArticleStatus,
      note: p.item.skip ?? null,
    }));
  // ignoreDuplicates: a run racing this one may have stored the same article a moment ago.
  for (const part of chunks(rows)) {
    const { error } = await db().from("news_articles").upsert(part, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`storing new articles failed: ${error.message}`);
  }
  const skipped = rows.filter((r) => r.status === "skipped").length;
  return { fresh: rows.length - skipped, repeats: items.length - rows.length, skipped };
}

/** Hand this run up to `limit` articles in `from`, moved to `to`. See claim_news_articles in migration 0020. */
export async function claim(from: ArticleStatus, to: ArticleStatus, limit: number, runId: string, leaseSeconds = 600): Promise<ArticleRow[]> {
  const { data, error } = await db().rpc("claim_news_articles", {
    p_from: from,
    p_to: to,
    p_limit: limit,
    p_run: runId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`claiming articles failed: ${error.message}`);
  return (data ?? []) as ArticleRow[];
}

/** Save an article's new state and let go of its claim. */
export async function saveArticle(id: string, patch: Partial<ArticleRow>): Promise<void> {
  const { error } = await db()
    .from("news_articles")
    .update({ ...patch, claimed_at: null, claimed_by: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`saving article ${id} failed: ${error.message}`);
}

/**
 * The stored article this address belongs to, if another row already has it.
 * Two Google links often lead to one article (the same story filed under two
 * outlet names), and only the first should be read.
 */
export async function findOwnerOfUrl(url: string | null, exceptId: string): Promise<string | null> {
  const key = urlKey(url);
  if (!key) return null;
  const { data, error } = await db()
    .from("news_articles")
    .select("id")
    .eq("url_key", key)
    .neq("id", exceptId)
    .neq("status", "duplicate")
    .limit(1);
  if (error) throw new Error(`address check failed: ${error.message}`);
  return (data?.[0]?.id as string | undefined) ?? null;
}

/**
 * Save the unwrapped address. When another row claims the same address in the
 * meantime, the unique index refuses it, and this row becomes the duplicate.
 */
export async function saveResolvedUrl(id: string, url: string | null): Promise<{ duplicateOf: string | null }> {
  const key = urlKey(url);
  if (!url || !key) return { duplicateOf: null };
  const owner = await findOwnerOfUrl(url, id);
  if (owner) {
    await saveArticle(id, { url, url_key: key, status: "duplicate", dup_of: owner });
    return { duplicateOf: owner };
  }
  const { error } = await db().from("news_articles").update({ url, url_key: key, updated_at: new Date().toISOString() }).eq("id", id);
  if (!error) return { duplicateOf: null };
  if (/duplicate key|unique/i.test(error.message)) {
    const winner = await findOwnerOfUrl(url, id);
    await saveArticle(id, { url, url_key: key, status: "duplicate", dup_of: winner });
    return { duplicateOf: winner };
  }
  throw new Error(`saving the address of ${id} failed: ${error.message}`);
}

/** Put articles back where they were, for a later run: used when the AI can't answer. */
export async function release(ids: string[], status: ArticleStatus, error: string | null): Promise<void> {
  for (const part of chunks(ids)) {
    const { error: e } = await db()
      .from("news_articles")
      .update({ status, error, claimed_at: null, claimed_by: null, updated_at: new Date().toISOString() })
      .in("id", part);
    if (e) throw new Error(`releasing articles failed: ${e.message}`);
  }
}

/** Unreadable articles whose retry time has come go back in the queue, up to three tries. */
export async function requeueDueUnreadable(maxAttempts = 3): Promise<number> {
  const { data, error } = await db()
    .from("news_articles")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("status", "unreadable")
    .lt("read_attempts", maxAttempts)
    .lte("next_try_at", new Date().toISOString())
    .select("id");
  if (error) throw new Error(`re-queueing unreadable articles failed: ${error.message}`);
  return data?.length ?? 0;
}

/** How many articles are waiting in a status, claims included, so a step knows whether to run again. */
export async function waiting(status: ArticleStatus): Promise<number> {
  const { count, error } = await db().from("news_articles").select("id", { count: "exact", head: true }).eq("status", status);
  if (error) throw new Error(`counting ${status} failed: ${error.message}`);
  return count ?? 0;
}

/** Open a log row for one step of one run. */
export async function startRun(step: string, runId: string, link: number, trigger: string): Promise<number | null> {
  const { data, error } = await db()
    .from("news_runs")
    .insert({ run_day: dubaiDay(), run_id: runId, step, link, trigger })
    .select("id")
    .single();
  if (error) {
    console.error(`[news] could not open the run log: ${error.message}`);
    return null;
  }
  return data.id as number;
}

/** Close a step's log row. Never throws: a log failure must not undo the work. */
export async function finishRun(logId: number | null, ok: boolean, counts: StepCounts, error?: string | null): Promise<void> {
  if (logId == null) return;
  const { error: e } = await db()
    .from("news_runs")
    .update({ finished_at: new Date().toISOString(), ok, counts, error: error ?? null })
    .eq("id", logId);
  if (e) console.error(`[news] could not close the run log: ${e.message}`);
}
