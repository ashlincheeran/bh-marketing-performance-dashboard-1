import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleBody, ArticleBodyOptions } from "@/lib/apify";
import { readArticle, type ReadOptions } from "@/lib/news/read";

// Nothing here touches the network: every page comes from a stub fetch, the Google link is never
// really unwrapped, and Apify is always a stand-in.

const ADDRESS = "https://www.gulfpaper.example/property/prices-rise";
const GOOGLE = "https://news.google.com/rss/articles/CBMiTestOnlyNotARealLink?oc=5";

const STORY = [
  "Prime property prices in Dubai rose by five per cent in the third quarter, according to new figures.",
  "Louis Harding, chief executive of Knight Frank Middle East, said overseas buyers were driving demand.",
  "Agents at betterhomes reported more enquiries from families moving to the emirate from London this year.",
  "Analysts expect growth to slow next year as thousands of new homes are handed over across the city.",
  "Rents in established communities such as Arabian Ranches and Jumeirah Park also climbed in the period.",
];
const WHOLE = STORY.join("\n");
const paragraphs = (lines: string[]) => lines.map((line) => `<p>${line}</p>`).join("");
const ARTICLE = `<!doctype html><html><head><title>Prices rise | Gulf Paper</title></head><body><article>${paragraphs(STORY)}</article></body></html>`;
const TEASER = "Only the first paragraph of this story is free to read on the site.";
const THIN = `<html><body><article><p>${TEASER}</p></article></body></html>`;

const page = (body: string, status = 200, type = "text/html; charset=utf-8") => new Response(body, { status, headers: { "content-type": type } });

/** A stub fetch that answers every request with `answer`, and remembers what it was asked. */
function site(answer: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer(String(input));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Options with the Apify backup off. Anything that reaches Apify or Google fails the test. */
function options(extra: Partial<ReadOptions> = {}): ReadOptions {
  return {
    apifyBackup: false,
    apifyAllowed: async () => assert.fail("the caller should not be asked about Apify"),
    apifyRead: async () => assert.fail("Apify should not be called"),
    resolveLink: async () => assert.fail("the link should not need unwrapping"),
    ...extra,
  };
}

const apifyGot = (text: string, status: ArticleBody["status"] = "ok", resolvedUrl: string | null = ADDRESS): ArticleBody => ({
  text,
  status,
  resolvedUrl,
  resolveStatus: "direct",
  via: "cheerio",
});

test("a whole article read with a plain request is ok, asked for the way a desktop browser asks", async () => {
  const { fetchImpl, calls } = site(() => page(ARTICLE));
  const read = await readArticle({ googleLink: GOOGLE, url: ADDRESS }, options({ fetchImpl }));
  assert.equal(read.status, "ok");
  assert.equal(read.via, "plain");
  assert.equal(read.resolvedUrl, ADDRESS);
  assert.equal(read.text, WHOLE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ADDRESS);
  const init = calls[0].init!;
  const headers = new Headers(init.headers);
  assert.match(headers.get("user-agent") ?? "", /^Mozilla\/5\.0 \(Windows NT [\d.]+; Win64; x64\).* Chrome\/\d+/);
  assert.match(headers.get("accept") ?? "", /^text\/html/);
  assert.match(headers.get("accept-language") ?? "", /^en/);
  assert.equal(init.redirect, "follow");
  assert.ok(init.signal instanceof AbortSignal);
});

test("a short page is thin and an empty one is empty, and both keep what text there is", async () => {
  const thin = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(THIN)).fetchImpl }));
  assert.equal(thin.status, "thin");
  assert.equal(thin.via, "plain");
  assert.equal(thin.text, TEASER);
  const empty = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(`<html><body><div><img src="x.jpg"></div></body></html>`)).fetchImpl }));
  assert.equal(empty.status, "empty");
  assert.equal(empty.via, "plain");
  assert.equal(empty.text, "");
});

test("a summary is never a read in full, however long it is", async () => {
  const summary = `${STORY.join(" ")} ${STORY.join(" ")}`;
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(`<head><meta name="description" content="${summary}"></head><body></body>`)).fetchImpl }));
  assert.equal(read.status, "thin");
  assert.equal(read.text, summary);
});

test("HTTP 401, 403, 429, 451 and 503 are blocked, and the page isn't read", async () => {
  for (const code of [401, 403, 429, 451, 503]) {
    const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(ARTICLE, code)).fetchImpl }));
    assert.equal(read.status, "blocked", `HTTP ${code}`);
    assert.equal(read.via, "plain");
    assert.equal(read.text, "");
    assert.equal(read.resolvedUrl, ADDRESS);
    assert.match(read.note ?? "", new RegExp(`HTTP ${code}`));
  }
});

test("any other failing answer is an error with its code", async () => {
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page("<h1>Not found</h1>", 404)).fetchImpl }));
  assert.equal(read.status, "error");
  assert.equal(read.via, "plain");
  assert.match(read.note ?? "", /HTTP 404/);
});

test("a bot check is blocked even when it answers HTTP 200, and keeps its own words", async () => {
  const walls = [
    `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><div class="main-content"><h1>www.gulfpaper.example</h1>
      <p>Verifying you are human. This may take a few seconds.</p><noscript><div>Enable JavaScript and cookies to continue</div></noscript></div></body></html>`,
    `<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>You don't have permission to access "http&#58;&#47;&#47;www&#46;gulfpaper&#46;example&#47;" on this server.<P>Reference&#32;&#35;18&#46;5e1c1002</BODY></HTML>`,
    `<html><head><title>Attention Required! | Cloudflare</title></head><body><p>Sorry, you have been blocked.</p></body></html>`,
    `<html><head><title>gulfpaper.example</title></head><body><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p></body></html>`,
    `<html><head><title>Sucuri WebSite Firewall - Access Denied</title></head><body><h2>Access Denied - Sucuri Website Firewall</h2><p>If you are the site owner, please get in touch.</p></body></html>`,
    `<html><head><title>gulfpaper.example</title></head><body><h1>Your access to this site has been limited by the site owner</h1></body></html>`,
  ];
  for (const wall of walls) {
    const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(wall)).fetchImpl }));
    assert.equal(read.status, "blocked", wall.slice(0, 80));
    assert.match(read.note ?? "", /bot check/);
  }
  // A short real story can look like a bot check, so what the page said is kept: it can only ever prove
  // a mention, and a blocked read never counts as read in full.
  const first = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(walls[0])).fetchImpl }));
  assert.equal(first.text, "www.gulfpaper.example\nVerifying you are human. This may take a few seconds.");
});

test("a story that talks about access being denied is still a story", async () => {
  const html = `<html><head><title>Access denied: court rejects tenants' appeal</title></head><body><article>${paragraphs(STORY)}
    <p>Lawyers said the access denied to the tenants was unlawful.</p></article></body></html>`;
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(html)).fetchImpl }));
  assert.equal(read.status, "ok");
});

test("a redirect to a consent screen is blocked", async () => {
  const { fetchImpl } = site(() => {
    const res = page(`<html><body><p>${"We and our partners store and access information on your device. ".repeat(20)}</p></body></html>`);
    Object.defineProperty(res, "url", { value: "https://consent.yahoo.com/v2/collectConsent?sessionId=1" });
    return res;
  });
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl }));
  assert.equal(read.status, "blocked");
  assert.match(read.note ?? "", /consent\.yahoo\.com/);
});

test("something that isn't a web page is empty, unread", async () => {
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page("%PDF-1.7 binary", 200, "application/pdf")).fetchImpl }));
  assert.equal(read.status, "empty");
  assert.match(read.note ?? "", /application\/pdf/);
});

test("a network error is an error with the reason, and nothing was fetched", async () => {
  const { fetchImpl } = site(() => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND www.gulfpaper.example") });
  });
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl }));
  assert.deepEqual({ ...read, note: undefined }, { text: "", status: "error", via: "none", resolvedUrl: ADDRESS, note: undefined });
  assert.match(read.note ?? "", /ENOTFOUND/);
});

test("a site that doesn't answer in time is an error", async () => {
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
    })) as typeof fetch;
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl, timeoutMs: 30 }));
  assert.equal(read.status, "error");
  assert.equal(read.via, "none");
  assert.match(read.note ?? "", /did not answer within 30 milliseconds/);
});

test("a page that stops arriving keeps what came, and is never taken as read in full", async () => {
  const start = new TextEncoder().encode(`<html><body><article>${paragraphs(STORY)}`);
  // The first part arrives, then nothing more, ever.
  const stream = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(start) });
  const { fetchImpl } = site(() => new Response(stream, { headers: { "content-type": "text/html" } }));
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl, timeoutMs: 50 }));
  assert.equal(read.status, "error");
  assert.equal(read.via, "plain");
  assert.equal(read.text, WHOLE);
  assert.match(read.note ?? "", /stopped loading/);
});

test("no more than 3 MB of a page is read", async () => {
  const chunk = new TextEncoder().encode(`<p>${"filler text ".repeat(90_000)}</p>`);
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      pulled++;
      controller.enqueue(chunk);
    },
    cancel: () => {
      cancelled = true;
    },
  });
  const { fetchImpl } = site(() => new Response(stream, { headers: { "content-type": "text/html" } }));
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl }));
  assert.ok(pulled <= 5, `pulled ${pulled} chunks of about 1 MB`);
  assert.ok(cancelled, "the rest of the download was stopped");
  assert.equal(read.status, "ok");
});

test("a windows-1252 page keeps its accents and curly quotes", async () => {
  const before = `<html><head><meta charset="windows-1252"></head><body><article>${paragraphs(STORY)}<p>Engel & V`;
  const bytes = new Uint8Array([
    ...new TextEncoder().encode(before),
    0xf6,
    ...new TextEncoder().encode("lkers and Sotheby"),
    0x92,
    ...new TextEncoder().encode("s both opened offices.</p></article></body></html>"),
  ]);
  const { fetchImpl } = site(() => new Response(bytes, { headers: { "content-type": "text/html" } }));
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl }));
  assert.equal(read.status, "ok");
  assert.ok(read.text.endsWith("Engel & Völkers and Sotheby’s both opened offices."), read.text.slice(-80));
});

test("a UTF-8 page labelled Latin-1 is read as UTF-8", async () => {
  const html = `<html><body><article>${paragraphs(STORY)}<p>Engel & Völkers opened an office.</p></article></body></html>`;
  const { fetchImpl } = site(() => new Response(new TextEncoder().encode(html), { headers: { "content-type": "text/html; charset=iso-8859-1" } }));
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl }));
  assert.ok(read.text.endsWith("Engel & Völkers opened an office."), read.text.slice(-80));
});

test("a whole article read for free never asks about Apify", async () => {
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(ARTICLE)).fetchImpl, apifyBackup: true }));
  assert.equal(read.status, "ok");
  assert.equal(read.via, "plain");
});

test("Apify is left alone when the backup is off in Settings, or the caller says no", async () => {
  const { fetchImpl } = site(() => page(THIN));
  const off = await readArticle({ googleLink: GOOGLE, url: ADDRESS }, options({ fetchImpl }));
  assert.equal(off.status, "thin");
  assert.equal(off.via, "plain");

  let asked = 0;
  const refused = await readArticle(
    { googleLink: GOOGLE, url: ADDRESS },
    options({
      fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => {
        asked++;
        return false;
      },
      onApifyRead: async () => assert.fail("nothing to count"),
    }),
  );
  assert.equal(asked, 1);
  assert.equal(refused.status, "thin");
  assert.equal(refused.via, "plain");
  assert.equal(refused.text, TEASER);
});

test("Apify reads a blocked page when allowed, at the publisher's address, and the read is counted", async () => {
  const asked: string[] = [];
  let counted = 0;
  const read = await readArticle(
    { googleLink: GOOGLE, url: ADDRESS },
    options({
      fetchImpl: site(() => page("Forbidden", 403)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async (link) => {
        asked.push(link);
        return apifyGot(`  ${STORY.join("\n\n")}  `);
      },
      onApifyRead: async () => {
        counted++;
      },
    }),
  );
  assert.equal(read.status, "ok");
  assert.equal(read.via, "apify");
  assert.equal(read.text, WHOLE);
  assert.equal(read.resolvedUrl, ADDRESS);
  assert.deepEqual(asked, [ADDRESS]);
  assert.equal(counted, 1);
  assert.match(read.note ?? "", /HTTP 403/);
});

test("when Apify can't do better the plain read stands, and the attempt still counts", async () => {
  let counted = 0;
  const read = await readArticle(
    { googleLink: null, url: ADDRESS },
    options({
      fetchImpl: site(() => page(THIN)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async () => ({ ...apifyGot("", "http_error"), note: "HTTP 402 not-enough-usage" }),
      onApifyRead: async () => {
        counted++;
      },
    }),
  );
  assert.equal(read.status, "thin");
  assert.equal(read.via, "plain");
  assert.equal(read.text, TEASER);
  assert.equal(counted, 1);
  assert.match(read.note ?? "", /Apify could not read it either \(http_error: HTTP 402/);
});

test("Apify's short text is kept when the plain read got none, but it is only thin", async () => {
  const read = await readArticle(
    { googleLink: null, url: ADDRESS },
    options({
      fetchImpl: site(() => page("", 403)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async () => apifyGot(TEASER, "thin"),
      onApifyRead: async () => {},
    }),
  );
  assert.equal(read.status, "thin");
  assert.equal(read.via, "apify");
  assert.equal(read.text, TEASER);
});

test("with no APIFY_TOKEN nothing reaches Apify, so nothing is counted", async () => {
  const read = await readArticle(
    { googleLink: null, url: ADDRESS },
    options({
      fetchImpl: site(() => page(THIN)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async () => apifyGot("", "no_token", null),
      onApifyRead: async () => assert.fail("nothing was read"),
    }),
  );
  assert.equal(read.status, "thin");
  assert.match(read.note ?? "", /APIFY_TOKEN/);
});

test("a failure to count an Apify read, or to check the allowance, is a note and not an exception", async () => {
  const counting = await readArticle(
    { googleLink: null, url: ADDRESS },
    options({
      fetchImpl: site(() => page("", 403)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async () => apifyGot(WHOLE),
      onApifyRead: async () => {
        throw new Error("the counter is down");
      },
    }),
  );
  assert.equal(counting.status, "ok");
  assert.equal(counting.via, "apify");
  assert.match(counting.note ?? "", /could not be counted: the counter is down/);

  const checking = await readArticle(
    { googleLink: null, url: ADDRESS },
    options({
      fetchImpl: site(() => page(THIN)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => {
        throw new Error("settings unreadable");
      },
    }),
  );
  assert.equal(checking.status, "thin");
  assert.match(checking.note ?? "", /allowance could not be checked: settings unreadable/);
});

test("a Google link is unwrapped first, then the publisher's page is read", async () => {
  for (const input of [
    { googleLink: GOOGLE, url: null },
    // A Google link stored as the address is treated the same way.
    { googleLink: null, url: GOOGLE },
  ]) {
    const unwrapped: string[] = [];
    const { fetchImpl, calls } = site(() => page(ARTICLE));
    const read = await readArticle(
      input,
      options({
        fetchImpl,
        resolveLink: async (link) => {
          unwrapped.push(link);
          return { url: ADDRESS, status: "batchexecute" };
        },
      }),
    );
    assert.deepEqual(unwrapped, [GOOGLE]);
    assert.deepEqual(calls.map((c) => c.url), [ADDRESS]);
    assert.equal(read.status, "ok");
    assert.equal(read.resolvedUrl, ADDRESS);
  }
});

test("a Google link that can't be unwrapped is unresolved, with no address and nothing fetched", async () => {
  const { fetchImpl, calls } = site(() => assert.fail("nothing should be fetched"));
  const read = await readArticle(
    { googleLink: GOOGLE, url: null },
    options({ fetchImpl, resolveLink: async () => ({ url: null, status: "unresolved", note: "no signature in 600B" }) }),
  );
  assert.equal(read.status, "unresolved");
  assert.equal(read.via, "none");
  assert.equal(read.resolvedUrl, null);
  assert.equal(read.text, "");
  assert.match(read.note ?? "", /no signature in 600B/);
  assert.equal(calls.length, 0);
});

test("Apify can read an unwrapped Google link in a browser, and its landing address is kept", async () => {
  const asked: string[] = [];
  const read = await readArticle(
    { googleLink: GOOGLE, url: null },
    options({
      fetchImpl: site(() => assert.fail("nothing should be fetched")).fetchImpl,
      resolveLink: async () => ({ url: null, status: "unresolved" }),
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async (link) => {
        asked.push(link);
        return { ...apifyGot(WHOLE), resolveStatus: "browser" };
      },
      onApifyRead: async () => {},
    }),
  );
  assert.deepEqual(asked, [GOOGLE]);
  assert.equal(read.status, "ok");
  assert.equal(read.via, "apify");
  assert.equal(read.resolvedUrl, ADDRESS);
});

test("Apify that stops on one of Google's own pages hasn't read the article", async () => {
  const read = await readArticle(
    { googleLink: GOOGLE, url: null },
    options({
      resolveLink: async () => ({ url: null, status: "unresolved" }),
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async () => apifyGot(WHOLE, "ok", "https://consent.google.com/ml?continue=https://news.google.com/"),
      onApifyRead: async () => {},
    }),
  );
  assert.equal(read.status, "unresolved");
  assert.equal(read.resolvedUrl, null);
  assert.equal(read.text, "");
  assert.match(read.note ?? "", /consent\.google\.com, not the article/);
});

test("no link at all is unresolved, and a stored address that isn't one is an error", async () => {
  const none = await readArticle({ googleLink: null, url: null }, options());
  assert.equal(none.status, "unresolved");
  assert.equal(none.via, "none");
  assert.equal(none.resolvedUrl, null);
  const bad = await readArticle({ googleLink: null, url: "javascript:alert(1)" }, options());
  assert.equal(bad.status, "error");
  assert.equal(bad.resolvedUrl, null);
});

test("readArticle never throws, even when fetch hands back nonsense", async () => {
  const nonsense = (async () => ({}) as Response) as typeof fetch;
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: nonsense }));
  assert.equal(read.status, "error");
  const broken = (async () => ({ status: 200, ok: true, url: "", headers: null }) as unknown as Response) as typeof fetch;
  const worse = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: broken }));
  assert.equal(worse.status, "error");
  assert.match(worse.note ?? "", /the read failed/);
});

test("an address on one of Google's own pages is never taken for the article", async () => {
  const pages = [
    "https://www.google.com/sorry/index?continue=https://news.google.com/a",
    "https://consent.google.com/ml?continue=https://news.google.com/b",
    "https://www.google.ae/intl/en/policies/privacy/",
    "https://www.gstatic.com/recaptcha/api.js",
  ];
  for (const landed of pages) {
    const r = await readArticle(
      { googleLink: "https://news.google.com/rss/articles/abc", url: null },
      {
        apifyBackup: false,
        apifyAllowed: async () => false,
        resolveLink: async () => ({ url: landed, status: "redirected" }),
        fetchImpl: async () => {
          throw new Error("Google's page must not be read as the article");
        },
      },
    );
    assert.equal(r.status, "unresolved", landed);
    assert.equal(r.resolvedUrl, null, landed);
  }
});

test("a Google page stored as the address is unwrapped again from the Google link", async () => {
  let unwrapped = 0;
  const r = await readArticle(
    { googleLink: "https://news.google.com/rss/articles/abc", url: "https://consent.google.com/ml?continue=x" },
    {
      apifyBackup: false,
      apifyAllowed: async () => false,
      resolveLink: async () => {
        unwrapped++;
        return { url: null, status: "unresolved", note: "still rate-limited" };
      },
    },
  );
  assert.equal(unwrapped, 1);
  assert.equal(r.status, "unresolved");
  const none = await readArticle(
    { googleLink: null, url: "https://www.google.com/sorry/index" },
    { apifyBackup: false, apifyAllowed: async () => false },
  );
  assert.equal(none.status, "unresolved");
  assert.match(none.note ?? "", /Google's own pages/);
});

// The review's cases (docs/news-pipeline.md rule 4): a read is "ok" only when the story itself was there.

const P1 =
  "Sales of homes worth more than Dh10 million in Dubai reached a record in the three months to September, as wealthy buyers from Europe and Asia continued to move money into the emirate's prime districts.";
const P2 =
  "More than 1,200 such homes changed hands in the quarter, up 18 per cent on a year earlier, with Palm Jumeirah, Emirates Hills and Jumeirah Bay Island accounting for nearly half of the deals by value.";
const ldJson = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

/** A stub fetch whose answer ends at `landed`, as a followed redirect does. */
const landedOn = (landed: string, body = ARTICLE) =>
  site(() => {
    const res = page(body);
    Object.defineProperty(res, "url", { value: landed });
    return res;
  }).fetchImpl;

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Apify switched on, with a tally of every ask, read and count, to show none happened. */
function watchedApify(extra: Partial<ReadOptions> = {}) {
  const seen = { asked: 0, read: 0, counted: 0 };
  const opts = options({
    apifyBackup: true,
    apifyAllowed: async () => {
      seen.asked++;
      return true;
    },
    apifyRead: async () => {
      seen.read++;
      return apifyGot(WHOLE);
    },
    onApifyRead: async () => {
      seen.counted++;
    },
    ...extra,
  });
  return { opts, seen };
}

/** Runs `p` on the mocked clock, a second at a time, until it settles. */
async function onTheClock<T>(p: Promise<T>, limitMs = 600_000): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let waited = 0; !settled && waited <= limitMs; waited += 1_000) {
    await flush();
    if (!settled) mock.timers.tick(1_000);
  }
  await flush();
  assert.ok(settled, "still running on the mocked clock");
  return p;
}

test("a story the page says goes on behind a paywall is only thin, keeps its opening, and Apify is not spent on it", async () => {
  const html = `<html><head><title>Luxury sales hit a record | Gulf Herald</title>${ldJson({ "@type": "NewsArticle", isAccessibleForFree: false, hasPart: { "@type": "WebPageElement", isAccessibleForFree: false, cssSelector: ".paywall" } })}</head>
    <body><article><h1>Luxury sales hit a record</h1><p>${P1}</p><p>${P2}</p><div class="paywall"><p>Already a subscriber? Sign in to continue reading.</p></div></article></body></html>`;
  // Apify's crawler would meet the same wall, so it is not asked.
  const { opts, seen } = watchedApify({ fetchImpl: site(() => page(html)).fetchImpl });
  const read = await readArticle({ googleLink: null, url: ADDRESS }, opts);
  assert.deepEqual(seen, { asked: 0, read: 0, counted: 0 });
  assert.equal(read.status, "thin");
  assert.match(read.note ?? "", /behind a paywall/);
  assert.ok(read.text.includes(P1) && read.text.includes(P2));
});

test("a redirect to the front page, a sign-in or subscription page, or a page-not-found page is never the story", async () => {
  for (const landed of ["https://www.gulfpaper.example/", "https://www.gulfpaper.example/en/", "https://www.gulfpaper.example/?redirect=%2Fproperty%2Fprices-rise"]) {
    const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: landedOn(landed) }));
    assert.equal(read.status, "blocked", landed);
    assert.equal(read.text, "", landed);
    assert.match(read.note ?? "", /front page/, landed);
  }
  // Up the address's own path, to the section the story sits in.
  const section = await readArticle(
    { googleLink: null, url: "https://www.gulfpaper.example/property/2026/11/04/prime-prices-rise" },
    options({ fetchImpl: landedOn("https://www.gulfpaper.example/property/") }),
  );
  assert.equal(section.status, "blocked");
  assert.match(section.note ?? "", /a section page \(www\.gulfpaper\.example\/property\/\)/);
  // A sign-in or subscription page is the same wall for Apify's crawler, so Apify is not asked.
  for (const landed of ["https://www.gulfpaper.example/subscribe?return=/property/prices-rise", "https://www.gulfpaper.example/account/login", "https://myaccount.gulfpaper.example/"]) {
    const { opts, seen } = watchedApify({ fetchImpl: landedOn(landed) });
    const read = await readArticle({ googleLink: null, url: ADDRESS }, opts);
    assert.equal(read.status, "blocked", landed);
    assert.deepEqual(seen, { asked: 0, read: 0, counted: 0 }, landed);
  }
  // A page-not-found page served with HTTP 200, by its heading or its title, whatever else it lists.
  for (const html of [
    `<html><head><title>Gulf Paper | News from the UAE</title></head><body><main><h1>Page not found</h1>${paragraphs(STORY)}</main></body></html>`,
    `<html><head><title>Page not found | Gulf Paper</title></head><body><main>${paragraphs(STORY)}</main></body></html>`,
  ]) {
    const { opts, seen } = watchedApify({ fetchImpl: site(() => page(html)).fetchImpl });
    const read = await readArticle({ googleLink: null, url: ADDRESS }, opts);
    assert.equal(read.status, "error");
    assert.equal(read.text, "");
    assert.match(read.note ?? "", /page-not-found/);
    assert.deepEqual(seen, { asked: 0, read: 0, counted: 0 });
  }
});

test("a redirect that only tidies the address still lands on the story", async () => {
  for (const landed of [
    "https://gulfpaper.example/property/prices-rise",
    "https://www.gulfpaper.example/property/prices-rise/",
    "https://www.gulfpaper.example/property/prices-rise-in-dubai-2026",
    "https://www.gulfpaper.example/en/property/prices-rise",
    "https://www.gulfpaper.example/property/prices-rise?utm_source=google",
  ]) {
    const read = await readArticle({ googleLink: null, url: "http://www.gulfpaper.example/amp/property/prices-rise" }, options({ fetchImpl: landedOn(landed) }));
    assert.equal(read.status, "ok", landed);
  }
  // Dropping an AMP or an id from the end of the address leaves the story's own part in place.
  for (const asked of ["https://www.gulfpaper.example/property/prices-rise/amp", "https://www.gulfpaper.example/property/prices-rise/123456"]) {
    const read = await readArticle({ googleLink: null, url: asked }, options({ fetchImpl: landedOn("https://www.gulfpaper.example/property/prices-rise") }));
    assert.equal(read.status, "ok", asked);
  }
});

test("a short story on a site that loads AWS WAF's script is a story, and one taken for a bot check keeps its words", async () => {
  const brief = "Dubai brokerage betterhomes has opened its first office in Abu Dhabi, on Al Reem Island, with a team of 25 agents.";
  const sdk = `<html><head><title>Brokerage expands to the capital</title><script src="https://a1b2c3d4e5f6.us-east-1.sdk.awswaf.com/a1b2c3d4e5f6/f6e5d4c3b2a1/challenge.js" defer></script></head>
    <body><article><p>${brief}</p></article></body></html>`;
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(sdk)).fetchImpl }));
  assert.equal(read.status, "thin");
  assert.equal(read.text, brief);
  // AWS WAF's own challenge page is still a bot check.
  const challenge = `<html><head><script>window.awsWafCookieDomainList = []; window.gokuProps = {"key":"AQID","iv":"A6we","context":"x"};</script>
    <script src="https://a1b2c3d4e5f6.us-east-1.token.awswaf.com/a1b2c3d4e5f6/f6e5d4c3b2a1/challenge.js"></script></head><body><div id="challenge-container"></div></body></html>`;
  const wall = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(challenge, 202)).fetchImpl }));
  assert.equal(wall.status, "blocked");
  // A brief whose headline starts the way a bot check's title does is taken for one, but its words are kept.
  const forbidden = `<html><head><meta property="og:title" content="Forbidden: Dubai bans holiday lets in older towers"></head>
    <body><article><p>Agents including betterhomes said owners of older towers would have to switch to annual leases.</p></article></body></html>`;
  const taken = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => page(forbidden)).fetchImpl }));
  assert.equal(taken.status, "blocked");
  assert.match(taken.text, /betterhomes/);
});

test("a page that names no character set is read as UTF-8 when its bytes are, else as windows-1252", async () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const oe = String.fromCharCode(0xf6);
  const apostrophe = String.fromCharCode(0x2019);
  const latin = new Uint8Array([
    ...enc(`<html><body><article>${paragraphs(STORY)}<p>Engel & V`),
    0xf6,
    ...enc("lkers and Sotheby"),
    0x92,
    ...enc("s both opened offices.</p></article></body></html>"),
  ]);
  const labels: Record<string, string>[] = [{ "content-type": "text/html" }, {}];
  for (const headers of labels) {
    const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => new Response(latin, { headers })).fetchImpl }));
    assert.ok(read.text.endsWith(`Engel & V${oe}lkers and Sotheby${apostrophe}s both opened offices.`), read.text.slice(-80));
  }
  // UTF-8 with no label, and one stray broken byte among its whole characters, is still UTF-8.
  const utf8 = new Uint8Array([
    ...enc(`<html><body><article>${paragraphs(STORY)}<p>Engel & V${oe}lkers and Sotheby${apostrophe}s opened offices.</p><p>Cut here: `),
    0xc3,
    ...enc(" and on.</p></article></body></html>"),
  ]);
  const read = await readArticle({ googleLink: null, url: ADDRESS }, options({ fetchImpl: site(() => new Response(utf8, { headers: { "content-type": "text/html" } })).fetchImpl }));
  assert.ok(read.text.includes(`Engel & V${oe}lkers and Sotheby${apostrophe}s opened offices.`), read.text.slice(-120));
});

test("Apify is not spent on a page that is gone or is not a web page, but still reads one that was refused or broke", async () => {
  for (const [status, type] of [[404, "text/html"], [410, "text/html"], [200, "application/pdf"]] as const) {
    const { opts, seen } = watchedApify({ fetchImpl: site(() => page("x", status, type)).fetchImpl });
    const read = await readArticle({ googleLink: null, url: ADDRESS }, opts);
    assert.notEqual(read.status, "ok", `HTTP ${status} ${type}`);
    assert.deepEqual(seen, { asked: 0, read: 0, counted: 0 }, `HTTP ${status} ${type}`);
  }
  for (const status of [403, 405, 500]) {
    let asked = 0;
    let counted = 0;
    const read = await readArticle(
      { googleLink: null, url: ADDRESS },
      options({
        fetchImpl: site(() => page("x", status)).fetchImpl,
        apifyBackup: true,
        apifyAllowed: async () => true,
        apifyRead: async () => {
          asked++;
          return apifyGot(WHOLE);
        },
        onApifyRead: async () => {
          counted++;
        },
      }),
    );
    assert.equal(asked, 1, `HTTP ${status}`);
    assert.equal(counted, 1, `HTTP ${status}`);
    assert.equal(read.status, "ok", `HTTP ${status}`);
  }
});

test("Apify's read is checked as the plain read is: a consent, sign-in or front page, or a page-not-found page, is not the story", async () => {
  const cases: [string, Partial<ArticleBody>, RegExp][] = [
    ["consent", { landedUrl: "https://consent.yahoo.com/v2/collectConsent?sessionId=1" }, /Apify was sent to consent\.yahoo\.com/],
    ["sign-in", { landedUrl: "https://www.gulfpaper.example/account/login?next=/property/prices-rise" }, /sign-in or subscription page/],
    ["front page", { landedUrl: "https://www.gulfpaper.example/" }, /front page/],
    ["not found", { title: "Page not found | Gulf Paper" }, /page-not-found/],
  ];
  for (const [label, extra, note] of cases) {
    let counted = 0;
    const read = await readArticle(
      { googleLink: null, url: ADDRESS },
      options({
        fetchImpl: site(() => page("Forbidden", 403)).fetchImpl,
        apifyBackup: true,
        apifyAllowed: async () => true,
        apifyRead: async () => ({ ...apifyGot(WHOLE), ...extra }),
        onApifyRead: async () => {
          counted++;
        },
      }),
    );
    // The plain read's answer stands, and the attempt still counts.
    assert.equal(read.status, "blocked", label);
    assert.equal(read.via, "plain", label);
    assert.match(read.note ?? "", note, label);
    assert.equal(counted, 1, label);
  }
});

test("Apify meeting a paywall or a bot check has not read the story either", async () => {
  const apify = (body: ArticleBody) =>
    options({ fetchImpl: site(() => page("Forbidden", 403)).fetchImpl, apifyBackup: true, apifyAllowed: async () => true, apifyRead: async () => body, onApifyRead: async () => {} });
  // A paywall's own line in what it read: the text can prove a mention, never a read in full.
  const walled = await readArticle({ googleLink: null, url: ADDRESS }, apify(apifyGot(`${WHOLE}\nSubscribe to continue reading.`)));
  assert.equal(walled.status, "thin");
  assert.equal(walled.via, "apify");
  assert.ok(walled.text.includes(STORY[2]));
  const bot = await readArticle({ googleLink: null, url: ADDRESS }, apify(apifyGot("Verifying you are human. This may take a few seconds.", "thin")));
  assert.equal(bot.status, "blocked");
  assert.equal(bot.via, "plain");
  assert.match(bot.note ?? "", /bot check too/);
});

test("short of a whole read, what Apify found is kept with what the plain read found", async () => {
  const forbidden = `<html><head><meta property="og:title" content="Forbidden: Dubai bans holiday lets in older towers"></head>
    <body><article><p>Agents including betterhomes said owners of older towers would have to switch to annual leases.</p></article></body></html>`;
  const read = await readArticle(
    { googleLink: null, url: ADDRESS },
    options({
      fetchImpl: site(() => page(forbidden)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async () => apifyGot("Haus & Haus said the change would affect about 3,000 flats.", "thin"),
      onApifyRead: async () => {},
    }),
  );
  assert.equal(read.status, "thin");
  assert.equal(read.via, "apify");
  assert.match(read.text, /betterhomes/);
  assert.match(read.text, /Haus & Haus/);
});

test("Apify gets what is left of the caller's time, and never more than the read step keeps for it", async () => {
  const deadlines: number[] = [];
  const opts = (extra: Partial<ReadOptions> = {}) =>
    options({
      fetchImpl: site(() => page("Forbidden", 403)).fetchImpl,
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async (_link, o) => {
        deadlines.push(o.deadline ?? Infinity);
        return apifyGot(WHOLE);
      },
      onApifyRead: async () => {},
      ...extra,
    });
  const before = Date.now();
  await readArticle({ googleLink: null, url: ADDRESS }, opts());
  await readArticle({ googleLink: null, url: ADDRESS }, opts({ deadline: before + 60_000 }));
  const after = Date.now();
  assert.ok(deadlines[0] >= before + 150_000 && deadlines[0] <= after + 150_000, `${deadlines[0] - before} ms`);
  assert.equal(deadlines[1], before + 60_000);
});

test("with too little time left Apify is not asked about, so nothing is reserved or counted", async () => {
  const { opts, seen } = watchedApify({ fetchImpl: site(() => page("Forbidden", 403)).fetchImpl, deadline: Date.now() + 20_000 });
  const read = await readArticle({ googleLink: null, url: ADDRESS }, opts);
  assert.deepEqual(seen, { asked: 0, read: 0, counted: 0 });
  assert.equal(read.status, "blocked");
  assert.match(read.note ?? "", /too little time was left to try Apify/);
});

test("an Apify read that has not finished by its deadline is given up on and counted, and the plain read stands", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    let counted = 0;
    const pending = readArticle(
      { googleLink: null, url: ADDRESS },
      options({
        fetchImpl: site(() => page("Forbidden", 403)).fetchImpl,
        apifyBackup: true,
        apifyAllowed: async () => true,
        // Never answers.
        apifyRead: () => new Promise<ArticleBody>(() => {}),
        onApifyRead: async () => {
          counted++;
        },
        deadline: 1_060_000,
      }),
    );
    const read = await onTheClock(pending);
    assert.equal(read.status, "blocked");
    assert.match(read.note ?? "", /had not finished by the deadline/);
    assert.equal(counted, 1);
    assert.ok(Date.now() <= 1_065_000, `returned at ${Date.now() - 1_000_000} ms`);
  } finally {
    mock.timers.reset();
  }
});

test("a Google link the plain read could not unwrap goes to Apify as such, and a read Apify had no time to start is not counted", async () => {
  const given: ArticleBodyOptions[] = [];
  const read = await readArticle(
    { googleLink: GOOGLE, url: null },
    options({
      resolveLink: async () => ({ url: null, status: "unresolved", note: "rate-limited" }),
      apifyBackup: true,
      apifyAllowed: async () => true,
      apifyRead: async (_link, o) => {
        given.push(o);
        return { ...apifyGot("", "no_time", null), note: "no Apify crawl came free in time" };
      },
      onApifyRead: async () => assert.fail("nothing reached Apify"),
    }),
  );
  assert.equal(given[0].resolved?.url, null);
  assert.equal(given[0].resolved?.status, "unresolved");
  assert.equal(read.status, "unresolved");
  assert.match(read.note ?? "", /Apify was not tried: no Apify crawl came free in time/);
});

test("the plain read keeps to the caller's deadline", async () => {
  const late = await readArticle(
    { googleLink: null, url: ADDRESS },
    options({ fetchImpl: site(() => assert.fail("nothing should be fetched")).fetchImpl, deadline: Date.now() - 1 }),
  );
  assert.equal(late.status, "error");
  assert.match(late.note ?? "", /no time was left to read the page/);
  const started = Date.now();
  const stuck = await readArticle(
    { googleLink: GOOGLE, url: null },
    options({ resolveLink: () => new Promise(() => {}), deadline: Date.now() + 50 }),
  );
  assert.equal(stuck.status, "unresolved");
  assert.match(stuck.note ?? "", /no time was left to unwrap it/);
  assert.ok(Date.now() - started < 2_000);
});
