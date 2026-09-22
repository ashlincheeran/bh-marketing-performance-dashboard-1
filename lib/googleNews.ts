// Turning a Google News RSS link into the publisher's own article URL.
//
// WHY THIS EXISTS — the bot stored `hasBody: false` on essentially every row it
// has ever written (2 exceptions in ~1,900). Without a body, lib/ingest.ts
// judged brand relevance from the headline alone, so the coverage that matters
// most — "according to analysis by Betterhomes", where the brand is named in
// the text and never in the title — was filed "no brand in text" and dropped.
//
// The cause is that RSS gives a WRAPPER link, not the article:
//   https://news.google.com/rss/articles/CBMipgFBVV95cUxNQmdCcVZ...?oc=5
// Handing that to Apify's website-content-crawler reads Google's interstitial,
// not the publisher, because the crawler stays on the start URL's domain and so
// refuses to follow the redirect off news.google.com. It then returns nothing
// and the run SUCCEEDS with no text — a silent failure, which is exactly the
// shape of bug this codebase keeps getting bitten by.
//
// So resolve the link ourselves first and hand Apify a real article URL.
//
// Two wrapper generations exist and both are handled:
//   OLD — the base64 payload literally contains the article URL. Free, instant,
//         no network at all.
//   NEW — the payload holds an opaque "AU_yqL…" identifier that only Google can
//         expand, so it has to be followed over the network.
//
// Every failure is NAMED rather than returned as an empty string, because "no
// text" has meant four different things in this pipeline and the caller needs to
// tell them apart.

/** Why a resolution attempt ended the way it did. */
export type ResolveStatus =
  | "direct"       // not a Google wrapper; already a publisher URL
  | "decoded"      // old-format payload carried the URL
  | "redirected"   // followed the wrapper to the publisher
  | "scraped"      // pulled the publisher link out of Google's interstitial HTML
  | "unresolved"   // it is a wrapper and none of the above worked
  | "error";

export interface Resolved {
  url: string | null;
  status: ResolveStatus;
  note?: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const RESOLVE_TIMEOUT_MS = Number(process.env.NEWS_RESOLVE_TIMEOUT_MS || 15_000);

export function isGoogleNewsLink(url: string): boolean {
  return /^https?:\/\/news\.google\.com\//i.test(url || "");
}

/**
 * Old-format wrapper: base64url payload is a protobuf whose first string field
 * is the article URL. Shape is `\x08\x13\x22<varint len><url>`, so the length
 * prefix is read properly rather than regexing and hoping — a regex over binary
 * happily runs past the end of the string into the next field.
 */
function decodeEmbeddedUrl(id: string): string | null {
  try {
    const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(b64, "base64").toString("latin1");

    if (raw.charCodeAt(0) === 0x08 && raw.charCodeAt(2) === 0x22) {
      let i = 3;
      let len = 0;
      let shift = 0;
      while (i < raw.length && shift <= 28) {
        const b = raw.charCodeAt(i++);
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      const candidate = raw.slice(i, i + len);
      if (/^https?:\/\/\S+$/.test(candidate)) return candidate;
    }

    // Older variants without that exact header still embed a plain URL.
    const m = raw.match(/https?:\/\/[^\s\u0000-\u001f"'<>\\]{12,}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** First absolute non-Google link in Google's interstitial HTML. */
function scrapePublisherLink(html: string): string | null {
  const patterns = [
    /data-n-au="(https?:\/\/[^"]+)"/i,
    /<link[^>]+rel="canonical"[^>]+href="(https?:\/\/[^"]+)"/i,
    /<a[^>]+href="(https?:\/\/[^"]+)"/gi,
    /url=(https?:\/\/[^"'&\s]+)/i,
  ];
  for (const re of patterns) {
    if (re.global) {
      for (const m of html.matchAll(re)) {
        const u = decodeURIComponent(m[1]);
        if (!/(^https?:\/\/)?[^/]*google\.com/i.test(u)) return u;
      }
    } else {
      const m = html.match(re);
      if (m) {
        const u = decodeURIComponent(m[1]);
        if (!/(^https?:\/\/)?[^/]*google\.com/i.test(u)) return u;
      }
    }
  }
  return null;
}

/**
 * Resolve one RSS link to the publisher's article URL.
 *
 * Ordered cheapest-first: a decode costs nothing, so the network is only
 * touched for new-format wrappers.
 */
export async function resolveArticleUrl(link: string): Promise<Resolved> {
  if (!link) return { url: null, status: "error", note: "empty link" };
  if (!isGoogleNewsLink(link)) return { url: link, status: "direct" };

  const id = link.match(/\/rss\/articles\/([^?/]+)/)?.[1];
  if (id) {
    const decoded = decodeEmbeddedUrl(id);
    if (decoded) return { url: decoded, status: "decoded" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(link, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      signal: ctrl.signal,
      cache: "no-store",
    });

    // The browser-visible redirect is the happy path for new-format wrappers.
    if (res.url && !isGoogleNewsLink(res.url)) {
      return { url: res.url, status: "redirected" };
    }

    const html = await res.text();
    const scraped = scrapePublisherLink(html);
    if (scraped) return { url: scraped, status: "scraped" };

    return {
      url: null,
      status: "unresolved",
      note: `HTTP ${res.status}, no publisher link in ${html.length} bytes`,
    };
  } catch (e) {
    return {
      url: null,
      status: "error",
      note: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve many links with a concurrency cap. */
export async function resolveArticleUrls(
  links: string[],
  concurrency = 6,
): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  const queue = [...new Set(links.filter(Boolean))];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const link = queue.shift();
      if (!link) return;
      out.set(link, await resolveArticleUrl(link));
    }
  });
  await Promise.all(workers);
  return out;
}
