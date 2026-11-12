// The article store's reads and writes (news_articles, news_runs). Server-only.
//
// Every step goes through here, so the rules that keep the bot honest live in
// one place: a repeat is never stored twice, an article is worked on by one
// run at a time (claim_news_articles), a step saves an article only while it
// is still as the step found it (saveArticle's guard), and every step leaves a
// log row.
import { adminClient } from "@/lib/supabase";
import { articleId, outletKey, titleKey, urlKey } from "@/lib/news/keys";
import type { ArticleRow, ArticleStatus, FoundItem, StepCounts } from "@/lib/news/types";

/** Rows per insert. They travel in the request's body, so only the count matters. */
const CHUNK = 200;
/** Supabase returns at most 1,000 rows to one select. */
const PAGE = 1000;

type Db = NonNullable<ReturnType<typeof adminClient>>;

/** The service-role client, which every step's reads and writes need. Throws when SUPABASE_SERVICE_ROLE_KEY is not set. */
export function db(): Db {
  const c = adminClient();
  if (!c) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return c;
}

const chunks = <T>(xs: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * True for an old bot's mentions row that was rejected by hand, outside any
 * screen: a one-off cleanup of the old rival feed rejected 23 rows ("not the
 * competitor brokerage") and marked each with metadata.rejected_by and
 * rejected_reason, nothing else. No bot ever writes rejected_by, so such a row
 * is a person's Reject, and the bot leaves it as it is (docs/news-pipeline.md,
 * rule 6). Kept here, beside the other rules every step shares, so the write
 * guard, the re-checks and Bot Activity all read it the same way.
 */
export function rejectedByHand(row: { status: string | null; metadata: unknown }): boolean {
  const meta = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};
  return row.status === "rejected" && typeof meta.rejected_by === "string" && meta.rejected_by.trim() !== "";
}

/**
 * What a person's Keep and Reject leave in the article's note (app/actions.ts).
 * The news bot's steps and re-checks leave alone any article whose note starts
 * with one of these (lib/news/run.ts, lib/news/migrate.ts), so a person's
 * verdict is never checked again.
 */
export const KEPT_NOTE = "kept by a person";
export const REJECTED_NOTE = "rejected by a person";

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
  // ignoreDuplicates: a run racing this one may have stored the same article a
  // moment ago. The answer then holds only the rows this call stored, which are
  // the ones counted, so two searches at once never both count one article as new.
  const stored = new Set<string>();
  for (const part of chunks(rows)) {
    const { data, error } = await c.from("news_articles").upsert(part, { onConflict: "id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`storing new articles failed: ${error.message}`);
    for (const r of data ?? []) stored.add(String(r.id));
  }
  const added = rows.filter((r) => stored.has(r.id));
  const skipped = added.filter((r) => r.status === "skipped").length;
  return { fresh: added.length - skipped, repeats: items.length - added.length, skipped };
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

/**
 * What must still be true of an article for a step's save of it to land: the
 * run still holds its claim, or, for the publish step, which takes none, it is
 * still in the status the step found it in.
 */
export type SaveGuard = { claimedBy: string } | { status: ArticleStatus };

/**
 * Save an article's new state and let go of its claim, but only while the
 * guard still holds, and say whether it saved. A person's Keep or Reject on Bot
 * Activity must win over a run that holds the article: their Reject closes it
 * and lets go of the claim, so a step that finishes after that saves nothing
 * over their decision. A claim whose lease ran out may be another run's by now,
 * which the guard refuses too.
 */
export async function saveArticle(id: string, patch: Partial<ArticleRow>, guard: SaveGuard, client: Db | null = null): Promise<boolean> {
  let q = (client ?? db())
    .from("news_articles")
    .update({ ...patch, claimed_at: null, claimed_by: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  q = "claimedBy" in guard ? q.eq("claimed_by", guard.claimedBy) : q.eq("status", guard.status);
  const { data, error } = await q.select("id");
  if (error) throw new Error(`saving article ${id} failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** An article's status, claim and note as they are now. Null when it is no longer stored. */
export type ArticleState = Pick<ArticleRow, "status" | "claimed_by" | "note">;

/**
 * An article's status, claim and note as they are now, read just before a
 * step writes: a person may have kept or rejected it, or another run published
 * it, since the step took it.
 */
export async function articleState(id: string, client: Db | null = null): Promise<ArticleState | null> {
  const { data, error } = await (client ?? db()).from("news_articles").select("status,claimed_by,note").eq("id", id).limit(1);
  if (error) throw new Error(`reading article ${id} failed: ${error.message}`);
  return ((data ?? [])[0] as ArticleState | undefined) ?? null;
}

/**
 * The stored article this address belongs to, if another row already has it.
 * Two Google links often lead to one article (the same story filed under two
 * outlet names), and only the first should be read.
 */
async function findOwnerOfUrl(url: string | null, exceptId: string, client: Db | null = null): Promise<string | null> {
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
 * Save the unwrapped address of an article the read step holds. When another
 * row has it, this row becomes that row's duplicate. When another row claims
 * it in the meantime, the unique index refuses it, and this row becomes the
 * duplicate of that one.
 *
 * Should the index refuse it and no owner then be found (the other row let
 * the address go again a moment later), this row is not made a duplicate of
 * nothing: it is left without the address, and the read carries on as for an
 * article no other row shares.
 *
 * Every write needs the run's claim still in place: `lost` says it was gone (a
 * person closed the article on Bot Activity), and then nothing was saved.
 */
export async function saveResolvedUrl(
  id: string,
  url: string | null,
  runId: string,
  client: Db | null = null,
): Promise<{ duplicateOf: string | null; lost?: true }> {
  const key = urlKey(url);
  if (!url || !key) return { duplicateOf: null };
  const c = client ?? db();
  const claim = { claimedBy: runId };
  const copyOf = async (owner: string) =>
    (await saveArticle(id, { url, url_key: key, status: "duplicate", dup_of: owner }, claim, c))
      ? { duplicateOf: owner }
      : { duplicateOf: null, lost: true as const };
  const owner = await findOwnerOfUrl(url, id, c);
  if (owner) return copyOf(owner);
  const { data, error } = await c
    .from("news_articles")
    .update({ url, url_key: key, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("claimed_by", runId)
    .select("id");
  if (!error) return data?.length ? { duplicateOf: null } : { duplicateOf: null, lost: true };
  if (isUniqueViolation(error)) {
    const winner = await findOwnerOfUrl(url, id, c);
    if (!winner) return { duplicateOf: null };
    return copyOf(winner);
  }
  throw new Error(`saving the address of ${id} failed: ${error.message}`);
}

/**
 * Put articles back where they were, for a later run: used when the AI can't
 * answer. Only the ones `runId` still holds: one a person closed on Bot
 * Activity in the meantime stays closed.
 */
export async function release(ids: string[], status: ArticleStatus, error: string | null, runId: string, client: Db | null = null): Promise<void> {
  for (const part of chunkByLength(ids)) {
    const { error: e } = await (client ?? db())
      .from("news_articles")
      .update({ status, error, claimed_at: null, claimed_by: null, updated_at: new Date().toISOString() })
      .in("id", part)
      .eq("claimed_by", runId);
    if (e) throw new Error(`releasing articles failed: ${e.message}`);
  }
}

/** A mentions row of an article, as the bot reads it to tell who decided what (lib/news/handCheck.ts toArticleMentionRow). */
export type MentionRef = {
  id: string;
  status: string;
  source: string | null;
  competitor: string | null;
  personVerdict: string | null;
  /** metadata.rejected_by, which only the old rival feed's cleanup by hand and the audit of 6 Nov 2026 wrote (rejectedByHand). */
  rejectedBy?: string | null;
  articleId: string | null;
};

/** The columns of a MentionRef, as PostgREST reads them. */
export const MENTION_REF_FIELDS =
  "id,status,source,competitor:metadata->>competitor,personVerdict:metadata->>personVerdict,rejectedBy:metadata->>rejected_by,articleId:metadata->>articleId";

/**
 * The mentions rows of each article, by the article's id, as Check by hand and
 * the morning's re-queue for Apify read them: every row the news bot or a
 * person wrote for it, which carry metadata.articleId; the old bot's row it was
 * imported from (legacy_mention_id); and the old rows of its copies (status
 * duplicate, dup_of the article), since the old bot stored some stories twice,
 * for two companies or under two links. A read that fails throws, so nothing
 * is decided on a guess. `client` is the caller's: Check by hand reads with
 * the read-only one.
 */
export async function mentionRefsOf(
  articles: Pick<ArticleRow, "id" | "legacy_mention_id">[],
  client: Db | null = null,
): Promise<Map<string, MentionRef[]>> {
  const c = client ?? db();
  const ids = articles.map((a) => a.id);
  const known = new Set(ids);
  const legacyOf = new Map<string, string>();
  for (const a of articles) if (a.legacy_mention_id) legacyOf.set(a.legacy_mention_id, a.id);
  const copies = await Promise.all(
    chunkByLength(ids).map((part) => c.from("news_articles").select("legacy_mention_id,dup_of").eq("status", "duplicate").in("dup_of", part)),
  );
  for (const { data, error } of copies) {
    if (error) throw new Error(`reading the articles' copies failed: ${error.message}`);
    for (const copy of (data ?? []) as Pick<ArticleRow, "legacy_mention_id" | "dup_of">[]) {
      if (copy.legacy_mention_id && copy.dup_of && known.has(copy.dup_of) && !legacyOf.has(copy.legacy_mention_id)) {
        legacyOf.set(copy.legacy_mention_id, copy.dup_of);
      }
    }
  }
  const reads = await Promise.all([
    ...chunkByLength(ids).map((part) => c.from("mentions").select(MENTION_REF_FIELDS).in("metadata->>articleId", part)),
    ...chunkByLength([...legacyOf.keys()]).map((part) => c.from("mentions").select(MENTION_REF_FIELDS).in("id", part)),
  ]);
  const out = new Map<string, MentionRef[]>();
  for (const { data, error } of reads) {
    if (error) throw new Error(`reading the articles' rows failed: ${error.message}`);
    for (const r of (data ?? []) as unknown as MentionRef[]) {
      const owner = r.articleId && known.has(r.articleId) ? r.articleId : legacyOf.get(r.id);
      if (!owner) continue;
      const list = out.get(owner) ?? [];
      if (!list.some((x) => x.id === r.id)) list.push(r);
      out.set(owner, list);
    }
  }
  return out;
}

/** An unreadable article as the morning's re-queue reads it, to say whether Apify should have its go at it. */
export type UnreadableArticle = Pick<
  ArticleRow,
  "id" | "found_by" | "legacy_mention_id" | "url" | "outlet" | "read_via" | "note" | "next_try_at"
>;

const UNREADABLE_FIELDS = "id,found_by,legacy_mention_id,url,outlet,read_via,note,next_try_at";

/**
 * Unreadable articles go back in the queue (docs/news-pipeline.md, search step 1):
 *
 * - those whose retry time has come, up to `maxAttempts` tries;
 * - with `forApify`, which the caller gives while the Apify backup is on, every
 *   other one it picks, whatever its tries, so the read that follows gives it
 *   to Apify. Only one whose next try is still set is offered to it: a
 *   person's Keep, Count or Not about clears the next try, and their Reject
 *   closes the article. The caller is handed each one's rows (mentionRefsOf),
 *   so it can pass by one a person decided on a row instead, as Check by hand
 *   does, and picks those worth an Apify read that Apify has not had its go at
 *   (lib/news/run.ts apifyTryDue). That read records Apify's go, so none is put
 *   back for this twice. Its next try is made now, so the read step takes it
 *   at once.
 *
 * Says how many went back each way. `client` is for tests.
 */
export async function requeueDueUnreadable(
  forApify: ((a: UnreadableArticle, rows: MentionRef[]) => boolean) | null = null,
  { maxAttempts = 3, client = null }: { maxAttempts?: number; client?: Db | null } = {},
): Promise<{ due: number; forApify: number }> {
  const c = client ?? db();
  const now = new Date().toISOString();
  const { data, error } = await c
    .from("news_articles")
    .update({ status: "queued", updated_at: now })
    .eq("status", "unreadable")
    .lt("read_attempts", maxAttempts)
    .lte("next_try_at", now)
    .select("id");
  if (error) throw new Error(`re-queueing unreadable articles failed: ${error.message}`);
  const due = data?.length ?? 0;
  if (!forApify) return { due, forApify: 0 };

  // Read whole, a page at a time, before anything is moved, so no page skips a row.
  const backlog: UnreadableArticle[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error: readError } = await c
      .from("news_articles")
      .select(UNREADABLE_FIELDS)
      .eq("status", "unreadable")
      .not("next_try_at", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (readError) throw new Error(`reading the unreadable articles failed: ${readError.message}`);
    backlog.push(...((rows ?? []) as unknown as UnreadableArticle[]));
    if (!rows || rows.length < PAGE) break;
  }
  const rowsOf = backlog.length ? await mentionRefsOf(backlog, c) : new Map<string, MentionRef[]>();
  const picked = backlog.filter((a) => forApify(a, rowsOf.get(a.id) ?? [])).map((a) => a.id);
  // Only while each is still unreadable and undecided: a person may have counted one in the meantime.
  let moved = 0;
  for (const part of chunkByLength(picked)) {
    const { data: back, error: moveError } = await c
      .from("news_articles")
      .update({ status: "queued", next_try_at: now, updated_at: now })
      .in("id", part)
      .eq("status", "unreadable")
      .not("next_try_at", "is", null)
      .select("id");
    if (moveError) throw new Error(`re-queueing unreadable articles for Apify failed: ${moveError.message}`);
    moved += back?.length ?? 0;
  }
  return { due, forApify: moved };
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
 * The article's own verdict on the story, once the new bot has one: decided
 * with a decision (the AI's, or a person's on Bot Activity), read in full and
 * naming nobody, or ruled out by its headline. An article still waiting, held
 * or unreadable has none yet, and neither has an untouched import.
 */
export function speaksForStory(owner: Pick<ArticleRow, "status" | "decision">): boolean {
  return owner.status === "no_names" || owner.status === "skipped" || (owner.status === "decided" && owner.decision != null);
}

/** An imported duplicate as the sweep of old rows reads it: its old row, the article it copies, and its old row's status at the import. */
type ImportedDuplicate = Pick<ArticleRow, "id" | "legacy_mention_id" | "dup_of" | "legacy_status">;

/**
 * Every imported article that is the same story as another stored one (status
 * duplicate, with the old bot's row it came from and the article it copies),
 * once that article has a verdict of its own (speaksForStory). Its old row can
 * then stop counting on its own; before that, withdrawing it could drop the
 * story's only counted row on the strength of an article nobody has checked.
 * Read whole, a page at a time; a page that fails fails the read.
 */
export async function importedDuplicates(client: Db | null = null): Promise<ImportedDuplicate[]> {
  const c = client ?? db();
  const out: ImportedDuplicate[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await c
      .from("news_articles")
      .select("id,legacy_mention_id,dup_of,legacy_status")
      .eq("status", "duplicate")
      .not("legacy_mention_id", "is", null)
      .not("dup_of", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`reading the imported duplicates failed: ${error.message}`);
    out.push(...((data ?? []) as ImportedDuplicate[]));
    if (!data || data.length < PAGE) break;
  }
  const owners = new Map<string, Pick<ArticleRow, "status" | "decision">>();
  for (const part of chunkByLength([...new Set(out.map((d) => d.dup_of as string))])) {
    const { data, error } = await c.from("news_articles").select("id,status,decision").in("id", part);
    if (error) throw new Error(`reading the articles the duplicates copy failed: ${error.message}`);
    for (const r of data ?? []) owners.set(String(r.id), r as Pick<ArticleRow, "status" | "decision">);
  }
  return out.filter((d) => {
    const owner = owners.get(d.dup_of as string);
    return !!owner && speaksForStory(owner);
  });
}

/**
 * The deployment a run's log rows belong to (news_runs.env): Vercel's
 * environment, production or preview, and "development" anywhere else.
 * Production and the previews share one database, so this is what keeps a
 * preview's test runs off the live Bot Activity.
 */
export function runEnv(env: Record<string, string | undefined> = process.env): string {
  return env.VERCEL_ENV || "development";
}

/**
 * The news_runs rows `env`'s deployment wrote, as a PostgREST `or` filter
 * (query.or). In production that includes the rows with no env: code from
 * before migration 0024, still live while this change was on its way, went on
 * writing them.
 */
export function runEnvFilter(env: string): string {
  return env === "production" ? "env.eq.production,env.is.null" : `env.eq.${env}`;
}

/** Open a log row for one step of one run, marked with the deployment that runs it. */
export async function startRun(step: string, runId: string, link: number, trigger: string, client: Db | null = null): Promise<number | null> {
  const { data, error } = await (client ?? db())
    .from("news_runs")
    .insert({ run_day: dubaiDay(), run_id: runId, step, link, trigger, env: runEnv() })
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

/**
 * Leave how a run ended on its last news_runs row, where Bot Activity reads
 * it: the error added after any the row has, and ok false, which is what Bot
 * Activity shows as a problem (lib/data.ts summariseRunDay). The run's summary
 * goes to ingest_runs, which a preview's test run never writes and Bot
 * Activity does not read, so a chain that stopped early, at a next link that
 * could not be started or at the link limit, would otherwise be recorded
 * nowhere anyone looks. The same ending again changes nothing. Returns whether
 * the row changed.
 */
export async function noteRunEnding(runId: string, error: string, client: Db | null = null): Promise<boolean> {
  const c = client ?? db();
  const { data, error: readError } = await c
    .from("news_runs")
    .select("id,ok,error")
    .eq("run_id", runId)
    .order("id", { ascending: false })
    .limit(1);
  if (readError) throw new Error(`the run's last step could not be read: ${readError.message}`);
  const last = (data ?? [])[0] as { id: number; ok: boolean | null; error: string | null } | undefined;
  if (!last) return false;
  const before = last.error ?? "";
  if (before.includes(error) && last.ok === false) return false;
  const { error: e } = await c
    .from("news_runs")
    .update({ ok: false, error: before.includes(error) ? before : before ? `${before}; ${error}` : error })
    .eq("id", last.id);
  if (e) throw new Error(`the run's ending could not be recorded: ${e.message}`);
  return true;
}
