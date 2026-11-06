import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import {
  GATE_LIMITS,
  UNCOUNTED_MESSAGE,
  UNCOUNTED_RETRY_SECONDS,
  blockedMessage,
  clientIp,
  compareUncounted,
  decideAttempt,
  markRight,
  openAttempt,
  waitLabel,
} from "@/lib/gateLimit";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const MIN = 60_000;
/** `n` wrong attempts, one a minute, the newest `newestAgo` minutes before NOW. */
const fails = (n: number, newestAgo = 1) => Array.from({ length: n }, (_, i) => NOW - (newestAgo + i) * MIN);

test("the limits are the ones the unlock screen promises", () => {
  assert.equal(GATE_LIMITS.windowMs, 15 * MIN);
  assert.equal(GATE_LIMITS.perIp, 8);
  assert.equal(GATE_LIMITS.overall, 60);
});

test("a first attempt, and one after seven wrong PINs, are judged", () => {
  assert.deepEqual(decideAttempt({ ip: [], all: [] }, NOW), { allowed: true });
  assert.deepEqual(decideAttempt({ ip: fails(7), all: fails(7) }, NOW), { allowed: true });
});

test("after eight wrong PINs from one address the next waits for the oldest to leave the window", () => {
  // Wrong at 1..8 minutes ago. The 8th newest is 8 minutes old, so there is room again in 7 minutes.
  const d = decideAttempt({ ip: fails(8), all: fails(8) }, NOW);
  assert.deepEqual(d, { allowed: false, retryAfterSeconds: 7 * 60, reason: "ip" });
});

test("only the eight newest count when more slipped in at once", () => {
  // Ten wrong, 1..10 minutes ago: room again when the 8th newest (8 minutes old) leaves.
  const d = decideAttempt({ ip: fails(10), all: fails(10) }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.retryAfterSeconds, 7 * 60);
});

test("wrong attempts older than 15 minutes are forgotten", () => {
  const old = Array.from({ length: 20 }, (_, i) => NOW - (15 * MIN + 1 + i * 1000));
  assert.deepEqual(decideAttempt({ ip: old, all: old }, NOW), { allowed: true });
  // Exactly 15 minutes old is outside the window too.
  const edge = Array.from({ length: 8 }, () => NOW - 15 * MIN);
  assert.deepEqual(decideAttempt({ ip: edge, all: edge }, NOW), { allowed: true });
});

test("the order the times come in does not matter", () => {
  const shuffled = [...fails(8)].reverse();
  const d = decideAttempt({ ip: shuffled, all: shuffled }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.retryAfterSeconds, 7 * 60);
});

test("sixty wrong PINs from many addresses stop everyone, even an address with none", () => {
  // 60 wrong in the last 15 minutes, none from this address.
  const all = Array.from({ length: 60 }, (_, i) => NOW - 10_000 - i * 10_000);
  const d = decideAttempt({ ip: [], all }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.equal(d.reason, "everyone");
    // The 60th newest is 600 s old: room again in 300 s.
    assert.equal(d.retryAfterSeconds, 300);
  }
  assert.deepEqual(decideAttempt({ ip: [], all: all.slice(0, 59) }, NOW), { allowed: true });
});

test("when both limits are reached the longer wait is given", () => {
  const ip = fails(8, 10); // the 8th newest is 17 minutes old: outside, so wait 0
  assert.deepEqual(decideAttempt({ ip, all: [] }, NOW), { allowed: true });
  const mine = fails(8, 6); // 6..13 minutes ago: room in 2 minutes
  const all = Array.from({ length: 60 }, (_, i) => NOW - 1000 - i * 1000); // 1..60 s ago: room in 14 minutes
  const d = decideAttempt({ ip: mine, all }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.equal(d.reason, "everyone");
    assert.equal(d.retryAfterSeconds, 15 * 60 - 60);
  }
});

test("the wait is never less than a second, and is rounded up", () => {
  // The 8th newest leaves the window 1 ms from now.
  const ip = [...fails(7), NOW - 15 * MIN + 1];
  const d = decideAttempt({ ip, all: ip }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.retryAfterSeconds, 1);
});

test("custom limits are honoured", () => {
  const limits = { windowMs: 60_000, perIp: 2, overall: 3 };
  assert.deepEqual(decideAttempt({ ip: [NOW - 1000], all: [NOW - 1000] }, NOW, limits), { allowed: true });
  const d = decideAttempt({ ip: [NOW - 1000, NOW - 2000], all: [NOW - 1000, NOW - 2000] }, NOW, limits);
  assert.deepEqual(d, { allowed: false, retryAfterSeconds: 58, reason: "ip" });
});

test("waits read in whole minutes, rounded up", () => {
  assert.equal(waitLabel(1), "1 minute");
  assert.equal(waitLabel(60), "1 minute");
  assert.equal(waitLabel(61), "2 minutes");
  assert.equal(waitLabel(7 * 60), "7 minutes");
});

test("the message says whose attempts caused the wait, in plain words", () => {
  assert.equal(
    blockedMessage({ allowed: false, retryAfterSeconds: 420, reason: "ip" }),
    "Too many wrong PINs from this connection. Try again in 7 minutes.",
  );
  assert.equal(
    blockedMessage({ allowed: false, retryAfterSeconds: 30, reason: "everyone" }),
    "Too many wrong PINs have been tried on this dashboard. Try again in 1 minute.",
  );
  for (const reason of ["ip", "everyone"] as const) {
    assert.doesNotMatch(blockedMessage({ allowed: false, retryAfterSeconds: 99, reason }), /[–—]/);
  }
});

test("the address is the first forwarded one, then x-real-ip, then unknown", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": " 2001:db8::1 " })), "2001:db8::1");
  assert.equal(clientIp(new Headers({ "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "", "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(new Headers()), "unknown");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "x".repeat(500) })).length, 100);
});

test("an attempt the limit could not count is never judged, except in local development with no database", () => {
  const unavailable = { status: "unavailable", reason: "FetchError: fetch failed" } as const;
  const off = { status: "off", reason: "no database is set up" } as const;
  // A failing or slow database: refused everywhere, development included.
  for (const env of ["production", "development", "test", undefined]) assert.equal(compareUncounted(unavailable, env), false);
  // No database at all: a deployment without its service-role key is refused, a laptop is not.
  assert.equal(compareUncounted(off, "production"), false);
  for (const env of ["development", "test", undefined]) assert.equal(compareUncounted(off, env), true);
});

test("the unlock screen is told to wait a minute, in plain words", () => {
  assert.equal(UNCOUNTED_RETRY_SECONDS, 60);
  assert.equal(UNCOUNTED_MESSAGE, "The PIN check is unavailable right now. Try again in a minute.");
  assert.doesNotMatch(UNCOUNTED_MESSAGE, /[\u2013\u2014]/);
});

type AttemptRow = { id: number; ip: string; gate: string; ok: boolean; at: string };
type Mode = "healthy" | "fail" | "unreachable" | "missing" | "hang" | "counts fail";

/**
 * gate_attempts behind a stand-in for Supabase's REST API, reached through a
 * real supabase-js client, so openAttempt builds every request as it does in
 * production and nothing leaves the process.
 */
function fakeAttempts(mode: Mode = "healthy") {
  const rows: AttemptRow[] = [];
  const calls: string[] = [];
  let nextId = 1;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "gate.test") throw new Error(`a test tried to reach ${url.host}`);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push(method);
    if (mode === "unreachable") throw new TypeError("fetch failed");
    if (mode === "hang") {
      // Answers only when the caller gives up.
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    if (mode === "fail") return json({ message: "upstream unavailable" }, 503);
    if (mode === "missing") return json({ code: "PGRST205", message: "Could not find the table 'public.gate_attempts' in the schema cache" }, 404);
    if (mode === "counts fail" && method === "GET") return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);

    const filters = [...url.searchParams.entries()].filter(([k]) => !["select", "order", "limit"].includes(k));
    const hit = (r: AttemptRow) =>
      filters.every(([col, f]) => {
        const op = f.slice(0, f.indexOf("."));
        const arg = f.slice(f.indexOf(".") + 1);
        const v = r[col as keyof AttemptRow];
        if (col === "at") return op === "gt" ? Date.parse(r.at) > Date.parse(arg) : Date.parse(r.at) < Date.parse(arg);
        if (op === "eq") return String(v) === arg;
        if (op === "neq") return String(v) !== arg;
        throw new Error(`the stand-in does not know ${col}=${f}`);
      });
    if (method === "POST") {
      const body = JSON.parse(String(init.body)) as Omit<AttemptRow, "id" | "at">;
      const row = { ...body, id: nextId++, at: new Date().toISOString() };
      rows.push(row);
      return json({ id: row.id, at: row.at }, 201);
    }
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? Infinity);
      return json(rows.filter(hit).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit).map((r) => ({ at: r.at })));
    }
    if (method === "PATCH") {
      for (const r of rows.filter(hit)) Object.assign(r, JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      const keep = rows.filter((r) => !hit(r));
      rows.splice(0, rows.length, ...keep);
      return new Response(null, { status: 204 });
    }
    throw new Error(`the stand-in does not know ${method}`);
  };
  const db = createClient("http://gate.test", "service-key-for-tests", { auth: { persistSession: false }, global: { fetch } });
  return { db, rows, calls };
}

test("a healthy database lets eight wrong PINs from one address be judged, then asks the ninth to wait", async () => {
  const { db, rows } = fakeAttempts();
  for (let i = 0; i < GATE_LIMITS.perIp; i++) {
    const check = await openAttempt("203.0.113.7", "app", db);
    assert.equal(check.status, "allowed");
  }
  const ninth = await openAttempt("203.0.113.7", "app", db);
  assert.equal(ninth.status, "blocked");
  if (ninth.status === "blocked") assert.equal(ninth.decision.reason, "ip");
  assert.equal(rows.length, GATE_LIMITS.perIp, "the turned-away attempt's row is deleted");
  // Another address is still judged.
  assert.equal((await openAttempt("198.51.100.2", "app", db)).status, "allowed");
});

test("a right PIN stops counting as a wrong one", async () => {
  const { db, rows } = fakeAttempts();
  const check = await openAttempt("203.0.113.8", "settings", db);
  assert.equal(check.status, "allowed");
  if (check.status !== "allowed") return;
  assert.equal(await markRight(check.id, db), null);
  assert.deepEqual(rows.map((r) => r.ok), [true]);
});

test("a database that fails, cannot be reached or has no table cannot count the attempt", async () => {
  for (const mode of ["fail", "unreachable", "missing"] as const) {
    const { db } = fakeAttempts(mode);
    const check = await openAttempt("203.0.113.9", "app", db);
    assert.equal(check.status, "unavailable", mode);
  }
});

test("when the attempt was written but could not be counted, it stays counted as wrong", async () => {
  const { db, rows } = fakeAttempts("counts fail");
  const check = await openAttempt("203.0.113.10", "app", db);
  assert.equal(check.status, "unavailable");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, false);
});

test("a database too slow to answer is given three seconds, then the attempt is uncounted", async () => {
  const { db, calls } = fakeAttempts("hang");
  // AbortSignal.timeout does not hold the process open the way a server's
  // sockets do, so this timer keeps the test alive until it fires.
  const alive = setInterval(() => {}, 1000);
  const started = Date.now();
  const check = await openAttempt("203.0.113.11", "app", db).finally(() => clearInterval(alive));
  const took = Date.now() - started;
  assert.equal(check.status, "unavailable");
  assert.ok(took >= 2900 && took < 6000, `took ${took} ms`);
  assert.deepEqual(calls, ["POST"], "gave up on the first call");
});

test("with no database client there is nowhere to count", async () => {
  const check = await openAttempt("203.0.113.12", "app", null);
  assert.equal(check.status, "off");
  assert.match((await markRight(1, null)) ?? "", /no database is set up/);
});
