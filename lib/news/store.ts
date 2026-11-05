// The article store's reads and writes (news_articles, news_runs). Server-only.
//
// Every step goes through here, so the rules that keep the bot honest live in
// one place: a repeat is never stored twice, an article is worked on by one
// run at a time (claim_news_articles), and every step leaves a log row.
import { adminClient } from "@/lib/supabase";
import { articleId, outletKey, titleKey, urlKey } from "@/lib/news/keys";
import type { ArticleRow, ArticleStatus, FoundItem, StepCounts } from "@/lib/news/types";

/** Rows per insert. They travel in the request's body, so only the count matters. */
const CHUNK = 200;
/** Supabase returns at most 1,000 rows to one select. */
const PAGE = 1000;

type Db = NonNullable<ReturnType<typeof adminClient>>;

function db(): Db {
  const c = adminClient();
  if (!c) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return c;
}

const chunks = <T>(xs: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Values split so each `.in()` filter stays a short web address. The filter
 * travels in the address, and a few hundred long values make one too long to
 * be accepted: 200 Google links, at about 230 characters each, come to some
 * 46,000. So a part holds about `maxChars` characters of values, as they are
 * written in the address, and never more than `maxCount` of them. A value
 * longer than the limit still goes, in a part of its own.
 */
export function chunkByLength(values: string[], maxChars = 4000, maxCount = 200): string[][] {
  const out: string[][] = [];
  let part: string[] = [];
  let size = 0;
  for (const value of values) {
    // The value as it is written in the address, with its quotes and comma.
    const length = encodeURIComponent(value).length + 3;
    if (part.length && (size + length > maxChars || part.length >= maxCount)) {
      out.push(part);
      part = [];
      size = 0;
    }
    part.push(value);
    size += length;
  }
  if (part.length) out.push(part);
  return out;
}

/** Today in Dubai, YYYY-MM-DD: the day a run belongs to. */
export function dubaiDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Store what the searches found, minus anything already stored.
 *
 * Repeats are checked three ways before a row is written: the same result
 * twice in this batch, the same Google link, and the same headline at the same
 * outlet. The address check comes later, once the link is unwrapped. A test
 * may hand it a stand-in client.
 */
export async function insertFound(items: FoundItem[], client: Db | null = null): Promise<{ fresh: number; repeats: number; skipped: number }> {
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

  const c = client ?? db();
  const seenLinks = new Set<string>();
  const seenTitles = new Set<string>();
  for (const part of chunkByLength([...new Set(pending.map((p) => p.item.link).filter(Boolean))])) {
    const { data, error } = await c.from("news_articles").select("google_link").in("google_link", part);
    if (error) throw new Error(`repeat check failed: ${error.message}`);
    for (const r of data ?? []) seenLinks.add(String(r.google_link));
  }
  for (const part of chunkByLength([...new Set(pending.map((p) => p.tkey))])) {
    const { data, error } = await c.from("news_articles").select("title_key,outlet_key").in("title_key", part);
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
    const { error } = await c.from("news_articles").upsert(part, { onConflict: "id", ignoreDuplicates: true });
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
export async function saveArticle(id: string, patch: Partial<ArticleRow>, client: Db | null = null): Promise<void> {
  const { error } = await (client ?? db())
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
export async function findOwnerOfUrl(url: string | null, exceptId: string, client: Db | null = null): Promise<string | null> {
  const key = urlKey(url);
  if (!key) return null;
  const { data, error } = await (client ?? db())
    .from("news_articles")
    .select("id")
    .eq("url_key", key)
    .neq("id", exceptId)
    .neq("status", "duplicate")
    .limit(1);
  if (error) throw new Error(`address check failed: ${error.message}`);
  return (data?.[0]?.id as string | undefined) ?? null;
}

const isUniqueViolation = (e: { code?: string; message: string }) => e.code === "23505" || /duplicate key|unique/i.test(e.message);

/**
 * Save the unwrapped address. When another row has it, this row becomes that
 * row's duplicate. When another row claims it in the meantime, the unique
 * index refuses it, and this row becomes the duplicate of that one.
 *
 * Should the index refuse it and no owner then be found (the other row let
 * the address go again a moment later), this row is not made a duplicate of
 * nothing: it is left without the address, and the read carries on as for an
 * article no other row shares.
 */
export async function saveResolvedUrl(id: string, url: string | null, client: Db | null = null): Promise<{ duplicateOf: string | null }> {
  const key = urlKey(url);
  if (!url || !key) return { duplicateOf: null };
  const c = client ?? db();
  const owner = await findOwnerOfUrl(url, id, c);
  if (owner) {
    await saveArticle(id, { url, url_key: key, status: "duplicate", dup_of: owner }, c);
    return { duplicateOf: owner };
  }
  const { error } = await c.from("news_articles").update({ url, url_key: key, updated_at: new Date().toISOString() }).eq("id", id);
  if (!error) return { duplicateOf: null };
  if (isUniqueViolation(error)) {
    const winner = await findOwnerOfUrl(url, id, c);
    if (!winner) return { duplicateOf: null };
    await saveArticle(id, { url, url_key: key, status: "duplicate", dup_of: winner }, c);
    return { duplicateOf: winner };
  }
  throw new Error(`saving the address of ${id} failed: ${error.message}`);
}

/** Put articles back where they were, for a later run: used when the AI can't answer. */
export async function release(ids: string[], status: ArticleStatus, error: string | null): Promise<void> {
  for (const part of chunkByLength(ids)) {
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

/**
 * Held articles for the publish step, oldest first, `limit` from `offset`.
 * The offset passes over the ones this step tried and had to leave held, which
 * stay at the front of the list while the rest move on to decided.
 */
export async function heldArticles(offset: number, limit: number, client: Db | null = null): Promise<ArticleRow[]> {
  const { data, error } = await (client ?? db())
    .from("news_articles")
    .select("*")
    .eq("status", "held")
    .order("first_seen_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`reading the held articles failed: ${error.message}`);
  return (data ?? []) as ArticleRow[];
}

/**
 * Every imported article found to be the same story as another stored one:
 * status duplicate, with the old bot's row it came from and the article it
 * copies. Read whole, a page at a time; a page that fails fails the read.
 */
export async function importedDuplicates(client: Db | null = null): Promise<Pick<ArticleRow, "id" | "legacy_mention_id" | "dup_of">[]> {
  const c = client ?? db();
  const out: Pick<ArticleRow, "id" | "legacy_mention_id" | "dup_of">[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await c
      .from("news_articles")
      .select("id,legacy_mention_id,dup_of")
      .eq("status", "duplicate")
      .not("legacy_mention_id", "is", null)
      .not("dup_of", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`reading the imported duplicates failed: ${error.message}`);
    out.push(...((data ?? []) as Pick<ArticleRow, "id" | "legacy_mention_id" | "dup_of">[]));
    if (!data || data.length < PAGE) return out;
  }
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
