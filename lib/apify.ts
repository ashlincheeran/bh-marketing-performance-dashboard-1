// Full-text article extraction via Apify.
//
// Google News RSS gives a WRAPPER link that a normal fetch can't open, and that
// Apify can't crawl either: website-content-crawler stays on the start URL's
// domain, so it reads Google's interstitial instead of following the redirect
// out to the publisher. It then returns no text and the run SUCCEEDS — which is
// why every stored row carried `hasBody: false` and why the bot spent months
// judging articles by their headlines.
//
// So the wrapper is resolved to a real article URL first (lib/googleNews.ts),
// and only then handed to the crawler.
//
// Nothing here returns a bare empty string any more. "No text" had four
// different causes — no token, unresolvable link, crawler error, paywall — and
// the caller has to be able to tell them apart, because only one of them means
// "this article genuinely doesn't mention us".
//
// Every read has a deadline. Each run is told to end inside it, so no run goes
// on billing after the read has stopped waiting, and the read always returns in
// time to be counted against the monthly cap.
import { resolveArticleUrl, type ResolveStatus, type Resolved } from "@/lib/googleNews";

const ACTOR = "apify~website-content-crawler";

/** How a body fetch ended. Only `ok` licenses a "no brand in text" verdict. */
export type BodyStatus =
  | "ok"
  | "thin"         // text came back but too short to judge (paywall / consent wall)
  | "no_token"
  | "no_time"      // too little time was left to start a crawl, so nothing reached Apify
  | "unresolved"   // never found the publisher URL behind the Google wrapper
  | "empty"        // crawler ran, returned nothing
  | "http_error"
  | "error";

export interface ArticleBody {
  text: string;
  status: BodyStatus;
  resolvedUrl: string | null;
  resolveStatus: ResolveStatus | null;
  /** Where the crawler ended up after any redirect, when it said. A consent or sign-in page there is not the story. */
  landedUrl?: string | null;
  /** The title of the page the crawler read, when it said. */
  title?: string | null;
  /** Which proxy plan actually worked — shows when residential has run dry. */
  via?: string;
  note?: string;
}

export interface ArticleBodyOptions {
  /** When the read must be over, as a time in milliseconds (as Date.now() gives it). DEFAULT_WINDOW_MS from the call if not given. */
  deadline?: number;
  /** What unwrapping the link already gave the caller, so it is not tried again. */
  resolved?: Resolved;
}

/** Below this a "body" is a cookie banner or a paywall stub, not an article. */
const THIN_CHARS = Number(process.env.APIFY_THIN_CHARS || 400);

/**
 * Concurrent Apify runs, not concurrent articles, for every caller in this
 * process: the news bot's read lanes wait for a free one like everyone else.
 *
 * Apify caps TOTAL MEMORY across simultaneous runs and answers HTTP 402 past
 * it. website-content-crawler claims 4 GB, so four at once is 16 GB, the whole
 * account ceiling, and a backfill batch duly came back with 402 on 31 of 32
 * crawls. Three at once is 12 GB and leaves the nightly ingest and the social
 * scrapers room to run alongside.
 */
const MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.APIFY_MAX_CONCURRENT || 3)) || 3);

/**
 * Memory per run, in MB.
 *
 * Back to the actor's own default of 4 GB. It was pinned to 2 GB to stop the
 * 402s, and that traded one failure for another: every crawl then came back
 * TIMED-OUT, because Playwright Firefox cannot boot reliably in 2 GB and simply
 * sat there until the run expired.
 *
 * The 402 was never really about per-run memory anyway. It was four concurrent
 * runs at 4 GB hitting the 16 GB account ceiling exactly. Three at 4 GB is
 * 12 GB, which leaves headroom — so the concurrency cap is the right lever and
 * the memory pin was the wrong one.
 */
const RUN_MEMORY_MB = Number(process.env.APIFY_RUN_MEMORY_MB || 4096);

/**
 * A 402 memory error is CONTENTION, not a verdict on the article: whatever was
 * holding the memory finishes, and the same request then succeeds. Treating it
 * as permanent is what turned one busy moment into a whole wasted batch, so it
 * is retried with a widening gap, while the deadline leaves room for the crawl.
 */
const MEMORY_RETRY_MS = [6_000, 18_000, 45_000];

/**
 * How long a read may take when the caller gives no deadline: the window the
 * news bot's read step keeps for an Apify read when it allows one.
 */
const DEFAULT_WINDOW_MS = 150_000;

/**
 * Time for a run to be set going and its items to come back, on top of the run
 * itself. Each run is told to end this long before the deadline.
 */
const RUN_MARGIN_SECS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A signal that aborts after `ms`, and a way to let go of its timer once the request is over. */
function abortAfter(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("the deadline passed", "TimeoutError")), Math.max(0, ms));
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/** What `p` came to, or `late()` if it had not settled by `deadline`. It carries on unobserved. */
async function byDeadline<T>(p: Promise<T>, deadline: number, late: () => T): Promise<T> {
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

function extractText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((it) => {
      const o = it as Record<string, unknown> | null;
      return String(o?.text || o?.markdown || "");
    })
    .join("\n")
    .trim();
}

/**
 * Where the crawler actually ended up: the proof a redirect was followed, and
 * the way to tell a consent or sign-in page from the story. The crawler gives
 * it as crawl.loadedUrl; `url` can be the address it was asked for.
 */
function loadedUrl(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const o = it as Record<string, unknown> | null;
    const crawled = o?.crawl && typeof o.crawl === "object" ? (o.crawl as Record<string, unknown>).loadedUrl : undefined;
    const u = crawled ?? o?.loadedUrl ?? o?.url;
    if (typeof u === "string" && u) return u;
  }
  return null;
}

/** The title of the page the crawler read, from its metadata. */
function titleOf(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const meta = (it as Record<string, unknown> | null)?.metadata;
    const title = meta && typeof meta === "object" ? (meta as Record<string, unknown>).title : undefined;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return null;
}

/**
 * Attempts, in order. Crawler type matters more than the proxy.
 *
 * `cheerio` fetches the HTML and parses it — no browser at all. It finishes in
 * seconds, costs a fraction of the compute, and works on any page rendered
 * server-side, which most news sites still are. `playwright:firefox` boots a
 * real browser: slow, memory-hungry, and on a FREE plan slow enough to hit the
 * run timeout. It is worth having for JavaScript-rendered pages, but as the
 * fallback, not the default — starting with it is what made every crawl take
 * two minutes before failing.
 *
 * RESIDENTIAL is absent on purpose: `apify.whoami` reports availableCount 0 for
 * it on this plan, so asking produced run-failed 400s on every crawl in a
 * batch. It returns behind APIFY_RESIDENTIAL=1 once the plan supports it.
 */
const USE_RESIDENTIAL = process.env.APIFY_RESIDENTIAL === "1";
const SHARED_PROXY = { useApifyProxy: true };
const RESIDENTIAL_PROXY = { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] };

interface Attempt {
  label: string;
  crawlerType: string;
  timeoutSecs: number;
  /** With less time than this left the attempt is not started, since it could not finish: a browser needs a while to boot. */
  minSecs: number;
  proxy?: Record<string, unknown>;
}

const ATTEMPTS: Attempt[] = [
  { label: "cheerio", crawlerType: "cheerio", timeoutSecs: 45, minSecs: 15, proxy: SHARED_PROXY },
  ...(USE_RESIDENTIAL
    ? [{ label: "cheerio+residential", crawlerType: "cheerio", timeoutSecs: 45, minSecs: 15, proxy: RESIDENTIAL_PROXY }]
    : []),
  { label: "firefox", crawlerType: "playwright:firefox", timeoutSecs: 120, minSecs: 45, proxy: SHARED_PROXY },
];

const BROWSER_ATTEMPTS = ATTEMPTS.filter((a) => a.crawlerType.startsWith("playwright"));

/** The least time a crawl of these attempts needs, from now to the deadline. */
const leastTimeMs = (attempts: Attempt[]): number => (Math.min(...attempts.map((a) => a.minSecs)) + RUN_MARGIN_SECS) * 1000;

/** Pull the real message out of an Apify error body instead of showing its first line. */
function apifyError(status: number, raw: string): { message: string; type: string } {
  try {
    const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string } };
    const type = parsed?.error?.type ?? "";
    const message = parsed?.error?.message ?? "";
    if (message) return { message: `HTTP ${status} ${type}: ${message}`.slice(0, 600), type };
  } catch {
    /* not JSON — fall through */
  }
  // Truncating an error to its opening brace is how the Supermetrics quota
  // failure stayed invisible for a month. Keep enough to read.
  return { message: `HTTP ${status} ${raw.replace(/\s+/g, " ").slice(0, 600)}`, type: "" };
}

/** Crawls running in this process, and the callers waiting for one of them to end. */
let running = 0;
const waiting: (() => void)[] = [];

/**
 * A crawl slot, waited for until `by` at the latest: true when one came free in
 * time. Every caller in this process shares MAX_CONCURRENT, so the read step's
 * four lanes can't ask Apify for 16 GB at once.
 */
function takeSlot(by: number): Promise<boolean> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    // Only called once it is in the queue, by which time the timer is set.
    const grant = () => {
      clearTimeout(timer);
      running++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(grant);
      if (at !== -1) waiting.splice(at, 1);
      resolve(false);
    }, Math.max(0, by - Date.now()));
    waiting.push(grant);
  });
}

function freeSlot(): void {
  running = Math.max(0, running - 1);
  waiting.shift()?.();
}

interface Crawled {
  text: string;
  landed: string | null;
  title: string | null;
  error?: string;
  via?: string;
  /** A run was asked of Apify, so the read counts against the cap. */
  sent: boolean;
}

/**
 * One crawl, escalating from the cheap crawler to the expensive one, all of it
 * before `deadline`.
 *
 * `via` names the attempt that worked, so the logs show when pages are needing
 * a browser rather than just showing a slower job.
 */
async function crawl(
  token: string,
  url: string,
  deadline: number,
  /**
   * Skip the cheap crawler. Used for unresolved Google News wrappers, where the
   * redirect is performed by JavaScript: cheerio would fetch the shell, find
   * text in it, and return "success" holding a consent page — never reaching
   * the browser that is the entire point of that call.
   */
  browserOnly = false,
): Promise<Crawled> {
  const errors: string[] = [];
  let sent = false;

  for (const attempt of browserOnly ? BROWSER_ATTEMPTS : ATTEMPTS) {
    const body = JSON.stringify({
      startUrls: [{ url }],
      maxCrawlPages: 1,
      maxCrawlDepth: 0,
      crawlerType: attempt.crawlerType,
      ...(attempt.proxy ? { proxyConfiguration: attempt.proxy } : {}),
      readableTextCharThreshold: 80,
      saveMarkdown: false,
      maxResults: 1,
    });

    let planError = "";

    for (let retry = 0; ; retry++) {
      // The run is told to end in the time left, less what the request itself
      // needs. Stopping the wait would not stop the run, so this is what keeps
      // it from billing on after the read has given up on it.
      const left = deadline - Date.now();
      const secs = Math.min(attempt.timeoutSecs, Math.floor(left / 1000) - RUN_MARGIN_SECS);
      if (secs < attempt.minSecs) {
        planError = `too little time was left for the ${attempt.label} crawl`;
        break;
      }
      const endpoint =
        `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items` +
        `?token=${encodeURIComponent(token)}&timeout=${secs}&memory=${RUN_MEMORY_MB}`;

      let res: Response;
      let raw: string;
      // A backstop only: the run's own timeout above ends it first.
      const limit = abortAfter(left);
      try {
        sent = true;
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          cache: "no-store",
          signal: limit.signal,
        });
        raw = await res.text();
      } catch (e) {
        errors.push(`${limit.signal.aborted ? "Apify did not answer in the time left" : messageOf(e)} [${attempt.label}]`);
        return { text: "", landed: null, title: null, error: errors.join("; "), sent };
      } finally {
        limit.done();
      }

      if (res.ok) {
        let items: unknown = null;
        try {
          items = JSON.parse(raw);
        } catch {
          // Not the items: treated as none.
        }
        const text = extractText(items);
        // An empty result from cheerio usually means the page is rendered by
        // JavaScript, which is exactly what the browser attempt is for — so
        // keep going rather than reporting success with nothing in hand.
        if (text) return { text, landed: loadedUrl(items), title: titleOf(items), via: attempt.label, sent };
        planError = `no text via ${attempt.label}`;
        break;
      }

      const { message } = apifyError(res.status, raw);

      // Contention, not a verdict on the article. A wait that would leave the
      // crawl too little time before the deadline is not worth making.
      if (res.status === 402 && /memory-limit-exceeded/i.test(message) && retry < MEMORY_RETRY_MS.length) {
        const wait = MEMORY_RETRY_MS[retry];
        if (deadline - Date.now() - wait >= (attempt.minSecs + RUN_MARGIN_SECS) * 1000) {
          await sleep(wait);
          continue;
        }
      }

      planError = `${message} [${attempt.label}]`;
      break;
    }

    if (planError) errors.push(planError);
  }

  return { text: "", landed: null, title: null, error: errors.join("; ") || "no attempt made", sent };
}

/**
 * Fetch the readable body for one RSS link, resolving the wrapper first, and
 * all of it before `opts.deadline` (DEFAULT_WINDOW_MS from now if not given).
 */
export async function fetchArticleBody(link: string, opts: ArticleBodyOptions = {}): Promise<ArticleBody> {
  const token = process.env.APIFY_TOKEN;
  if (!token || !link) {
    return { text: "", status: "no_token", resolvedUrl: null, resolveStatus: null };
  }
  const deadline = opts.deadline ?? Date.now() + DEFAULT_WINDOW_MS;

  // A link the caller has already tried to unwrap is not tried again: that
  // would only repeat the calls to Google that just failed. Unwrapping leaves
  // time for the quickest crawl.
  const resolved =
    opts.resolved ??
    (await byDeadline(resolveArticleUrl(link), deadline - leastTimeMs(ATTEMPTS), (): Resolved => ({
      url: null,
      status: "error",
      note: "no time was left to unwrap the link",
    })));

  /**
   * Resolution failed — try the browser anyway.
   *
   * Our resolver runs plain HTTP, and the new-format wrapper redirects with
   * JavaScript, so a fetch lands on Google's shell and stops. Playwright
   * executes that redirect. Whether it worked is checked against where the
   * crawler LANDED, not against how much text came back: the shell is a big
   * page and would otherwise read as a successful crawl.
   */
  const target = resolved.url;
  const via = resolved.status;
  const attempts = target ? ATTEMPTS : BROWSER_ATTEMPTS;
  const noTime = (note: string): ArticleBody => ({ text: "", status: "no_time", resolvedUrl: target, resolveStatus: via, note });
  if (deadline - Date.now() < leastTimeMs(attempts)) return noTime("too little time was left to start a crawl");
  if (!(await takeSlot(deadline - leastTimeMs(attempts)))) return noTime("no Apify crawl came free in time");

  try {
    if (!target) {
      try {
        const attempt = await crawl(token, link, deadline, true);
        if (!attempt.sent) return noTime(attempt.error ?? "too little time was left to start a crawl");
        const escaped = attempt.landed && !/news\.google\.com/i.test(attempt.landed);
        if (escaped && attempt.text) {
          const status: BodyStatus = attempt.text.length < THIN_CHARS ? "thin" : "ok";
          return {
            text: attempt.text,
            status,
            resolvedUrl: attempt.landed,
            resolveStatus: "browser",
            landedUrl: attempt.landed,
            title: attempt.title,
            via: attempt.via,
          };
        }
        const landing = attempt.landed ?? `nothing${attempt.error ? ` (${attempt.error})` : ""}`;
        return {
          text: "",
          status: "unresolved",
          resolvedUrl: null,
          resolveStatus: resolved.status,
          note: `${resolved.note ?? "no url"}; browser landed on ${landing}`,
        };
      } catch (e) {
        return {
          text: "",
          status: "unresolved",
          resolvedUrl: null,
          resolveStatus: resolved.status,
          note: `${resolved.note ?? "no url"}; browser fallback failed: ${messageOf(e)}`,
        };
      }
    }

    try {
      const crawled = await crawl(token, target, deadline);
      if (!crawled.sent) return noTime(crawled.error ?? "too little time was left to start a crawl");
      if (crawled.error) {
        return { text: "", status: "http_error", resolvedUrl: target, resolveStatus: via, note: crawled.error };
      }
      const status: BodyStatus = !crawled.text ? "empty" : crawled.text.length < THIN_CHARS ? "thin" : "ok";
      // The address stays the one asked for, which the article is stored under. Where the crawler landed
      // goes beside it, for the caller to check.
      return {
        text: crawled.text,
        status,
        resolvedUrl: target,
        resolveStatus: via,
        landedUrl: crawled.landed,
        title: crawled.title,
        via: crawled.via,
      };
    } catch (e) {
      return {
        text: "",
        status: "error",
        resolvedUrl: target,
        resolveStatus: via,
        note: messageOf(e),
      };
    }
  } finally {
    freeSlot();
  }
}

/** Fetch many bodies, capped so Apify's memory ceiling isn't tripped. Each read's deadline starts when it does. */
export async function fetchArticleBodies(links: string[]): Promise<Map<string, ArticleBody>> {
  const out = new Map<string, ArticleBody>();
  const queue = [...new Set(links.filter(Boolean))];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
    for (;;) {
      const link = queue.shift();
      if (!link) return;
      out.set(link, await fetchArticleBody(link));
    }
  });
  await Promise.all(workers);
  return out;
}

/** Back-compat: the text alone, for callers that don't care why it's missing. */
export async function fetchArticleText(link: string): Promise<string | null> {
  const r = await fetchArticleBody(link);
  return r.text || null;
}

/** A one-line summary of how a batch went, for run logs. */
export function summariseBodies(bodies: Map<string, ArticleBody>): string {
  const counts = new Map<BodyStatus, number>();
  for (const b of bodies.values()) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "none";
}
