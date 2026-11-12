// Reading one article for the news bot: unwrap its Google link if need be, fetch the publisher's page
// with a plain request, and find the story in it (lib/news/extract.ts). Apify reads it instead only
// when the caller allows it for this article (Settings has the backup on, and the article is worth it)
// and the plain read didn't get the whole article. Server-only.
//
// Nothing here throws. Every way a read can fail comes back as a status the read step can act on,
// because "no text" has several causes (the site refused us, the link never unwrapped, the page was a
// bot check, the story sits behind a paywall) and only a whole article, read in full, licenses the
// conclusion that it names nobody. So a read is "ok" only when the story itself was there: not when the
// site sent the read somewhere else, served a page-not-found page, or showed the story's opening above
// a paywall. Whatever text such a read found is still handed back, since it can prove a mention.
import { fetchArticleBody, type ArticleBody, type ArticleBodyOptions } from "@/lib/apify";
import { isGoogleOwned, resolveArticleUrl, type Resolved } from "@/lib/googleNews";
import {
  BOT_CHECK_TEXT,
  BOT_CHECK_TITLE,
  OK_CHARS,
  extractArticle,
  isBotCheckText,
  saysNotFound,
  tidyText,
  wallLineIn,
  type ExtractSource,
  type ExtractedArticle,
} from "@/lib/news/extract";
import type { ReadResult } from "@/lib/news/types";

export interface ReadOptions {
  /**
   * Apify may read what the plain request could not, for this article: Settings has the Apify backup
   * on, and the article is worth it (lib/news/run.ts worthApify). Without it the plain read stands.
   */
  apifyBackup: boolean;
  /** Asked only when the backup would be used, so the caller can check the time left. */
  apifyAllowed: () => Promise<boolean>;
  /**
   * Called after every Apify attempt that reached a crawl, whatever came of it, so the caller can count the
   * run's Apify reads. Not when nothing was crawled: no token, no time, or every crawl turned down.
   */
  onApifyRead?: () => Promise<void>;
  /** How long the plain request may take, the page's body included. 15 seconds by default. */
  timeoutMs?: number;
  /**
   * When the whole read must be over, as a time in milliseconds (as Date.now() gives it). Unwrapping the
   * link and the plain request are cut short to fit, and Apify gets what is left, APIFY_WINDOW_MS at most.
   * Without it, each part keeps its own limit.
   */
  deadline?: number;
  fetchImpl?: typeof fetch;
  /** For tests: stands in for lib/apify.ts, which calls Apify. */
  apifyRead?: (link: string, opts: ArticleBodyOptions) => Promise<ArticleBody>;
  /** For tests: stands in for lib/googleNews.ts, which calls Google. */
  resolveLink?: (link: string) => Promise<Resolved>;
}

const TIMEOUT_MS = 15_000;

/**
 * The longest an Apify read may take: the window the read step keeps for one when it allows it
 * (lib/news/run.ts), so a read it allowed is over, and counted, inside the step that started it.
 */
const APIFY_WINDOW_MS = 150_000;

/** With less time than this left, Apify is not started: even its quick crawler could not finish. */
const APIFY_MIN_MS = 30_000;

/** How long past its deadline an Apify read is waited for, should lib/apify.ts overrun it, before the plain read stands. */
const APIFY_GRACE_MS = 5_000;

/** The most of a page that is read. Stories sit well inside it; what lies beyond is inline script and data. */
const MAX_BYTES = 3 * 1024 * 1024;

/** Answers that mean "not for you": sign-in walls, bot shields, rate limits, legal blocks, and the 503 bot shields also send. */
const BLOCKED_STATUSES = new Set([401, 403, 429, 451, 503]);

/** Answers that mean the page is gone, for Apify's crawler as much as for the plain request. */
const GONE_STATUSES = new Set([404, 410]);

/** A desktop browser's request. Many sites answer anything that looks like a script with a block page. */
const HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
};

/** Bot checks are small pages; the start of a big one is enough to look through. */
const BOT_CHECK_SCAN = 500_000;

/** Consent screens a site sends a reader to. A crawler elsewhere in the world may not be sent there. */
const CONSENT_HOST = /^(?:consent|guce|gdpr)\./;
/** Sign-in and subscription hosts a site sends a reader to instead of the story. */
const WALL_HOST = /^(?:login|signin|sign-in|accounts?|myaccount|auth|sso|subscribe|subscriptions?|join|register|paywall)\./;
/** The same pages as parts of an address on the site itself: "/subscribe", "/account/login", "/en/consent". */
const CONSENT_PATH = /^(?:consent|gdpr|cookie-?consent)$/i;
const WALL_PATH = /^(?:subscribe|subscriptions?|register|registration|sign[-_]?up|sign[-_]?in|log[-_]?in|account|accounts|my[-_]?account|paywall|auth)$/i;
/** A site's front page, perhaps in one language: "/", "/en/", "/index.html", "/home". */
const FRONT_PAGE = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?\/?)?(?:(?:index|default|home)(?:\.\w+)?\/?)?$/i;
/** Query parameters that track a visit or say where to go back to, and never name a story. */
const NOT_A_STORY = /^(?:utm_\w+|ref|refsrc|src|source|from|fbclid|gclid|mc_\w+|return\w*|redirect\w*|continue|next|dest\w*|back\w*|origin)$/i;

/** Where the text was found, for the note kept with the article. */
const FOUND_IN: Record<ExtractSource, string> = {
  jsonld: "the article data in the page",
  articlebody: "the marked article body",
  article: "the article section",
  main: "the main section",
  paragraphs: "the page's paragraphs",
  meta: "the page's summary",
  none: "around the story",
};

/**
 * Node's windows-1252 decoder (which every "latin1" and "iso-8859-1" page really is) leaves bytes 0x80
 * to 0x9F as control characters instead of the curly quotes, dashes and euro sign they stand for, so
 * "Sotheby’s" would come out with a control character where its apostrophe is. These are the
 * characters those bytes stand for, in order; the five the encoding leaves undefined stay as they are.
 */
const WINDOWS_1252_HIGH =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

/** A plain read, with what only this module needs to know of it. */
interface PlainRead extends ReadResult {
  /** Apify's crawler would meet the same answer: the page is gone, is not a web page, or stops at a paywall or a sign-in. */
  final?: true;
}

const FINAL = { final: true } as const;

/** The address, if it is a web address (http or https). */
function webAddress(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  try {
    return /^https?:$/.test(new URL(t).protocol) ? t : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Google's own pages (its consent screen, its rate-limit page, its news site), which are never the story. */
const isGoogleHost = (url: string): boolean => isGoogleOwned(url);

function messageOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // Node's fetch says only "fetch failed" and keeps the reason (no such host, connection refused) in `cause`.
  const cause = (e as { cause?: unknown }).cause;
  const why = cause instanceof Error ? cause.message : "";
  return (why && !e.message.includes(why) ? `${e.message} (${why})` : e.message).slice(0, 300);
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} milliseconds`;
  const s = Math.round(ms / 1000);
  return s === 1 ? "1 second" : `${s} seconds`;
}

const count = (n: number): string => n.toLocaleString("en-GB");

const joinNotes = (...notes: (string | null | undefined | false)[]): string => notes.filter(Boolean).join("; ");

function withNote<T extends ReadResult>(result: T, ...notes: (string | null | undefined | false)[]): T {
  const note = joinNotes(result.note, ...notes);
  return note ? { ...result, note } : result;
}

/** The time left before the caller's deadline, or for ever when it set none. */
const timeLeft = (opts: ReadOptions): number => (opts.deadline === undefined ? Infinity : opts.deadline - Date.now());

/** What `p` came to, or `late()` if it had not settled by `deadline`. It carries on unobserved. */
async function byDeadline<T>(p: Promise<T>, deadline: number | undefined, late: () => T): Promise<T> {
  if (deadline === undefined || !Number.isFinite(deadline)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(late()), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Let go of a response's body unread, so the connection isn't held open for it. */
function drop(res: Response): void {
  try {
    res.body?.cancel().catch(() => undefined);
  } catch {
    // Already gone.
  }
}

/** The page's first MAX_BYTES, and why it stopped early if it did. */
async function readBody(res: Response, signal: AbortSignal, tooSlow: string): Promise<{ bytes: Uint8Array; cutShort: string | null }> {
  if (!res.body) return { bytes: new Uint8Array(0), cutShort: null };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cutShort: string | null = signal.aborted ? tooSlow : null;
  // The time limit is held here too, so a body that stops arriving can't keep the read waiting
  // whichever fetch delivered it.
  const onAbort = () => {
    cutShort ??= tooSlow;
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort);
  try {
    while (!cutShort && size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const part = value.byteLength > MAX_BYTES - size ? value.subarray(0, MAX_BYTES - size) : value;
      chunks.push(part);
      size += part.byteLength;
    }
  } catch (e) {
    cutShort ??= signal.aborted ? tooSlow : messageOf(e);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Past the cap, or after a failure, the rest of the download isn't wanted.
    reader.cancel().catch(() => undefined);
  }
  if (chunks.length === 1) return { bytes: chunks[0], cutShort };
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, cutShort };
}

/** The character set a page names: its byte-order mark, else its Content-Type header, else its own <meta>. Null when it names none. */
function charsetOf(bytes: Uint8Array, contentType: string): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const declared = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(contentType)?.[1];
  if (declared) return declared;
  // The <meta> sits near the top, and reading the bytes one to a character is enough to find it.
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 8192));
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ?? null;
}

/** True when text decoded as UTF-8 has more characters beyond plain ASCII that came out whole than came out broken. */
function mostlyWhole(text: string): boolean {
  let whole = 0;
  let broken = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd) broken++;
    else if (c > 0x7f) whole++;
  }
  return whole > broken;
}

/**
 * The page's bytes as text. A page that claims a single-byte set such as Latin-1 but is valid UTF-8 is
 * read as UTF-8, since servers often send the wrong label and "Engel & Völkers" must come out whole.
 * A page that names no set is read as browsers read it: as UTF-8 when its bytes are UTF-8 (allowing a
 * stray broken byte among many whole characters), else as windows-1252, which is what such pages are.
 */
function decodePage(bytes: Uint8Array, contentType: string): string {
  const label = charsetOf(bytes, contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label ?? "windows-1252");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  if (/^(?:windows-125\d|iso-8859-\d+)$/.test(decoder.encoding)) {
    try {
      // `stream` lets a character cut in two at the size cap pass, rather than fail the whole test.
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    } catch {
      // Not strictly UTF-8: the declared set is right, unless no set was named and the bytes are still
      // UTF-8 bar a stray byte.
      if (!label) {
        const utf8 = new TextDecoder("utf-8").decode(bytes);
        if (mostlyWhole(utf8)) return utf8;
      }
    }
  }
  const text = decoder.decode(bytes);
  if (decoder.encoding !== "windows-1252") return text;
  return text.replace(/[\u0080-\u009f]/g, (c) => WINDOWS_1252_HIGH[c.charCodeAt(0) - 0x80]);
}

/**
 * True when the page is a bot check rather than the story (lib/news/extract.ts BOT_CHECK_TITLE and
 * BOT_CHECK_TEXT). Only a page with little story can be one: a page that gives up a whole article is the
 * article, whatever else it says, since a story may well quote "access denied". Text from elsewhere
 * (Apify), which comes without its page, has its own test there: isBotCheckText.
 */
function isBotCheck(html: string, found: ExtractedArticle): boolean {
  if (found.storyChars >= OK_CHARS) return false;
  if (found.title && BOT_CHECK_TITLE.test(found.title)) return true;
  return BOT_CHECK_TEXT.test(html.length > BOT_CHECK_SCAN ? html.slice(0, BOT_CHECK_SCAN) : html);
}

/** True for a site's front page: its root or a language's, with nothing in its query that names a story. */
function isFrontPage(u: URL): boolean {
  return FRONT_PAGE.test(u.pathname) && [...u.searchParams.keys()].every((key) => NOT_A_STORY.test(key));
}

/** Words joined by hyphens or underscores, as a story's slug is: three of them at least. */
const SLUG = /[a-z0-9]+[-_][a-z0-9]+[-_][a-z0-9]+/i;

/**
 * True when the read was sent up the address's own path, to the section the story sits in, leaving
 * behind the part that named the story. A tidied address keeps that part: dropping "/amp" or an id from
 * the end is not this.
 */
function upThePath(from: URL, to: URL): boolean {
  const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
  if (bare(from.hostname) !== bare(to.hostname)) return false;
  const asked = from.pathname.split("/").filter(Boolean);
  const got = to.pathname.split("/").filter(Boolean);
  if (got.length >= asked.length || got.some((part, i) => part.toLowerCase() !== asked[i].toLowerCase())) return false;
  return asked.slice(got.length).some((part) => SLUG.test(part));
}

/** Where a read was sent instead of the story, for the note, and whether that is a wall Apify's crawler would meet too. */
interface OffStory {
  where: string;
  wall: boolean;
}

/**
 * Where a redirect took the read instead of the story, if it did: a consent screen, a sign-in or
 * subscription page, the site's front page, or the section the story sits in. A redirect that only
 * tidies the address (to https, to www, to the full slug, from the AMP copy) still lands on the story.
 */
function offStory(requested: string, landed: string | null | undefined): OffStory | null {
  if (!landed || landed === requested) return null;
  let from: URL;
  let to: URL;
  try {
    from = new URL(requested);
    to = new URL(landed);
  } catch {
    return null;
  }
  const host = to.hostname.toLowerCase();
  if (host !== from.hostname.toLowerCase()) {
    if (CONSENT_HOST.test(host)) return { where: host, wall: false };
    if (WALL_HOST.test(host)) return { where: host, wall: true };
  }
  const names = (u: URL, re: RegExp) => u.pathname.split("/").some((part) => re.test(part.replace(/\.\w+$/, "")));
  if (names(to, WALL_PATH) && !names(from, WALL_PATH)) return { where: `a sign-in or subscription page (${host}${to.pathname})`, wall: true };
  if (names(to, CONSENT_PATH) && !names(from, CONSENT_PATH)) return { where: `a consent page (${host}${to.pathname})`, wall: false };
  if (isFrontPage(to) && !isFrontPage(from)) return { where: `the front page (${host})`, wall: false };
  if (upThePath(from, to)) return { where: `a section page (${host}${to.pathname})`, wall: false };
  return null;
}

/** One plain request for the publisher's page, and what it gave. */
async function readPage(url: string, opts: ReadOptions): Promise<PlainRead> {
  const timeoutMs = Math.min(opts.timeoutMs ?? TIMEOUT_MS, timeLeft(opts));
  if (!(timeoutMs > 0)) return { text: "", status: "error", via: "none", resolvedUrl: url, note: "no time was left to read the page" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const answered = (status: ReadResult["status"], note: string, text = ""): PlainRead => ({ text, status, via: "plain", resolvedUrl: url, note });
  try {
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(url, { headers: HEADERS, redirect: "follow", signal: ctrl.signal, cache: "no-store" });
    } catch (e) {
      const note = ctrl.signal.aborted ? `the site did not answer within ${duration(timeoutMs)}` : `the page could not be fetched: ${messageOf(e)}`;
      return { text: "", status: "error", via: "none", resolvedUrl: url, note };
    }
    if (BLOCKED_STATUSES.has(res.status)) {
      drop(res);
      return answered("blocked", `the site refused the read (HTTP ${res.status})`);
    }
    if (!res.ok) {
      drop(res);
      return { ...answered("error", `the site answered HTTP ${res.status}`), ...(GONE_STATUSES.has(res.status) ? FINAL : {}) };
    }
    const off = offStory(url, res.url);
    if (off) {
      drop(res);
      return { ...answered("blocked", `the site sent the read to ${off.where}`), ...(off.wall ? FINAL : {}) };
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|xml|text\/plain/i.test(type)) {
      drop(res);
      return { ...answered("empty", `not a web page (${type.split(";")[0].trim()})`), ...FINAL };
    }

    const body = await readBody(res, ctrl.signal, `it took longer than ${duration(timeoutMs)}`);
    const html = decodePage(body.bytes, type);
    const found = extractArticle(html);
    // A bot check's own words are kept: a short real story can look like one, and words can only ever prove a mention.
    if (isBotCheck(html, found)) return answered("blocked", "the site showed a bot check instead of the article", found.text);
    // A page-not-found page is not the story, whatever else it lists, and it is the same for Apify's crawler.
    if (found.notFound) return { ...answered("error", "the site served a page-not-found page"), ...FINAL };
    const chars = found.storyChars;
    // Part of a page can prove a mention but never the lack of one, however long that part is.
    if (body.cutShort) {
      return answered("error", `the page stopped loading after ${count(Math.round(body.bytes.length / 1024))} KB (${body.cutShort})`, found.text);
    }
    if (!found.text) return answered("empty", "no article text on the page");
    // A summary is never the article, so it can't count as a read in full, however long it runs.
    if (found.source === "meta") return answered("thin", "only the page's summary could be read", found.text);
    // Nor is a story the page says goes on behind a paywall, which Apify's crawler meets too.
    if (found.walled) {
      return { ...answered("thin", `the story goes on behind a paywall: only ${count(chars)} characters of it, from ${FOUND_IN[found.source]}`, found.text), ...FINAL };
    }
    if (!chars) return answered("thin", `no story paragraphs, only ${count(found.text.length)} characters of other lines, from ${FOUND_IN[found.source]}`, found.text);
    if (chars < OK_CHARS) return answered("thin", `only ${count(chars)} characters, from ${FOUND_IN[found.source]}`, found.text);
    return answered("ok", `${count(chars)} characters, from ${FOUND_IN[found.source]}`, found.text);
  } finally {
    clearTimeout(timer);
  }
}

/** The publisher's page, by its address or by unwrapping the Google link. */
async function readPlain(input: { googleLink: string | null; url: string | null }, opts: ReadOptions): Promise<PlainRead> {
  const given = webAddress(input.url);
  // A Google address stored as the article's (an old consent or rate-limit
  // page, say) is never the story: the Google link is unwrapped again instead.
  if (given && !isGoogleOwned(given)) return readPage(given, opts);
  // A Google News link stored as the address is unwrapped like any other.
  const storedWrapper = given && /(^|\.)news\.google\.com$/i.test(hostOf(given)) ? given : null;
  const wrapper = webAddress(input.googleLink) ?? storedWrapper;
  if (!wrapper) {
    if (given) return { text: "", status: "unresolved", via: "none", resolvedUrl: null, note: "the stored address is one of Google's own pages, and there is no Google News link to unwrap" };
    return input.url?.trim()
      ? { text: "", status: "error", via: "none", resolvedUrl: null, note: "the stored address is not a web address" }
      : { text: "", status: "unresolved", via: "none", resolvedUrl: null, note: "no link to read" };
  }
  let resolved: Resolved;
  try {
    resolved = await byDeadline((opts.resolveLink ?? resolveArticleUrl)(wrapper), opts.deadline, (): Resolved => ({
      url: null,
      status: "error",
      note: "no time was left to unwrap it",
    }));
  } catch (e) {
    resolved = { url: null, status: "error", note: messageOf(e) };
  }
  const url = webAddress(resolved.url);
  // Never Google's own page: kept as the address, every article that morning
  // would share it and all but one would be filed as duplicates.
  if (!url || isGoogleOwned(url)) {
    const why = resolved.note ?? resolved.status;
    return { text: "", status: "unresolved", via: "none", resolvedUrl: null, note: `the Google News link could not be unwrapped (${why})` };
  }
  return readPage(url, opts);
}

/** Tell the caller an Apify read happened. A failure to count is reported rather than thrown: the read itself went fine. */
async function countRead(opts: ReadOptions): Promise<string | null> {
  try {
    await opts.onApifyRead?.();
    return null;
  } catch (e) {
    return `the Apify read could not be counted: ${messageOf(e)}`;
  }
}

/**
 * How a note says Apify has not had its go at the article yet, though it may on a later read: there was
 * too little time, no crawl came free, Apify is not set up, or it turned the crawl down before it started
 * (a wrong token, the plan's allowance used up). The search step puts such an article back in the queue
 * for Apify (lib/news/run.ts apifyTryDue). Every other note about Apify says it has had its go: it read
 * the article, tried and could not, or would only meet what the plain read met.
 */
const NOT_YET = "Apify was not tried";

/**
 * True when an article's last read, as its row keeps it (lib/news/run.ts readOutcome), gave Apify its
 * go: Apify's text is in it (read_via "apify"), or its note says Apify tried, or would only meet what
 * the plain read met. A note that says Apify was not tried, or says nothing of Apify, means it has not.
 * A crawl Apify turned down before it started is not a try (lib/apify.ts refusedRun).
 */
export function apifyHadItsGo(row: { read_via: string | null; note: string | null }): boolean {
  if (row.read_via === "apify") return true;
  const note = row.note ?? "";
  return /\bApify\b/.test(note) && !note.includes(NOT_YET);
}

/**
 * True when an article's last read says Apify was due to read it but has not had its go (NOT_YET), so the
 * morning's re-queue puts it back for that, whatever its tries, while the backup is on and no person has
 * decided it (lib/news/run.ts apifyTryDue). The Review list says so rather than that it is not tried again.
 */
export const awaitsApifyTry = (row: { read_via: string | null; note: string | null }): boolean =>
  !apifyHadItsGo(row) && (row.note ?? "").includes(NOT_YET);

/** Apify's try at a page the plain read couldn't finish, when the caller allows it for this article. */
async function apifyBackup(plain: PlainRead, input: { googleLink: string | null }, opts: ReadOptions): Promise<ReadResult> {
  if (!opts.apifyBackup) return plain;
  // A page that is gone or is not a web page, or a story that stops at a paywall or a sign-in, is the
  // same for Apify's crawler: a read there would only spend the plan's allowance. Said, so the article
  // is not put back in the queue for Apify (apifyHadItsGo).
  if (plain.final) return withNote(plain, "Apify would meet the same, so it was not used");
  const target = plain.resolvedUrl ?? webAddress(input.googleLink);
  if (!target) return withNote(plain, "Apify had no address to read, so it was not used");
  // Apify gets what is left of the caller's time, up to the window the read step keeps for it.
  const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + APIFY_WINDOW_MS);
  if (deadline - Date.now() < APIFY_MIN_MS) return withNote(plain, `${NOT_YET}: too little time was left`);
  try {
    if (!(await opts.apifyAllowed())) return withNote(plain, `${NOT_YET}: too little of the run's time was left`);
  } catch (e) {
    return withNote(plain, `${NOT_YET}: ${messageOf(e)}`);
  }

  // A Google link the plain read could not unwrap goes to Apify as it is, and Apify is told so: trying
  // to unwrap it again would only repeat the calls to Google that just failed.
  const resolved: Resolved | undefined = plain.resolvedUrl ? undefined : { url: null, status: "unresolved", note: plain.note };
  let body: ArticleBody;
  try {
    body = await byDeadline((opts.apifyRead ?? fetchArticleBody)(target, { deadline, resolved }), deadline + APIFY_GRACE_MS, (): ArticleBody => ({
      text: "",
      status: "error",
      resolvedUrl: null,
      resolveStatus: null,
      note: "it had not finished by the deadline",
    }));
  } catch (e) {
    return withNote(plain, `Apify failed: ${messageOf(e)}`, await countRead(opts));
  }
  // Without a token, or with too little time left to start a crawl, nothing reached Apify, so there is nothing to count.
  if (body.status === "no_token") return withNote(plain, `${NOT_YET}: it is not set up (no APIFY_TOKEN)`);
  if (body.status === "no_time") return withNote(plain, `${NOT_YET}: ${body.note ?? "too little time was left"}`);
  // Nor when Apify turned down every crawl before it started (a wrong token, the plan's allowance or memory used
  // up): nothing was crawled, which says nothing of the page, so it is offered to Apify again on a later morning.
  if (body.status === "refused") return withNote(plain, `${NOT_YET}: it refused to start the crawl (${body.note ?? "no reason given"})`);
  const counted = await countRead(opts);

  const landed = webAddress(body.landedUrl) ?? webAddress(body.resolvedUrl);
  // Apify's browser can stop on Google's consent or news page, and that text is Google's, not the story.
  if (landed && isGoogleHost(landed)) return withNote(plain, `Apify reached ${hostOf(landed)}, not the article`, counted);
  // Nor is the consent screen, sign-in page or front page a site sent it to: the plain read's answer stands.
  const off = offStory(target, landed);
  if (off) return withNote(plain, `Apify was sent to ${off.where}, not the article`, counted);
  const raw = String(body.text ?? "");
  const text = tidyText(raw);
  if (saysNotFound(body.title)) return withNote(plain, "Apify found a page-not-found page", counted);
  if (text && isBotCheckText(raw, body.title)) return withNote(plain, "Apify was shown a bot check too", counted);
  const resolvedUrl = plain.resolvedUrl ?? landed;
  const before = plain.note && `the plain read: ${plain.note}`;
  // A paywall's own line in what Apify read means it met the wall too: its text can prove a mention, never a read in full.
  if (body.status === "ok" && text.length >= OK_CHARS && !wallLineIn(raw)) {
    return { text, status: "ok", via: "apify", resolvedUrl, note: joinNotes(`${count(text.length)} characters, read through Apify`, before, counted) };
  }
  // Neither read is whole, so each can only prove a mention, never the lack of one: what both found is kept.
  const both = tidyText(`${plain.text}\n${text}`);
  if (text && both !== plain.text) {
    const kept = plain.text ? `, kept with the ${count(plain.text.length)} the plain read found` : "";
    return { text: both, status: "thin", via: "apify", resolvedUrl, note: joinNotes(`only ${count(text.length)} characters read through Apify${kept}`, before, counted) };
  }
  return withNote(plain, `Apify could not read it either (${body.status}${body.note ? `: ${body.note}` : ""})`, counted);
}

/** The read as the rest of the bot sees it: what this module noted for itself stays here. */
function outward(result: PlainRead): ReadResult {
  const out: ReadResult = { text: result.text, status: result.status, via: result.via, resolvedUrl: result.resolvedUrl };
  if (result.note !== undefined) out.note = result.note;
  return out;
}

/**
 * Read one article: the publisher's address if it is known, else the Google link unwrapped
 * (lib/googleNews.ts, free). `resolvedUrl` is that address, or null when the link couldn't be
 * unwrapped. Never throws.
 */
export async function readArticle(input: { googleLink: string | null; url: string | null }, opts: ReadOptions): Promise<ReadResult> {
  try {
    const plain = await readPlain(input, opts);
    return outward(plain.status === "ok" ? plain : await apifyBackup(plain, input, opts));
  } catch (e) {
    // Nothing above throws on purpose; this keeps the promise that nothing does.
    return { text: "", status: "error", via: "none", resolvedUrl: null, note: `the read failed: ${messageOf(e)}` };
  }
}
