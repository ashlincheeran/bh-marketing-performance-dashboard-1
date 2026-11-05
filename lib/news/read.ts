// Reading one article for the news bot: unwrap its Google link if need be, fetch the publisher's page
// with a plain request, and find the story in it (lib/news/extract.ts). Apify reads it instead only
// when Settings allows it and the plain read didn't get the whole article. Server-only.
//
// Nothing here throws. Every way a read can fail comes back as a status the read step can act on,
// because "no text" has several causes (the site refused us, the link never unwrapped, the page was a
// bot check, the story sits behind a paywall) and only a whole article, read in full, licenses the
// conclusion that it names nobody.
import { fetchArticleBody, type ArticleBody } from "@/lib/apify";
import { isGoogleOwned, resolveArticleUrl, type Resolved } from "@/lib/googleNews";
import { OK_CHARS, extractArticle, tidyText, type ExtractSource, type ExtractedArticle } from "@/lib/news/extract";
import type { ReadResult } from "@/lib/news/types";

export interface ReadOptions {
  /** Settings: Apify may read what the plain request could not. */
  apifyBackup: boolean;
  /** Asked only when the backup would be used, so the caller can check the monthly cap and the time left. */
  apifyAllowed: () => Promise<boolean>;
  /** Called after every Apify attempt, whatever came of it, so the caller can count it against the cap. */
  onApifyRead?: () => Promise<void>;
  /** How long the plain request may take, the page's body included. 15 seconds by default. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** For tests: stands in for lib/apify.ts, which calls Apify. */
  apifyRead?: (link: string) => Promise<ArticleBody>;
  /** For tests: stands in for lib/googleNews.ts, which calls Google. */
  resolveLink?: (link: string) => Promise<Resolved>;
}

const TIMEOUT_MS = 15_000;

/** The most of a page that is read. Stories sit well inside it; what lies beyond is inline script and data. */
const MAX_BYTES = 3 * 1024 * 1024;

/** Answers that mean "not for you": sign-in walls, bot shields, rate limits, legal blocks, and the 503 bot shields also send. */
const BLOCKED_STATUSES = new Set([401, 403, 429, 451, 503]);

/** A desktop browser's request. Many sites answer anything that looks like a script with a block page. */
const HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
};

/**
 * What bot checks call their pages (Cloudflare, Akamai, Imperva, DataDome, PerimeterX, Sucuri and the
 * rest), allowing a short suffix such as "| Cloudflare". A headline that merely starts the same way is
 * caught by the text-length test in isBotCheck.
 */
const BOT_CHECK_TITLE =
  /^(?:just a moment|attention required|access denied|access to this page has been denied|request unsuccessful|security check(?:point)?|checking your browser|verifying you are human|human verification|are you a robot|robot check|one more step|pardon our interruption|please wait|ddos-guard|403 forbidden|forbidden)[.!?\u2026\s]*(?:[|:\-]\s*.{0,80})?$/i;

/** What their pages say. */
const BOT_CHECK_TEXT =
  /enable javascript and cookies to continue|checking (?:if the site connection is secure|your browser before accessing)|needs to review the security of your connection|verif(?:y|ying) (?:that )?you are (?:a )?human|press (?:&amp;|&) hold|incapsula incident id|captcha-delivery\.com|_cf_chl_opt|cf-browser-verification|\.awswaf\.com|sucuri website firewall|your access to this site has been limited|you don['\u2019]t have permission to access|unusual traffic from your (?:computer|network)|please enable js and disable any ad blocker/i;

/** Bot checks are small pages; the start of a big one is enough to look through. */
const BOT_CHECK_SCAN = 500_000;

/** Hosts a site sends a reader to instead of the story: consent screens and sign-in pages. */
const WALL_HOST = /^(?:consent|guce|login|signin|accounts|auth)\./;

/** Where the text was found, for the note kept with the article. */
const FOUND_IN: Record<ExtractSource, string> = {
  jsonld: "the article data in the page",
  articlebody: "the marked article body",
  article: "the article section",
  main: "the main section",
  paragraphs: "the page's paragraphs",
  meta: "the page's summary",
  none: "nowhere",
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

function withNote(result: ReadResult, ...notes: (string | null | undefined | false)[]): ReadResult {
  const note = joinNotes(result.note, ...notes);
  return note ? { ...result, note } : result;
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

/** The character set a page is in: its byte-order mark, else its Content-Type header, else its own <meta>, else UTF-8. */
function charsetOf(bytes: Uint8Array, contentType: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const declared = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(contentType)?.[1];
  if (declared) return declared;
  // The <meta> sits near the top, and reading the bytes one to a character is enough to find it.
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 8192));
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ?? "utf-8";
}

/**
 * The page's bytes as text. A page that claims a single-byte set such as Latin-1 but is valid UTF-8 is
 * read as UTF-8, since servers often send the wrong label and "Engel & Völkers" must come out whole.
 */
function decodePage(bytes: Uint8Array, contentType: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(bytes, contentType));
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  if (/^(?:windows-125\d|iso-8859-\d+)$/.test(decoder.encoding)) {
    try {
      // `stream` lets a character cut in two at the size cap pass, rather than fail the whole test.
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    } catch {
      // Not UTF-8: the declared set is right.
    }
  }
  const text = decoder.decode(bytes);
  if (decoder.encoding !== "windows-1252") return text;
  return text.replace(/[\u0080-\u009f]/g, (c) => WINDOWS_1252_HIGH[c.charCodeAt(0) - 0x80]);
}

/**
 * True when the page is a bot check rather than the story. Only a page with little article text can be
 * one: a page that gives up a whole article is the article, whatever else it says, since a story may
 * well quote "access denied".
 */
function isBotCheck(html: string, found: ExtractedArticle): boolean {
  if (found.text.length >= OK_CHARS) return false;
  if (found.title && BOT_CHECK_TITLE.test(found.title)) return true;
  return BOT_CHECK_TEXT.test(html.length > BOT_CHECK_SCAN ? html.slice(0, BOT_CHECK_SCAN) : html);
}

/** The consent or sign-in host a redirect took the read to, if that is where it ended. */
function wallHost(requested: string, landed: string | undefined): string | null {
  const host = landed ? hostOf(landed) : "";
  return host && host !== hostOf(requested) && WALL_HOST.test(host) ? host : null;
}

/** One plain request for the publisher's page, and what it gave. */
async function readPage(url: string, opts: ReadOptions): Promise<ReadResult> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const answered = (status: ReadResult["status"], note: string, text = ""): ReadResult => ({ text, status, via: "plain", resolvedUrl: url, note });
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
      return answered("error", `the site answered HTTP ${res.status}`);
    }
    const wall = wallHost(url, res.url);
    if (wall) {
      drop(res);
      return answered("blocked", `the site sent the read to ${wall}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|xml|text\/plain/i.test(type)) {
      drop(res);
      return answered("empty", `not a web page (${type.split(";")[0].trim()})`);
    }

    const body = await readBody(res, ctrl.signal, `it took longer than ${duration(timeoutMs)}`);
    const html = decodePage(body.bytes, type);
    const found = extractArticle(html);
    if (isBotCheck(html, found)) return answered("blocked", "the site showed a bot check instead of the article");
    const chars = found.text.length;
    // Part of a page can prove a mention but never the lack of one, however long that part is.
    if (body.cutShort) {
      return answered("error", `the page stopped loading after ${count(Math.round(body.bytes.length / 1024))} KB (${body.cutShort})`, found.text);
    }
    if (!chars) return answered("empty", "no article text on the page");
    // A summary is never the article, so it can't count as a read in full, however long it runs.
    if (found.source === "meta") return answered("thin", "only the page's summary could be read", found.text);
    if (chars < OK_CHARS) return answered("thin", `only ${count(chars)} characters, from ${FOUND_IN[found.source]}`, found.text);
    return answered("ok", `${count(chars)} characters, from ${FOUND_IN[found.source]}`, found.text);
  } finally {
    clearTimeout(timer);
  }
}

/** The publisher's page, by its address or by unwrapping the Google link. */
async function readPlain(input: { googleLink: string | null; url: string | null }, opts: ReadOptions): Promise<ReadResult> {
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
    resolved = await (opts.resolveLink ?? resolveArticleUrl)(wrapper);
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

/** Apify's try at a page the plain read couldn't finish, when Settings and the caller allow it. */
async function apifyBackup(plain: ReadResult, input: { googleLink: string | null }, opts: ReadOptions): Promise<ReadResult> {
  if (!opts.apifyBackup) return plain;
  const target = plain.resolvedUrl ?? webAddress(input.googleLink);
  if (!target) return plain;
  try {
    if (!(await opts.apifyAllowed())) return plain;
  } catch (e) {
    return withNote(plain, `the Apify allowance could not be checked: ${messageOf(e)}`);
  }

  let body: ArticleBody;
  try {
    body = await (opts.apifyRead ?? fetchArticleBody)(target);
  } catch (e) {
    return withNote(plain, `Apify failed: ${messageOf(e)}`, await countRead(opts));
  }
  // Without a token nothing reached Apify, so there is nothing to count.
  if (body.status === "no_token") return withNote(plain, "Apify is not set up (no APIFY_TOKEN)");
  const counted = await countRead(opts);

  const landed = webAddress(body.resolvedUrl);
  // Apify's browser can stop on Google's consent or news page, and that text is Google's, not the story.
  if (landed && isGoogleHost(landed)) return withNote(plain, `Apify reached ${hostOf(landed)}, not the article`, counted);
  const text = tidyText(body.text);
  const resolvedUrl = plain.resolvedUrl ?? landed;
  const before = plain.note && `the plain read: ${plain.note}`;
  if (body.status === "ok" && text.length >= OK_CHARS) {
    return { text, status: "ok", via: "apify", resolvedUrl, note: joinNotes(`${count(text.length)} characters, read through Apify`, before, counted) };
  }
  // Some text beats none: it can still prove a mention, though never the lack of one.
  if (text && !plain.text) {
    return { text, status: "thin", via: "apify", resolvedUrl, note: joinNotes(`only ${count(text.length)} characters, read through Apify`, before, counted) };
  }
  return withNote(plain, `Apify could not read it either (${body.status}${body.note ? `: ${body.note}` : ""})`, counted);
}

/**
 * Read one article: the publisher's address if it is known, else the Google link unwrapped
 * (lib/googleNews.ts, free). `resolvedUrl` is that address, or null when the link couldn't be
 * unwrapped. Never throws.
 */
export async function readArticle(input: { googleLink: string | null; url: string | null }, opts: ReadOptions): Promise<ReadResult> {
  try {
    const plain = await readPlain(input, opts);
    return plain.status === "ok" ? plain : await apifyBackup(plain, input, opts);
  } catch (e) {
    // Nothing above throws on purpose; this keeps the promise that nothing does.
    return { text: "", status: "error", via: "none", resolvedUrl: null, note: `the read failed: ${messageOf(e)}` };
  }
}
