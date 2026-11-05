import { test } from "node:test";
import assert from "node:assert/strict";
import type { ArticleBody } from "@/lib/apify";
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

test("a bot check is blocked even when it answers HTTP 200", async () => {
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
    assert.equal(read.text, "");
    assert.match(read.note ?? "", /bot check/);
  }
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
