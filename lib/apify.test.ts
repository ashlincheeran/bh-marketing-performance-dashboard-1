import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { fetchArticleBody } from "@/lib/apify";

// Nothing here reaches Apify or Google. fetch is a stand-in in every test and refuses any other host,
// and where time matters the clock is mocked, so a deadline minutes away passes in no time.

const ARTICLE = "https://www.gulfpaper.example/property/prices-rise";
const GOOGLE = "https://news.google.com/rss/articles/CBMiTestOnlyNotARealLink?oc=5";
const STORY = [
  "Prime property prices in Dubai rose by five per cent in the third quarter, according to new figures.",
  "Louis Harding, chief executive of Knight Frank Middle East, said overseas buyers were driving demand.",
  "Agents at betterhomes reported more enquiries from families moving to the emirate from London this year.",
  "Analysts expect growth to slow next year as thousands of new homes are handed over across the city.",
  "Rents in established communities such as Arabian Ranches and Jumeirah Park also climbed in the period.",
].join("\n");

interface Call {
  /** The clock when the request was made. */
  at: number;
  url: URL;
  input: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

const items = (list: unknown[]) => new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });

/** Stands in for fetch, and sets a token, while `run` goes: every request is answered by `answer` and remembered. */
async function withApify<T>(answer: (call: Call) => Response | Promise<Response>, run: (calls: Call[]) => Promise<T>): Promise<T> {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.APIFY_TOKEN;
  process.env.APIFY_TOKEN = "test-token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.apify.com") assert.fail(`only Apify may be asked, not ${url.hostname}`);
    const call: Call = { at: Date.now(), url, input: JSON.parse(String(init?.body ?? "{}")), signal: init?.signal ?? undefined };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = realToken;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

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

/** Apify's answer when every gigabyte of the account is in use. */
const memoryFull = () =>
  new Response(JSON.stringify({ error: { type: "memory-limit-exceeded", message: "By launching this job you will exceed the memory limit" } }), { status: 402 });

test("without APIFY_TOKEN nothing is sent", async () => {
  const realToken = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  try {
    assert.equal((await fetchArticleBody(ARTICLE)).status, "no_token");
  } finally {
    if (realToken !== undefined) process.env.APIFY_TOKEN = realToken;
  }
});

test("each run is told to end inside the deadline, and where the crawler landed comes back beside the address asked for", async () => {
  const landed = "https://consent.gulfpaper.example/collect?return=%2Fproperty%2Fprices-rise";
  await withApify(
    () => items([{ url: ARTICLE, crawl: { loadedUrl: landed }, metadata: { title: "Prices rise | Gulf Paper" }, text: STORY }]),
    async (calls) => {
      const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 100_000 });
      assert.equal(body.status, "ok");
      // The address stays the one the article is stored under; the landing is for the caller to check.
      assert.equal(body.resolvedUrl, ARTICLE);
      assert.equal(body.landedUrl, landed);
      assert.equal(body.title, "Prices rise | Gulf Paper");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url.searchParams.get("timeout"), "45");
      assert.ok(calls[0].signal instanceof AbortSignal);
    },
  );
});

test("a crawl that could not finish before the deadline is not started, and with no time at all nothing is sent", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    // 50 seconds: the quick crawler is told to end in 40, and the browser, which needs 45, is never started.
    await withApify(
      () => items([]),
      async (calls) => {
        const body = await fetchArticleBody(ARTICLE, { deadline: 50_000 });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].input.crawlerType, "cheerio");
        assert.equal(calls[0].url.searchParams.get("timeout"), "40");
        assert.equal(body.status, "http_error");
        assert.match(body.note ?? "", /too little time was left for the firefox crawl/);
      },
    );
    // 20 seconds: not even the quick crawler could finish, so nothing reaches Apify, and nothing is to be counted.
    await withApify(
      () => assert.fail("nothing should be sent"),
      async (calls) => {
        const body = await fetchArticleBody(ARTICLE, { deadline: 20_000 });
        assert.equal(body.status, "no_time");
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    mock.timers.reset();
  }
});

test("a memory 402 is waited out only while the wait leaves the crawl its time", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    await withApify(memoryFull, async (calls) => {
      const body = await onTheClock(fetchArticleBody(ARTICLE, { deadline: 60_000 }));
      // At once, then after waits of 6 and 18 seconds. A third wait, of 45, would leave too little of the
      // minute, so it is not made, and the browser has too little time to start.
      assert.deepEqual(
        calls.map((c) => c.at),
        [0, 6_000, 24_000],
      );
      assert.ok(calls.every((c) => Number(c.url.searchParams.get("timeout")) * 1_000 <= 60_000 - c.at - 10_000));
      assert.equal(body.status, "http_error");
      assert.match(body.note ?? "", /memory-limit-exceeded/);
      assert.ok(Date.now() < 60_000);
    });
  } finally {
    mock.timers.reset();
  }
});

test("a request Apify never answers is given up at the deadline, and was sent, so it counts", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const hang = (call: Call) =>
      new Promise<Response>((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason)));
    await withApify(hang, async (calls) => {
      const body = await onTheClock(fetchArticleBody(ARTICLE, { deadline: 60_000 }));
      assert.equal(calls.length, 1);
      assert.equal(body.status, "http_error");
      assert.match(body.note ?? "", /did not answer in the time left/);
      assert.ok(Date.now() <= 60_000, `gave up at ${Date.now()} ms`);
    });
  } finally {
    mock.timers.reset();
  }
});

test("every caller shares three crawls at a time, so the read step's lanes can't ask for 16 GB at once", async () => {
  const waiting: (() => void)[] = [];
  let running = 0;
  let most = 0;
  const answer = () =>
    new Promise<Response>((resolve) => {
      running++;
      most = Math.max(most, running);
      waiting.push(() => {
        running--;
        resolve(items([{ url: ARTICLE, text: STORY }]));
      });
    });
  await withApify(answer, async (calls) => {
    const reads = Array.from({ length: 5 }, () => fetchArticleBody(ARTICLE, { deadline: Date.now() + 100_000 }));
    await flush();
    assert.equal(calls.length, 3);
    for (let released = 0; released < 5; released++) {
      for (let i = 0; i < 20 && !waiting.length; i++) await flush();
      waiting.shift()!();
    }
    const bodies = await Promise.all(reads);
    assert.deepEqual(
      bodies.map((b) => b.status),
      ["ok", "ok", "ok", "ok", "ok"],
    );
    assert.equal(calls.length, 5);
    assert.equal(most, 3);
  });
});

test("a crawl that no slot frees up for in time is given up without sending anything", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const waiting: (() => void)[] = [];
  try {
    await withApify(
      () => new Promise<Response>((resolve) => waiting.push(() => resolve(items([{ url: ARTICLE, text: STORY }])))),
      async (calls) => {
        const busy = Array.from({ length: 3 }, () => fetchArticleBody(ARTICLE, { deadline: 300_000 }));
        await flush();
        assert.equal(calls.length, 3);
        // Half a minute away, so it waits five seconds for a slot at most: the quick crawl needs the rest.
        const body = await onTheClock(fetchArticleBody(ARTICLE, { deadline: 30_000 }));
        assert.equal(body.status, "no_time");
        assert.match(body.note ?? "", /no Apify crawl came free in time/);
        assert.equal(calls.length, 3);
        assert.ok(Date.now() <= 5_000);
        for (const release of waiting.splice(0)) release();
        await Promise.all(busy);
      },
    );
  } finally {
    for (const release of waiting.splice(0)) release();
    mock.timers.reset();
  }
});

test("a Google link the caller already tried to unwrap goes straight to the browser, and Google is not asked again", async () => {
  await withApify(
    () => items([{ url: GOOGLE, crawl: { loadedUrl: ARTICLE }, text: STORY }]),
    async (calls) => {
      const body = await fetchArticleBody(GOOGLE, { deadline: Date.now() + 140_000, resolved: { url: null, status: "unresolved", note: "rate-limited" } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].input.crawlerType, "playwright:firefox");
      assert.equal(body.status, "ok");
      assert.equal(body.resolveStatus, "browser");
      assert.equal(body.resolvedUrl, ARTICLE);
      assert.equal(body.landedUrl, ARTICLE);
    },
  );
});
