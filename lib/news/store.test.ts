import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkByLength, heldArticles, importedDuplicates, insertFound, saveResolvedUrl } from "@/lib/news/store";
import { titleKey, urlKey } from "@/lib/news/keys";
import type { FoundItem } from "@/lib/news/types";

// Nothing here touches the database: each function is handed a stand-in client that records its calls.

type Answer = { data?: unknown; error: { message: string; code?: string } | null };
type Query = { table: string; calls: unknown[][] };

/** A stand-in Supabase client: every query is recorded, and `answer` says what each one returns. */
function recordingClient(answer: (q: Query) => Answer = () => ({ data: [], error: null })) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, calls: [] };
      queries.push(q);
      const builder: Record<string, unknown> = {
        then: (resolve: (v: Answer) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer(q)).then(resolve, reject),
      };
      for (const name of ["select", "in", "upsert", "update", "eq", "neq", "not", "is", "order", "range", "limit"]) {
        builder[name] = (...args: unknown[]) => {
          q.calls.push([name, ...args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return { client: client as unknown as NonNullable<Parameters<typeof saveResolvedUrl>[2]>, queries };
}

const callOf = (q: Query, name: string) => q.calls.find((c) => c[0] === name);
/** The characters a part of values takes in the address, as chunkByLength counts them. */
const addressSize = (part: string[]) => part.reduce((n, v) => n + encodeURIComponent(v).length + 3, 0);

/** A Google News link as long as the real ones, about 230 characters. */
const googleLink = (i: number) => `https://news.google.com/rss/articles/CBMi${"q".repeat(170)}${String(i).padStart(4, "0")}?oc=5&hl=en-AE&gl=AE`;

test("chunkByLength keeps each filter short and loses nothing", () => {
  const long = Array.from({ length: 50 }, (_, i) => `${googleLink(i)}&n=${i}`);
  const parts = chunkByLength(long, 1000);
  assert.ok(parts.length > 1);
  assert.deepEqual(parts.flat(), long);
  for (const part of parts) assert.ok(addressSize(part) <= 1000 || part.length === 1);
  // Short values are capped by count instead.
  assert.deepEqual(
    chunkByLength(["a", "b", "c", "d", "e"], 4000, 2).map((p) => p.length),
    [2, 2, 1],
  );
  // A value longer than the limit still goes, on its own.
  assert.deepEqual(chunkByLength(["x".repeat(50)], 10), [["x".repeat(50)]]);
  assert.deepEqual(chunkByLength([]), []);
});

test("200 Google links are looked up a few thousand characters at a time, not 46,000 in one address", () => {
  const links = Array.from({ length: 200 }, (_, i) => googleLink(i));
  assert.ok(links[0].length >= 220 && links[0].length <= 240, `a link of ${links[0].length} characters`);
  const parts = chunkByLength(links);
  assert.deepEqual(parts.flat(), links);
  for (const part of parts) assert.ok(addressSize(part) <= 4000, `a part of ${addressSize(part)} characters`);
  // About fifteen a request; 200 a request was what made the address too long.
  assert.ok(parts.length >= 12 && parts.length <= 20, `${parts.length} parts`);
  assert.ok(parts.every((p) => p.length < 20));
});

test("insertFound looks up repeats in short parts, stores what is new and counts the rest as repeats", async () => {
  const items: FoundItem[] = Array.from({ length: 200 }, (_, i) => ({
    title: `Dubai rents rise again, story ${i}`,
    link: googleLink(i),
    outlet: "Gulf News",
    publishedOn: "2026-11-05",
    query: "betterhomes",
  }));
  // Two are stored already: one by its Google link, one by its headline at the same outlet.
  const storedLink = items[7].link;
  const storedTitle = titleKey(items[150].title, items[150].outlet);
  const { client, queries } = recordingClient((q) => {
    const inCall = callOf(q, "in");
    if (inCall?.[1] === "google_link") return { data: (inCall[2] as string[]).includes(storedLink) ? [{ google_link: storedLink }] : [], error: null };
    if (inCall?.[1] === "title_key") {
      return { data: (inCall[2] as string[]).includes(storedTitle) ? [{ title_key: storedTitle, outlet_key: "gulfnews" }] : [], error: null };
    }
    return { data: null, error: null };
  });
  const out = await insertFound(items, client);
  assert.deepEqual(out, { fresh: 198, repeats: 2, skipped: 0 });

  const lookups = (column: string) => queries.map((q) => callOf(q, "in")).filter((c) => c?.[1] === column).map((c) => c?.[2] as string[]);
  const linkParts = lookups("google_link");
  const titleParts = lookups("title_key");
  assert.deepEqual(linkParts.flat(), items.map((i) => i.link));
  assert.equal(new Set(titleParts.flat()).size, 200);
  assert.ok(linkParts.length > 1);
  for (const part of [...linkParts, ...titleParts]) assert.ok(addressSize(part) <= 4000, `a lookup of ${addressSize(part)} characters`);
  // The rows go in a body, not the address, so 198 go in one upsert.
  const upserts = queries.map((q) => callOf(q, "upsert")).filter(Boolean);
  assert.equal(upserts.length, 1);
  assert.equal((upserts[0]?.[1] as unknown[]).length, 198);
  assert.deepEqual(upserts[0]?.[2], { onConflict: "id", ignoreDuplicates: true });
});

test("insertFound fails outright when a lookup fails, rather than storing repeats", async () => {
  const { client } = recordingClient(() => ({ data: null, error: { message: "414 Request-URI Too Large" } }));
  const items: FoundItem[] = [{ title: "Rents rise", link: googleLink(1), outlet: "Gulf News", publishedOn: null, query: "betterhomes" }];
  await assert.rejects(insertFound(items, client), /repeat check failed: 414 Request-URI Too Large/);
});

// ── saveResolvedUrl ──────────────────────────────────────────────────────

const ADDRESS = "https://www.zawya.com/en/business/real-estate/dubai-rents-rise-abc123/";
const KEY = urlKey(ADDRESS);

/** A client for saveResolvedUrl: owner lookups answer from `owners` in turn, and the address's update gives `updateError`. */
function addressClient(owners: (string | null)[], updateError: Answer["error"] = null) {
  const lookups = [...owners];
  return recordingClient((q) => {
    if (callOf(q, "select")) {
      const owner = lookups.shift() ?? null;
      return { data: owner ? [{ id: owner }] : [], error: null };
    }
    const patch = callOf(q, "update")?.[1] as Record<string, unknown> | undefined;
    // Saving as a duplicate always works; saving the address may meet the unique index.
    if (patch && patch.status === "duplicate") return { data: null, error: null };
    return { data: null, error: updateError };
  });
}

const updates = (queries: Query[]) => queries.map((q) => callOf(q, "update")?.[1]).filter(Boolean) as Record<string, unknown>[];

test("an address another article already has makes this one its duplicate", async () => {
  const { client, queries } = addressClient(["na_owner"]);
  assert.deepEqual(await saveResolvedUrl("na_copy", ADDRESS, client), { duplicateOf: "na_owner" });
  const [patch] = updates(queries);
  assert.deepEqual([patch.url, patch.url_key, patch.status, patch.dup_of, patch.claimed_by], [ADDRESS, KEY, "duplicate", "na_owner", null]);
  // The owner is looked up by the folded address, never by this article or another duplicate.
  assert.deepEqual(queries[0].calls.slice(0, 5), [
    ["select", "id"],
    ["eq", "url_key", KEY],
    ["neq", "id", "na_copy"],
    ["neq", "status", "duplicate"],
    ["limit", 1],
  ]);
});

test("an address nobody has is saved on the article, which reads on", async () => {
  const { client, queries } = addressClient([null]);
  assert.deepEqual(await saveResolvedUrl("na_1", ADDRESS, client), { duplicateOf: null });
  const [patch] = updates(queries);
  assert.deepEqual([patch.url, patch.url_key, "status" in patch], [ADDRESS, KEY, false]);
});

test("an address taken in the meantime makes this article the duplicate of the one that took it", async () => {
  const { client, queries } = addressClient([null, "na_winner"], { message: 'duplicate key value violates unique constraint "news_articles_url_key"', code: "23505" });
  assert.deepEqual(await saveResolvedUrl("na_1", ADDRESS, client), { duplicateOf: "na_winner" });
  assert.deepEqual(updates(queries).map((p) => [p.status, p.dup_of]), [
    [undefined, undefined],
    ["duplicate", "na_winner"],
  ]);
});

test("an address refused when no owner can then be found leaves the article without it, not a duplicate of nothing", async () => {
  const { client, queries } = addressClient([null, null], { message: 'duplicate key value violates unique constraint "news_articles_url_key"' });
  assert.deepEqual(await saveResolvedUrl("na_1", ADDRESS, client), { duplicateOf: null });
  // Only the refused write of the address: no save as a duplicate, no dup_of null.
  const written = updates(queries);
  assert.equal(written.length, 1);
  assert.equal(written[0].status, undefined);
  assert.ok(written.every((p) => !("dup_of" in p)));
});

test("any other failure saving the address is an error, and an address with no key asks nothing", async () => {
  const { client } = addressClient([null], { message: "connection reset" });
  await assert.rejects(saveResolvedUrl("na_1", ADDRESS, client), /saving the address of na_1 failed: connection reset/);
  const idle = recordingClient();
  assert.deepEqual(await saveResolvedUrl("na_1", null, idle.client), { duplicateOf: null });
  assert.deepEqual(await saveResolvedUrl("na_1", "not an address", idle.client), { duplicateOf: null });
  assert.deepEqual(idle.queries, []);
});

// ── What the publish step reads ──────────────────────────────────────────

test("held articles are read oldest first, a page from where the step got to", async () => {
  const { client, queries } = recordingClient(() => ({ data: [{ id: "na_1" }], error: null }));
  assert.deepEqual(await heldArticles(3, 20, client), [{ id: "na_1" }]);
  assert.deepEqual(queries[0].calls, [
    ["select", "*"],
    ["eq", "status", "held"],
    ["order", "first_seen_at", { ascending: true }],
    ["order", "id", { ascending: true }],
    ["range", 3, 22],
  ]);
  const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(heldArticles(0, 20, failing.client), /reading the held articles failed: timeout/);
});

test("every imported duplicate is read, a thousand at a time", async () => {
  const page = (first: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `lm_${first + i}`, legacy_mention_id: `old_${first + i}`, dup_of: "na_x" }));
  const pages = [page(0, 1000), page(1000, 3)];
  const { client, queries } = recordingClient(() => ({ data: pages.shift() ?? [], error: null }));
  const out = await importedDuplicates(client);
  assert.equal(out.length, 1003);
  assert.deepEqual(out[1002], { id: "lm_1002", legacy_mention_id: "old_1002", dup_of: "na_x" });
  assert.deepEqual(queries[0].calls, [
    ["select", "id,legacy_mention_id,dup_of"],
    ["eq", "status", "duplicate"],
    ["not", "legacy_mention_id", "is", null],
    ["not", "dup_of", "is", null],
    ["order", "id", { ascending: true }],
    ["range", 0, 999],
  ]);
  assert.deepEqual(callOf(queries[1], "range"), ["range", 1000, 1999]);
  const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(importedDuplicates(failing.client), /reading the imported duplicates failed: timeout/);
});
