// One-off moves from the old news bot to the new one (docs/news-pipeline.md).
// Server-only.
//
// seedFromMentions stores every story the old bot ever kept or turned down as
// an article that has already been decided, so the new bot treats it as seen
// and never reads or judges it again by accident. requeueForRecheck sends a
// chosen group of those stories back through read and check, so the new rules
// decide them instead of the old bot; lib/news/write.ts then updates the old
// row rather than adding a second one beside it. Run the seed once, then each
// kind of re-check once.
import { adminClient } from "@/lib/supabase";
import { isGoogleNewsLink } from "@/lib/googleNews";
import { outletKey, titleKey, urlKey } from "@/lib/news/keys";
import { chunkByLength } from "@/lib/news/store";
import type { ArticleRow } from "@/lib/news/types";

/** Which imported stories go back through the bot. */
export type RecheckKind =
  | "unchecked_ours" //  ours, still counting, never fact-checked
  | "pending_reread" //  ours, taken out of the count by the old fact check because the page could not be read
  | "rivals"; //         every rival story, of any year and status

export const RECHECK_KINDS: readonly RecheckKind[] = ["unchecked_ours", "pending_reread", "rivals"];

export const isRecheckKind = (v: unknown): v is RecheckKind => RECHECK_KINDS.includes(v as RecheckKind);

/** The mentions sources the old bot wrote. Every other source is the PR team's own history. */
const OLD_BOT_SOURCES = ["googlenews", "competitor_news"];

/** Supabase returns at most 1,000 rows to one select. */
const PAGE = 1000;
const INSERT_CHUNK = 200;

/** The columns of a mentions row the import reads. */
export interface LegacyMention {
  id: string;
  source: string | null;
  status: string | null;
  url: string | null;
  title: string | null;
  outlet_name: string | null;
  published_on: string | null;
  created_at?: string | null;
  metadata: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
}

/** A news_articles row made from an old one. */
export type ImportedArticle = Pick<
  ArticleRow,
  | "id"
  | "google_link"
  | "url"
  | "url_key"
  | "title"
  | "title_key"
  | "outlet"
  | "outlet_key"
  | "published_on"
  | "found_by"
  | "status"
  | "legacy_mention_id"
  | "decision"
  | "note"
> & { first_seen_at?: string; dup_of?: string };

/** What makes two stored articles the same one, as the search step checks it. */
type ArticleKeys = Pick<ArticleRow, "id" | "google_link" | "url_key" | "title_key" | "outlet_key">;

function db() {
  const c = adminClient();
  if (!c) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return c;
}

const squash = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Hosts whose pages are never the story: Google's own, and the consent and
 * sign-in screens a site sends a reader to instead. The old bot sometimes kept
 * one of these as the article's address when a redirect stopped there, and
 * many stories would then share one "address".
 */
const NOT_A_PUBLISHER = /(^|\.)google(?:\.[a-z]{2,3}){1,2}$|^(?:consent|guce|login|signin|accounts|auth)\./;

/** The address, when it is a publisher's web page rather than a Google link or a wall. */
export function publisherAddress(value: unknown): string | null {
  const s = squash(value);
  if (!s || isGoogleNewsLink(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || NOT_A_PUBLISHER.test(u.hostname.toLowerCase())) return null;
  return s;
}

/** The search terms that found the story, as the old bot kept them. */
function keywordsOf(m: LegacyMention): string[] {
  const listed = asRecord(m.metadata).keywords ?? asRecord(m.raw).keywords;
  if (!Array.isArray(listed)) return [];
  // At most 20, like the search step keeps.
  return [...new Set(listed.map(squash).filter(Boolean))].slice(0, 20);
}

const dateOnly = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function timestamp(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const at = new Date(v);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * The article row an old bot's mention becomes, or null when it has no
 * headline to be stored under. Pure, so it can be tested without a database.
 *
 * The keys are made exactly as the search step makes them (lib/news/keys.ts),
 * which is what lets a story found again tomorrow be recognised as this one:
 * the Google link from the feed (raw.link, or the row's address when it was
 * never unwrapped), the publisher's address when the old bot had one, and the
 * headline at the outlet. It is stored as decided with no decision, which the
 * read and check steps never claim, and keeps the old row's id so a re-check
 * updates that row. first_seen_at is when the old bot stored it, so this
 * morning's list on Bot Activity is not filled with imports.
 */
export function articleFromMention(m: LegacyMention): ImportedArticle | null {
  const title = squash(m.title);
  const outlet = squash(m.outlet_name) || null;
  const tkey = titleKey(title, outlet);
  if (!m.id || !tkey) return null;
  const raw = asRecord(m.raw);
  const googleLink = [raw.link, m.url].map(squash).find((s) => s && isGoogleNewsLink(s)) ?? null;
  const url = publisherAddress(m.url) ?? publisherAddress(raw.resolved);
  const article: ImportedArticle = {
    id: `lm_${m.id}`,
    google_link: googleLink,
    url,
    url_key: urlKey(url),
    title,
    title_key: tkey,
    outlet,
    outlet_key: outletKey(outlet),
    published_on: dateOnly(m.published_on),
    found_by: keywordsOf(m),
    status: "decided",
    legacy_mention_id: m.id,
    decision: null,
    note: `imported from the old bot (${squash(m.status) || "no status"})`,
  };
  const firstSeen = timestamp(m.created_at);
  if (firstSeen) article.first_seen_at = firstSeen;
  return article;
}

/** The keys an article is known by: any one shared with a stored article makes it the same article. */
export function sameArticleKeys(a: ArticleKeys): string[] {
  const keys = [`id ${a.id}`, `title ${a.title_key}|${a.outlet_key}`];
  if (a.google_link) keys.push(`link ${a.google_link}`);
  if (a.url_key) keys.push(`address ${a.url_key}`);
  return keys;
}

/** Counting rows first: of two old rows for one story, the one that counts speaks for it. */
const STATUS_ORDER: Record<string, number> = { reviewed: 0, new: 1 };

/**
 * The articles to store for these mentions, given the keys already stored
 * (key to the id of the article holding it). Pure.
 *
 * A mention is left out when the new bot wrote it (it carries its article's
 * id) or when it has no headline. The old bot sometimes stored one story
 * twice, under two outlet spellings or two links; the first of those, with
 * counting rows taken before rejected ones, becomes the article, and each
 * other is stored as its duplicate (status duplicate, dup_of the article), so
 * its old row follows the article's verdict once the new bot has one
 * (lib/news/store.ts importedDuplicates) instead of counting on its own. A
 * duplicate carries no Google link, which may be stored only once.
 */
export function planImport(
  mentions: LegacyMention[],
  seen: Map<string, string>,
): { rows: ImportedArticle[]; duplicates: ImportedArticle[]; skipped: number } {
  const rows: ImportedArticle[] = [];
  const duplicates: ImportedArticle[] = [];
  let skipped = 0;
  const ordered = [...mentions].sort(
    (a, b) => (STATUS_ORDER[a.status ?? ""] ?? 2) - (STATUS_ORDER[b.status ?? ""] ?? 2) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const m of ordered) {
    const article = asRecord(m.metadata).articleId ? null : articleFromMention(m);
    if (!article) {
      skipped++;
      continue;
    }
    const keys = sameArticleKeys(article);
    // Stored already under its own id: nothing to do.
    if (seen.has(`id ${article.id}`)) {
      skipped++;
      continue;
    }
    const owner = keys.map((k) => seen.get(k)).find((id): id is string => !!id && id !== article.id);
    if (owner) {
      duplicates.push({ ...article, status: "duplicate", dup_of: owner, google_link: null, note: `the same story as article ${owner}, stored twice by the old bot` });
      seen.set(`id ${article.id}`, article.id);
      continue;
    }
    for (const k of keys) seen.set(k, article.id);
    rows.push(article);
  }
  return { rows, duplicates, skipped };
}

type Page = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

/** Every row a query returns, a page at a time. A page that fails fails the whole read: a partial list is the bug. */
async function readAll<T>(what: string, page: (from: number, to: number) => Page): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${what} could not be read: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

const isUniqueViolation = (e: { code?: string; message: string }) => e.code === "23505" || /duplicate key|unique/i.test(e.message);

/**
 * Store a chunk of imported articles and return how many were stored. A
 * search storing the same story at the same moment trips a unique index for
 * the whole chunk, so then the rows go in one at a time and the ones already
 * there are left out.
 */
async function insertImported(rows: ImportedArticle[]): Promise<number> {
  const { error } = await db().from("news_articles").insert(rows);
  if (!error) return rows.length;
  if (!isUniqueViolation(error)) throw new Error(`storing imported articles failed: ${error.message}`);
  let stored = 0;
  for (const row of rows) {
    const { error: e } = await db().from("news_articles").insert(row);
    if (!e) stored++;
    else if (!isUniqueViolation(e)) throw new Error(`storing imported article ${row.id} failed: ${e.message}`);
  }
  return stored;
}

/**
 * Store every story the old bot saw (mentions with source googlenews or
 * competitor_news) as an article already decided, unless an article with the
 * same id, Google link, address or headline and outlet is stored already: then
 * it is stored as that article's duplicate (see planImport). Safe to run
 * again: what it stored the first time is skipped the second.
 *
 * The stored articles' keys are read in full first, rather than looked up a
 * chunk at a time, because the lookups would carry long Google links in the
 * address and the whole table is a few thousand short rows.
 */
/**
 * Bring every stored address key up to the current rule (lib/news/keys.ts
 * urlKey). Keys stored before Nov 2026 dropped the query whenever the address
 * had a path, so every YouTube video, and every article on a site that names
 * its pages by ?id=, shared one key. A key that now belongs to another stored
 * article makes this one its duplicate, as the read step would. Returns how
 * many keys changed.
 */
export async function rekeyAddresses(): Promise<number> {
  const rows = await readAll<Pick<ArticleRow, "id" | "url" | "url_key" | "status">>("the stored addresses", (from, to) =>
    db().from("news_articles").select("id,url,url_key,status").not("url", "is", null).order("id", { ascending: true }).range(from, to),
  );
  let changed = 0;
  for (const r of rows) {
    const key = urlKey(r.url);
    if (!key || key === r.url_key) continue;
    const { error } = await db().from("news_articles").update({ url_key: key }).eq("id", r.id);
    if (!error) {
      changed++;
      continue;
    }
    if (!isUniqueViolation(error)) throw new Error(`refreshing the address of ${r.id} failed: ${error.message}`);
    const { data: owner, error: e } = await db()
      .from("news_articles")
      .select("id")
      .eq("url_key", key)
      .neq("status", "duplicate")
      .neq("id", r.id)
      .limit(1);
    if (e) throw new Error(`finding the article at ${key} failed: ${e.message}`);
    const ownerId = owner?.[0]?.id as string | undefined;
    if (!ownerId) continue;
    const { error: e2 } = await db().from("news_articles").update({ url_key: key, status: "duplicate", dup_of: ownerId }).eq("id", r.id);
    if (e2) throw new Error(`marking ${r.id} as the same story as ${ownerId} failed: ${e2.message}`);
    changed++;
  }
  return changed;
}

export async function seedFromMentions(): Promise<{ seeded: number; skipped: number; twins: number; rekeyed: number }> {
  const rekeyed = await rekeyAddresses();
  const stored = await readAll<ArticleKeys>("the stored articles", (from, to) =>
    db().from("news_articles").select("id,google_link,url_key,title_key,outlet_key").order("id", { ascending: true }).range(from, to),
  );
  const mentions = await readAll<LegacyMention>("the old bot's mentions", (from, to) =>
    db()
      .from("mentions")
      .select("id,source,status,url,title,outlet_name,published_on,created_at,metadata,raw")
      .in("source", OLD_BOT_SOURCES)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const seen = new Map<string, string>();
  for (const a of stored) for (const k of sameArticleKeys(a)) seen.set(k, a.id);
  const { rows, duplicates, skipped } = planImport(mentions, seen);
  let seeded = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) seeded += await insertImported(rows.slice(i, i + INSERT_CHUNK));
  let twins = 0;
  for (let i = 0; i < duplicates.length; i += INSERT_CHUNK) twins += await insertImported(duplicates.slice(i, i + INSERT_CHUNK));
  return { seeded, skipped: skipped + rows.length - seeded + duplicates.length - twins, twins, rekeyed };
}

/** How each kind finds its old rows in mentions. Kept apart from the query so it can be tested. */
export interface RecheckFilter {
  source: string;
  /** The old row's status. */
  status?: string;
  /** No metadata.factCheck at all: the old fact check never looked at it. */
  withoutFactCheck?: boolean;
  /** metadata.factCheck.result, as the old fact check left it. */
  factCheckResult?: string;
  /** No metadata.personVerdict: a person's Keep or Reject is never sent back through the bot. */
  withoutPersonVerdict?: boolean;
}

/**
 * The old rows each kind covers:
 * - unchecked_ours: ours, still counting (status new), that the old fact check never looked at;
 * - pending_reread: ours that the old fact check took out of the count because it could not read
 *   the page (status rejected, factCheck.result "unread"), which the new bot may well read;
 * - rivals: every rival story, of any year and any status.
 */
export function recheckFilter(kind: RecheckKind): RecheckFilter {
  switch (kind) {
    case "unchecked_ours":
      return { source: "googlenews", status: "new", withoutFactCheck: true };
    case "pending_reread":
      return { source: "googlenews", status: "rejected", factCheckResult: "unread", withoutPersonVerdict: true };
    case "rivals":
      return { source: "competitor_news", withoutPersonVerdict: true };
  }
}

/** The ids of the old bot's rows a re-check kind covers. */
async function legacyMentionIds(kind: RecheckKind): Promise<string[]> {
  const f = recheckFilter(kind);
  const rows = await readAll<{ id: string }>("the old bot's mentions", (from, to) => {
    let q = db().from("mentions").select("id").eq("source", f.source);
    if (f.status) q = q.eq("status", f.status);
    if (f.withoutFactCheck) q = q.is("metadata->factCheck", null);
    if (f.factCheckResult) q = q.eq("metadata->factCheck->>result", f.factCheckResult);
    if (f.withoutPersonVerdict) q = q.is("metadata->>personVerdict", null);
    return q.order("id", { ascending: true }).range(from, to);
  });
  return rows.map((r) => String(r.id));
}

/** What the person-rejection test reads of a mentions row. */
export interface OldRowVerdict {
  status: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * True for a row a person rejected on the old Bot Activity, which recorded no
 * verdict of its own: its Reject set the status and nothing else. The retired
 * backfill (lib/prBackfill.ts) put the rows it recovered back to new, marked
 * recoveredBy "backfill", and no bot of that time ever rejected one again, so
 * such a row now rejected was rejected by a person. A row the new bot or the
 * new Bot Activity has written carries its article's id, and is left out.
 */
export function rejectedOnOldScreen(row: OldRowVerdict): boolean {
  const meta = asRecord(row.metadata);
  return row.status === "rejected" && meta.recoveredBy === "backfill" && meta.personVerdict == null && meta.articleId == null;
}

/**
 * Mark the rows a person rejected on the old Bot Activity (rejectedOnOldScreen)
 * with metadata.personVerdict "rejected", the verdict the new Bot Activity
 * records, so no re-check and no later write counts them again. Safe to run
 * again: a row marked once no longer matches. Returns how many were marked.
 */
export async function markOldPersonRejections(): Promise<number> {
  const rows = await readAll<{ id: string; status: string | null; metadata: Record<string, unknown> | null }>(
    "the rows rejected on the old Bot Activity",
    (from, to) =>
      db()
        .from("mentions")
        .select("id,status,metadata")
        .eq("status", "rejected")
        .eq("metadata->>recoveredBy", "backfill")
        .is("metadata->>personVerdict", null)
        .is("metadata->>articleId", null)
        .order("id", { ascending: true })
        .range(from, to),
  );
  let marked = 0;
  for (const row of rows.filter(rejectedOnOldScreen)) {
    // Again in the database: a verdict given since the read stands as it is.
    const { data, error } = await db()
      .from("mentions")
      .update({ metadata: { ...asRecord(row.metadata), personVerdict: "rejected" } })
      .eq("id", row.id)
      .eq("status", "rejected")
      .is("metadata->>personVerdict", null)
      .select("id");
    if (error) throw new Error(`marking ${row.id} as rejected by a person failed: ${error.message}`);
    marked += data?.length ?? 0;
  }
  return marked;
}

/** The note a re-queued import carries until it is read, in place of the import's. */
export const RECHECK_NOTE = "re-checking the old bot's story";

/** The start of the note a person's Keep or Reject on Bot Activity leaves on the article (lib/data.ts). */
const PERSON_NOTES = ["rejected by a person", "kept by a person"];

/**
 * Statuses a re-check leaves alone. reading and checking are a run's claims,
 * so the article is being looked at already. A duplicate shares its address
 * with the article it copies, and the address may be stored only once outside
 * duplicates, so putting it back in the queue would be refused. A held article
 * has been checked already and waits only for counting to be turned on: in
 * test mode its old row is left as it was, so the same re-check would
 * otherwise pick it up again and pay to check it twice.
 */
const LEAVE_ALONE = ["reading", "checking", "duplicate", "held"];

/** What a re-check reads of an imported article. */
export type ImportedState = Pick<ArticleRow, "id" | "legacy_mention_id" | "status" | "note" | "google_link" | "url"> &
  Partial<Pick<ArticleRow, "dup_of">>;

/**
 * The imported articles to send back to the queue: those whose old row is
 * among `legacyIds`, unless a run is working on it or it is a duplicate
 * (LEAVE_ALONE), it has neither a Google link nor an address to read, or a
 * person kept or rejected it on Bot Activity, whose verdict stands. Pure.
 */
export function recheckIds(articles: ImportedState[], legacyIds: Set<string>): string[] {
  // A story the old bot stored twice is checked through its article: when the
  // twin's row is one this kind covers, the article goes back, and the twin's
  // row follows the article's new verdict (lib/news/store.ts importedDuplicates).
  const twinCovered = new Set(
    articles
      .filter((a) => a.status === "duplicate" && a.dup_of && a.legacy_mention_id && legacyIds.has(a.legacy_mention_id))
      .map((a) => a.dup_of as string),
  );
  return articles
    .filter(
      (a) =>
        !!a.legacy_mention_id &&
        (legacyIds.has(a.legacy_mention_id) || twinCovered.has(a.id)) &&
        !LEAVE_ALONE.includes(a.status) &&
        !!(a.google_link || a.url) &&
        !PERSON_NOTES.some((n) => (a.note ?? "").toLowerCase().startsWith(n)),
    )
    .map((a) => a.id);
}

/**
 * Send imported stories back through read and check, so the new rules decide
 * them (recheckFilter says which). First the rows a person rejected on the old
 * Bot Activity are marked as theirs (markOldPersonRejections), so none of them
 * is counted again. Each article then goes back in the queue as if new, with
 * the note RECHECK_NOTE. Returns how many went back, and how many old rows
 * were marked.
 */
export async function requeueForRecheck(kind: RecheckKind): Promise<{ requeued: number; markedRejected: number }> {
  if (!isRecheckKind(kind)) throw new Error(`unknown re-check: ${String(kind)}`);
  const markedRejected = await markOldPersonRejections();
  const legacyIds = new Set(await legacyMentionIds(kind));
  const imported = await readAll<ImportedState>("the imported articles", (from, to) =>
    db()
      .from("news_articles")
      .select("id,legacy_mention_id,status,note,google_link,url,dup_of")
      .not("legacy_mention_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to),
  );
  let requeued = 0;
  for (const part of chunkByLength(recheckIds(imported, legacyIds))) {
    const { data, error } = await db()
      .from("news_articles")
      .update({
        status: "queued",
        candidates: null,
        decision: null,
        read_attempts: 0,
        ai_attempts: 0,
        next_try_at: null,
        error: null,
        note: RECHECK_NOTE,
        updated_at: new Date().toISOString(),
      })
      .in("id", part)
      // Again here: a run may have claimed one since the read.
      .not("status", "in", `(${LEAVE_ALONE.join(",")})`)
      .select("id");
    if (error) throw new Error(`re-queueing imported articles failed: ${error.message}`);
    requeued += data?.length ?? 0;
  }
  return { requeued, markedRejected };
}
