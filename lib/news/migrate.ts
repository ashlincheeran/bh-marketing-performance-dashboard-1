// One-off moves from the old news bot to the new one (docs/news-pipeline.md).
// Server-only.
//
// seedFromMentions stores every story the old bot ever kept or turned down as
// an article that has already been decided, so the new bot treats it as seen
// and never reads or judges it again by accident. requeueForRecheck sends a
// chosen group of those stories back through read and check, so the new rules
// decide them instead of the old bot; lib/news/write.ts then updates the old
// row rather than adding a second one beside it.
import { adminClient } from "@/lib/supabase";
import { isGoogleNewsLink } from "@/lib/googleNews";
import { outletKey, titleKey, urlKey } from "@/lib/news/keys";
import type { ArticleRow } from "@/lib/news/types";

/** Which imported stories go back through the bot. */
export type RecheckKind =
  | "unchecked_ours" //  ours, still counting, never fact-checked
  | "rivals_2026"; //    every rival story published in 2026

export const RECHECK_KINDS: readonly RecheckKind[] = ["unchecked_ours", "rivals_2026"];

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
> & { first_seen_at?: string };

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

/**
 * The articles to store for these mentions, given the keys already stored.
 * Pure. A mention is left out when the new bot wrote it (it carries its
 * article's id), when it has no headline, or when it shares a key with a
 * stored article or one earlier in the list: the same story filed twice by the
 * old bot is one article, and the first row found keeps it.
 */
export function planImport(mentions: LegacyMention[], seen: Set<string>): { rows: ImportedArticle[]; skipped: number } {
  const rows: ImportedArticle[] = [];
  let skipped = 0;
  for (const m of mentions) {
    const article = asRecord(m.metadata).articleId ? null : articleFromMention(m);
    const keys = article ? sameArticleKeys(article) : [];
    if (!article || keys.some((k) => seen.has(k))) {
      skipped++;
      continue;
    }
    for (const k of keys) seen.add(k);
    rows.push(article);
  }
  return { rows, skipped };
}

/**
 * Values split so each `.in()` filter stays a short web address. The filter
 * travels in the address, and a few hundred long values make one that is too
 * long to be accepted.
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
 * same id, Google link, address or headline and outlet is stored already. Safe
 * to run again: what it stored the first time is skipped the second.
 *
 * The stored articles' keys are read in full first, rather than looked up a
 * chunk at a time, because the lookups would carry long Google links in the
 * address and the whole table is a few thousand short rows.
 */
export async function seedFromMentions(): Promise<{ seeded: number; skipped: number }> {
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
  const { rows, skipped } = planImport(mentions, new Set(stored.flatMap(sameArticleKeys)));
  let seeded = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) seeded += await insertImported(rows.slice(i, i + INSERT_CHUNK));
  return { seeded, skipped: skipped + rows.length - seeded };
}

/** How each kind finds its old rows in mentions. Kept apart from the query so it can be tested. */
export function recheckFilter(kind: RecheckKind): {
  source: string;
  status?: string;
  withoutFactCheck?: boolean;
  publishedFrom?: string;
  publishedBefore?: string;
} {
  return kind === "unchecked_ours"
    ? { source: "googlenews", status: "new", withoutFactCheck: true }
    : { source: "competitor_news", publishedFrom: "2026-01-01", publishedBefore: "2027-01-01" };
}

/** The ids of the old bot's rows a re-check kind covers. */
async function legacyMentionIds(kind: RecheckKind): Promise<string[]> {
  const f = recheckFilter(kind);
  const rows = await readAll<{ id: string }>("the old bot's mentions", (from, to) => {
    let q = db().from("mentions").select("id").eq("source", f.source);
    if (f.status) q = q.eq("status", f.status);
    if (f.withoutFactCheck) q = q.is("metadata->factCheck", null);
    if (f.publishedFrom) q = q.gte("published_on", f.publishedFrom);
    if (f.publishedBefore) q = q.lt("published_on", f.publishedBefore);
    return q.order("id", { ascending: true }).range(from, to);
  });
  return rows.map((r) => String(r.id));
}

/**
 * Statuses a re-check leaves alone. reading and checking are a run's claims,
 * so the article is being looked at already. A duplicate shares its address
 * with the article it copies, and the address may be stored only once outside
 * duplicates, so putting it back in the queue would be refused.
 */
const LEAVE_ALONE = "(reading,checking,duplicate)";

/**
 * Send imported stories back through read and check, so the new rules decide
 * them: "unchecked_ours" is our old rows still counting (status new) that were
 * never fact-checked, "rivals_2026" every old rival row published in 2026.
 * Returns how many articles went back in the queue. One with neither a Google
 * link nor an address has nothing to read, so it stays as it is.
 */
export async function requeueForRecheck(kind: RecheckKind): Promise<number> {
  if (!isRecheckKind(kind)) throw new Error(`unknown re-check: ${String(kind)}`);
  const ids = await legacyMentionIds(kind);
  let requeued = 0;
  for (const part of chunkByLength(ids)) {
    const { data, error } = await db()
      .from("news_articles")
      .update({
        status: "queued",
        candidates: null,
        decision: null,
        read_attempts: 0,
        ai_attempts: 0,
        next_try_at: null,
        updated_at: new Date().toISOString(),
      })
      .in("legacy_mention_id", part)
      .or("google_link.not.is.null,url.not.is.null")
      .not("status", "in", LEAVE_ALONE)
      .select("id");
    if (error) throw new Error(`re-queueing imported articles failed: ${error.message}`);
    requeued += data?.length ?? 0;
  }
  return requeued;
}
