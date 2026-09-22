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
import { resolveArticleUrl, type ResolveStatus } from "@/lib/googleNews";

const ACTOR = "apify~website-content-crawler";

/** How a body fetch ended. Only `ok` licenses a "no brand in text" verdict. */
export type BodyStatus =
  | "ok"
  | "thin"         // text came back but too short to judge (paywall / consent wall)
  | "no_token"
  | "unresolved"   // never found the publisher URL behind the Google wrapper
  | "empty"        // crawler ran, returned nothing
  | "http_error"
  | "error";

export interface ArticleBody {
  text: string;
  status: BodyStatus;
  resolvedUrl: string | null;
  resolveStatus: ResolveStatus | null;
  /** Which proxy plan actually worked — shows when residential has run dry. */
  via?: string;
  note?: string;
}

/** Below this a "body" is a cookie banner or a paywall stub, not an article. */
const THIN_CHARS = Number(process.env.APIFY_THIN_CHARS || 400);

/**
 * Concurrent Apify runs, not concurrent articles.
 *
 * Apify caps TOTAL MEMORY across simultaneous runs and answers HTTP 402 past
 * it. website-content-crawler claims 4 GB by default, so four at once is 16 GB
 * — the whole account ceiling — and a backfill batch duly came back with 402 on
 * 31 of 32 crawls. The fix is the memory pin below rather than crawling one at
 * a time: at 2 GB a run, three at once is 6 GB and leaves the nightly ingest
 * and the social scrapers room to run alongside.
 */
const MAX_CONCURRENT = Number(process.env.APIFY_MAX_CONCURRENT || 3);

/**
 * Memory per run, in MB. One page in a headless browser does not need 4 GB, and
 * the default is what puts the account over its ceiling.
 */
const RUN_MEMORY_MB = Number(process.env.APIFY_RUN_MEMORY_MB || 2048);

/**
 * A 402 memory error is CONTENTION, not a verdict on the article: whatever was
 * holding the memory finishes, and the same request then succeeds. Treating it
 * as permanent is what turned one busy moment into a whole wasted batch, so it
 * is retried with a widening gap.
 */
const MEMORY_RETRY_MS = [6_000, 18_000, 45_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Where the crawler actually ended up — the proof a redirect was followed. */
function loadedUrl(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const o = it as Record<string, unknown> | null;
    const u = o?.loadedUrl ?? o?.url;
    if (typeof u === "string" && u) return u;
  }
  return null;
}

/**
 * Proxy plans, tried in order.
 *
 * RESIDENTIAL is NOT the default, despite being the best exit for Gulf and UK
 * publishers that serve datacentre IPs a consent wall. The account this runs on
 * is a FREE plan, and `apify.whoami` reports RESIDENTIAL with availableCount 0
 * while listing PROXY_RESIDENTIAL under enabled features — a group can be
 * advertised and still be unusable. Requesting it produced `run-failed` 400s on
 * every crawl in a whole backfill batch.
 *
 * So ask for the shared pool, which resolves to whatever the plan actually has,
 * and let residential be opted into once the plan supports it. The order still
 * degrades to no proxy at all, so a proxy problem costs hit rate rather than
 * stopping the job.
 */
const USE_RESIDENTIAL = process.env.APIFY_RESIDENTIAL === "1";

const PROXY_PLANS: { label: string; proxy?: Record<string, unknown> }[] = [
  ...(USE_RESIDENTIAL
    ? [{ label: "residential", proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] } }]
    : []),
  { label: "shared", proxy: { useApifyProxy: true } },
  { label: "none" },
];

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

/**
 * One crawl, degrading through the proxy plans if the exit is the problem.
 *
 * Returns the text and where the browser finished. `via` names the plan that
 * worked, so the logs show when residential has stopped being available rather
 * than just showing a lower hit rate.
 */
async function crawl(
  token: string,
  url: string,
): Promise<{ text: string; landed: string | null; error?: string; via?: string }> {
  const endpoint =
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=120&memory=${RUN_MEMORY_MB}`;

  let lastError = "no attempt made";

  for (const plan of PROXY_PLANS) {
    const body = JSON.stringify({
      startUrls: [{ url }],
      maxCrawlPages: 1,
      maxCrawlDepth: 0,
      crawlerType: "playwright:firefox",
      ...(plan.proxy ? { proxyConfiguration: plan.proxy } : {}),
      readableTextCharThreshold: 80,
      saveMarkdown: false,
      maxResults: 1,
    });

    let planError = "";
    let tryNextPlan = false;

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        cache: "no-store",
      });
      if (res.ok) {
        const items = await res.json();
        return { text: extractText(items), landed: loadedUrl(items), via: plan.label };
      }

      const { message, type } = apifyError(res.status, await res.text());

      // Contention, not a verdict on the article: whatever held the memory
      // finishes and the same request then succeeds.
      if (res.status === 402 && /memory-limit-exceeded/i.test(message) && attempt < MEMORY_RETRY_MS.length) {
        await sleep(MEMORY_RETRY_MS[attempt]);
        continue;
      }

      planError = `${message} [proxy=${plan.label}]`;
      // Only an exit-related refusal is worth a cheaper plan. A 404, or a URL
      // the crawler cannot parse, fails identically however it is routed, so
      // retrying it twice more just spends time.
      tryNextPlan =
        res.status === 400 || res.status === 402 || /proxy|usage|limit|run-failed/i.test(`${type} ${message}`);
      break;
    }

    lastError = planError || lastError;
    if (!tryNextPlan) break;
  }

  return { text: "", landed: null, error: lastError };
}

/** Fetch the readable body for one RSS link, resolving the wrapper first. */
export async function fetchArticleBody(link: string): Promise<ArticleBody> {
  const token = process.env.APIFY_TOKEN;
  if (!token || !link) {
    return { text: "", status: "no_token", resolvedUrl: null, resolveStatus: null };
  }

  const resolved = await resolveArticleUrl(link);

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
  if (!target) {
    try {
      const attempt = await crawl(token, link);
      const escaped = attempt.landed && !/news\.google\.com/i.test(attempt.landed);
      if (escaped && attempt.text) {
        const status: BodyStatus = attempt.text.length < THIN_CHARS ? "thin" : "ok";
        return { text: attempt.text, status, resolvedUrl: attempt.landed, resolveStatus: "browser", via: attempt.via };
      }
      return {
        text: "",
        status: "unresolved",
        resolvedUrl: null,
        resolveStatus: resolved.status,
        note: `${resolved.note ?? "no url"}; browser landed on ${attempt.landed ?? "nothing"}`,
      };
    } catch (e) {
      return {
        text: "",
        status: "unresolved",
        resolvedUrl: null,
        resolveStatus: resolved.status,
        note: `${resolved.note ?? "no url"}; browser fallback failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  try {
    const { text, error, via: proxyVia } = await crawl(token, target);
    if (error) {
      return { text: "", status: "http_error", resolvedUrl: target, resolveStatus: via, note: error };
    }
    const status: BodyStatus = !text ? "empty" : text.length < THIN_CHARS ? "thin" : "ok";
    return { text, status, resolvedUrl: target, resolveStatus: via, via: proxyVia };
  } catch (e) {
    return {
      text: "",
      status: "error",
      resolvedUrl: target,
      resolveStatus: via,
      note: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Fetch many bodies, capped so Apify's memory ceiling isn't tripped. */
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
