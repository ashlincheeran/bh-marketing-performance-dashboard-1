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
  note?: string;
}

/** Below this a "body" is a cookie banner or a paywall stub, not an article. */
const THIN_CHARS = Number(process.env.APIFY_THIN_CHARS || 400);

/**
 * Concurrent Apify runs, not concurrent articles.
 *
 * Apify caps total memory across simultaneous runs and answers HTTP 402 past
 * it. Unbounded Promise.all over a run's worth of links has already caused
 * exactly that, so the cap is on runs and stays low.
 */
const MAX_CONCURRENT = Number(process.env.APIFY_MAX_CONCURRENT || 4);

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

/** One crawl. Returns the text and where the browser finished. */
async function crawl(token: string, url: string): Promise<{ text: string; landed: string | null; error?: string }> {
  const endpoint =
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=120`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startUrls: [{ url }],
      maxCrawlPages: 1,
      maxCrawlDepth: 0,
      crawlerType: "playwright:firefox",
      // Residential exit: Gulf and UK publishers routinely serve datacentre
      // IPs a consent wall instead of the article.
      proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
      readableTextCharThreshold: 80,
      saveMarkdown: false,
      maxResults: 1,
    }),
    cache: "no-store",
  });
  if (!res.ok) return { text: "", landed: null, error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
  const items = await res.json();
  return { text: extractText(items), landed: loadedUrl(items) };
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
        return { text: attempt.text, status, resolvedUrl: attempt.landed, resolveStatus: "browser" };
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
    const { text, error } = await crawl(token, target);
    if (error) {
      return { text: "", status: "http_error", resolvedUrl: target, resolveStatus: via, note: error };
    }
    const status: BodyStatus = !text ? "empty" : text.length < THIN_CHARS ? "thin" : "ok";
    return { text, status, resolvedUrl: target, resolveStatus: via };
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
