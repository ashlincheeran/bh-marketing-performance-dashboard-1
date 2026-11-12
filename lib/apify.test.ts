import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { apifyAccount, askOnce, fetchArticleBody, hasResidential } from "@/lib/apify";

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

/** users/me for a plan, as Apify answers it: the free plan's groups, or a paid plan's with residential addresses. */
const account = (residential: number) =>
  new Response(
    JSON.stringify({
      data: {
        username: "test-user",
        plan: { id: residential ? "STARTER" : "FREE" },
        proxy: { groups: [{ name: "BUYPROXIES94952", availableCount: 5 }, { name: "RESIDENTIAL", availableCount: residential }] },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/**
 * How often the crawl's own question about residential addresses (users/me) reached the stand-in. It is asked
 * once per process at most, and answered with the free plan's groups, so the crawls here that don't say
 * otherwise go without residential addresses, as on the free plan.
 */
let accountAsks = 0;

/** Stands in for fetch, and sets a token, while `run` goes: every crawl is answered by `answer` and remembered. */
async function withApify<T>(answer: (call: Call) => Response | Promise<Response>, run: (calls: Call[]) => Promise<T>): Promise<T> {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.APIFY_TOKEN;
  process.env.APIFY_TOKEN = "test-token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.apify.com") assert.fail(`only Apify may be asked, not ${url.hostname}`);
    if (url.pathname === "/v2/users/me") {
      accountAsks++;
      return account(0);
    }
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
      // No run ever started, which says nothing of the page.
      assert.equal(body.status, "refused");
      assert.match(body.note ?? "", /memory-limit-exceeded/);
      assert.ok(Date.now() < 60_000);
    });
  } finally {
    mock.timers.reset();
  }
});

test("a crawl Apify turns down before it starts is refused, never a read: a wrong token, the allowance used up, its own fault", async () => {
  const refusal = (status: number, type: string, message: string) => () =>
    new Response(JSON.stringify({ error: { type, message } }), { status, headers: { "content-type": "application/json" } });
  const answers: [string, () => Response | Promise<Response>][] = [
    ["a wrong token", refusal(401, "token-not-valid", "Authentication token is not valid.")],
    ["a token that may not run the actor", refusal(403, "insufficient-permissions", "You do not have permission to run this actor.")],
    ["the plan's allowance used up", refusal(402, "not-enough-usage-to-run-paid-actor", "You have reached your monthly usage limit.")],
    ["too many requests", refusal(429, "rate-limit-exceeded", "You have exceeded the rate limit.")],
    ["Apify's own fault", refusal(500, "internal-server-error", "Internal server error.")],
  ];
  for (const [why, answer] of answers) {
    await withApify(answer, async (calls) => {
      const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => false });
      // Each attempt is turned down at once, so both are asked for, and neither crawled anything.
      assert.deepEqual(calls.map(attemptOf), ["cheerio", "playwright:firefox"], why);
      assert.equal(body.status, "refused", why);
      assert.match(body.note ?? "", /HTTP \d{3} .+\[cheerio\]; HTTP \d{3} .+\[firefox\]/, why);
    });
  }
  // No answer at all, before the request reached a run.
  await withApify(
    () => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.apify.com") })),
    async () => {
      const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => false });
      assert.equal(body.status, "refused");
    },
  );
  // A run that went on past the wait did run, and Apify has had its go.
  await withApify(refusal(408, "run-timeout-exceeded", "Actor run exceeded the timeout of 300 seconds for this API endpoint"), async () => {
    const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => false });
    assert.equal(body.status, "http_error");
  });
  // So did a crawl that read a bot check before the next was turned down.
  await withApify(
    (call) => (attemptOf(call) === "cheerio" ? storyFor()(call) : refusal(402, "not-enough-usage-to-run-paid-actor", "You have reached your monthly usage limit.")()),
    async () => {
      const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => false });
      assert.equal(body.status, "thin");
      assert.equal(body.text, BOT_CHECK);
    },
  );
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

// ── Residential addresses, and bot checks ──────────────────────────────────

/** What a crawl asked for: its crawler, and "+residential" when it asked for a residential address. */
const attemptOf = (call: Call): string => {
  const proxy = call.input.proxyConfiguration as { apifyProxyGroups?: string[] } | undefined;
  return `${call.input.crawlerType}${proxy?.apifyProxyGroups?.includes("RESIDENTIAL") ? "+residential" : ""}`;
};

/** AWS WAF's CAPTCHA as a crawler's text holds it: what Arabian Business showed a browser on the shared proxy (12 Nov 2026). */
const BOT_CHECK = [
  "Let's confirm you are human",
  "Complete the security check before continuing. This step verifies that you are not a bot, which helps to protect your account and prevent spam.",
  "Begin",
].join("\n");

/** The story for the attempts named, and the bot check for any other. */
const storyFor = (...attempts: string[]) => (call: Call) => items([{ url: ARTICLE, text: attempts.includes(attemptOf(call)) ? STORY : BOT_CHECK }]);

test("the plan is read from users/me: its proxy groups, and whether residential addresses can be used", async () => {
  const asked: string[] = [];
  const answering = (res: () => Response) =>
    (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return res();
    }) as typeof fetch;
  const free = await apifyAccount({ token: "test-token", fetchImpl: answering(() => account(0)) });
  assert.equal(asked[0], "https://api.apify.com/v2/users/me?token=test-token");
  assert.ok(free.ok);
  assert.deepEqual(free.proxyGroups, [
    { name: "BUYPROXIES94952", availableCount: 5 },
    { name: "RESIDENTIAL", availableCount: 0 },
  ]);
  assert.equal(free.data.username, "test-user");
  // Listed is not enough: the group needs addresses available.
  assert.equal(hasResidential(free.proxyGroups), false);
  const paid = await apifyAccount({ token: "test-token", fetchImpl: answering(() => account(100)) });
  assert.ok(paid.ok);
  assert.equal(hasResidential(paid.proxyGroups), true);
  assert.equal(hasResidential([]), false);

  // Anything else is said, never thrown.
  assert.deepEqual(await apifyAccount({ token: "" }), { ok: false, error: "APIFY_TOKEN is not set" });
  const refusal = '{"error":{"type":"token-not-valid"}}';
  assert.deepEqual(await apifyAccount({ token: "test-token", fetchImpl: answering(() => new Response(refusal, { status: 401 })) }), {
    ok: false,
    error: "HTTP 401",
    status: 401,
    body: refusal,
  });
  assert.deepEqual(await apifyAccount({ token: "test-token", fetchImpl: answering(() => new Response("<html>busy</html>")) }), {
    ok: false,
    error: "the answer was not JSON",
    status: 200,
    body: "<html>busy</html>",
  });
  const down = (async () => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.apify.com") });
  }) as typeof fetch;
  assert.deepEqual(await apifyAccount({ token: "test-token", fetchImpl: down }), {
    ok: false,
    error: "fetch failed (getaddrinfo ENOTFOUND api.apify.com)",
  });
  const silent = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
  assert.deepEqual(await apifyAccount({ token: "test-token", timeoutMs: 20, fetchImpl: silent }), {
    ok: false,
    error: "Apify did not answer in time",
  });
});

test("the plan is asked about once, and a question that fails is no", async () => {
  let asks = 0;
  const yes = askOnce(async () => {
    asks++;
    return true;
  });
  assert.deepEqual(await Promise.all([yes(), yes()]), [true, true]);
  assert.equal(await yes(), true);
  assert.equal(asks, 1);
  let fails = 0;
  const broken = askOnce(async () => {
    fails++;
    throw new Error("users/me timed out");
  });
  assert.equal(await broken(), false);
  assert.equal(await broken(), false);
  assert.equal(fails, 1);
});

test("with residential addresses on the plan, a bot check moves the crawl on: cheerio, cheerio through a residential address, then a browser through one", async () => {
  await withApify(storyFor("playwright:firefox+residential"), async (calls) => {
    const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => true });
    assert.deepEqual(calls.map(attemptOf), ["cheerio", "cheerio+residential", "playwright:firefox+residential"]);
    assert.equal(body.status, "ok");
    assert.equal(body.text, STORY);
    assert.equal(body.via, "firefox+residential");
    // The shared proxy names no group; a residential attempt names that group alone.
    assert.deepEqual(calls[0].input.proxyConfiguration, { useApifyProxy: true });
    assert.deepEqual(calls[1].input.proxyConfiguration, { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] });
    assert.deepEqual(calls[2].input.proxyConfiguration, { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] });
  });

  // A site that only turns away datacentre addresses is read by the cheap crawler through a residential one: no browser.
  await withApify(storyFor("cheerio+residential"), async (calls) => {
    const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => true });
    assert.deepEqual(calls.map(attemptOf), ["cheerio", "cheerio+residential"]);
    assert.equal(body.via, "cheerio+residential");
  });

  // Residential attempts that fail outright leave the browser on the shared proxy, last.
  const noResidential = () =>
    new Response(JSON.stringify({ error: { type: "run-failed", message: "Proxy group RESIDENTIAL is not available" } }), { status: 400 });
  await withApify(
    (call) => (attemptOf(call).endsWith("+residential") ? noResidential() : storyFor("playwright:firefox")(call)),
    async (calls) => {
      const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => true });
      assert.deepEqual(calls.map(attemptOf), ["cheerio", "cheerio+residential", "playwright:firefox+residential", "playwright:firefox"]);
      assert.equal(body.status, "ok");
      assert.equal(body.via, "firefox");
    },
  );
});

test("without residential addresses, as on the free plan, a bot check moves the crawl on to a browser on the shared proxy", async () => {
  let asked = 0;
  await withApify(storyFor("playwright:firefox"), async (calls) => {
    const body = await fetchArticleBody(ARTICLE, {
      deadline: Date.now() + 150_000,
      residential: async () => {
        asked++;
        return false;
      },
    });
    assert.deepEqual(calls.map(attemptOf), ["cheerio", "playwright:firefox"]);
    assert.equal(body.status, "ok");
    assert.equal(body.via, "firefox");
    // Asked once, when a residential attempt was next.
    assert.equal(asked, 1);
  });

  // A page the cheap crawler reads never needs the question.
  await withApify(storyFor("cheerio"), async (calls) => {
    const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => assert.fail("no residential attempt was next") });
    assert.deepEqual(calls.map(attemptOf), ["cheerio"]);
    assert.equal(body.status, "ok");
  });
});

test("a residential check that fails is no residential address, never a failed read", async () => {
  await withApify(storyFor("playwright:firefox"), async (calls) => {
    const body = await fetchArticleBody(ARTICLE, {
      deadline: Date.now() + 150_000,
      residential: async () => {
        throw new Error("users/me timed out");
      },
    });
    assert.deepEqual(calls.map(attemptOf), ["cheerio", "playwright:firefox"]);
    assert.equal(body.status, "ok");
    assert.equal(body.text, STORY);
  });
});

test("a page that is a bot check on every attempt comes back as the bot check, for the caller to say so", async () => {
  await withApify(storyFor(), async (calls) => {
    const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => false });
    assert.deepEqual(calls.map(attemptOf), ["cheerio", "playwright:firefox"]);
    assert.equal(body.status, "thin");
    assert.equal(body.text, BOT_CHECK);
    assert.equal(body.via, "firefox");
  });
});

test("a bot check that stops the browser on a residential address ends the crawl: the shared proxy's browser would meet it too", async () => {
  await withApify(storyFor(), async (calls) => {
    const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => true });
    // Three runs, not four: no browser on the shared proxy after the residential one met the check.
    assert.deepEqual(calls.map(attemptOf), ["cheerio", "cheerio+residential", "playwright:firefox+residential"]);
    assert.equal(body.status, "thin");
    assert.equal(body.text, BOT_CHECK);
    assert.equal(body.via, "firefox+residential");
  });
  // A residential browser that read nothing failed outright, so the shared proxy's browser still has its turn.
  await withApify(
    (call) => (attemptOf(call) === "playwright:firefox+residential" ? items([]) : storyFor("playwright:firefox")(call)),
    async (calls) => {
      const body = await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000, residential: async () => true });
      assert.deepEqual(calls.map(attemptOf), ["cheerio", "cheerio+residential", "playwright:firefox+residential", "playwright:firefox"]);
      assert.equal(body.status, "ok");
      assert.equal(body.via, "firefox");
    },
  );
});

test("a Google link only a browser can follow tries the shared proxy first, then a residential address", async () => {
  await withApify(
    (call) => items([{ url: GOOGLE, crawl: { loadedUrl: ARTICLE }, text: attemptOf(call) === "playwright:firefox+residential" ? STORY : BOT_CHECK }]),
    async (calls) => {
      const body = await fetchArticleBody(GOOGLE, {
        deadline: Date.now() + 150_000,
        resolved: { url: null, status: "unresolved", note: "rate-limited" },
        residential: async () => true,
      });
      assert.deepEqual(calls.map(attemptOf), ["playwright:firefox", "playwright:firefox+residential"]);
      assert.equal(body.status, "ok");
      assert.equal(body.resolveStatus, "browser");
      assert.equal(body.resolvedUrl, ARTICLE);
    },
  );
});

test("the crawl's own question goes to users/me no more than once per process, and the free plan's answer keeps it on the shared proxy", async () => {
  await withApify(storyFor("playwright:firefox"), async (calls) => {
    for (let i = 0; i < 2; i++) assert.equal((await fetchArticleBody(ARTICLE, { deadline: Date.now() + 150_000 })).via, "firefox");
    assert.deepEqual(calls.map(attemptOf), ["cheerio", "playwright:firefox", "cheerio", "playwright:firefox"]);
    assert.ok(accountAsks <= 1, `users/me asked ${accountAsks} times`);
  });
});
