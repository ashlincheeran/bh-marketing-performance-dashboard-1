import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { COOKIES, MAX_AGE, PINS, canSignCookies, cronOrBothPins, hasGateCookie, issueToken, tokenValid, type Scope } from "@/lib/gate";
import { proxy } from "@/proxy";
import * as unlockRoute from "@/app/api/unlock/route";
import * as newsRoute from "@/app/api/news/route";
import * as reportRoute from "@/app/api/report/route";
import * as probeActorsRoute from "@/app/api/pr/probe-actors/route";
import * as perfProbeRoute from "@/app/api/perf/probe/route";
import * as ingestRoute from "@/app/api/ingest/route";

// The PIN gate's cookies, and every place that checks them: proxy.ts, the
// routes that check their own callers, and /api/unlock, which issues them.
//
// Nothing here reaches the network or a database: fetch is replaced while a
// route runs, the service-role key is removed so no Supabase client is built,
// and the one test that lets the LinkedIn probe run answers its Apify calls
// here.

type Env = Record<string, string | undefined>;

const CRON = "cron-secret-for-tests";
const NOW = Date.parse("2026-11-05T10:00:00Z");
const HOUR = 3600_000;

/** Run `fn` with these environment variables (undefined removes one), then put them back. */
async function withEnv<T>(vars: Env, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Env;
  const saved: Env = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = env[k];
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

/** The settings most tests run under: a known key, no database, not production. */
const testEnv = (more: Env = {}): Env => ({
  CRON_SECRET: CRON,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  APIFY_TOKEN: undefined,
  NODE_ENV: undefined,
  ...more,
});

/** Run `fn` with fetch answered by `answer`, which by default refuses everything. */
async function withFetch<T>(fn: () => Promise<T>, answer?: (url: string, init?: RequestInit) => Promise<Response>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!answer) throw new Error(`a test tried to reach ${url}`);
    return answer(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** A Cookie header holding these gate cookies. */
const cookieHeader = (tokens: Partial<Record<Scope, string>>) =>
  (Object.entries(tokens) as [Scope, string][]).map(([scope, token]) => `${COOKIES[scope]}=${token}`).join("; ");

const request = (path: string, opts: { method?: string; cookies?: Partial<Record<Scope, string>>; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://dash.example${path}`, {
    method: opts.method ?? "GET",
    headers: { ...(opts.cookies ? { cookie: cookieHeader(opts.cookies) } : {}), ...opts.headers },
  });

/** Both cookies, the app one issued `appAgo` and the settings one `settingsAgo` milliseconds ago. */
async function bothCookies(appAgo = 0, settingsAgo = 0) {
  return { app: await issueToken("app", Date.now() - appAgo), settings: await issueToken("settings", Date.now() - settingsAgo) };
}

const passesProxy = (res: Response) => res.headers.get("x-middleware-next") === "1";

test("a cookie is the time it was issued and an HMAC of the scope, its PIN and that time", async () => {
  await withEnv(testEnv(), async () => {
    for (const scope of ["app", "settings"] as const) {
      const token = await issueToken(scope, NOW);
      const issued = String(Math.floor(NOW / 1000));
      const mac = createHmac("sha256", CRON).update(`${scope}|${PINS[scope]}|${issued}`).digest("hex");
      assert.equal(token, `${issued}.${mac}`);
      assert.equal(await tokenValid(scope, token, NOW), true);
    }
  });
});

test("an app cookie lasts 12 hours and a settings cookie 1 hour, whatever the browser does", async () => {
  assert.deepEqual(MAX_AGE, { app: 12 * 3600, settings: 3600 });
  await withEnv(testEnv(), async () => {
    const app = await issueToken("app", NOW);
    assert.equal(await tokenValid("app", app, NOW + 12 * HOUR), true);
    assert.equal(await tokenValid("app", app, NOW + 12 * HOUR + 1000), false);

    const settings = await issueToken("settings", NOW);
    assert.equal(await tokenValid("settings", settings, NOW + HOUR), true);
    assert.equal(await tokenValid("settings", settings, NOW + HOUR + 1000), false);
    // The copied cookie from the review, sent a year later.
    assert.equal(await tokenValid("settings", settings, NOW + 365 * 24 * HOUR), false);
  });
});

test("a cookie dated more than a minute ahead is refused, half a minute ahead is not", async () => {
  await withEnv(testEnv(), async () => {
    assert.equal(await tokenValid("app", await issueToken("app", NOW + 30_000), NOW), true);
    assert.equal(await tokenValid("app", await issueToken("app", NOW + 61_000), NOW), false);
    // Signed far ahead, so it would otherwise last for years.
    assert.equal(await tokenValid("settings", await issueToken("settings", NOW + 400 * 24 * HOUR), NOW), false);
  });
});

test("a cookie changed in any way is refused", async () => {
  await withEnv(testEnv(), async () => {
    const token = await issueToken("settings", NOW);
    const [issued, mac] = token.split(".");
    const flipped = `${issued}.${mac.slice(0, -1)}${mac.endsWith("0") ? "1" : "0"}`;
    assert.equal(await tokenValid("settings", flipped, NOW), false, "one digit of the signature changed");
    // An expired cookie moved forward to look newly issued, keeping its signature.
    const later = NOW + 2 * HOUR;
    assert.equal(await tokenValid("settings", token, later), false, "expired as it is");
    assert.equal(await tokenValid("settings", `${Math.floor(later / 1000)}.${mac}`, later), false, "and re-dated");
    assert.equal(await tokenValid("settings", `0${token}`, NOW), false, "the same time written another way");
    assert.equal(await tokenValid("settings", token.toUpperCase(), NOW), false);
    assert.equal(await tokenValid("settings", `${token}.x`, NOW), false);
    for (const junk of ["", "x", ".", `${issued}.`, `.${mac}`, mac, null, undefined]) {
      assert.equal(await tokenValid("settings", junk, NOW), false, `refused: ${String(junk)}`);
    }
  });
});

test("the old cookies, a fixed digest with no time in it, no longer open anything", async () => {
  await withEnv(testEnv(), async () => {
    for (const scope of ["app", "settings"] as const) {
      const old = createHash("sha256").update(`${scope}|${PINS[scope]}|${CRON}`).digest("hex");
      assert.equal(await tokenValid(scope, old, NOW), false);
    }
  });
});

test("an app cookie does not open settings, nor a settings cookie the app", async () => {
  await withEnv(testEnv(), async () => {
    assert.equal(await tokenValid("settings", await issueToken("app", NOW), NOW), false);
    assert.equal(await tokenValid("app", await issueToken("settings", NOW), NOW), false);
  });
});

test("a cookie stops working when the key or its PIN changes", async () => {
  const token = await withEnv(testEnv(), () => issueToken("app", NOW));
  await withEnv(testEnv({ CRON_SECRET: "another-secret" }), async () => {
    assert.equal(await tokenValid("app", token, NOW), false);
  });
  const pin = PINS.app;
  PINS.app = `${pin}9`;
  try {
    await withEnv(testEnv(), async () => assert.equal(await tokenValid("app", token, NOW), false));
  } finally {
    PINS.app = pin;
  }
  await withEnv(testEnv(), async () => assert.equal(await tokenValid("app", token, NOW), true));
});

test("the key is CRON_SECRET, and a fixed key only outside production", async () => {
  const issued = String(Math.floor(NOW / 1000));
  const signedWith = (key: string) => `${issued}.${createHmac("sha256", key).update(`app|${PINS.app}|${issued}`).digest("hex")}`;

  await withEnv(testEnv(), async () => {
    assert.equal(await issueToken("app", NOW), signedWith(CRON));
    assert.equal(await tokenValid("app", signedWith(CRON), NOW), true);
  });

  const none = { CRON_SECRET: undefined };
  const devToken = await withEnv(testEnv({ ...none, NODE_ENV: "development" }), async () => {
    assert.equal(canSignCookies(), true);
    const token = await issueToken("app", NOW);
    assert.equal(await tokenValid("app", token, NOW), true);
    return token;
  });
  // In production a key written in the code would let anyone sign a cookie for every PIN.
  await withEnv(testEnv({ ...none, NODE_ENV: "production" }), async () => {
    assert.equal(canSignCookies(), false);
    await assert.rejects(() => issueToken("app", NOW), /CRON_SECRET/);
    assert.equal(await tokenValid("app", devToken, NOW), false);
  });
});

test("hasGateCookie reads the scope's own cookie, and cronOrBothPins never settles for the app cookie alone", async () => {
  await withEnv(testEnv(), async () => {
    const { app, settings } = await bothCookies();
    const jar = (tokens: Partial<Record<Scope, string>>) => request("/", { cookies: tokens }).cookies;
    assert.equal(await hasGateCookie(jar({ app }), "app"), true);
    assert.equal(await hasGateCookie(jar({ app }), "settings"), false);
    assert.equal(await hasGateCookie(jar({ settings: app }), "settings"), false);

    const call = (headers: Record<string, string>, tokens: Partial<Record<Scope, string>> = {}) =>
      cronOrBothPins(request("/api/x", { method: "POST", headers, cookies: tokens }));
    assert.equal(await call({ authorization: `Bearer ${CRON}` }), true);
    assert.equal(await call({ authorization: "Bearer wrong" }), false);
    assert.equal(await call({}, { app }), false);
    assert.equal(await call({}, { app, settings }), true);
    const stale = await bothCookies(0, HOUR + 1000);
    assert.equal(await call({}, stale), false);
  });
  await withEnv(testEnv({ CRON_SECRET: undefined }), async () => {
    // With no cron secret set, an empty one must not match.
    assert.equal(await cronOrBothPins(request("/api/x", { method: "POST", headers: { authorization: "Bearer " } })), false);
  });
});

test("the proxy lets a fresh app cookie in, and sends an expired, changed or old one to the unlock screen", async () => {
  await withEnv(testEnv(), async () => {
    const fresh = await issueToken("app");
    assert.ok(passesProxy(await proxy(request("/pr", { cookies: { app: fresh } }))));

    const expired = await issueToken("app", Date.now() - 12 * HOUR - 2000);
    const old = createHash("sha256").update(`app|${PINS.app}|${CRON}`).digest("hex");
    for (const token of [expired, old, `${fresh.slice(0, -1)}${fresh.endsWith("0") ? "1" : "0"}`]) {
      const page = await proxy(request("/pr", { cookies: { app: token } }));
      assert.equal(page.status, 307);
      assert.equal(new URL(page.headers.get("location") ?? "").pathname, "/unlock");
      assert.equal(new URL(page.headers.get("location") ?? "").searchParams.get("next"), "/pr");
      const api = await proxy(request("/api/summary", { cookies: { app: token } }));
      assert.equal(api.status, 401);
      assert.deepEqual(await api.json(), { error: "locked", scope: "app" });
    }
  });
});

test("the proxy opens settings only with a settings cookie under an hour old, on top of the app cookie", async () => {
  await withEnv(testEnv(), async () => {
    const { app, settings } = await bothCookies();
    assert.ok(passesProxy(await proxy(request("/settings", { cookies: { app, settings } }))));
    assert.ok(passesProxy(await proxy(request("/api/console", { method: "POST", cookies: { app, settings } }))));

    const stale = await issueToken("settings", Date.now() - 61 * 60_000);
    const page = await proxy(request("/settings", { cookies: { app, settings: stale } }));
    assert.equal(page.status, 307);
    const to = new URL(page.headers.get("location") ?? "");
    assert.equal(to.pathname, "/unlock");
    assert.equal(to.searchParams.get("scope"), "settings");
    for (const wrong of [stale, app, await issueToken("settings", Date.now() - 365 * 24 * HOUR)]) {
      const api = await proxy(request("/api/console", { method: "POST", cookies: { app, settings: wrong } }));
      assert.equal(api.status, 401);
      assert.deepEqual(await api.json(), { error: "locked", scope: "settings" });
    }
  });
});

test("PR & Media settings need the settings PIN as Settings does, and the PR tab the app PIN only", async () => {
  await withEnv(testEnv(), async () => {
    const { app, settings } = await bothCookies();
    for (const path of ["/pr/settings", "/pr/settings/anything"]) {
      assert.ok(passesProxy(await proxy(request(path, { cookies: { app, settings } }))), path);
      const page = await proxy(request(path, { cookies: { app } }));
      assert.equal(page.status, 307, path);
      const to = new URL(page.headers.get("location") ?? "");
      assert.equal(to.pathname, "/unlock");
      assert.equal(to.searchParams.get("scope"), "settings");
      // Back to the same page once the PIN is entered.
      assert.equal(to.searchParams.get("next"), path);
    }
    // The tab itself, and an address that only starts the same way, stay behind the app PIN alone.
    for (const path of ["/pr", "/pr/settingsx"]) assert.ok(passesProxy(await proxy(request(path, { cookies: { app } }))), path);
  });
});

test("the proxy passes the routes that check their own callers, the LinkedIn probe among them", async () => {
  await withEnv(testEnv(), async () => {
    for (const path of ["/api/perf/probe", "/api/pr/probe-actors", "/api/news", "/api/report", "/api/ingest"]) {
      assert.ok(passesProxy(await proxy(request(path, { method: "POST" }))), path);
    }
    // Anything else under /api still needs the app cookie.
    assert.equal((await proxy(request("/api/perf/stream", { method: "POST" }))).status, 401);
  });
});

test("the news, report and actor-probe routes refuse an expired or replayed settings cookie", async () => {
  await withEnv(testEnv(), async () => {
    await withFetch(async () => {
      const { app, settings } = await bothCookies();
      const stale = await issueToken("settings", Date.now() - HOUR - 2000);
      const appStale = await issueToken("app", Date.now() - 12 * HOUR - 2000);

      const news = (tokens: Partial<Record<Scope, string>>) =>
        newsRoute.POST(request("/api/news?step=no-such-step", { method: "POST", cookies: tokens }));
      assert.deepEqual(await (await news({ app: appStale, settings })).json(), { error: "locked", scope: "app" });
      const locked = await news({ app, settings: stale });
      assert.equal(locked.status, 401);
      assert.deepEqual(await locked.json(), { error: "locked", scope: "settings" });
      assert.equal((await news({ app, settings: app })).status, 401);
      // Fresh cookies get past the check, to the step name, which here starts nothing.
      assert.equal((await news({ app, settings })).status, 400);

      const report = (tokens: Partial<Record<Scope, string>>) =>
        reportRoute.POST(request("/api/report?action=preview", { method: "POST", cookies: tokens }));
      assert.equal((await report({ app, settings: stale })).status, 401);
      assert.equal((await report({ app: appStale, settings })).status, 401);
      // Past the check: with no database here the settings cannot be read, so nothing is sent.
      const read = await report({ app, settings });
      assert.equal(read.status, 500);
      assert.deepEqual(await read.json(), { error: "settings could not be read" });

      const probe = (opts: { cookies?: Partial<Record<Scope, string>>; headers?: Record<string, string> }) =>
        probeActorsRoute.POST(request("/api/pr/probe-actors?actor=99", { method: "POST", ...opts }));
      assert.equal((await probe({ cookies: { app, settings: stale } })).status, 401);
      assert.equal((await probe({ cookies: { app } })).status, 401);
      // Past the check, to an actor that does not exist, so no Apify run starts.
      assert.equal((await probe({ cookies: { app, settings } })).status, 400);
      assert.equal((await probe({ headers: { authorization: `Bearer ${CRON}` } })).status, 400);
    });
  });
});

test("the LinkedIn probe answers GET with 405 and starts runs only for the cron secret or both cookies", async () => {
  const runs: { url: string; body: unknown }[] = [];
  const apify = async (url: string, init?: RequestInit) => {
    if (!url.startsWith("https://api.apify.com/")) throw new Error(`a test tried to reach ${url}`);
    runs.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
    // What an actor answers when it finds nothing: no rows, no error.
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  await withEnv(testEnv({ APIFY_TOKEN: "apify-token-for-tests" }), async () => {
    await withFetch(async () => {
      const { app, settings } = await bothCookies();
      const stale = await issueToken("settings", Date.now() - HOUR - 2000);
      const path = "/api/perf/probe?handle=anything";

      // The link from the review, opened from an email by someone holding the app cookie.
      const got = await perfProbeRoute.GET();
      assert.equal(got.status, 405);
      assert.equal(got.headers.get("allow"), "POST");

      for (const opts of [{}, { cookies: { app } }, { cookies: { app, settings: stale } }, { headers: { authorization: "Bearer wrong" } }]) {
        const res = await perfProbeRoute.POST(request(path, { method: "POST", ...opts }));
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: "locked", scope: "settings" });
      }
      assert.equal(runs.length, 0, "nothing reached Apify without the secret or both cookies");

      const byScript = await perfProbeRoute.POST(request(path, { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
      assert.equal(byScript.status, 200);
      assert.ok(runs.length > 0);
      const counted = runs.length;
      const byAdmin = await perfProbeRoute.POST(request(path, { method: "POST", cookies: { app, settings } }));
      assert.equal(byAdmin.status, 200);
      assert.equal(((await byAdmin.json()) as { probed: { slug: string } }).probed.slug, "anything");
      assert.ok(runs.length > counted);
    }, apify);
  });
});

test("/api/ingest no longer takes the cron secret in its address, only in the Authorization header", async () => {
  await withEnv(testEnv(), async () => {
    await withFetch(async () => {
      for (const path of [`/api/ingest?secret=${CRON}`, "/api/ingest"]) {
        const res = ingestRoute.GET(request(path));
        assert.equal(res.status, 401, path);
        assert.deepEqual(await res.json(), { error: "unauthorized" });
      }
      // With the header it gets past the check and hands the run to after(),
      // which works only inside a real request, so here it stops there and
      // nothing starts.
      assert.throws(() => ingestRoute.GET(request("/api/ingest", { headers: { authorization: `Bearer ${CRON}` } })), /outside a request scope/);
    });
  });
});

/** Ask /api/unlock for a cookie, as the PIN prompt does, noting what it warned about. */
async function unlock(pin: string, scope: Scope) {
  const warnings: string[] = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  console.error = console.warn;
  try {
    const res = await unlockRoute.POST(
      new Request("https://dash.example/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ pin, scope }),
      }),
    );
    const setCookie = res.headers.get("set-cookie") ?? "";
    const cookie = new RegExp(`(?:^|, )${COOKIES[scope]}=([^;]*)`).exec(setCookie)?.[1] ?? null;
    const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1] ?? NaN);
    return { res, cookie, maxAge, warnings };
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
}

test("/api/unlock issues a signed cookie that lasts as long on the server as in the browser", async () => {
  await withEnv(testEnv(), async () => {
    await withFetch(async () => {
      for (const scope of ["app", "settings"] as const) {
        const { res, cookie, maxAge, warnings } = await unlock(PINS[scope], scope);
        assert.equal(res.status, 200);
        assert.ok(cookie && (await tokenValid(scope, cookie)), "the cookie is one tokenValid accepts");
        assert.equal(maxAge, MAX_AGE[scope]);
        assert.ok(warnings.some((w) => /limit is off/.test(w)), "says the limit is off on a machine without a database");
      }
      const wrong = await unlock(`${PINS.app}1`, "app");
      assert.equal(wrong.res.status, 401);
      assert.equal(wrong.cookie, null);
    });
  });
});

test("/api/unlock in production compares nothing when the limit has no database, or there is no key", async () => {
  await withEnv(testEnv({ NODE_ENV: "production" }), async () => {
    await withFetch(async () => {
      // The right PIN, which would have opened the gate before.
      const { res, cookie } = await unlock(PINS.app, "app");
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "60");
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "limit_unavailable");
      assert.equal(body.message, "The PIN check is unavailable right now. Try again in a minute.");
      assert.equal(cookie, null);
    });
  });
  await withEnv(testEnv({ NODE_ENV: "production", CRON_SECRET: undefined }), async () => {
    await withFetch(async () => {
      const { res, cookie, warnings } = await unlock(PINS.app, "app");
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "no_session_key");
      assert.match(body.message, /CRON_SECRET/);
      assert.doesNotMatch(body.message, /[\u2013\u2014]/);
      assert.equal(cookie, null);
      assert.ok(warnings.some((w) => /CRON_SECRET/.test(w)));
    });
  });
});
