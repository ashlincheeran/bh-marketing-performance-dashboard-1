// Full-text article extraction via Apify.
//
// Google News RSS gives us wrapper links that a normal fetch can't open (403).
// Apify's website-content-crawler loads them in a real browser, follows the
// redirect to the actual publisher article, and returns the readable text.
//
// No APIFY_TOKEN set → returns null (the caller then falls back to title+source
// for that article, so the bot still runs, just without the body).
const ACTOR = "apify~website-content-crawler";

function extractText(items: any): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((it) => String(it?.text || it?.markdown || "") )
    .join("\n")
    .trim();
}

/** Fetch the readable body text for one URL. null on failure / no token. */
export async function fetchArticleText(url: string): Promise<string | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token || !url) return null;
  const endpoint =
    `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=120`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startUrls: [{ url }],
        maxCrawlPages: 1,
        maxCrawlDepth: 0,
        crawlerType: "playwright:firefox", // browser → resolves the Google News redirect
        proxyConfiguration: { useApifyProxy: true },
        readableTextCharThreshold: 80,
        saveMarkdown: false,
        maxResults: 1,
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = extractText(await res.json());
    return text || null;
  } catch {
    return null;
  }
}

/** Extract bodies for many URLs in parallel; returns url → text for the ones that worked. */
export async function fetchArticleTexts(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const results = await Promise.allSettled(urls.map((u) => fetchArticleText(u)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) out.set(urls[i], r.value);
  });
  return out;
}
