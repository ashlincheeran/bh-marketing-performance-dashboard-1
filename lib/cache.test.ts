import { test } from "node:test";
import assert from "node:assert/strict";
import { FRESH_MS, cacheKey, markAllStale, remembered, type CacheStore } from "@/lib/cache";

// The remembered answers (lib/cache.ts) against a store kept in memory: what is
// shown, what is kept, and what is worked out again, and when.

type Row = { payload: unknown; computedAt: string; stale: boolean; lockedAt?: string };

function memoryStore(failRead = false) {
  const rows = new Map<string, Row>();
  const store: CacheStore = {
    async read(key) {
      if (failRead) throw new Error("the cache table is not there");
      const r = rows.get(key);
      return r ? { payload: r.payload, computedAt: r.computedAt, stale: r.stale } : null;
    },
    async write(key, payload, computedAt) {
      rows.set(key, { payload: JSON.parse(JSON.stringify(payload)), computedAt, stale: false });
    },
    async lock(key, since) {
      const r = rows.get(key);
      if (!r || (r.lockedAt && r.lockedAt >= since)) return false;
      r.lockedAt = new Date().toISOString();
      return true;
    },
    async markAllStale() {
      for (const r of rows.values()) r.stale = true;
    },
  };
  return { store, rows };
}

const NOW = Date.parse("2026-11-16T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
type Answer = { leads: number; error?: string };
const whole = (a: Answer) => !a.error;

/** Background refreshes, run when the test says so. */
function laterQueue() {
  const queue: (() => Promise<void>)[] = [];
  return { later: (w: () => Promise<void>) => void queue.push(w), runAll: async () => { while (queue.length) await queue.shift()!(); }, queue };
}

test("an answer not kept yet is worked out now and kept, with when", async () => {
  const { store, rows } = memoryStore();
  let calls = 0;
  const got = await remembered<Answer>("k", async () => ({ leads: ++calls * 10 }), whole, { store, now: () => NOW, later: () => assert.fail("no refresh") });
  assert.deepEqual(got, { leads: 10, cachedAt: iso(NOW) });
  assert.equal(rows.get("k")?.computedAt, iso(NOW));
});

test("a young answer is shown as kept, without asking the source", async () => {
  const { store } = memoryStore();
  await store.write("k", { leads: 7 }, iso(NOW - 10 * 60_000));
  const got = await remembered<Answer>("k", async () => assert.fail("the source was asked"), whole, { store, now: () => NOW, later: () => assert.fail("no refresh") });
  assert.deepEqual(got, { leads: 7, cachedAt: iso(NOW - 10 * 60_000) });
});

test("an old answer is shown at once and worked out again behind it, for the next look", async () => {
  const { store, rows } = memoryStore();
  await store.write("k", { leads: 7 }, iso(NOW - FRESH_MS - 1));
  const q = laterQueue();
  const got = await remembered<Answer>("k", async () => ({ leads: 9 }), whole, { store, now: () => NOW, later: q.later });
  assert.deepEqual(got, { leads: 7, cachedAt: iso(NOW - FRESH_MS - 1) });
  assert.equal(q.queue.length, 1);
  await q.runAll();
  assert.deepEqual(rows.get("k")?.payload, { leads: 9 });
  assert.equal(rows.get("k")?.computedAt, iso(NOW));
});

test("Refresh everything marks every answer due, kept to show with its real time meanwhile", async () => {
  const { store, rows } = memoryStore();
  await store.write("k", { leads: 7 }, iso(NOW - 60_000));
  await markAllStale(store);
  const q = laterQueue();
  const got = await remembered<Answer>("k", async () => ({ leads: 8 }), whole, { store, now: () => NOW, later: q.later });
  assert.deepEqual(got, { leads: 7, cachedAt: iso(NOW - 60_000) });
  await q.runAll();
  assert.equal(rows.get("k")?.stale, false);
  assert.deepEqual(rows.get("k")?.payload, { leads: 8 });
});

test("a failed or partial answer is never kept: shown once, and the last good one stays", async () => {
  const { store, rows } = memoryStore();
  const got = await remembered<Answer>("new", async () => ({ leads: 0, error: "Metabase timed out" }), whole, { store, now: () => NOW });
  assert.deepEqual(got, { leads: 0, error: "Metabase timed out", cachedAt: null });
  assert.equal(rows.has("new"), false);

  await store.write("old", { leads: 7 }, iso(NOW - FRESH_MS - 1));
  const q = laterQueue();
  await remembered<Answer>("old", async () => ({ leads: 0, error: "Metabase timed out" }), whole, { store, now: () => NOW, later: q.later });
  await q.runAll();
  assert.deepEqual(rows.get("old")?.payload, { leads: 7 });
});

test("one refresh at a time: a second look while one runs does not start another", async () => {
  const { store } = memoryStore();
  await store.write("k", { leads: 7 }, iso(NOW - FRESH_MS - 1));
  const q = laterQueue();
  let asked = 0;
  const work = async () => ({ leads: ++asked });
  await remembered<Answer>("k", work, whole, { store, now: () => NOW, later: q.later });
  await remembered<Answer>("k", work, whole, { store, now: () => NOW, later: q.later });
  await q.runAll();
  assert.equal(asked, 1);
});

test("fresh works it out now whatever is kept, and a store that can't be read never stops the answer", async () => {
  const { store, rows } = memoryStore();
  await store.write("k", { leads: 7 }, iso(NOW - 60_000));
  const got = await remembered<Answer>("k", async () => ({ leads: 11 }), whole, { store, now: () => NOW, fresh: true });
  assert.deepEqual(got, { leads: 11, cachedAt: iso(NOW) });
  assert.deepEqual(rows.get("k")?.payload, { leads: 11 });

  const broken = memoryStore(true);
  const live = await remembered<Answer>("k", async () => ({ leads: 12 }), whole, { store: broken.store, now: () => NOW });
  assert.equal(live.leads, 12);
  const none = await remembered<Answer>("k", async () => ({ leads: 13 }), whole, { store: null, now: () => NOW });
  assert.equal(none.leads, 13);
});

test("keys keep each environment's answers apart, and say what was asked", () => {
  assert.notEqual(cacheKey("company", { from: "2026-01-01" }, "production"), cacheKey("company", { from: "2026-01-01" }, "preview"));
  assert.notEqual(cacheKey("company", { from: "2026-01-01" }, "production"), cacheKey("company", { from: "2026-02-01" }, "production"));
  assert.match(cacheKey("portals", { side: "all" }, "production"), /production:portals:\{"side":"all"\}$/);
});
