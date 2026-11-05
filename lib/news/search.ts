// The search step's Google News half (docs/news-pipeline.md, "search"): which
// searches to run each morning, running them, and turning each feed into
// FoundItems for insertFound. Server-only.
//
// Nothing here decides whether an article is about anyone we track; the read
// and check steps do that from the article's text. The one exception is a
// headline or outlet that names another company with our name inside it, such
// as Better Homes & Gardens, which is ruled out here before anything reads it.
import { stripOutletSuffix } from "@/lib/news/keys";
import type { FoundItem, NewsSettings, Registry } from "@/lib/news/types";

/** One Google News search, and which list asked for it. */
export interface SearchQuery {
  query: string;
  kind: "pr" | "rival" | "person";
}

/** A search that produced nothing because it failed, or was never started. */
export interface SearchFailure {
  query: string;
  error: string;
}

export interface SearchOptions {
  /** The Google News edition as URL parameters. Defaults to NEWS_EDITION, then the UAE edition. */
  edition?: string;
  /** Searches in flight at once. Default 4. */
  concurrency?: number;
  /** The longest wait for one search, in milliseconds. Default 15 seconds. */
  timeoutMs?: number;
  /** No new search starts once this many milliseconds have passed. Default 90 seconds. */
  budgetMs?: number;
  /** Stands in for fetch, so tests never reach Google. */
  fetchImpl?: typeof fetch;
}

// The UAE edition, as lib/ingest.ts found: the coverage that matters sits on
// Zawya, TradeArabia, MENAFN, Khaleej Times and Arabian Business, which the US
// edition under-represents.
const DEFAULT_EDITION = "hl=en-AE&gl=AE&ceid=AE:en";

// A desktop browser's, like the other Google requests in this app
// (lib/googleNews.ts), so the search looks like an ordinary reader's.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const squash = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Every search for one morning: our own name, the PR keywords, then each
 * rival's own query, then `"<name>" dubai` for every current spokesperson.
 *
 * Our name is searched even when the PR keyword list doesn't hold it, so
 * emptying that list in the editor can't stop the bot looking for us.
 *
 * A person's name is quoted and paired with "dubai" so the search finds the
 * name as written and in our market: "Simon Baker" alone is mostly the actor.
 * Former people are not searched, because they count only when the article
 * names their old company, and that company's own searches look for it. The
 * same search twice, ignoring case and spacing, runs once, under the kind that
 * asked for it first.
 */
export function buildQueries(reg: Registry, prKeywords: string[], window: NewsSettings["searchWindow"]): SearchQuery[] {
  const seen = new Set<string>();
  const out: SearchQuery[] = [];
  const add = (raw: string, kind: SearchQuery["kind"]) => {
    const query = squash(raw);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) return;
    seen.add(key);
    out.push({ query, kind });
  };
  add(reg.us.query, "pr");
  for (const keyword of prKeywords) add(keyword, "pr");
  for (const company of reg.companies) if (!company.isUs) add(company.query, "rival");
  for (const person of reg.people) {
    // A quote inside the name would end the quoted phrase early.
    const name = squash((person.name || "").replace(/"/g, " "));
    if (person.active && name) add(`"${name}" dubai`, "person");
  }
  if (!window) return out;
  // A keyword written with its own time filter keeps it: a second when: would
  // leave Google to pick one of the two.
  return out.map((q) => (/(^|\s)when:\S/i.test(q.query) ? q : { ...q, query: `${q.query} when:${window}` }));
}

// Copied from NOT_US in lib/match.ts, which this module may not change: other
// companies whose names contain ours. Kept identical so the two agree. Only
// match() and replace() use it, which ignore where a "g" pattern last stopped.
const NOT_US = /\bbetter[ \u00a0]?homes?\s*(?:&|and)\s*gardens\b|\bbetter[ \u00a0]?home\s+group\b/gi;
/** BHG, Better Homes & Gardens' short form, as a whole word: "bhg.com", "BH&G". Any other BHG is not us either. */
const BHG = /\bbhg\b|\bbh ?& ?g\b/gi;
/** Our name as one word, copied from BRAND_WORD in lib/match.ts. */
const OUR_WORD = /\bbetterhomes\b|\bbhomes(?:\.com)?\b/i;

function otherCompanyIn(text: string): string | null {
  const named = text.match(NOT_US)?.[0];
  if (named) return /garden/i.test(named) ? "Better Homes & Gardens, another company" : "BetterHome Group, another company";
  return text.match(BHG) ? "BHG, another company" : null;
}

/**
 * Why the headline alone rules the article out, or null when it doesn't.
 *
 * Better Homes & Gardens and BetterHome Group are other companies whose names
 * contain ours, and BHG is the first one's short form, so a headline or outlet
 * that names any of them is stored as skipped and never read. Spacing and
 * case don't matter. A headline that also names us as one word
 * ("betterhomes", "bhomes") is not skipped: a skip is final, so it goes on to
 * be read and checked instead.
 */
export function headlineSkip(title: string, outlet: string | null): string | null {
  const headline = squash(title);
  const reason = otherCompanyIn(headline) ?? otherCompanyIn(squash(outlet));
  if (!reason) return null;
  if (OUR_WORD.test(headline.replace(NOT_US, " ").replace(BHG, " "))) return null;
  return reason;
}

/** The named entities that turn up in headlines. Anything else is left as written. */
const ENTITIES = new Map<string, string>(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    lsquo: "\u2018",
    rsquo: "\u2019",
    sbquo: "\u201a",
    ldquo: "\u201c",
    rdquo: "\u201d",
    bdquo: "\u201e",
    laquo: "\u00ab",
    raquo: "\u00bb",
    ndash: "\u2013",
    mdash: "\u2014",
    hellip: "\u2026",
    bull: "\u2022",
    middot: "\u00b7",
    deg: "\u00b0",
    times: "\u00d7",
    euro: "\u20ac",
    pound: "\u00a3",
    cent: "\u00a2",
    yen: "\u00a5",
    copy: "\u00a9",
    reg: "\u00ae",
    trade: "\u2122",
    szlig: "\u00df",
    aelig: "\u00e6",
    AElig: "\u00c6",
    oslash: "\u00f8",
    Oslash: "\u00d8",
  }),
);
/** Accented letters written as entities, such as the "&ouml;" in Engel & V&ouml;lkers. */
const ACCENTS: Record<string, string> = {
  acute: "\u0301",
  grave: "\u0300",
  circ: "\u0302",
  tilde: "\u0303",
  uml: "\u0308",
  ring: "\u030a",
  cedil: "\u0327",
  caron: "\u030c",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES.get(body);
    if (named) return named;
    const accented = body.match(/^([a-zA-Z])(acute|grave|circ|tilde|uml|ring|cedil|caron)$/);
    return accented ? (accented[1] + ACCENTS[accented[2]]).normalize("NFC") : whole;
  });
}

/** An element's text as XML means it: CDATA taken as written, entities elsewhere decoded once. */
function elementText(raw: string | undefined): string {
  return squash(
    (raw ?? "")
      .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
      .map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decodeEntities(part)))
      .join(""),
  );
}

/**
 * A headline's or outlet's text. Decoded a second time, because a publisher's
 * own entities arrive escaped again ("Dubai&amp;#39;s") or inside CDATA.
 */
const displayText = (raw: string | undefined) => squash(decodeEntities(elementText(raw)));

const DUBAI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * The day an article was published in Dubai, where it is read: 23:00 GMT is
 * already the next morning there. Built from the parts rather than the
 * locale's own layout, so a change in date style can't move the fields.
 */
function dubaiDate(raw: string): string | null {
  const at = new Date(raw);
  if (!raw || Number.isNaN(at.getTime())) return null;
  const part = Object.fromEntries(DUBAI_DAY.formatToParts(at).map((p) => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day}`;
}

const ITEM = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const LINK = /<link\b[^>]*>([\s\S]*?)<\/link>/i;
const PUB_DATE = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i;
const SOURCE = /<source\b[^>]*>([\s\S]*?)<\/source>/i;

/**
 * The results in one Google News feed, in the feed's order.
 *
 * A pattern over the <item> blocks is enough, because Google's feed is plain
 * and regular. A result with no headline has nothing to be stored under and
 * one with no link has nothing to read, so both are left out.
 */
export function parseRss(xml: string, query: string): FoundItem[] {
  const items: FoundItem[] = [];
  for (const [, block] of (xml || "").matchAll(ITEM)) {
    const outlet = displayText(block.match(SOURCE)?.[1]) || null;
    const title = stripOutletSuffix(displayText(block.match(TITLE)?.[1]), outlet);
    const link = elementText(block.match(LINK)?.[1]);
    if (!title || !/^https?:\/\/\S+$/i.test(link)) continue;
    const item: FoundItem = { title, link, outlet, publishedOn: dubaiDate(elementText(block.match(PUB_DATE)?.[1])), query };
    const skip = headlineSkip(title, outlet);
    if (skip) item.skip = skip;
    items.push(item);
  }
  return items;
}

type Outcome = { items: FoundItem[]; error?: string };

/** A failed request in a few plain words, for the run log. */
function describeFailure(e: unknown, timeoutMs: number): string {
  const err = (e ?? {}) as { name?: unknown; message?: unknown; cause?: unknown };
  if (err.name === "TimeoutError" || err.name === "AbortError") return `timed out after ${timeoutMs / 1000} s`;
  const message = typeof err.message === "string" && err.message ? err.message : String(e);
  // fetch itself says only "fetch failed"; the cause says why, such as no network or a refused connection.
  const cause = (err.cause as { message?: unknown } | undefined)?.message;
  return typeof cause === "string" && cause && !message.includes(cause) ? `${message} (${cause})` : message;
}

async function searchOne(query: string, edition: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<Outcome> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}${edition ? `&${edition}` : ""}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeoutMs),
      // Each morning's results are new: never answer a search from Next's data cache.
      cache: "no-store",
    });
    if (!res.ok) {
      // Let the connection go rather than leave an unread body holding it.
      void res.body?.cancel().catch(() => undefined);
      return { items: [], error: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    // A consent or "unusual traffic" page can come back as a 200 too, and
    // would otherwise read as a search that found nothing.
    if (!/<rss\b|<channel\b/i.test(xml)) return { items: [], error: "not a news feed" };
    return { items: parseRss(xml, query) };
  } catch (e) {
    return { items: [], error: describeFailure(e, timeoutMs) };
  }
}

const atLeast = (n: number | undefined, min: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) && n >= min ? n : fallback;

/**
 * Run the searches against Google News, a few at a time.
 *
 * One failed search never stops the others: its HTTP status or error goes in
 * `failures`, and so does every search not started because the time budget
 * ran out, so a short morning shows rather than passing as a quiet one. A
 * search already running when the budget passes is left to finish, since its
 * request has its own timeout. Items and failures come back in the order of
 * `queries`, whatever order the answers arrive in, so the first search to find
 * an article is the copy insertFound keeps.
 */
export async function runSearches(
  queries: { query: string; kind: string }[],
  opts: SearchOptions = {},
): Promise<{ items: FoundItem[]; failures: SearchFailure[] }> {
  // Read at call time, so the edition follows the environment the run is in.
  const edition = (opts.edition || process.env.NEWS_EDITION || DEFAULT_EDITION).trim().replace(/^[?&]+/, "");
  const concurrency = Math.floor(atLeast(opts.concurrency, 1, 4));
  const timeoutMs = Math.round(atLeast(opts.timeoutMs, 1, 15_000));
  const budgetMs = atLeast(opts.budgetMs, 0, 90_000);
  // Looked up now rather than when this module loads, so Next's own fetch is the one used.
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();

  const outcomes: Outcome[] = new Array(queries.length);
  let next = 0;
  const worker = async () => {
    while (next < queries.length) {
      const i = next++;
      outcomes[i] =
        Date.now() - startedAt >= budgetMs
          ? { items: [], error: "time budget" }
          : await searchOne(queries[i].query, edition, timeoutMs, fetchImpl);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, worker));

  const items: FoundItem[] = [];
  const failures: SearchFailure[] = [];
  queries.forEach((q, i) => {
    const { items: found, error } = outcomes[i];
    items.push(...found);
    if (error) failures.push({ query: q.query, error });
  });
  return { items, failures };
}
