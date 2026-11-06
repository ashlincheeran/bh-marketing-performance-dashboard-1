import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry } from "@/lib/news/registry";
import { buildQueries, headlineSkip, parseRss, runSearches } from "@/lib/news/search";
import type { Person } from "@/lib/news/types";

// A feed shaped like Google News's own: a channel title and link that are not
// results, then items with the quirks real feeds have.
const FEED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<generator>NFE/5.0</generator>
<title>"betterhomes" when:2d - Google News</title>
<link>https://news.google.com/search?q=betterhomes+when:2d&amp;hl=en-AE&amp;gl=AE&amp;ceid=AE:en</link>
<language>en-AE</language>
<lastBuildDate>Thu, 05 Nov 2026 06:00:00 GMT</lastBuildDate>
<description>Google News</description>
<item>
<title>Dubai&#39;s prime rents climb 8% as betterhomes reports a record quarter - Khaleej Times</title>
<link>https://news.google.com/rss/articles/CBMiTmh0dHBzOi8va2hhbGVlanRpbWVzLmNvbS9wcmltZS1yZW50cw?oc=5</link>
<guid isPermaLink="false">CBMiTmh0dHBzOi8va2hhbGVlanRpbWVzLmNvbS9wcmltZS1yZW50cw</guid>
<pubDate>Wed, 04 Nov 2026 21:15:00 GMT</pubDate>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiTmh0dHBzOi8va2hhbGVlanRpbWVzLmNvbS9wcmltZS1yZW50cw?oc=5" target="_blank"&gt;Dubai&amp;#39;s prime rents climb 8% as betterhomes reports a record quarter&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Khaleej Times&lt;/font&gt;</description>
<source url="https://www.khaleejtimes.com">Khaleej Times</source>
</item>
<item>
<title><![CDATA[Allsopp & Allsopp opens a second office in Dubai Hills - Gulf News]]></title>
<link>https://news.google.com/rss/articles/CBMiQkJC?oc=5</link>
<guid isPermaLink="false">CBMiQkJC</guid>
<pubDate>Tue, 03 Nov 2026 09:00:00 GMT</pubDate>
<source url="https://gulfnews.com"><![CDATA[Gulf News]]></source>
</item>
<item>
<title>Engel &amp;amp; V&amp;ouml;lkers: &amp;#8220;Buyers are back&amp;#8221; &amp;ndash; Q3 review - Arabian Business</title>
<link>https://news.google.com/rss/articles/CBMiQ0ND?oc=5</link>
<pubDate>Mon, 02 Nov 2026 19:59:00 GMT</pubDate>
<source url="https://www.arabianbusiness.com">Arabian Business</source>
</item>
<item>
<title>Better Homes &amp; Gardens names its colour of the year - Better Homes &amp; Gardens</title>
<link>https://news.google.com/rss/articles/CBMiREZE?oc=5</link>
<pubDate>Wed, 04 Nov 2026 12:00:00 GMT</pubDate>
<source url="https://www.bhg.com">Better Homes &amp; Gardens</source>
</item>
<item>
<title>A result that lost its link - Zawya</title>
<pubDate>Wed, 04 Nov 2026 08:00:00 GMT</pubDate>
<source url="https://www.zawya.com">Zawya</source>
</item>
<item>
<title></title>
<link>https://news.google.com/rss/articles/CBMiRkZG?oc=5</link>
<source url="https://www.zawya.com">Zawya</source>
</item>
<item>
<title>Knight Frank appoints Louis Harding as partner - Consultancy-me.com</title>
<link>https://news.google.com/rss/articles/CBMiR0dH?oc=5&amp;hl=en-AE</link>
<pubDate>sometime last week</pubDate>
<source url="https://www.consultancy-me.com">Consultancy-me.com</source>
</item>
</channel>
</rss>`;

test("parseRss reads every usable result in a Google News feed", () => {
  const q = "betterhomes when:2d";
  assert.deepEqual(parseRss(FEED, q), [
    {
      title: "Dubai's prime rents climb 8% as betterhomes reports a record quarter",
      link: "https://news.google.com/rss/articles/CBMiTmh0dHBzOi8va2hhbGVlanRpbWVzLmNvbS9wcmltZS1yZW50cw?oc=5",
      outlet: "Khaleej Times",
      // 21:15 GMT is already 01:15 the next morning in Dubai.
      publishedOn: "2026-11-05",
      query: q,
    },
    {
      title: "Allsopp & Allsopp opens a second office in Dubai Hills",
      link: "https://news.google.com/rss/articles/CBMiQkJC?oc=5",
      outlet: "Gulf News",
      publishedOn: "2026-11-03",
      query: q,
    },
    {
      // Escaped twice in the feed, so decoded twice.
      title: "Engel & V\u00f6lkers: \u201cBuyers are back\u201d \u2013 Q3 review",
      link: "https://news.google.com/rss/articles/CBMiQ0ND?oc=5",
      outlet: "Arabian Business",
      publishedOn: "2026-11-02",
      query: q,
    },
    {
      title: "Better Homes & Gardens names its colour of the year",
      link: "https://news.google.com/rss/articles/CBMiREZE?oc=5",
      outlet: "Better Homes & Gardens",
      publishedOn: "2026-11-04",
      query: q,
      skip: "Better Homes & Gardens, another company",
    },
    {
      title: "Knight Frank appoints Louis Harding as partner",
      link: "https://news.google.com/rss/articles/CBMiR0dH?oc=5&hl=en-AE",
      outlet: "Consultancy-me.com",
      publishedOn: null,
      query: q,
    },
  ]);
});

test("parseRss finds nothing in an empty feed or in something that is not a feed", () => {
  assert.deepEqual(parseRss(`<rss version="2.0"><channel><title>x - Google News</title></channel></rss>`, "x"), []);
  assert.deepEqual(parseRss("<html><body>Before you continue to Google</body></html>", "x"), []);
  assert.deepEqual(parseRss("", "x"), []);
});

const person = (name: string, company: string, active: boolean): Person => ({ name, company, role: null, aliases: [], active, note: null });

const REG = buildRegistry(
  [
    { label: "Knight Frank", query: "knight frank dubai" },
    { label: "Haus & Haus", query: "haus and haus dubai" },
  ],
  [
    person("Simon Baker", "betterhomes", true),
    // Former at betterhomes: not searched.
    person("Jacob Fletcher", "betterhomes", false),
    // Moved: former at betterhomes, current at Knight Frank, so searched once.
    person("Louis Harding", "betterhomes", false),
    person("Louis Harding", "Knight Frank", true),
  ],
);

test("buildQueries searches the PR keywords, each rival, then each current person", () => {
  const keywords = ["betterhomes", "BetterHomes", "  dubai   real estate ", "Knight Frank Dubai", ""];
  assert.deepEqual(buildQueries(REG, keywords, "2d"), [
    { query: "betterhomes when:2d", kind: "pr" },
    { query: "dubai real estate when:2d", kind: "pr" },
    // The rival's own "knight frank dubai" is the same search, so it runs once.
    { query: "Knight Frank Dubai when:2d", kind: "pr" },
    { query: "haus and haus dubai when:2d", kind: "rival" },
    { query: '"Simon Baker" dubai when:2d', kind: "person" },
    { query: '"Louis Harding" dubai when:2d', kind: "person" },
  ]);
});

test("buildQueries adds the time filter only when Settings has one", () => {
  const none = buildQueries(REG, ["betterhomes"], "");
  assert.deepEqual(none, [
    { query: "betterhomes", kind: "pr" },
    { query: "knight frank dubai", kind: "rival" },
    { query: "haus and haus dubai", kind: "rival" },
    { query: '"Simon Baker" dubai', kind: "person" },
    { query: '"Louis Harding" dubai', kind: "person" },
  ]);
  assert.ok(buildQueries(REG, ["betterhomes"], "7d").every((q) => q.query.endsWith(" when:7d")));
  // A keyword that sets its own filter keeps it rather than getting two.
  assert.equal(buildQueries(REG, ["dubai rents when:7d"], "2d")[1].query, "dubai rents when:7d");
});

test("buildQueries keeps a quote in a name from breaking the quoted phrase", () => {
  const reg = buildRegistry([], [person('Ali "The Broker" Khan', "betterhomes", true)]);
  assert.deepEqual(buildQueries(reg, [], ""), [
    { query: "betterhomes", kind: "pr" },
    { query: '"Ali The Broker Khan" dubai', kind: "person" },
  ]);
});

test("buildQueries searches our own name even when the PR keyword list is empty", () => {
  assert.deepEqual(buildQueries(buildRegistry([], []), [], "2d"), [{ query: "betterhomes when:2d", kind: "pr" }]);
});

test("headlineSkip rules out other companies whose names contain ours", () => {
  const gardens = "Better Homes & Gardens, another company";
  assert.equal(headlineSkip("Better Homes & Gardens names its colour of the year", null), gardens);
  assert.equal(headlineSkip("better homes and gardens real estate expands", "Inman"), gardens);
  assert.equal(headlineSkip("BetterHomes&Gardens kitchen ideas", null), gardens);
  assert.equal(headlineSkip("BETTER\u00a0HOMES  &  GARDENS picks", null), gardens);
  assert.equal(headlineSkip("Ten small kitchen ideas", "Better Homes and Gardens"), gardens);
  assert.equal(headlineSkip("BetterHome Group launches a fund", null), "BetterHome Group, another company");
  assert.equal(headlineSkip("Better Home Group results", null), "BetterHome Group, another company");
  assert.equal(headlineSkip("BHG Furniture opens in Dubai Hills Mall", null), "BHG, another company");
  assert.equal(headlineSkip("Paint trends for 2027", "bhg.com"), "BHG, another company");
  assert.equal(headlineSkip("BH&G Real Estate signs a new brokerage", null), "BHG, another company");
});

test("headlineSkip leaves ordinary headlines, and ones that name us, alone", () => {
  assert.equal(headlineSkip("Dubai rents rise 5% in the third quarter, says betterhomes", "Khaleej Times"), null);
  assert.equal(headlineSkip("Better Homes reports a record quarter", "Gulf News"), null);
  // BHG only as a whole word.
  assert.equal(headlineSkip("BHGX shares rise", null), null);
  // A skip is final, so a headline that also names us goes on to be read.
  assert.equal(headlineSkip("betterhomes and Better Homes & Gardens Real Estate sign a referral deal", null), null);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A one-result feed for a search, so each item says which search found it. */
function feedFor(q: string): string {
  const safe = q.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${safe} - Google News</title>` +
    `<item><title>Result for ${safe} - Zawya</title><link>https://news.google.com/rss/articles/${encodeURIComponent(q)}?oc=5</link>` +
    `<pubDate>Thu, 05 Nov 2026 05:00:00 GMT</pubDate><source url="https://www.zawya.com">Zawya</source></item></channel></rss>`
  );
}

/** A fetch that never leaves the machine: it records each request and answers from `answer`. */
function stubFetch(answer: (q: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; headers: Headers; signal: AbortSignal | null | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), signal: init?.signal });
    return answer(new URL(url).searchParams.get("q") ?? "", init);
  };
  return { fetchImpl, calls };
}

test("runSearches runs every search, reports the ones that fail, and keeps their order", async () => {
  let inFlight = 0;
  let most = 0;
  const { fetchImpl, calls } = stubFetch(async (q) => {
    inFlight++;
    most = Math.max(most, inFlight);
    // The first search answers last, so arrival order differs from query order.
    await sleep(q.startsWith("betterhomes") ? 30 : 5);
    inFlight--;
    if (q === "haus and haus dubai") return new Response("<html>Service Unavailable</html>", { status: 503 });
    if (q === "allsopp and allsopp dubai") {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND news.google.com") });
    }
    return new Response(feedFor(q), { status: 200, headers: { "content-type": "application/rss+xml" } });
  });
  const queries = [
    { query: "betterhomes when:2d", kind: "pr" },
    { query: "haus and haus dubai", kind: "rival" },
    { query: '"Louis Harding" dubai when:2d', kind: "person" },
    { query: "allsopp and allsopp dubai", kind: "rival" },
  ];
  const out = await runSearches(queries, { fetchImpl, concurrency: 2, edition: "hl=en-AE&gl=AE&ceid=AE:en" });

  assert.deepEqual(
    out.items.map((i) => [i.query, i.title, i.outlet]),
    [
      ["betterhomes when:2d", "Result for betterhomes when:2d", "Zawya"],
      ['"Louis Harding" dubai when:2d', 'Result for "Louis Harding" dubai when:2d', "Zawya"],
    ],
  );
  assert.deepEqual(out.failures, [
    { query: "haus and haus dubai", error: "HTTP 503" },
    { query: "allsopp and allsopp dubai", error: "fetch failed (getaddrinfo ENOTFOUND news.google.com)" },
  ]);
  assert.equal(calls.length, 4);
  assert.equal(most, 2);
  assert.ok(
    calls.some((c) => c.url === "https://news.google.com/rss/search?q=%22Louis%20Harding%22%20dubai%20when%3A2d&hl=en-AE&gl=AE&ceid=AE:en"),
  );
  for (const c of calls) {
    assert.match(c.headers.get("user-agent") ?? "", /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\).*Chrome\//);
    assert.ok(c.signal instanceof AbortSignal, "every request has a timeout");
  }
});

test("runSearches gives up on a search that hangs and still runs the rest", async () => {
  const { fetchImpl } = stubFetch((q, init) => {
    if (q !== "hangs") return new Response(feedFor(q));
    const signal = init?.signal;
    if (!signal) throw new Error("no timeout was set");
    return new Promise<Response>((resolve, reject) => {
      // Held open as a stuck server would hold it, until the request's own timeout ends it.
      const late = setTimeout(() => resolve(new Response(feedFor(q))), 5_000);
      signal.addEventListener("abort", () => {
        clearTimeout(late);
        reject(signal.reason);
      });
    });
  });
  const out = await runSearches(
    [
      { query: "hangs", kind: "pr" },
      { query: "answers", kind: "pr" },
    ],
    { fetchImpl, timeoutMs: 40 },
  );
  assert.deepEqual(out.failures, [{ query: "hangs", error: "timed out after 0.04 s" }]);
  assert.deepEqual(
    out.items.map((i) => i.query),
    ["answers"],
  );
});

test("runSearches reports a page that is not a feed instead of reading it as no results", async () => {
  const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>quiet - Google News</title></channel></rss>`;
  const { fetchImpl } = stubFetch((q) =>
    q === "consent" ? new Response("<!doctype html><html><body>Before you continue to Google</body></html>") : new Response(empty),
  );
  const out = await runSearches(
    [
      { query: "consent", kind: "pr" },
      { query: "quiet", kind: "pr" },
    ],
    { fetchImpl },
  );
  assert.deepEqual(out.failures, [{ query: "consent", error: "not a news feed" }]);
  assert.deepEqual(out.items, []);
});

test("runSearches starts no search once the time budget has passed", async () => {
  const { fetchImpl, calls } = stubFetch(async (q) => {
    await sleep(120);
    return new Response(feedFor(q));
  });
  const queries = ["one", "two", "three", "four"].map((query) => ({ query, kind: "pr" }));
  const out = await runSearches(queries, { fetchImpl, concurrency: 2, budgetMs: 60 });
  // The two started at once finish after the budget and keep their results; the others never start.
  assert.equal(calls.length, 2);
  assert.deepEqual(
    out.items.map((i) => i.query),
    ["one", "two"],
  );
  assert.deepEqual(out.failures, [
    { query: "three", error: "time budget" },
    { query: "four", error: "time budget" },
  ]);

  const spent = await runSearches(queries, { fetchImpl, budgetMs: 0 });
  assert.equal(calls.length, 2, "no request once the budget is spent");
  assert.deepEqual(
    spent.failures.map((f) => f.error),
    ["time budget", "time budget", "time budget", "time budget"],
  );
});

test("runSearches uses NEWS_EDITION, else the UAE edition, unless told otherwise", async () => {
  const saved = process.env.NEWS_EDITION;
  const { fetchImpl, calls } = stubFetch((q) => new Response(feedFor(q)));
  const one = [{ query: "betterhomes", kind: "pr" }];
  try {
    delete process.env.NEWS_EDITION;
    await runSearches(one, { fetchImpl });
    process.env.NEWS_EDITION = "hl=en-GB&gl=GB&ceid=GB:en";
    await runSearches(one, { fetchImpl });
    await runSearches(one, { fetchImpl, edition: "hl=en-US&gl=US&ceid=US:en" });
  } finally {
    if (saved === undefined) delete process.env.NEWS_EDITION;
    else process.env.NEWS_EDITION = saved;
  }
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "https://news.google.com/rss/search?q=betterhomes&hl=en-AE&gl=AE&ceid=AE:en",
      "https://news.google.com/rss/search?q=betterhomes&hl=en-GB&gl=GB&ceid=GB:en",
      "https://news.google.com/rss/search?q=betterhomes&hl=en-US&gl=US&ceid=US:en",
    ],
  );
});

test("runSearches with nothing to search makes no request", async () => {
  const { fetchImpl, calls } = stubFetch((q) => new Response(feedFor(q)));
  assert.deepEqual(await runSearches([], { fetchImpl }), { items: [], failures: [] });
  assert.equal(calls.length, 0);
});

test("headlineSkip catches Better Homes & Garden, singular, and a hidden mark between the words", () => {
  const gardens = "Better Homes & Gardens, another company";
  assert.equal(headlineSkip("Better Homes & Garden Heritage Holiday Enamel Acacia Bowl", "khorasantimes.com"), gardens);
  assert.equal(headlineSkip("ND Today: Business Highlight: Better Homes and Garden Real Estate", "KFYR-TV"), gardens);
  const lrm = String.fromCharCode(0x200e);
  assert.equal(headlineSkip(`Better Homes${lrm} & Gardens Quilt Sampler Magazines 2004/2005`, "khorasantimes.com"), gardens);
  // Our own name is never struck out with them.
  assert.equal(headlineSkip("Betterhomes reports record rental demand", "Khaleej Times"), null);
});
