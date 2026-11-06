import { test } from "node:test";
import assert from "node:assert/strict";

// /api/unlock end to end, against a stand-in for Supabase's REST API. fetch is
// replaced, so the real supabase-js builds every request and nothing leaves
// the process. The cases are the ones the review ran against the old route,
// where the right PIN got its cookie whenever the database could not count
// the attempt: failing, not answering, or slowed by a flood of guesses.
//
// Run this file on its own (node scripts/test.mjs app/api/unlock/route.test.ts):
// lib/supabase.ts reads the Supabase address once, when it first loads, so
// the address must be set here before anything imports it.

type Row = { id: number; ip: string; gate: string; ok: boolean; at: string };

/** gate_attempts in memory, behind a database with `pool` connections that each take `latencyMs` a call. */
class FakeDatabase {
  rows: Row[] = [];
  calls: string[] = [];
  mode: "healthy" | "fail" | "hang" = "healthy";
  pool = Infinity;
  latencyMs = 0;
  private busy = 0;
  private queue: (() => void)[] = [];
  private nextId = 1;

  reset(opts: { mode?: FakeDatabase["mode"]; pool?: number; latencyMs?: number } = {}) {
    this.rows = [];
    this.calls = [];
    this.mode = opts.mode ?? "healthy";
    this.pool = opts.pool ?? Infinity;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  /** Wait for a free connection. A request given up on while it waits leaves the queue, as a cancelled one would. */
  private async connection(signal?: AbortSignal | null): Promise<void> {
    if (this.busy < this.pool) {
      this.busy++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", drop);
        resolve();
      };
      const drop = () => {
        this.queue = this.queue.filter((q) => q !== go);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", drop, { once: true });
      this.queue.push(go);
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.busy--;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "supabase.test") throw new Error(`a test tried to reach ${url.host}`);
    const method = (init.method ?? "GET").toUpperCase();
    this.calls.push(method);
    if (this.mode === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    await this.connection(init.signal);
    try {
      if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
      if (init.signal?.aborted) throw init.signal.reason;
      if (this.mode === "fail") return json({ message: "upstream unavailable" }, 503);
      return this.answer(url, method, init.body ? JSON.parse(String(init.body)) : undefined);
    } finally {
      this.release();
    }
  };

  private answer(url: URL, method: string, body: unknown): Response {
    const filters = [...url.searchParams.entries()].filter(([k]) => !["select", "order", "limit"].includes(k));
    const hit = (r: Row) =>
      filters.every(([col, f]) => {
        const op = f.slice(0, f.indexOf("."));
        const arg = f.slice(f.indexOf(".") + 1);
        if (col === "at") return op === "gt" ? Date.parse(r.at) > Date.parse(arg) : Date.parse(r.at) < Date.parse(arg);
        const v = String(r[col as keyof Row]);
        if (op === "eq") return v === arg;
        if (op === "neq") return v !== arg;
        throw new Error(`the stand-in does not know ${col}=${f}`);
      });
    if (method === "POST") {
      const row: Row = { ...(body as Omit<Row, "id" | "at">), id: this.nextId++, at: new Date().toISOString() };
      this.rows.push(row);
      return json({ id: row.id, at: row.at }, 201);
    }
    if (method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? Infinity);
      return json(this.rows.filter(hit).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit).map((r) => ({ at: r.at })));
    }
    if (method === "PATCH") {
      for (const r of this.rows.filter(hit)) Object.assign(r, body);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      this.rows = this.rows.filter((r) => !hit(r));
      return new Response(null, { status: 204 });
    }
    throw new Error(`the stand-in does not know ${method}`);
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-tests";
process.env.CRON_SECRET = "cron-secret-for-tests";
const db = new FakeDatabase();
globalThis.fetch = db.fetch as typeof fetch;

// Loaded only now, after the address and the stand-in are in place.
const loading = (async () => ({
  route: await import("@/app/api/unlock/route"),
  gate: await import("@/lib/gate"),
  supabase: await import("@/lib/supabase"),
}))();

/** One unlock, as the PIN prompt sends it. */
async function unlock(pin: string, ip = "203.0.113.20", scope: "app" | "settings" = "app") {
  const { route, gate } = await loading;
  const res = await route.POST(
    new Request("https://dash.example/api/unlock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ pin, scope }),
    }),
  );
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = new RegExp(`(?:^|, )${gate.COOKIES[scope]}=([^;]*)`).exec(setCookie)?.[1] ?? null;
  return { status: res.status, retryAfter: res.headers.get("retry-after"), cookie, body: (await res.json()) as Record<string, unknown> };
}

/** Run `fn` with console warnings kept out of the test output, and the process held open. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  // AbortSignal.timeout does not hold the process open the way a server's sockets do.
  const alive = setInterval(() => {}, 1000);
  try {
    return await fn();
  } finally {
    clearInterval(alive);
    console.warn = warn;
  }
}

const rightPin = async () => (await loading).gate.PINS.app;
const wrongPin = async () => `${(await loading).gate.PINS.app}1`;

test("this file runs on its own, with the stand-in as the database", async () => {
  const { supabase } = await loading;
  assert.ok(supabase.adminClient(), "lib/supabase.ts was loaded before this file set the address: run this file on its own");
});

test("a healthy database: the right PIN gets a signed cookie, and the ninth wrong PIN from one address waits", async () => {
  const { gate } = await loading;
  db.reset();
  await quietly(async () => {
    const right = await unlock(await rightPin());
    assert.equal(right.status, 200);
    assert.ok(right.cookie && (await gate.tokenValid("app", right.cookie)));
    assert.deepEqual(db.rows.map((r) => r.ok), [true], "a right PIN does not count as wrong");

    for (let i = 0; i < 8; i++) assert.equal((await unlock(await wrongPin(), "198.51.100.7")).status, 401);
    const ninth = await unlock(await rightPin(), "198.51.100.7");
    assert.equal(ninth.status, 429);
    assert.equal(ninth.cookie, null);
    assert.ok(Number(ninth.retryAfter) > 0);
  });
});

test("a database answering 503: the right PIN is turned away unchecked, and nothing else is asked of it", async () => {
  db.reset({ mode: "fail" });
  await quietly(async () => {
    const res = await unlock(await rightPin());
    assert.equal(res.status, 503);
    assert.equal(res.retryAfter, "60");
    assert.equal(res.cookie, null);
    assert.equal(res.body.error, "limit_unavailable");
    assert.equal(res.body.message, "The PIN check is unavailable right now. Try again in a minute.");
    assert.deepEqual(db.calls, ["POST"], "no right PIN was recorded, so none was compared");
  });
});

test("a database that does not answer: after three seconds the right PIN is turned away unchecked", async () => {
  db.reset({ mode: "hang" });
  await quietly(async () => {
    const started = Date.now();
    const res = await unlock(await rightPin());
    assert.equal(res.status, 503);
    assert.equal(res.cookie, null);
    assert.ok(Date.now() - started < 6000);
  });
});

test("a flood of guesses that makes the database slow gets no more PINs judged than the limit allows", async () => {
  // Two connections at 30 ms a call: 300 guesses at once need about 13 seconds
  // of database time, so most of them run out of their three seconds.
  db.reset({ pool: 2, latencyMs: 30 });
  await quietly(async () => {
    const wrong = await wrongPin();
    const pins = Array.from({ length: 300 }, (_, i) => (i === 299 ? null : wrong));
    const results = await Promise.all(pins.map(async (pin) => unlock(pin ?? (await rightPin()), "203.0.113.66")));
    const judged = results.filter((r) => r.status === 401 || r.status === 200).length;
    const tally = results.reduce<Record<number, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    assert.ok(judged <= 8, `judged ${judged}: ${JSON.stringify(tally)}`);
    assert.ok((tally[503] ?? 0) > 0, `some were turned away for want of a count: ${JSON.stringify(tally)}`);
    assert.deepEqual(Object.keys(tally).filter((s) => !["401", "429", "503"].includes(s)), [], JSON.stringify(tally));
    assert.equal(results[299].cookie, null, "the right PIN at the end of the flood got no cookie");
  });
});

test("without the service-role key a deployment turns the PIN away, and a laptop judges it", async () => {
  const env = process.env as Record<string, string | undefined>;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const nodeEnv = env.NODE_ENV;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  db.reset();
  try {
    await quietly(async () => {
      env.NODE_ENV = "production";
      const deployed = await unlock(await rightPin());
      assert.equal(deployed.status, 503);
      assert.equal(deployed.cookie, null);

      env.NODE_ENV = "development";
      const laptop = await unlock(await rightPin());
      assert.equal(laptop.status, 200);
      assert.ok(laptop.cookie);
      assert.equal((await unlock(await wrongPin())).status, 401);
    });
    assert.deepEqual(db.calls, [], "no database was asked");
  } finally {
    env.SUPABASE_SERVICE_ROLE_KEY = key;
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
  }
});
