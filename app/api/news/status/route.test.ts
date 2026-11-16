import { test } from "node:test";
import assert from "node:assert/strict";

// /api/news/status end to end, against a stand-in for Supabase's REST API:
// fetch is replaced, so the real supabase-js builds every request and nothing
// leaves the process. Then the proxy in front of it, which keeps it behind
// both PINs like PR & Media settings itself.
//
// Run this file on its own (node scripts/test.mjs app/api/news/status/route.test.ts):
// lib/supabase.ts reads the Supabase address once, when it first loads, so the
// address must be set here before anything imports it.

/** One request the route made, as the stand-in saw it. */
type Asked = { method: string; table: string; params: URLSearchParams };

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

/** news_runs, the queue's counts and news_articles, answered from memory, each read failing on demand. */
class FakeRest {
  asked: Asked[] = [];
  runs: unknown[] = [];
  articles: unknown[] = [];
  queue: Record<string, number> = {};
  failing = new Set<string>();

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "supabase.test") throw new Error(`a test tried to reach ${url.host}`);
    const method = (init.method ?? "GET").toUpperCase();
    const table = url.pathname.replace("/rest/v1/", "");
    this.asked.push({ method, table, params: url.searchParams });
    if (this.failing.has(table)) return json({ message: "upstream unavailable" }, 503);
    if (method === "HEAD" && table === "news_articles") {
      const status = (url.searchParams.get("status") ?? "").replace(/^eq\./, "");
      return new Response(null, { status: 200, headers: { "content-range": `*/${this.queue[status] ?? 0}` } });
    }
    if (table === "news_runs") return json(this.runs);
    if (table === "news_articles") return json(this.articles);
    throw new Error(`the stand-in does not know ${method} ${table}`);
  };
}

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-tests";
process.env.CRON_SECRET = "cron-secret-for-tests";
const rest = new FakeRest();
globalThis.fetch = rest.fetch as typeof fetch;

// Loaded only now, after the address and the stand-in are in place.
const loading = (async () => ({
  route: await import("@/app/api/news/status/route"),
  proxy: await import("@/proxy"),
  gate: await import("@/lib/gate"),
  store: await import("@/lib/news/store"),
  server: await import("next/server"),
}))();

/** A time `seconds` ago. */
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

/** A morning's run as its news_runs rows read while its read works: a search, then a read still going. */
function morningUnderWay() {
  rest.runs = [
    {
      run_id: "nr_test",
      step: "read",
      link: 1,
      trigger: "cron",
      started_at: ago(160),
      finished_at: null,
      ok: null,
      counts: { read: 0, noNames: 5, unreadable: 1, duplicates: 0, apifyReads: 5 },
      error: null,
    },
    {
      run_id: "nr_test",
      step: "search",
      link: 0,
      trigger: "cron",
      started_at: ago(180),
      finished_at: ago(165),
      ok: true,
      counts: { found: 109, fresh: 59, queries: 77, repeats: 45, skipped: 5, requeued: 32, queryFailures: 0 },
      error: null,
    },
  ];
  rest.articles = [
    {
      id: "na_1",
      title: "Dubai rents rise again",
      outlet: "Gulf News",
      published_on: "2026-11-16",
      first_seen_at: ago(170),
      url: "https://gulfnews.com/a",
      google_link: null,
      status: "no_names",
      decision: null,
      legacy_mention_id: null,
      note: "read in full (2,880 characters, read through Apify), and it names no tracked company or person",
      error: null,
      read_attempts: 2,
      read_via: "apify",
      body_status: "ok",
      updated_at: ago(60),
    },
  ];
  rest.queue = { queued: 98, reading: 0, read: 0, checking: 0, held: 0, unreadable: 202, failed: 0 };
  rest.failing.clear();
  rest.asked = [];
}

test("this file runs on its own, with the stand-in as the database", async () => {
  const { route } = await loading;
  assert.equal(typeof route.GET, "function");
  assert.equal(route.dynamic, "force-dynamic");
  assert.ok(route.maxDuration <= 30, "a short limit: it only reads");
});

test("the route answers 200 with this morning's run, the queue, the progress bar and the log, never cached", async () => {
  const { route, store } = await loading;
  morningUnderWay();
  const res = await route.GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as Record<string, any>;
  assert.deepEqual(Object.keys(body).sort(), ["at", "log", "progress", "queue", "run"]);
  assert.ok(Math.abs(Date.parse(body.at) - Date.now()) < 60_000);
  assert.equal(body.run.steps, 2);
  assert.equal(body.run.running, true);
  assert.deepEqual([body.run.latest.step, body.run.latest.link, body.run.latest.working], ["read", 1, true]);
  assert.equal(body.queue.queued, 98);
  assert.deepEqual(body.progress, { label: "Reading articles: 6 of 104", share: 6 / 104, state: "working" });
  assert.deepEqual(
    body.log.map((l: { text: string }) => l.text),
    [
      "Reading now: 6 done so far…",
      "Names nobody we track (read by Apify) · Gulf News",
      "Read started (round 2)",
      "Search finished: 109 found, 59 new, 32 put back to try again",
      "Search started: 77 searches",
    ],
  );
  assert.equal(body.log[1].link, "https://gulfnews.com/a");

  // Read as the card reads it: this deployment's rows of today in Dubai, and the articles its steps changed.
  const runs = rest.asked.find((a) => a.table === "news_runs");
  assert.equal(runs?.params.get("run_day"), `eq.${store.dubaiDay()}`);
  assert.equal(runs?.params.get("or"), `(${store.runEnvFilter(store.runEnv())})`);
  assert.equal(runs?.params.get("select"), "run_id,step,link,trigger,started_at,finished_at,ok,counts,error");
  const counts = rest.asked.filter((a) => a.method === "HEAD").map((a) => a.params.get("status"));
  assert.deepEqual(counts, ["eq.queued", "eq.reading", "eq.read", "eq.checking", "eq.held", "eq.unreadable", "eq.failed"]);
  const articles = rest.asked.find((a) => a.table === "news_articles" && a.method === "GET");
  assert.match(articles?.params.get("or") ?? "", /^\(and\(updated_at\.gte\.[^,]+,updated_at\.lte\.[^)]+\)\)$/);
  assert.equal(articles?.params.get("order"), "updated_at.desc,id.asc");
  assert.equal(articles?.params.get("limit"), "100");
});

test("one read that fails blanks only its own part of the answer", async () => {
  const { route } = await loading;
  morningUnderWay();
  rest.failing.add("news_runs");
  const body = (await (await route.GET()).json()) as Record<string, unknown>;
  assert.deepEqual([body.run, body.progress, body.log], [null, null, null]);
  assert.equal((body.queue as { queued: number }).queued, 98);

  morningUnderWay();
  rest.failing.add("news_articles");
  const noArticles = (await (await route.GET()).json()) as Record<string, any>;
  assert.equal(noArticles.queue, null);
  assert.equal(noArticles.log, null);
  assert.equal(noArticles.run.steps, 2);
  // The queue unknown: the bar says what is done so far.
  assert.deepEqual(noArticles.progress, { label: "Reading articles: 6 so far", share: null, state: "working" });
});

test("the route is behind both PINs: a locked request gets the proxy's 401, and /api/news's own way through is no wider", async () => {
  const { proxy, gate, server } = await loading;
  const request = (path: string, cookies: string[] = []) =>
    new server.NextRequest(`https://dash.example${path}`, cookies.length ? { headers: { cookie: cookies.join("; ") } } : {});
  const app = `${gate.COOKIES.app}=${await gate.issueToken("app")}`;
  const settings = `${gate.COOKIES.settings}=${await gate.issueToken("settings")}`;
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  const none = await proxy.proxy(request("/api/news/status"));
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: "locked", scope: "app" });
  // The app PIN alone is not enough: this is what PR & Media settings shows.
  const appOnly = await proxy.proxy(request("/api/news/status", [app]));
  assert.equal(appOnly.status, 401);
  assert.deepEqual(await appOnly.json(), { error: "locked", scope: "settings" });
  assert.equal(passes(await proxy.proxy(request("/api/news/status", [app, settings]))), true);

  // /api/news checks the cron's secret or both cookies itself, so the proxy lets it through, as before; nothing
  // else under it is let through that way.
  assert.equal(passes(await proxy.proxy(request("/api/news"))), true);
  const other = await proxy.proxy(request("/api/news/anything"));
  assert.equal(other.status, 401);
});
