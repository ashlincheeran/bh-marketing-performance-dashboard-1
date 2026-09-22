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
//         no network at all. Note this is now essentially historical: the format
//         was retired in late 2024, and of 30 ids sampled from a live feed in
//         September 2026 none decoded offline. Kept because it costs nothing and
//         still answers for anything old sitting in the table.
//   NEW — the payload holds an opaque "AU_yqL…" identifier that only Google can
//         expand, so it has to be followed over the network.
//
// This decoder is a WORKAROUND, and worth naming as one: batchexecute is an
// internal endpoint with no contract, it has changed once already, and it costs
// two round trips per article before a word is read. scripts/probe-discovery-
// sources.mjs measures the alternatives that hand back publisher URLs directly.
//
// Every failure is NAMED rather than returned as an empty string, because "no
// text" has meant four different things in this pipeline and the caller needs to
// tell them apart.

/** Why a resolution attempt ended the way it did. */
export type ResolveStatus =
  | "direct"       // not a Google wrapper; already a publisher URL
  | "decoded"      // old-format payload carried the URL
  | "batchexecute" // new-format id expanded through Google's own RPC
  | "redirected"   // followed the wrapper to the publisher
  | "scraped"      // pulled the publisher link out of Google's interstitial HTML
  | "browser"      // plain HTTP couldn't, but a real browser followed the JS redirect
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

/**
 * "Consent already recorded".
 *
 * Without it Google answers these requests with a 302 to its consent page, and
 * the signature and timestamp the RPC needs are simply not on that page — the
 * request looks like it worked and yields nothing. Browser-shaped headers alone
 * do not avoid it.
 */
const CONSENT_COOKIE = "SOCS=CAESHAgBEhIaAB; CONSENT=YES+";

const BROWSERISH = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,*/*",
  "accept-language": "en-GB,en;q=0.9",
  cookie: CONSENT_COOKIE,
} as const;

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

/**
 * New-format wrappers: ask Google to expand the id.
 *
 * The payload for these holds an opaque "AU_yqL…" identifier rather than a URL,
 * and the page behind it is a ~600KB JavaScript shell — fetching it and looking
 * for a publisher link finds nothing, which is exactly what the first backfill
 * pass reported for all 40 rows. The only thing that expands the id is Google's
 * own DotsSplashUi RPC, which needs two values minted into the article page:
 * a signature and a timestamp.
 *
 * The literal inside `garturlreq` is Google's request shape, not something we
 * get to design; the "X" placeholders are required positional filler.
 */
async function resolveViaBatchExecute(id: string): Promise<Resolved> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const page = await fetch(`https://news.google.com/rss/articles/${id}`, {
      headers: BROWSERISH,
      signal: ctrl.signal,
      cache: "no-store",
    });
    const html = await page.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) {
      return {
        url: null,
        status: "unresolved",
        note: `no signature/timestamp in ${html.length}B (sg=${!!sg} ts=${!!ts})`,
      };
    }

    const inner = JSON.stringify([
      "garturlreq",
      [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
       "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
      id,
      Number(ts),
      sg,
    ]);
    const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);

    const rpc = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": UA,
        cookie: CONSENT_COOKIE,
      },
      body: `f.req=${encodeURIComponent(freq)}`,
      signal: ctrl.signal,
      cache: "no-store",
    });
    const raw = await rpc.text();

    // The response is an anti-JSON-hijacking prologue `)]}'`, a blank line, then
    // CHUNKS: each a byte-count on its own line followed by a JSON array. So it
    // is not one document — splitting on the blank line and parsing leaves the
    // length digits glued to the front and JSON.parse throws. Walk the lines
    // instead and parse the ones that actually start an array.
    //
    // The url sits inside a nested JSON *string* at row[2], so it needs a
    // second parse. A regex stays as a backstop for when the envelope shifts
    // again, which it has before.
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("[[")) continue;
      try {
        const envelope = JSON.parse(trimmed) as unknown[][];
        for (const row of envelope) {
          if (row?.[0] !== "wrb.fr" || typeof row?.[2] !== "string") continue;
          const parsed = JSON.parse(row[2] as string) as unknown[];
          const url = parsed.find((v) => typeof v === "string" && /^https?:\/\//.test(v));
          if (typeof url === "string") return { url, status: "batchexecute" };
        }
      } catch {
        /* not the chunk we want — keep going */
      }
    }
    const loose = raw.match(/https?:\\?\/\\?\/(?!news\.google\.com)[^"\\]{12,}/);
    if (loose) return { url: loose[0].replace(/\\\//g, "/"), status: "batchexecute" };

    return { url: null, status: "unresolved", note: `RPC ${rpc.status}, no url in ${raw.length}B` };
  } catch (e) {
    return { url: null, status: "error", note: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
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

  // New-format ids only Google can expand. Tried before the plain fetch,
  // because that fetch just lands on a 600KB JavaScript shell.
  if (id) {
    const viaRpc = await resolveViaBatchExecute(id);
    if (viaRpc.url) return viaRpc;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(link, {
      redirect: "follow",
      headers: BROWSERISH,
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
