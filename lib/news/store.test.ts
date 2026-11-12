import { test } from "node:test";
import assert from "node:assert/strict";
import {
  articleState,
  chunkByLength,
  heldArticles,
  importedDuplicates,
  insertFound,
  noteRunEnding,
  release,
  requeueDueUnreadable,
  runEnv,
  runEnvFilter,
  saveArticle,
  saveResolvedUrl,
  speaksForStory,
  startRun,
} from "@/lib/news/store";
import { titleKey, urlKey } from "@/lib/news/keys";
import type { FoundItem } from "@/lib/news/types";
import type { UnreadableArticle } from "@/lib/news/store";

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
      for (const name of ["select", "in", "insert", "upsert", "update", "eq", "neq", "lt", "lte", "not", "is", "order", "range", "limit", "single"]) {
        builder[name] = (...args: unknown[]) => {
          q.calls.push([name, ...args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return { client: client as unknown as NonNullable<Parameters<typeof saveResolvedUrl>[3]>, queries };
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
    // The upsert answers with the rows it stored: here every one it was given.
    return { data: storedIds(q), error: null };
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
  // Asked to say which rows it stored.
  assert.deepEqual(callOf(queries.find((q) => callOf(q, "upsert")) as Query, "select"), ["select", "id"]);
});

/** The ids of the rows an upsert was given, as the database answers when it stores them all. */
const storedIds = (q: Query) => ((callOf(q, "upsert")?.[1] as { id: string }[] | undefined) ?? []).map((r) => ({ id: r.id }));

test("two searches at once never both count one article as new: only what this one stored is fresh", async () => {
  const items: FoundItem[] = [
    { title: "Rents rise again", link: googleLink(1), outlet: "Gulf News", publishedOn: null, query: "betterhomes" },
    { title: "Prices hold", link: googleLink(2), outlet: "Gulf News", publishedOn: null, query: "betterhomes" },
    { title: "Better Homes & Gardens picks", link: googleLink(3), outlet: "Gulf News", publishedOn: null, query: "betterhomes", skip: "Better Homes & Gardens" },
  ];
  // The other search stored the first a moment after this one looked, so the upsert leaves it alone.
  const { client } = recordingClient((q) =>
    callOf(q, "upsert") ? { data: storedIds(q).slice(1), error: null } : { data: [], error: null },
  );
  assert.deepEqual(await insertFound(items, client), { fresh: 1, repeats: 1, skipped: 1 });
});

test("insertFound fails outright when a lookup fails, rather than storing repeats", async () => {
  const { client } = recordingClient(() => ({ data: null, error: { message: "414 Request-URI Too Large" } }));
  const items: FoundItem[] = [{ title: "Rents rise", link: googleLink(1), outlet: "Gulf News", publishedOn: null, query: "betterhomes" }];
  await assert.rejects(insertFound(items, client), /repeat check failed: 414 Request-URI Too Large/);
});

// ── saveResolvedUrl ──────────────────────────────────────────────────────

const ADDRESS = "https://www.zawya.com/en/business/real-estate/dubai-rents-rise-abc123/";
const KEY = urlKey(ADDRESS);
/** The run that claimed the article. */
const RUN = "nr20261105T040000-abcd1234";

/**
 * A client for saveResolvedUrl: owner lookups answer from `owners` in turn,
 * and the address's update gives `updateError`. Every update finds the article
 * still this run's, unless `claimLost`: a person closed it in the meantime.
 */
function addressClient(owners: (string | null)[], updateError: Answer["error"] = null, claimLost = false) {
  const lookups = [...owners];
  return recordingClient((q) => {
    const patch = callOf(q, "update")?.[1] as Record<string, unknown> | undefined;
    if (!patch) {
      const owner = lookups.shift() ?? null;
      return { data: owner ? [{ id: owner }] : [], error: null };
    }
    const matched = claimLost ? [] : [{ id: "na_matched" }];
    // Saving as a duplicate always works; saving the address may meet the unique index.
    if (patch.status === "duplicate" || !updateError) return { data: matched, error: null };
    return { data: null, error: updateError };
  });
}

const updates = (queries: Query[]) => queries.map((q) => callOf(q, "update")?.[1]).filter(Boolean) as Record<string, unknown>[];
/** The filters of every update, each as its list of calls after the update itself. */
const updateFilters = (queries: Query[]) => queries.filter((q) => callOf(q, "update")).map((q) => q.calls.slice(1));

test("an address another article already has makes this one its duplicate", async () => {
  const { client, queries } = addressClient(["na_owner"]);
  assert.deepEqual(await saveResolvedUrl("na_copy", ADDRESS, RUN, client), { duplicateOf: "na_owner" });
  const [patch] = updates(queries);
  assert.deepEqual([patch.url, patch.url_key, patch.status, patch.dup_of, patch.claimed_by], [ADDRESS, KEY, "duplicate", "na_owner", null]);
  // Saved only while this run still holds the article.
  assert.deepEqual(updateFilters(queries), [
    [
      ["eq", "id", "na_copy"],
      ["eq", "claimed_by", RUN],
      ["select", "id"],
    ],
  ]);
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
  assert.deepEqual(await saveResolvedUrl("na_1", ADDRESS, RUN, client), { duplicateOf: null });
  const [patch] = updates(queries);
  assert.deepEqual([patch.url, patch.url_key, "status" in patch], [ADDRESS, KEY, false]);
  assert.deepEqual(updateFilters(queries)[0], [
    ["eq", "id", "na_1"],
    ["eq", "claimed_by", RUN],
    ["select", "id"],
  ]);
});

test("an address saved after a person closed the article saves nothing, and the read hears so", async () => {
  for (const owner of ["na_owner", null]) {
    const { client } = addressClient([owner], null, true);
    assert.deepEqual(await saveResolvedUrl("na_1", ADDRESS, RUN, client), { duplicateOf: null, lost: true }, String(owner));
  }
});

test("an address taken in the meantime makes this article the duplicate of the one that took it", async () => {
  const { client, queries } = addressClient([null, "na_winner"], { message: 'duplicate key value violates unique constraint "news_articles_url_key"', code: "23505" });
  assert.deepEqual(await saveResolvedUrl("na_1", ADDRESS, RUN, client), { duplicateOf: "na_winner" });
  assert.deepEqual(updates(queries).map((p) => [p.status, p.dup_of]), [
    [undefined, undefined],
    ["duplicate", "na_winner"],
  ]);
});

test("an address refused when no owner can then be found leaves the article without it, not a duplicate of nothing", async () => {
  const { client, queries } = addressClient([null, null], { message: 'duplicate key value violates unique constraint "news_articles_url_key"' });
  assert.deepEqual(await saveResolvedUrl("na_1", ADDRESS, RUN, client), { duplicateOf: null });
  // Only the refused write of the address: no save as a duplicate, no dup_of null.
  const written = updates(queries);
  assert.equal(written.length, 1);
  assert.equal(written[0].status, undefined);
  assert.ok(written.every((p) => !("dup_of" in p)));
});

test("any other failure saving the address is an error, and an address with no key asks nothing", async () => {
  const { client } = addressClient([null], { message: "connection reset" });
  await assert.rejects(saveResolvedUrl("na_1", ADDRESS, RUN, client), /saving the address of na_1 failed: connection reset/);
  const idle = recordingClient();
  assert.deepEqual(await saveResolvedUrl("na_1", null, RUN, idle.client), { duplicateOf: null });
  assert.deepEqual(await saveResolvedUrl("na_1", "not an address", RUN, idle.client), { duplicateOf: null });
  assert.deepEqual(idle.queries, []);
});

// ── A step saves an article only while it still holds it ─────────────────

test("a step's save lands only while its claim, or the held status, is still in place, and says whether it did", async () => {
  const claimed = recordingClient(() => ({ data: [{ id: "na_1" }], error: null }));
  assert.equal(await saveArticle("na_1", { status: "read" }, { claimedBy: RUN }, claimed.client), true);
  const [patch] = updates(claimed.queries);
  assert.deepEqual([patch.status, patch.claimed_by, patch.claimed_at], ["read", null, null]);
  assert.deepEqual(updateFilters(claimed.queries), [
    [
      ["eq", "id", "na_1"],
      ["eq", "claimed_by", RUN],
      ["select", "id"],
    ],
  ]);
  // Publish holds no claim: its save needs the article still held, and here a person closed it.
  const held = recordingClient(() => ({ data: [], error: null }));
  assert.equal(await saveArticle("na_1", { status: "decided" }, { status: "held" }, held.client), false);
  assert.deepEqual(updateFilters(held.queries), [
    [
      ["eq", "id", "na_1"],
      ["eq", "status", "held"],
      ["select", "id"],
    ],
  ]);
  const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(saveArticle("na_1", {}, { claimedBy: RUN }, failing.client), /saving article na_1 failed: timeout/);
});

test("articles go back to read only while this run still holds them", async () => {
  const { client, queries } = recordingClient();
  await release(["na_1", "na_2"], "read", "out of credit", RUN, client);
  const [patch] = updates(queries);
  assert.deepEqual([patch.status, patch.error, patch.claimed_by], ["read", "out of credit", null]);
  assert.deepEqual(updateFilters(queries), [
    [
      ["in", "id", ["na_1", "na_2"]],
      ["eq", "claimed_by", RUN],
    ],
  ]);
  const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(release(["na_1"], "read", null, RUN, failing.client), /releasing articles failed: timeout/);
});

// ── The morning's re-queue of unreadable articles ─────────────────────────

/** Unreadable articles as the re-queue reads them, for the caller's pick. */
const backlogRow = (id: string, over: Partial<UnreadableArticle> = {}): UnreadableArticle => ({
  id,
  found_by: ["betterhomes when:2d"],
  legacy_mention_id: null,
  url: `https://www.arabianbusiness.com/${id}`,
  outlet: "Arabian Business",
  read_via: "plain",
  note: "the site refused the read (HTTP 403)",
  next_try_at: "2026-11-05T00:00:00.000Z",
  ...over,
});

test("the morning's re-queue puts back the retries that are due, and with a pick, the backlog for Apify whatever its tries", async () => {
  const backlog = [backlogRow("na_a"), backlogRow("na_b"), backlogRow("na_c")];
  const answered = (q: Query): Answer => {
    const patch = callOf(q, "update")?.[1] as Record<string, unknown> | undefined;
    // The retries that are due; then the read of the backlog; then the pick put back.
    if (patch && !("next_try_at" in patch)) return { data: [{ id: "na_due" }], error: null };
    if (patch) return { data: (callOf(q, "in")?.[2] as string[]).map((id) => ({ id })), error: null };
    return { data: backlog, error: null };
  };

  // With no pick, only the retries that are due: unreadable, under three tries, and their time come.
  const plain = recordingClient(answered);
  const before = Date.now();
  assert.deepEqual(await requeueDueUnreadable(null, { client: plain.client }), { due: 1, forApify: 0 });
  assert.equal(plain.queries.length, 1);
  const [due] = plain.queries;
  assert.deepEqual(due.calls.slice(1, 4).map((c) => c.slice(0, 2)), [
    ["eq", "status"],
    ["lt", "read_attempts"],
    ["lte", "next_try_at"],
  ]);
  assert.deepEqual(due.calls.slice(1, 3), [
    ["eq", "status", "unreadable"],
    ["lt", "read_attempts", 3],
  ]);
  assert.ok(Date.parse(String(due.calls[3][2])) >= before);

  // With a pick, the backlog is read whole first, then what was picked goes back, due at once.
  const picked: string[] = [];
  const { client, queries } = recordingClient(answered);
  const r = await requeueDueUnreadable(
    (a) => {
      picked.push(a.id);
      return a.id !== "na_b";
    },
    { client },
  );
  assert.deepEqual(r, { due: 1, forApify: 2 });
  assert.deepEqual(picked, ["na_a", "na_b", "na_c"]);
  const [, read, back] = queries;
  // Every unreadable article no person has decided, whatever its tries: no read_attempts filter.
  assert.deepEqual(read.calls, [
    ["select", "id,found_by,legacy_mention_id,url,outlet,read_via,note,next_try_at"],
    ["eq", "status", "unreadable"],
    ["not", "next_try_at", "is", null],
    ["order", "id", { ascending: true }],
    ["range", 0, 999],
  ]);
  const patch = back.calls[0][1] as Record<string, unknown>;
  assert.equal(patch.status, "queued");
  assert.ok(Date.parse(String(patch.next_try_at)) >= before, "due at once, so the read step that follows takes it");
  // Only while each is still unreadable and undecided: a person may have counted one in the meantime.
  assert.deepEqual(back.calls.slice(1), [
    ["in", "id", ["na_a", "na_c"]],
    ["eq", "status", "unreadable"],
    ["not", "next_try_at", "is", null],
    ["select", "id"],
  ]);
  assert.equal(queries.length, 3);

  // A pick that takes none moves none.
  const none = recordingClient(answered);
  assert.deepEqual(await requeueDueUnreadable(() => false, { client: none.client }), { due: 1, forApify: 0 });
  assert.equal(none.queries.length, 2);

  // A failure says which part failed.
  const failingRead = recordingClient((q) => (callOf(q, "update") ? answered(q) : { data: null, error: { message: "timeout" } }));
  await assert.rejects(requeueDueUnreadable(() => true, { client: failingRead.client }), /reading the unreadable articles failed: timeout/);
  const failingMove = recordingClient((q) =>
    callOf(q, "in") ? { data: null, error: { message: "timeout" } } : answered(q),
  );
  await assert.rejects(requeueDueUnreadable(() => true, { client: failingMove.client }), /re-queueing unreadable articles for Apify failed: timeout/);
});

test("an article's status, claim and note are read fresh, just before a step writes", async () => {
  const state = { status: "checking", claimed_by: RUN, note: "kept by a person" };
  const { client, queries } = recordingClient(() => ({ data: [state], error: null }));
  assert.deepEqual(await articleState("na_1", client), state);
  assert.deepEqual(queries[0].calls, [
    ["select", "status,claimed_by,note"],
    ["eq", "id", "na_1"],
    ["limit", 1],
  ]);
  assert.equal(await articleState("na_1", recordingClient(() => ({ data: [], error: null })).client), null);
  const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(articleState("na_1", failing.client), /reading article na_1 failed: timeout/);
});

// ── Which deployment a run's rows belong to ──────────────────────────────

test("each step's row is marked with the deployment that ran it, and a laptop is development", async () => {
  assert.equal(runEnv({ VERCEL_ENV: "production" }), "production");
  assert.equal(runEnv({ VERCEL_ENV: "preview" }), "preview");
  assert.equal(runEnv({}), "development");
  assert.equal(runEnv({ VERCEL_ENV: "" }), "development");

  const before = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  try {
    const { client, queries } = recordingClient(() => ({ data: { id: 7 }, error: null }));
    assert.equal(await startRun("read", "nrA", 2, "manual", client), 7);
    assert.equal(queries[0].table, "news_runs");
    const row = (callOf(queries[0], "insert")?.[1] ?? {}) as Record<string, unknown>;
    assert.deepEqual([row.run_id, row.step, row.link, row.trigger, row.env], ["nrA", "read", 2, "manual", "preview"]);
    assert.match(String(row.run_day), /^\d{4}-\d{2}-\d{2}$/);
    const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
    assert.equal(await startRun("read", "nrA", 2, "manual", failing.client), null);
  } finally {
    if (before === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = before;
  }
});

test("Bot Activity reads its own deployment's rows, and production also the rows written before they were marked", () => {
  assert.equal(runEnvFilter("production"), "env.eq.production,env.is.null");
  assert.equal(runEnvFilter("preview"), "env.eq.preview");
  assert.equal(runEnvFilter("development"), "env.eq.development");
});

// ── How a run ended, where Bot Activity reads it ─────────────────────────

test("how a run ended goes on its last news_runs row, after any error the row has", async () => {
  const lastRow = (row: { id: number; ok: boolean | null; error: string | null }) =>
    recordingClient((q) => (callOf(q, "update") ? { data: null, error: null } : { data: [row], error: null }));
  const HAND_OFF = "the read step could not be started (/api/news answered HTTP 401), so what is left waits for the next run";

  // A step that closed clean: the ending is its error now, and not ok, which Bot Activity shows as a problem.
  const clean = lastRow({ id: 41, ok: true, error: null });
  assert.equal(await noteRunEnding("nrA", HAND_OFF, clean.client), true);
  assert.deepEqual(clean.queries[0].calls, [
    ["select", "id,ok,error"],
    ["eq", "run_id", "nrA"],
    ["order", "id", { ascending: false }],
    ["limit", 1],
  ]);
  assert.deepEqual(clean.queries[1].calls, [
    ["update", { ok: false, error: HAND_OFF }],
    ["eq", "id", 41],
  ]);

  // A row with an error of its own keeps it first. The link limit is recorded the same way: on a
  // preview nothing picks the rest up until someone runs the bot again.
  const LIMIT = "stopped after 40 links with work still waiting, which the next run picks up";
  const noted = lastRow({ id: 42, ok: true, error: "1 article failed, the first: na_1: timeout" });
  assert.equal(await noteRunEnding("nrA", LIMIT, noted.client), true);
  assert.deepEqual(callOf(noted.queries[1], "update"), ["update", { ok: false, error: `1 article failed, the first: na_1: timeout; ${LIMIT}` }]);

  // The same ending again changes nothing, and a run with no row has nowhere to put it.
  const again = lastRow({ id: 43, ok: false, error: HAND_OFF });
  assert.equal(await noteRunEnding("nrA", HAND_OFF, again.client), false);
  assert.equal(again.queries.length, 1);
  assert.equal(await noteRunEnding("nrA", HAND_OFF, recordingClient(() => ({ data: [], error: null })).client), false);
  const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(noteRunEnding("nrA", HAND_OFF, failing.client), /the run's last step could not be read: timeout/);
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

test("every imported duplicate is read, a thousand at a time, and only those whose article has a verdict", async () => {
  const page = (first: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `lm_${first + i}`, legacy_mention_id: `old_${first + i}`, dup_of: i % 2 ? "na_waiting" : "na_decided" }));
  const pages = [page(0, 1000), page(1000, 3)];
  const owners = [
    { id: "na_decided", status: "decided", decision: { mentions: [] } },
    { id: "na_waiting", status: "read", decision: null },
  ];
  const { client, queries } = recordingClient((q) =>
    q.calls.some((c) => c[0] === "in") ? { data: owners, error: null } : { data: pages.shift() ?? [], error: null },
  );
  const out = await importedDuplicates(client);
  // Only the duplicates of the decided article: the other still waits for its check.
  assert.equal(out.length, 502);
  assert.ok(out.every((d) => d.dup_of === "na_decided"));
  assert.deepEqual(out[501], { id: "lm_1002", legacy_mention_id: "old_1002", dup_of: "na_decided" });
  assert.deepEqual(queries[0].calls, [
    // With the status each old row had at the import, so a person's change on the old screen is told apart.
    ["select", "id,legacy_mention_id,dup_of,legacy_status"],
    ["eq", "status", "duplicate"],
    ["not", "legacy_mention_id", "is", null],
    ["not", "dup_of", "is", null],
    ["order", "id", { ascending: true }],
    ["range", 0, 999],
  ]);
  assert.deepEqual(callOf(queries[1], "range"), ["range", 1000, 1999]);
  assert.deepEqual(queries[2].calls[0], ["select", "id,status,decision"]);
  const failing = recordingClient(() => ({ data: null, error: { message: "timeout" } }));
  await assert.rejects(importedDuplicates(failing.client), /reading the imported duplicates failed: timeout/);
});

test("an article speaks for its story once the new bot has a verdict on it", () => {
  assert.equal(speaksForStory({ status: "decided", decision: { mentions: [] } as never }), true);
  assert.equal(speaksForStory({ status: "no_names", decision: null }), true);
  assert.equal(speaksForStory({ status: "skipped", decision: null }), true);
  // An untouched import, or one still on its way through the bot.
  assert.equal(speaksForStory({ status: "decided", decision: null }), false);
  for (const status of ["queued", "reading", "read", "checking", "held", "unreadable", "failed", "duplicate"] as const) {
    assert.equal(speaksForStory({ status, decision: null }), false, status);
  }
});
