import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NewsSettings } from "@/lib/news/types";

// The news bot's server actions, run against a stand-in for Supabase's REST
// API. fetch is replaced, so the real supabase-js builds every request and
// nothing leaves the process. Next's request scope is stood in for too, so
// revalidatePath and cookies() behave as they do inside a server action.
//
// Run this file on its own (node scripts/test.mjs app/actions.test.ts):
// lib/supabase.ts reads the Supabase address once, when it first loads, so
// the address must be set here before anything imports it.
//
// Nothing here may start a run of the news bot or ask an AI: startNewsStep is
// replaced (see `loading`), no Claude key is set, and the stand-in throws for
// any address but Supabase's, so a Gemini or Claude call would fail the test.

type Row = Record<string, unknown>;

/** A column or JSON path (metadata->>articleId) of a row, read the way PostgREST reads it. */
function valueAt(row: Row, path: string): unknown {
  const parts = path.split(/(->>|->)/);
  let v: unknown = row[parts[0]];
  for (let i = 1; i < parts.length; i += 2) {
    v = v && typeof v === "object" ? (v as Row)[parts[i + 1]] : undefined;
    if (parts[i] === "->>" && v !== undefined && v !== null && typeof v === "object") v = JSON.stringify(v);
  }
  return v ?? null;
}

/**
 * The row with each `alias:path` column of a select added, as PostgREST names
 * it ("competitor:metadata->>competitor"). Every other column is left as it is:
 * the stand-in returns whole rows.
 */
function withAliases(row: Row, select: string | null): Row {
  const out: Row = { ...row };
  for (const part of (select ?? "").split(",")) {
    const at = part.indexOf(":");
    if (at > 0) out[part.slice(0, at).trim()] = valueAt(row, part.slice(at + 1).trim());
  }
  return out;
}

/** "(a,b,"c d")" as ["a", "b", "c d"]. */
function listOf(arg: string): string[] {
  return (arg.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? []).map((s) => (s.startsWith('"') ? JSON.parse(s) : s));
}

/** A LIKE pattern as a regular expression: % and * for any run, _ for one character, \ to take the next one as it is. */
function likePattern(pattern: string, flags: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "%" || ch === "*") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, flags);
}

function matches(row: Row, column: string, filter: string): boolean {
  const negate = filter.startsWith("not.");
  const expr = negate ? filter.slice(4) : filter;
  const op = expr.slice(0, expr.indexOf("."));
  const arg = expr.slice(expr.indexOf(".") + 1);
  const v = valueAt(row, column);
  const s = v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
  let ok: boolean;
  if (op === "eq") ok = s === arg;
  else if (op === "neq") ok = s !== null && s !== arg;
  else if (op === "in") ok = s !== null && listOf(arg).includes(s);
  else if (op === "like") ok = s !== null && likePattern(arg, "").test(s);
  else if (op === "ilike") ok = s !== null && likePattern(arg, "i").test(s);
  else if (op === "is") ok = arg === "null" ? v === null : s === arg;
  else if (op === "lt" || op === "lte" || op === "gt" || op === "gte") {
    // Numbers as numbers; anything else, such as the ISO times the tests store, as text, which orders them the same.
    const numbers = typeof v === "number" && /^-?\d+(\.\d+)?$/.test(arg);
    const [a, b] = numbers ? [v as number, Number(arg)] : [s ?? "", arg];
    ok = s !== null && (op === "lt" ? a < b : op === "lte" ? a <= b : op === "gt" ? a > b : a >= b);
  } else throw new Error(`the stand-in does not know the filter ${op}`);
  return negate ? !ok : ok;
}

/** An `or` filter, "(a.eq.1,b.is.null)": any of its parts holds. Plain parts only, no and() or or() inside. */
function anyOf(row: Row, list: string): boolean {
  return list
    .slice(1, -1)
    .split(",")
    .some((part) => matches(row, part.slice(0, part.indexOf(".")), part.slice(part.indexOf(".") + 1)));
}

const NOT_FILTERS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Supabase's REST API over tables kept in memory: enough of it for these actions. */
class FakeSupabase {
  tables: Record<string, Row[]> = {};
  requests: { method: string; table: string; params: [string, string][]; body: unknown }[] = [];
  /** A request this answers with a database error instead: return the error's message, or null to answer as usual. */
  fault: ((method: string, table: string, params: [string, string][]) => string | null) | null = null;
  private nextId = 1000;

  reset(tables: Record<string, Row[]>) {
    this.tables = structuredClone(tables);
    this.requests = [];
    this.fault = null;
  }

  row(table: string, id: unknown): Row | undefined {
    return (this.tables[table] ?? []).find((r) => r.id === id);
  }

  private sameRow(table: string, a: Row, b: Row): boolean {
    if (table === "tracked_people") return (b.id != null && a.id === b.id) || (a.name === b.name && a.company === b.company);
    return a.id === b.id;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "supabase.test") throw new Error(`a test tried to reach ${url.host}`);
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const method = (init.method ?? "GET").toUpperCase();
    const prefer = new Headers(init.headers).get("Prefer") ?? "";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const params = [...url.searchParams.entries()];
    this.requests.push({ method, table, params, body });
    const failed = this.fault?.(method, table, params);
    if (failed) return json({ code: "57014", message: failed, details: null, hint: null }, 500);
    const rows = (this.tables[table] ??= []);
    const filters = params.filter(([k]) => !NOT_FILTERS.has(k));
    const hit = (r: Row) => filters.every(([k, v]) => (k === "or" ? anyOf(r, v) : matches(r, k, v)));
    const answer = (data: Row[], status = 200) =>
      method === "GET" || prefer.includes("return=representation") ? json(structuredClone(data), status) : new Response(null, { status: 204 });

    if (method === "GET") return answer(rows.filter(hit).map((r) => withAliases(r, url.searchParams.get("select"))));
    // A count with no rows (select with head: true): how many match, in the header PostgREST uses.
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `*/${rows.filter(hit).length}` } });
    if (method === "PATCH") {
      const changed = rows.filter(hit);
      for (const r of changed) Object.assign(r, structuredClone(body));
      return answer(changed);
    }
    if (method === "DELETE") {
      const gone = rows.filter(hit);
      this.tables[table] = rows.filter((r) => !hit(r));
      return answer(gone);
    }
    if (method === "POST") {
      const upsert = prefer.includes("resolution=");
      const added: Row[] = [];
      for (const item of (Array.isArray(body) ? body : [body]) as Row[]) {
        const existing = rows.find((r) => this.sameRow(table, r, item));
        if (existing && !upsert) return json({ code: "23505", message: `duplicate key value violates unique constraint "${table}_pkey"` }, 409);
        if (existing) {
          if (!prefer.includes("ignore-duplicates")) Object.assign(existing, structuredClone(item));
          continue;
        }
        const row = structuredClone(item);
        if (table === "tracked_people" && row.id == null) row.id = this.nextId++;
        rows.push(row);
        added.push(row);
      }
      return answer(added, 201);
    }
    throw new Error(`the stand-in does not know ${method}`);
  };
}

// What Next's server sets up before any route runs.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-tests";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-tests";
delete process.env.ANTHROPIC_API_KEY;

const db = new FakeSupabase();
globalThis.fetch = db.fetch;

/** lib/news/run.ts's startNewsStep, as app/actions.ts calls it. */
type StartStep = (
  step: string,
  trigger: string,
  opts?: { kind?: string },
) => Promise<{ runId: string; started: boolean; error?: string }>;

/** What the stand-in for startNewsStep was asked to start, and what it answers. */
const steps = {
  calls: [] as { step: string; trigger: string }[],
  answer: (async () => ({ runId: "nr_test", started: true })) as () => ReturnType<StartStep>,
};

// Loaded only now, after the address and the stand-in are in place.
const loading = (async () => {
  const actions = await import("@/app/actions");
  // The module object app/actions.ts reads startNewsStep from at each call.
  // `import()` hands back a copy of it, so it is reached with require, and the
  // stand-in put there is what the action calls: no run is ever started.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const run = require("@/lib/news/run") as { startNewsStep: StartStep };
  run.startNewsStep = async (step, trigger) => {
    steps.calls.push({ step, trigger });
    return steps.answer();
  };
  return {
    actions,
    gate: await import("@/lib/gate"),
    work: await import("next/dist/server/app-render/work-async-storage.external.js"),
    unit: await import("next/dist/server/app-render/work-unit-async-storage.external.js"),
  };
})();

/** Both PIN cookies, as /settings sets them once both PINs are entered. */
async function unlocked(): Promise<Record<string, string>> {
  const { gate } = await loading;
  return {
    [gate.COOKIES.app]: await gate.issueToken("app"),
    [gate.COOKIES.settings]: await gate.issueToken("settings"),
  };
}

/**
 * Run an action the way Next runs one, with these cookies on the request:
 * both PINs' unless others are given, as PR & Media settings sends them.
 * Returns its result and the paths it revalidated.
 */
async function inAction<T>(call: (a: Awaited<typeof loading>["actions"]) => Promise<T>, given?: Record<string, string>) {
  const { actions, work, unit } = await loading;
  const cookies = given ?? (await unlocked());
  const jar = { get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined) };
  const workStore = { route: "/pr", incrementalCache: {}, pendingRevalidatedTags: [] as { tag: string }[] };
  const unitStore = { type: "request", phase: "action", cookies: jar, userspaceMutableCookies: jar, mutableCookies: jar };
  const result = await work.workAsyncStorage.run(workStore as never, () =>
    unit.workUnitAsyncStorage.run(unitStore as never, () => call(actions)),
  );
  return { result, revalidated: workStore.pendingRevalidatedTags.map((t) => t.tag) };
}

const ID = "na_0123456789abcdef0123";
const LEGACY = "3f2a9c1b7d4e5f60";
const OUR_SENTENCE = "Richard Waind, CEO of betterhomes, said rents rose again.";

const REGISTRY: Record<string, Row[]> = {
  tracked_keywords: [
    { id: 1, kind: "competitor", query: "knight frank dubai", label: "Knight Frank", active: true, created_at: "2026-01-01" },
    { id: 2, kind: "pr", query: "betterhomes", label: null, active: true, created_at: "2026-01-01" },
  ],
  tracked_people: [
    { id: 11, name: "Richard Waind", company: "betterhomes", role: "CEO", aliases: [], active: true, note: null },
    { id: 12, name: "Louis Harding", company: "betterhomes", role: "Former CEO", aliases: [], active: false, note: null },
    { id: 13, name: "Louis Harding", company: "Knight Frank", role: "Head of Residential", aliases: [], active: true, note: null },
  ],
  outlets: [{ id: 7, name: "Khaleej Times", tier: "T1-Local" }],
};

const article = (over: Row = {}): Row => ({
  id: ID,
  google_link: "https://news.google.com/rss/articles/CBMiTestOnly?oc=5",
  url: "https://www.khaleejtimes.com/business/property/rents-rise-again",
  url_key: "khaleejtimes.com/business/property/rents-rise-again",
  title: "Dubai rents rise again",
  title_key: "dubai rents rise again",
  outlet: "Khaleej Times",
  outlet_key: "khaleejtimes",
  published_on: "2026-11-04",
  found_by: ["betterhomes"],
  status: "decided",
  read_attempts: 1,
  ai_attempts: 1,
  body_status: "ok",
  body_chars: 2400,
  read_via: "plain",
  candidates: [
    { n: 1, text: "Knight Frank said prime prices held.", companies: ["Knight Frank"], people: [] },
    { n: 2, text: OUR_SENTENCE, companies: ["betterhomes"], people: ["Richard Waind"] },
  ],
  decision: {
    mentions: [],
    irrelevantReason: "the AI found no tracked company in it",
    possibleMoves: [],
    dropped: [],
    model: "claude-haiku-5-5",
    checkedAt: "2026-11-05T04:12:00.000Z",
  },
  legacy_mention_id: null,
  dup_of: null,
  note: null,
  error: null,
  next_try_at: null,
  claimed_at: null,
  claimed_by: null,
  first_seen_at: "2026-11-05T04:01:00.000Z",
  updated_at: "2026-11-05T04:12:00.000Z",
  ...over,
});

const meta = (row: Row | undefined) => (row?.metadata ?? {}) as Row;

test("Keep writes our row the way the bot would, reviewed, with the person's verdict", async () => {
  db.reset({ ...REGISTRY, news_articles: [article()], mentions: [] });
  const { result, revalidated } = await inAction((a) => a.keepArticleAction(ID));
  assert.deepEqual(result, { ok: true });
  const row = db.row("mentions", `nb_${ID}`);
  assert.ok(row, "our row was added");
  assert.equal(row.status, "reviewed");
  assert.equal(row.source, "googlenews");
  assert.equal(row.brand, "betterhomes");
  assert.equal(row.tier, "T1-Local");
  assert.equal(row.outlet_id, 7);
  assert.equal(meta(row).personVerdict, "kept");
  assert.equal(meta(row).articleId, ID);
  // The AI found nothing, so the proof is the first sentence naming us, as passing.
  assert.deepEqual(
    { ...(meta(row).factCheck as Row), checkedAt: "x" },
    { result: "pass", role: "passing", quote: OUR_SENTENCE, sentence: 2, checkedAt: "x", model: "person" },
  );
  assert.equal(db.row("news_articles", ID)?.note, "kept by a person");
  // The PR tab counts it, and PR & Media settings, where Keep is pressed, lists it.
  assert.ok(revalidated.some((t) => t.endsWith("/pr")));
  assert.ok(revalidated.some((t) => t.endsWith("/pr/settings")));
});

test("Keep on an article imported from the old bot's row for us changes that row and adds none", async () => {
  db.reset({
    ...REGISTRY,
    news_articles: [article({ id: `lm_${LEGACY}`, legacy_mention_id: LEGACY, decision: null, candidates: null })],
    mentions: [
      {
        id: LEGACY,
        source: "googlenews",
        status: "rejected",
        tags: ["leasing"],
        metadata: {
          reason: "fact check: no sentence in the article names betterhomes",
          factCheck: { result: "fail", why: "no sentence names betterhomes", prevStatus: "new" },
          keywords: ["betterhomes"],
        },
      },
    ],
  });
  const { result } = await inAction((a) => a.keepArticleAction(`lm_${LEGACY}`));
  assert.deepEqual(result, { ok: true });
  assert.equal(db.tables.mentions.length, 1, "no second row beside the old one");
  const row = db.row("mentions", LEGACY);
  assert.equal(row?.status, "reviewed");
  assert.equal(meta(row).personVerdict, "kept");
  assert.equal(meta(row).articleId, `lm_${LEGACY}`);
  assert.equal("reason" in meta(row), false);
  // A failed check proves nothing, so the headline stands in, as sentence 0.
  assert.equal((meta(row).factCheck as Row).quote, "Dubai rents rise again");
  assert.equal((meta(row).factCheck as Row).sentence, 0);
  assert.deepEqual(row?.tags, ["leasing"]);
});

test("Keep refuses a copy, an article no longer stored, and an id that is not one", async () => {
  db.reset({ ...REGISTRY, news_articles: [article({ status: "duplicate", dup_of: "na_ffffffffffffffffffff" })], mentions: [] });
  const copy = await inAction((a) => a.keepArticleAction(ID));
  assert.equal(copy.result.ok, false);
  assert.match(copy.result.ok ? "" : copy.result.error, /same article as another one/);
  assert.equal(db.tables.mentions.length, 0);

  const gone = await inAction((a) => a.keepArticleAction("na_ffffffffffffffffffff"));
  assert.deepEqual(gone.result, { ok: false, error: "That article is no longer stored." });

  db.requests = [];
  const odd = await inAction((a) => a.keepArticleAction("na_1,id.neq.x"));
  assert.deepEqual(odd.result, { ok: false, error: "That is not an article the bot stored." });
  assert.equal(db.requests.length, 0, "nothing was asked of the database");
});

test("Reject takes every row of the article out of the count, and no other article's", async () => {
  db.reset({
    ...REGISTRY,
    news_articles: [article({ legacy_mention_id: LEGACY })],
    mentions: [
      { id: `nb_${ID}`, source: "googlenews", status: "new", metadata: { articleId: ID } },
      { id: `nr_${ID}_knight-frank`, source: "competitor_news", status: "new", metadata: { articleId: ID, competitor: "Knight Frank" } },
      { id: `nr_${ID}_haus-haus`, source: "competitor_news", status: "new", metadata: { competitor: "Haus & Haus" } },
      { id: LEGACY, source: "googlenews", status: "new", metadata: {} },
      // Would match if "_" in the pattern were left to match any character.
      { id: `nrXna_0123456789abcdef0123_knight-frank`, source: "competitor_news", status: "new", metadata: {} },
      { id: "nr_na_0123456789abcdef0124_knight-frank", source: "competitor_news", status: "new", metadata: {} },
    ],
  });
  const { result } = await inAction((a) => a.rejectArticleAction(ID));
  assert.deepEqual(result, { ok: true });
  const byPrefix = db.requests.flatMap((r) => r.params).find(([k, v]) => k === "id" && v.startsWith("like."));
  assert.deepEqual(byPrefix, ["id", "like.nr\\_na\\_0123456789abcdef0123\\_%"]);
  for (const id of [`nb_${ID}`, `nr_${ID}_knight-frank`, `nr_${ID}_haus-haus`, LEGACY]) {
    const row = db.row("mentions", id);
    assert.equal(row?.status, "rejected", id);
    assert.equal(meta(row).personVerdict, "rejected", id);
    assert.equal(meta(row).articleId, ID, id);
  }
  assert.equal(meta(db.row("mentions", `nr_${ID}_knight-frank`)).competitor, "Knight Frank");
  assert.equal(db.row("mentions", `nrXna_0123456789abcdef0123_knight-frank`)?.status, "new");
  assert.equal(db.row("mentions", "nr_na_0123456789abcdef0124_knight-frank")?.status, "new");
  assert.equal(db.row("news_articles", ID)?.note, "rejected by a person");
});

test("a story's Keep or Reject is recorded beside what the row already holds", async () => {
  db.reset({
    mentions: [{ id: "m1", status: "rejected", metadata: { reason: "fact check: no sentence names us", factCheck: { prevStatus: "new" } } }],
  });
  const kept = await inAction((a) => a.setMentionStatusAction("m1", "reviewed"));
  assert.deepEqual(kept.result, { ok: true });
  assert.equal(db.row("mentions", "m1")?.status, "reviewed");
  assert.deepEqual(meta(db.row("mentions", "m1")), {
    reason: "fact check: no sentence names us",
    factCheck: { prevStatus: "new" },
    personVerdict: "kept",
  });
  await inAction((a) => a.setMentionStatusAction("m1", "rejected"));
  assert.equal(meta(db.row("mentions", "m1")).personVerdict, "rejected");
  await inAction((a) => a.setMentionStatusAction("m1", "new"));
  assert.equal(meta(db.row("mentions", "m1")).personVerdict, "kept");

  assert.deepEqual((await inAction((a) => a.setMentionStatusAction("m2", "reviewed"))).result, {
    ok: false,
    error: "That story is no longer stored.",
  });
  const odd = await inAction((a) => a.setMentionStatusAction("m1", "approved" as "new"));
  assert.deepEqual(odd.result, { ok: false, error: "Unknown status." });
});

test("a spokesperson is added once, and only at a tracked company", async () => {
  db.reset({ ...REGISTRY });
  const added = await inAction((a) => a.addPersonAction({ name: "  Faisal   Durrani ", company: "Knight Frank", role: "Head of Research" }));
  assert.deepEqual(added.result, { ok: true });
  const faisal = db.tables.tracked_people.find((p) => p.name === "Faisal Durrani");
  assert.deepEqual(
    { name: faisal?.name, company: faisal?.company, role: faisal?.role, active: faisal?.active },
    { name: "Faisal Durrani", company: "Knight Frank", role: "Head of Research", active: true },
  );

  const again = await inAction((a) => a.addPersonAction({ name: "faisal durrani", company: "Knight Frank", role: "" }));
  assert.deepEqual(again.result, { ok: false, error: "faisal durrani is already on the list for Knight Frank." });
  const former = await inAction((a) => a.addPersonAction({ name: "Louis Harding", company: "betterhomes", role: "" }));
  assert.deepEqual(former.result, {
    ok: false,
    error: "Louis Harding is already on the list for betterhomes, as former. Mark them current instead.",
  });
  const untracked = await inAction((a) => a.addPersonAction({ name: "Simon Baker", company: "Haus & Haus", role: "" }));
  assert.equal(untracked.result.ok, false);
  assert.equal(db.tables.tracked_people.length, 4);
});

test("a spokesperson is marked former or current, or removed", async () => {
  db.reset({ ...REGISTRY });
  assert.deepEqual((await inAction((a) => a.setPersonActiveAction(12, true))).result, { ok: true });
  assert.equal(db.row("tracked_people", 12)?.active, true);
  assert.deepEqual((await inAction((a) => a.setPersonActiveAction(999, false))).result, {
    ok: false,
    error: "That person is no longer on the list.",
  });
  assert.deepEqual((await inAction((a) => a.setPersonActiveAction(1.5, true))).result, {
    ok: false,
    error: "That person could not be found.",
  });
  assert.deepEqual((await inAction((a) => a.removePersonAction(13))).result, { ok: true });
  assert.equal(db.row("tracked_people", 13), undefined);
  assert.deepEqual((await inAction((a) => a.removePersonAction(13))).result, {
    ok: false,
    error: "That person is no longer on the list.",
  });
});

test("Reject closes an article no row carries: a failed one is saved as decided, about no company", async () => {
  db.reset({ ...REGISTRY, news_articles: [article({ status: "failed", decision: null, error: "Claude's answer was cut off" })], mentions: [] });
  const { result } = await inAction((a) => a.rejectArticleAction(ID));
  assert.deepEqual(result, { ok: true });
  const stored = db.row("news_articles", ID);
  assert.equal(stored?.status, "decided", "no later run picks it up again");
  assert.equal(stored?.note, "rejected by a person");
  assert.equal(stored?.error, null);
  const decision = stored?.decision as Row;
  assert.deepEqual(decision.mentions, []);
  assert.equal(decision.model, "person");
  assert.equal(db.tables.mentions.length, 0);
});

test("Reject on a held article closes it, so turning counting on never publishes it", async () => {
  db.reset({
    ...REGISTRY,
    news_articles: [
      article({
        status: "held",
        decision: {
          mentions: [{ company: "Knight Frank", sentence: 1, quote: "Knight Frank said prime prices held.", role: "data", sentiment: "neutral" }],
          irrelevantReason: null,
          possibleMoves: [],
          dropped: [],
          model: "claude-haiku-5-5",
          checkedAt: "2026-11-05T04:12:00.000Z",
        },
      }),
    ],
    mentions: [],
  });
  assert.deepEqual((await inAction((a) => a.rejectArticleAction(ID))).result, { ok: true });
  const stored = db.row("news_articles", ID);
  assert.equal(stored?.status, "decided");
  assert.deepEqual((stored?.decision as Row).mentions, []);
});

test("Reject on an article already decided changes its rows and note, not its decision", async () => {
  const decided = article({
    decision: {
      mentions: [{ company: "betterhomes", sentence: 2, quote: OUR_SENTENCE, role: "spokesperson", sentiment: "positive" }],
      irrelevantReason: null,
      possibleMoves: [],
      dropped: [],
      model: "claude-haiku-5-5",
      checkedAt: "2026-11-05T04:12:00.000Z",
    },
  });
  db.reset({ ...REGISTRY, news_articles: [decided], mentions: [{ id: `nb_${ID}`, source: "googlenews", status: "new", metadata: { articleId: ID } }] });
  assert.deepEqual((await inAction((a) => a.rejectArticleAction(ID))).result, { ok: true });
  const stored = db.row("news_articles", ID);
  assert.equal(stored?.status, "decided");
  assert.deepEqual(stored?.decision, decided.decision, "the AI's view stays on record beside the person's");
  assert.equal(stored?.note, "rejected by a person");
  assert.equal(db.row("mentions", `nb_${ID}`)?.status, "rejected");
});

test("a failed close is an error to show when the article is what holds the verdict", async () => {
  db.reset({
    ...REGISTRY,
    news_articles: [article({ status: "queued", decision: null, legacy_mention_id: LEGACY })],
    mentions: [{ id: LEGACY, source: "googlenews", status: "new", metadata: {} }],
  });
  db.fault = (method, table) => (method === "PATCH" && table === "news_articles" ? "canceling statement due to statement timeout" : null);
  const { result } = await inAction((a) => a.rejectArticleAction(ID));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /could not be marked as decided .*statement timeout.*Reject it again/);
  // The close comes first, so a run can't take the article while its rows are being marked: none was touched.
  assert.equal(db.row("mentions", LEGACY)?.status, "new");
  assert.equal(db.requests.some((r) => r.method === "PATCH" && r.table === "mentions"), false);
});

/** Who holds the article: a read run's claim, as claim_news_articles leaves it. */
const CLAIM = { claimed_by: "nr20261106T040000-abcd1234", claimed_at: "2026-11-06T04:00:05.000Z" };

test("Reject on an article a run holds closes it first and lets go of the claim, so the run saves nothing over it", async () => {
  for (const status of ["reading", "checking"]) {
    db.reset({
      ...REGISTRY,
      news_articles: [article({ status, decision: null, legacy_mention_id: LEGACY, note: "re-checking the old bot's story", ...CLAIM })],
      mentions: [{ id: LEGACY, source: "googlenews", status: "new", metadata: {} }],
    });
    assert.deepEqual((await inAction((a) => a.rejectArticleAction(ID))).result, { ok: true }, status);
    const stored = db.row("news_articles", ID);
    assert.deepEqual([stored?.status, stored?.note, stored?.claimed_by, stored?.claimed_at], ["decided", "rejected by a person", null, null], status);
    assert.equal((stored?.decision as Row).model, "person");
    assert.equal(meta(db.row("mentions", LEGACY)).personVerdict, "rejected");
    // Only while it is still in the status just read, and before any row is marked.
    const writes = db.requests.filter((r) => r.method === "PATCH");
    assert.deepEqual(
      writes.map((r) => r.table),
      ["news_articles", "mentions"],
      status,
    );
    assert.ok(writes[0].params.some(([k, v]) => k === "status" && v === `eq.${status}`), status);
  }
});

test("Reject on an article a run moved on since it was read goes by where the article is now", async () => {
  // The read step saved it as read between the look and the close: it is closed from there.
  db.reset({ ...REGISTRY, news_articles: [article({ status: "reading", decision: null, ...CLAIM })], mentions: [] });
  let moved = false;
  db.fault = (method, table) => {
    if (!moved && method === "PATCH" && table === "news_articles") {
      moved = true;
      Object.assign(db.row("news_articles", ID) as Row, { status: "read", claimed_by: null, claimed_at: null });
    }
    return null;
  };
  assert.deepEqual((await inAction((a) => a.rejectArticleAction(ID))).result, { ok: true });
  assert.deepEqual([db.row("news_articles", ID)?.status, db.row("news_articles", ID)?.note], ["decided", "rejected by a person"]);

  // The check decided it first: its decision stays on record beside the person's, and its row stops counting.
  const ai = { mentions: [{ company: "betterhomes", sentence: 2, quote: OUR_SENTENCE, role: "data", sentiment: "neutral" }], model: "claude-haiku-5-5" };
  db.reset({ ...REGISTRY, news_articles: [article({ status: "checking", decision: null, ...CLAIM })], mentions: [] });
  moved = false;
  db.fault = (method, table) => {
    if (!moved && method === "PATCH" && table === "news_articles") {
      moved = true;
      Object.assign(db.row("news_articles", ID) as Row, { status: "decided", decision: ai, claimed_by: null, claimed_at: null });
      db.tables.mentions.push({ id: `nb_${ID}`, source: "googlenews", status: "new", metadata: { articleId: ID } });
    }
    return null;
  };
  assert.deepEqual((await inAction((a) => a.rejectArticleAction(ID))).result, { ok: true });
  const stored = db.row("news_articles", ID);
  assert.deepEqual([stored?.status, stored?.note, stored?.decision], ["decided", "rejected by a person", ai]);
  assert.deepEqual([db.row("mentions", `nb_${ID}`)?.status, meta(db.row("mentions", `nb_${ID}`)).personVerdict], ["rejected", "rejected"]);
});

test("Reject on an article the bot keeps moving on asks for another go, and touches no row", async () => {
  db.reset({
    ...REGISTRY,
    news_articles: [article({ status: "queued", decision: null, legacy_mention_id: LEGACY })],
    mentions: [{ id: LEGACY, source: "googlenews", status: "new", metadata: {} }],
  });
  // Each close finds it moved on once more.
  db.fault = (method, table) => {
    if (method === "PATCH" && table === "news_articles") {
      const row = db.row("news_articles", ID) as Row;
      row.status = row.status === "queued" ? "reading" : "queued";
    }
    return null;
  };
  const { result } = await inAction((a) => a.rejectArticleAction(ID));
  assert.deepEqual(result, { ok: false, error: "The bot is moving this article on right now. Reject it again in a minute." });
  assert.equal(db.requests.filter((r) => r.method === "PATCH" && r.table === "news_articles").length, 3);
  assert.equal(db.row("mentions", LEGACY)?.status, "new");
});

test("Keep after a person's own Reject replaces that rejection on the article", async () => {
  db.reset({
    ...REGISTRY,
    news_articles: [
      article({
        decision: {
          mentions: [],
          irrelevantReason: "a person rejected it",
          possibleMoves: [],
          dropped: [],
          model: "person",
          checkedAt: "2026-11-05T05:00:00.000Z",
        },
        note: "rejected by a person",
      }),
    ],
    mentions: [],
  });
  assert.deepEqual((await inAction((a) => a.keepArticleAction(ID))).result, { ok: true });
  const stored = db.row("news_articles", ID);
  assert.equal(stored?.note, "kept by a person");
  const mentions = (stored?.decision as Row).mentions as Row[];
  assert.deepEqual(
    mentions.map((m) => [m.company, m.quote]),
    [["betterhomes", OUR_SENTENCE]],
  );
  assert.equal(db.row("mentions", `nb_${ID}`)?.status, "reviewed");
});

/** An article the bot could not read: the site turned it away, with tries left, as Check by hand lists it. */
const unreadable = (over: Row = {}): Row =>
  article({
    status: "unreadable",
    found_by: ["knight frank dubai when:2d", "betterhomes when:2d"],
    body_status: "blocked",
    body_chars: 0,
    read_via: "plain",
    candidates: [],
    decision: null,
    note: "the site refused the read (HTTP 403)",
    next_try_at: "2026-11-06T00:01:00.000Z",
    ...over,
  });

test("Count for a rival writes its competitor row the way the bot would, reviewed, and the rival's coverage counts it", async () => {
  db.reset({ ...REGISTRY, news_articles: [unreadable()], mentions: [] });
  // Any spelling of the rival's name is that rival.
  const { result, revalidated } = await inAction((a) => a.keepArticleAction(ID, "knight  frank"));
  assert.deepEqual(result, { ok: true });
  const row = db.row("mentions", `nr_${ID}_knight-frank`);
  assert.ok(row, "the rival's row was added");
  assert.equal(db.tables.mentions.length, 1, "and no row for us");
  assert.equal(row.status, "reviewed");
  assert.equal(row.source, "competitor_news");
  assert.equal(row.brand, null);
  assert.equal(row.tier, "T1-Local");
  assert.equal(meta(row).competitor, "Knight Frank");
  assert.equal(meta(row).personVerdict, "kept");
  assert.equal(meta(row).articleId, ID);
  // The page was never read, so nothing names Knight Frank: the headline stands in, as sentence 0.
  assert.deepEqual(
    { ...(meta(row).factCheck as Row), checkedAt: "x" },
    { result: "pass", role: "passing", quote: "Dubai rents rise again", sentence: 0, checkedAt: "x", model: "person" },
  );
  // A person decided it, so no re-check or later write of the bot changes it.
  const { decidedByPerson } = await import("@/lib/news/write");
  assert.equal(decidedByPerson({ status: String(row.status), metadata: meta(row) }), true);

  // It stays unreadable under the person's note, and the bot does not try to read it again.
  const stored = db.row("news_articles", ID);
  assert.deepEqual([stored?.status, stored?.note, stored?.next_try_at], ["unreadable", "kept by a person", null]);

  // The competitor feed, which Share of Voice and Press mentions count, has it under Knight Frank.
  const { getCompetitorNews, shareOfVoice } = await import("@/lib/data");
  const rivals = await getCompetitorNews();
  assert.equal(rivals.error, null);
  assert.deepEqual(
    rivals.items.map((c) => [c.id, c.brand, c.articleId]),
    [[`nr_${ID}_knight-frank`, "Knight Frank", ID]],
  );
  assert.deepEqual(
    shareOfVoice(rivals.items, [], "2026-11-11").items.map((s) => [s.brand, s.mentions]),
    [["Knight Frank", 1]],
  );
  assert.ok(revalidated.some((t) => t.endsWith("/pr")));
  assert.ok(revalidated.some((t) => t.endsWith("/pr/settings")));
});

test("Count for betterhomes from Check by hand is a Keep, and stops the bot trying to read the page", async () => {
  db.reset({ ...REGISTRY, news_articles: [unreadable()], mentions: [] });
  assert.deepEqual((await inAction((a) => a.keepArticleAction(ID, "betterhomes"))).result, { ok: true });
  const row = db.row("mentions", `nb_${ID}`);
  assert.equal(row?.status, "reviewed");
  assert.equal(row?.brand, "betterhomes");
  assert.equal(meta(row).personVerdict, "kept");
  assert.equal(db.tables.mentions.length, 1);
  const stored = db.row("news_articles", ID);
  assert.deepEqual([stored?.status, stored?.note, stored?.next_try_at], ["unreadable", "kept by a person", null]);

  // An article the bot has read keeps its next try, as a Keep always left it.
  db.reset({ ...REGISTRY, news_articles: [article({ next_try_at: "2026-11-06T00:01:00.000Z" })], mentions: [] });
  assert.deepEqual((await inAction((a) => a.keepArticleAction(ID))).result, { ok: true });
  assert.equal(db.row("news_articles", ID)?.next_try_at, "2026-11-06T00:01:00.000Z");
});

test("an article about two companies is counted for both: Check by hand keeps it until each is decided", async () => {
  db.reset({ ...REGISTRY, news_articles: [unreadable()], mentions: [] });
  const { getHandCheckList } = await import("@/lib/data");
  const listed = async () => (await getHandCheckList())?.items.map((i) => [i.id, i.companies, i.counted]);
  assert.deepEqual(await listed(), [[ID, ["betterhomes", "Knight Frank"], []]]);

  assert.deepEqual((await inAction((a) => a.keepArticleAction(ID, "betterhomes"))).result, { ok: true });
  // Counted for us, it stays for Knight Frank, and says what counts.
  assert.deepEqual(await listed(), [[ID, ["Knight Frank"], ["betterhomes"]]]);

  assert.deepEqual((await inAction((a) => a.keepArticleAction(ID, "Knight Frank"))).result, { ok: true });
  for (const id of [`nb_${ID}`, `nr_${ID}_knight-frank`]) {
    const row = db.row("mentions", id);
    assert.deepEqual([row?.status, meta(row).personVerdict, meta(row).articleId], ["reviewed", "kept", ID], id);
  }
  // Each company decided: off the list, and in no count either.
  assert.deepEqual(await getHandCheckList(), { items: [], counted: 0, general: 0 });
});

test("Not about one company sets that company aside and leaves what counts for another", async () => {
  const imported = `lm_${LEGACY}`;
  // The old bot's row counts the story for Knight Frank, and a search for us found it too.
  const oldRow = {
    id: LEGACY,
    source: "competitor_news",
    status: "new",
    brand: null,
    published_on: "2026-11-04",
    outlet_name: "Khaleej Times",
    title: "Dubai rents rise again",
    url: "https://www.khaleejtimes.com/business/property/rents-rise-again",
    metadata: { competitor: "Knight Frank" },
  };
  const tables = {
    ...REGISTRY,
    news_articles: [unreadable({ id: imported, legacy_mention_id: LEGACY, found_by: ["betterhomes when:2d"] })],
    mentions: [oldRow],
  };
  db.reset(tables);
  const { getCompetitorNews, getHandCheckList } = await import("@/lib/data");
  assert.deepEqual((await getHandCheckList())?.items.map((i) => [i.companies, i.counted]), [[["betterhomes"], ["Knight Frank"]]]);

  const { result, revalidated } = await inAction((a) => a.rejectArticleAction(imported, "betterhomes"));
  assert.deepEqual(result, { ok: true });
  // Our row, written the bot's way, out of the count with the person's verdict, and nothing proving it.
  const ours = db.row("mentions", `nb_${imported}`);
  assert.deepEqual([ours?.status, ours?.source, ours?.brand], ["rejected", "googlenews", "betterhomes"]);
  assert.deepEqual([meta(ours).personVerdict, meta(ours).articleId, "factCheck" in meta(ours)], ["rejected", imported, false]);
  const { decidedByPerson } = await import("@/lib/news/write");
  assert.equal(decidedByPerson({ status: String(ours?.status), metadata: meta(ours) }), true);
  // Knight Frank's row still counts, untouched, and the article keeps its status and note, with no more tries.
  assert.deepEqual(db.row("mentions", LEGACY), oldRow);
  const stored = db.row("news_articles", imported);
  assert.deepEqual([stored?.status, stored?.note, stored?.next_try_at], ["unreadable", "the site refused the read (HTTP 403)", null]);
  assert.deepEqual((await getCompetitorNews()).items.map((c) => [c.id, c.brand]), [[LEGACY, "Knight Frank"]]);
  assert.ok(revalidated.some((t) => t.endsWith("/pr/settings")));
  // Off the list: it is still counted from the old bot, which This morning's run says.
  assert.deepEqual(await getHandCheckList(), { items: [], counted: 1, general: 0 });

  // A later Count for us is the person's later word, and stands instead.
  assert.deepEqual((await inAction((a) => a.keepArticleAction(imported))).result, { ok: true });
  assert.deepEqual([db.row("mentions", `nb_${imported}`)?.status, meta(db.row("mentions", `nb_${imported}`)).personVerdict], ["reviewed", "kept"]);

  // A company the bot does not track is refused, and a name that is not one before anything is read.
  db.reset(tables);
  const savills = await inAction((a) => a.rejectArticleAction(imported, "Savills"));
  assert.deepEqual(savills.result, { ok: false, error: "Savills is not a company the bot tracks, so nothing was changed." });
  db.requests = [];
  const odd = await inAction((a) => a.rejectArticleAction(imported, 7 as unknown as string));
  assert.deepEqual(odd.result, { ok: false, error: "That is not a company the bot tracks, so nothing was changed." });
  assert.equal(db.requests.length, 0, "nothing was asked of the database");
  assert.deepEqual(db.tables.mentions, [oldRow]);
  assert.equal(db.row("news_articles", imported)?.next_try_at, "2026-11-06T00:01:00.000Z");
});

test("Count refuses a company the bot does not track, and changes nothing", async () => {
  db.reset({ ...REGISTRY, news_articles: [unreadable()], mentions: [] });
  const savills = await inAction((a) => a.keepArticleAction(ID, "Savills"));
  assert.deepEqual(savills.result, {
    ok: false,
    error: "Savills is not a company the bot tracks, so nothing was counted. Count it for betterhomes or one of the tracked rivals.",
  });
  // Not a name at all: refused before anything is read.
  db.requests = [];
  const odd = await inAction((a) => a.keepArticleAction(ID, { label: "Knight Frank" } as unknown as string));
  assert.equal(odd.result.ok, false);
  assert.match(odd.result.ok ? "" : odd.result.error, /^That is not a company the bot tracks/);
  assert.equal(db.requests.length, 0, "nothing was asked of the database");
  assert.equal(db.tables.mentions.length, 0);
  assert.deepEqual([db.row("news_articles", ID)?.note, db.row("news_articles", ID)?.next_try_at], [
    "the site refused the read (HTTP 403)",
    "2026-11-06T00:01:00.000Z",
  ]);
});

test("Count refuses an article on the company's own website, which never counts for it, but not for another company", async () => {
  const tables = {
    ...REGISTRY,
    tracked_keywords: [
      { ...REGISTRY.tracked_keywords[0], aliases: ["Knight Frank", "Knight Frank UAE"], sites: ["knightfrank.*"] },
      REGISTRY.tracked_keywords[1],
      { id: 5, kind: "us", query: "betterhomes", label: "betterhomes", active: true, created_at: "2026-11-06", aliases: [], sites: ["bhomes.com"] },
    ],
    mentions: [],
  };
  db.reset({ ...tables, news_articles: [unreadable({ url: "https://www.knightfrank.ae/research/dubai-prime", outlet: "Knight Frank UAE" })] });
  const theirs = await inAction((a) => a.keepArticleAction(ID, "Knight Frank"));
  assert.deepEqual(theirs.result, {
    ok: false,
    error: "Nothing was counted for Knight Frank: the article is on its own website, which never counts as its coverage.",
  });
  assert.equal(db.tables.mentions.length, 0);
  assert.equal(db.row("news_articles", ID)?.note, "the site refused the read (HTTP 403)");
  // Knight Frank's page naming us is still ours to count.
  assert.deepEqual((await inAction((a) => a.keepArticleAction(ID))).result, { ok: true });
  assert.ok(db.row("mentions", `nb_${ID}`));

  // Our own website is never ours, by Keep either.
  db.reset({ ...tables, news_articles: [unreadable({ url: "https://www.bhomes.com/en/blog/dubai-rents", outlet: "bhomes.com" })] });
  assert.deepEqual((await inAction((a) => a.keepArticleAction(ID))).result, {
    ok: false,
    error: "Nothing was counted for betterhomes: the article is on its own website, which never counts as its coverage.",
  });
  assert.equal(db.tables.mentions.length, 0);
});

test("a rival needs its company name, and no rival is added twice under another spelling", async () => {
  const tracked = {
    ...REGISTRY,
    tracked_keywords: [
      ...REGISTRY.tracked_keywords,
      { id: 3, kind: "competitor", query: "engel volkers dubai", label: "Engel & Völkers", active: true, created_at: "2026-01-01" },
      { id: 4, kind: "competitor", query: "old rival dubai", label: "Old Rival", active: false, created_at: "2026-01-01" },
    ],
  };
  db.reset(tracked);
  const refused = async (label: string | undefined, query = "haus and haus dubai") => {
    const { result } = await inAction((a) => a.addKeywordAction("competitor", query, label));
    assert.equal(result.ok, false, `${label} was refused`);
    return result.ok ? "" : result.error;
  };
  assert.match(await refused(undefined), /company name, 2 to 60 characters/);
  assert.match(await refused("H"), /2 to 60 characters/);
  assert.match(await refused("x".repeat(61)), /2 to 60 characters/);
  assert.match(await refused("knight  frank"), /knight frank is already tracked, as Knight Frank/);
  assert.match(await refused("Engel and Volkers"), /already tracked, as Engel & Völkers/);
  assert.match(await refused("Better Homes"), /betterhomes, which is always tracked/);
  assert.match(await refused("Knight Frank Residential", "Knight Frank Dubai"), /"knight frank dubai" is already used for Knight Frank/);
  assert.equal(db.tables.tracked_keywords.length, 4, "nothing was added");

  // A rival no longer tracked does not stand in the way.
  const { result } = await inAction((a) => a.addKeywordAction("competitor", " haus and haus dubai ", "  Haus   &  Haus "));
  assert.deepEqual(result, { ok: true });
  const added = db.tables.tracked_keywords.find((k) => k.query === "haus and haus dubai");
  assert.deepEqual(
    { kind: added?.kind, label: added?.label, active: added?.active },
    { kind: "competitor", label: "Haus & Haus", active: true },
  );
});

test("a betterhomes search needs no name, and keeps none", async () => {
  db.reset({ ...REGISTRY });
  assert.deepEqual((await inAction((a) => a.addKeywordAction("pr", "  betterhomes dubai ", "ignored"))).result, { ok: true });
  const added = db.tables.tracked_keywords.find((k) => k.query === "betterhomes dubai");
  assert.equal(added?.kind, "pr");
  assert.equal(added?.label, null);
  assert.equal((await inAction((a) => a.addKeywordAction("pr", "   "))).result.ok, false);
});

test("a company's other spellings and websites are saved cleaned, on both PR pages, and betterhomes' spellings stay fixed", async () => {
  db.reset({
    ...REGISTRY,
    tracked_keywords: [
      ...REGISTRY.tracked_keywords,
      { id: 5, kind: "us", query: "betterhomes", label: "betterhomes", active: true, created_at: "2026-11-06", aliases: [], sites: ["bhomes.com"] },
    ],
  });
  const kf = await inAction((a) =>
    a.updateCompanyAction(1, { aliases: ["Knight Frank", " knight frank ", "Knight Frank UAE"], sites: ["https://www.knightfrank.ae/x", "knightfrank.*"] }),
  );
  assert.deepEqual(kf.result, { ok: true });
  assert.deepEqual(db.row("tracked_keywords", 1)?.aliases, ["Knight Frank", "Knight Frank UAE"]);
  assert.deepEqual(db.row("tracked_keywords", 1)?.sites, ["knightfrank.ae", "knightfrank.*"]);
  assert.ok(kf.revalidated.some((t) => t.endsWith("/pr")));
  assert.ok(kf.revalidated.some((t) => t.endsWith("/pr/settings")));

  // betterhomes' row takes websites only.
  assert.deepEqual((await inAction((a) => a.updateCompanyAction(5, { sites: ["bhomes.com", "betterhomes.ae"] }))).result, { ok: true });
  assert.deepEqual(db.row("tracked_keywords", 5)?.sites, ["bhomes.com", "betterhomes.ae"]);
  assert.deepEqual((await inAction((a) => a.updateCompanyAction(5, { aliases: ["bhomes"] }))).result, {
    ok: false,
    error: "betterhomes' spellings are fixed by the bot's own rules, so they can't be changed here.",
  });
  // A search is not a company, and a row that is gone, or no row at all, is said so.
  assert.deepEqual((await inAction((a) => a.updateCompanyAction(2, { sites: ["bhomes.com"] }))).result, {
    ok: false,
    error: "That is a search, not a company.",
  });
  assert.deepEqual((await inAction((a) => a.updateCompanyAction(99, { sites: [] }))).result, {
    ok: false,
    error: "That company is no longer on the list.",
  });
  assert.deepEqual((await inAction((a) => a.updateCompanyAction(1.5, { sites: [] }))).result, {
    ok: false,
    error: "That company could not be found.",
  });
  // A refused change writes nothing.
  assert.equal((await inAction((a) => a.updateCompanyAction(1, { sites: ["not a site"] }))).result.ok, false);
  assert.deepEqual(db.row("tracked_keywords", 1)?.sites, ["knightfrank.ae", "knightfrank.*"]);

  // No rival is added again under another one's spelling, and betterhomes' row is never removed.
  assert.deepEqual((await inAction((a) => a.addKeywordAction("competitor", "knight frank uae dubai", "Knight Frank UAE"))).result, {
    ok: false,
    error: "Knight Frank UAE is already tracked, as Knight Frank.",
  });
  const removed = await inAction((a) => a.removeKeywordAction(5));
  assert.deepEqual(removed.result, { ok: true });
  assert.ok(db.row("tracked_keywords", 5), "betterhomes' row stays");
  assert.ok(removed.revalidated.some((t) => t.endsWith("/pr/settings")));
});

test("every PR & Media settings action needs the settings PIN, and writes nothing without it", async () => {
  const { gate } = await loading;
  const appOnly = { [gate.COOKIES.app]: await gate.issueToken("app") };
  const LOCKED = { ok: false, error: "Settings are locked. Enter the settings PIN and try again." };
  const calls: [string, (a: Awaited<typeof loading>["actions"]) => Promise<unknown>][] = [
    ["setMentionStatus", (a) => a.setMentionStatusAction("m1", "rejected")],
    ["addKeyword", (a) => a.addKeywordAction("competitor", "haus and haus dubai", "Haus & Haus")],
    ["removeKeyword", (a) => a.removeKeywordAction(1)],
    ["updateCompany", (a) => a.updateCompanyAction(1, { sites: ["gulfnews.com"] })],
    ["runNewsBot", (a) => a.runNewsBotAction()],
    ["manualCheck", (a) => a.manualCheckAction()],
    ["keepArticle", (a) => a.keepArticleAction(ID)],
    ["countForRival", (a) => a.keepArticleAction(ID, "Knight Frank")],
    ["rejectArticle", (a) => a.rejectArticleAction(ID)],
    ["notAboutOneCompany", (a) => a.rejectArticleAction(ID, "Knight Frank")],
    ["addPerson", (a) => a.addPersonAction({ name: "Faisal Durrani", company: "Knight Frank", role: "" })],
    ["setPersonActive", (a) => a.setPersonActiveAction(12, true)],
    ["removePerson", (a) => a.removePersonAction(13)],
  ];
  for (const cookies of [{}, appOnly]) {
    for (const [name, call] of calls) {
      db.reset({ ...REGISTRY, news_articles: [article()], mentions: [{ id: "m1", status: "new", metadata: {} }] });
      steps.calls = [];
      assert.deepEqual((await inAction(call, cookies)).result, LOCKED, name);
      // Refused before anything was read or written, and no run was started.
      assert.deepEqual(db.requests, [], name);
      assert.deepEqual(steps.calls, [], name);
    }
  }
});

test("a company's list saved from a stale page is refused, and nothing is lost", async () => {
  db.reset({
    ...REGISTRY,
    tracked_keywords: [{ ...REGISTRY.tracked_keywords[0], aliases: ["Knight Frank", "Knight Frank UAE"], sites: ["knightfrank.*"] }],
  });
  // The page loaded before "Knight Frank UAE" was added in another tab.
  const stale = await inAction((a) => a.updateCompanyAction(1, { aliases: ["Knight Frank", "Knight Frank Residential"] }, { aliases: ["Knight Frank"] }));
  assert.deepEqual(stale.result, {
    ok: false,
    error: "These spellings were changed since this page loaded, so nothing was saved. Reload the page and try again.",
  });
  assert.deepEqual(db.row("tracked_keywords", 1)?.aliases, ["Knight Frank", "Knight Frank UAE"]);
  const staleSites = await inAction((a) => a.updateCompanyAction(1, { sites: [] }, { sites: ["knightfrank.ae"] }));
  assert.match(staleSites.result.ok ? "" : staleSites.result.error, /^These websites were changed since this page loaded/);
  // From the list that is stored, the change goes through.
  const fresh = await inAction((a) =>
    a.updateCompanyAction(1, { aliases: ["Knight Frank", "Knight Frank UAE", "Knight Frank Residential"] }, { aliases: ["Knight Frank", "Knight Frank UAE"] }),
  );
  assert.deepEqual(fresh.result, { ok: true });
  assert.deepEqual(db.row("tracked_keywords", 1)?.aliases, ["Knight Frank", "Knight Frank UAE", "Knight Frank Residential"]);
});

test("a spelling that names another tracked company is refused", async () => {
  db.reset({
    ...REGISTRY,
    tracked_keywords: [
      ...REGISTRY.tracked_keywords,
      { id: 3, kind: "competitor", query: "sothebys dubai", label: "Sotheby's", active: true, created_at: "2026-01-01", aliases: ["Sotheby's", "Luxhabitat"] },
      { id: 4, kind: "competitor", query: "old rival dubai", label: "Old Rival", active: false, created_at: "2026-01-01", aliases: [] },
    ],
  });
  for (const [alias, owner] of [
    ["Luxhabitat", "Sotheby's"],
    ["sothebys", "Sotheby's"],
  ]) {
    const { result } = await inAction((a) => a.updateCompanyAction(1, { aliases: ["Knight Frank", alias] }));
    assert.deepEqual(result, { ok: false, error: `"${alias}" is already a spelling of ${owner}, so it can't be Knight Frank's too.` }, alias);
  }
  assert.equal(db.row("tracked_keywords", 1)?.aliases, undefined, "nothing was saved");
  // A rival no longer tracked, and the company's own name, stand in nobody's way.
  assert.deepEqual((await inAction((a) => a.updateCompanyAction(1, { aliases: ["Knight Frank", "Old Rival"] }))).result, { ok: true });
});

test("the ad-account list needs the settings PIN", async () => {
  db.reset({ paid_config: [] });
  const accounts = { google: [{ id: " 123-456 ", name: "Main" }], meta: [], linkedin: [] };
  const locked = await inAction((a) => a.savePaidConfigAction(accounts), {});
  assert.equal(locked.result.ok, false);
  assert.match(locked.result.ok ? "" : locked.result.error, /settings PIN/);
  assert.equal(db.tables.paid_config.length, 0, "nothing was saved");

  const saved = await inAction((a) => a.savePaidConfigAction(accounts), await unlocked());
  assert.deepEqual(saved.result, { ok: true });
  assert.deepEqual((db.row("paid_config", 1)?.payload as Row).accounts, {
    google: [{ id: "123-456", name: "Main" }],
    meta: [],
    linkedin: [],
  });
});

test("Receive Insights checks the months before reading anything", async () => {
  db.reset({});
  for (const [from, to] of [
    ["2026-13", "2026-11"],
    ["2026-1", "2026-11"],
    ["2026-11", "2026-10"],
  ]) {
    const { result } = await inAction((a) => a.receiveInsightsAction(from, to));
    assert.equal(result.ok, false, `${from} to ${to}`);
    assert.match(result.ok ? "" : result.error, /valid date range/);
  }
  assert.equal(db.requests.length, 0);
});

const ourMention = (over: Row = {}): Row => ({
  id: "m_ours",
  published_on: "2026-11-04",
  tier: "T1-Local",
  outlet_name: "Khaleej Times",
  title: "Dubai rents rise again",
  url: null,
  eav: null,
  reach: null,
  brand: "betterhomes",
  sentiment: "positive",
  source: "googlenews",
  status: "new",
  metadata: {},
  ...over,
});

test("Receive Insights says so when the rivals' stories could not be read, and asks no AI", async () => {
  db.reset({ ...REGISTRY, mentions: [ourMention()] });
  db.fault = (method, table, params) =>
    method === "GET" && table === "mentions" && params.some(([k, v]) => k === "source" && v === "eq.competitor_news")
      ? "canceling statement due to statement timeout"
      : null;
  const { result } = await inAction((a) => a.receiveInsightsAction("2026-10", "2026-11"));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /^Rival coverage could not be read just now \(.*statement timeout.*\), so no insights were asked for/);
});

test("Receive Insights reads the page's own rows and hands them to Claude, here with no key set", async () => {
  db.reset({
    ...REGISTRY,
    mentions: [
      ourMention(),
      { ...ourMention({ id: "c1", source: "competitor_news", brand: null, title: "Knight Frank on prime" }), metadata: { competitor: "Knight Frank" } },
    ],
  });
  const { result } = await inAction((a) => a.receiveInsightsAction("2026-10", "2026-11"));
  // The rows were in range, so the only thing missing is the key: the wiring reached the AI call.
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /No Claude key is set \(ANTHROPIC_API_KEY\)/);
});

test("news settings need the settings PIN, are cleaned, and leave the rest of the row alone", async () => {
  // A monthly cap on Apify reads, as the settings once had, is still stored here.
  const stored = {
    supermetricsEnabled: false,
    note: "Monthly quota spent",
    seoSource: "direct",
    news: { model: "claude-haiku-5-5", apifyBackup: false, apifyMonthlyCap: 30, searchWindow: "2d", countOnPrTab: false, laterSetting: "kept" },
  };
  db.reset({ app_settings: [{ id: 1, payload: stored, updated_at: "2026-11-01T00:00:00.000Z" }] });
  steps.calls = [];
  // A page opened before the cap went still sends one.
  const next = { model: "claude-opus-5-5", apifyBackup: true, apifyMonthlyCap: 9999, searchWindow: "7d", countOnPrTab: false } as const;

  const locked = await inAction((a) => a.setNewsSettingsAction(next), {});
  assert.deepEqual(locked.result, { ok: false, error: "Settings are locked. Enter the settings PIN and try again." });
  const { gate } = await loading;
  const appOnly = { [gate.COOKIES.app]: await gate.issueToken("app") };
  assert.equal((await inAction((a) => a.setNewsSettingsAction(next), appOnly)).result.ok, false);
  assert.deepEqual(db.row("app_settings", 1)?.payload, stored);

  const saved = await inAction((a) => a.setNewsSettingsAction(next), await unlocked());
  // There is no cap any more: the one sent is dropped, and the form is told what was stored, with none.
  const cleaned = { model: "claude-opus-5-5", apifyBackup: true, searchWindow: "7d", countOnPrTab: false };
  assert.deepEqual(saved.result, { ok: true, settings: cleaned, publish: null });
  // The cap stored before is left in the row with the rest, and nothing reads it.
  assert.deepEqual(db.row("app_settings", 1)?.payload, { ...stored, news: { ...cleaned, apifyMonthlyCap: 30, laterSetting: "kept" } });
  // Saved from PR & Media settings, which shows them, for the PR tab; the main Settings page no longer shows them.
  assert.ok(saved.revalidated.some((t) => t.endsWith("/pr/settings")));
  assert.ok(saved.revalidated.some((t) => t.endsWith("/pr")));
  assert.ok(!saved.revalidated.some((t) => t.endsWith("_/settings")), saved.revalidated.join(", "));
  assert.deepEqual(steps.calls, [], "still in test mode: nothing to publish");
});

test("turning counting on again starts the publish step, and says whether it started", async () => {
  const off: NewsSettings = { model: "claude-haiku-5-5", apifyBackup: false, searchWindow: "2d", countOnPrTab: false };
  const testMode = { news: off };
  const on: NewsSettings = { ...off, countOnPrTab: true };
  const keys = await unlocked();

  db.reset({ app_settings: [{ id: 1, payload: testMode }] });
  steps.calls = [];
  steps.answer = async () => ({ runId: "nr_1", started: true });
  const started = await inAction((a) => a.setNewsSettingsAction(on), keys);
  assert.deepEqual(started.result, { ok: true, settings: on, publish: { started: true } });
  assert.deepEqual(steps.calls, [{ step: "publish", trigger: "manual" }]);
  assert.equal((db.row("app_settings", 1)?.payload as { news: Row }).news.countOnPrTab, true, "saved before the publish began");
  assert.ok(started.revalidated.some((t) => t.endsWith("/pr")));

  // Already on: saving again publishes nothing.
  steps.calls = [];
  assert.deepEqual((await inAction((a) => a.setNewsSettingsAction(on), keys)).result, { ok: true, settings: on, publish: null });
  assert.deepEqual(steps.calls, []);

  // Never switched off (no value stored) counts as on.
  db.reset({ app_settings: [{ id: 1, payload: { news: { model: "claude-haiku-5-5" } } }] });
  await inAction((a) => a.setNewsSettingsAction(on), keys);
  assert.deepEqual(steps.calls, []);

  // The publish refused or failing to start is reported; the save stands.
  db.reset({ app_settings: [{ id: 1, payload: testMode }] });
  steps.answer = async () => ({ runId: "nr_2", started: false, error: "the news bot did not confirm that it started" });
  assert.deepEqual((await inAction((a) => a.setNewsSettingsAction(on), keys)).result, {
    ok: true,
    settings: on,
    publish: { started: false, error: "the news bot did not confirm that it started" },
  });
  db.reset({ app_settings: [{ id: 1, payload: testMode }] });
  steps.answer = async () => {
    throw new Error("CRON_SECRET not set");
  };
  assert.deepEqual((await inAction((a) => a.setNewsSettingsAction(on), keys)).result, {
    ok: true,
    settings: on,
    publish: { started: false, error: "CRON_SECRET not set" },
  });
  assert.equal((db.row("app_settings", 1)?.payload as { news: Row }).news.countOnPrTab, true);
  steps.answer = async () => ({ runId: "nr_test", started: true });

  // Switching counting off starts nothing.
  steps.calls = [];
  db.reset({ app_settings: [{ id: 1, payload: { news: on } }] });
  assert.deepEqual((await inAction((a) => a.setNewsSettingsAction({ ...on, countOnPrTab: false }), keys)).result, {
    ok: true,
    settings: { ...on, countOnPrTab: false },
    publish: null,
  });
  assert.deepEqual(steps.calls, []);
});

test("a stale Settings tab can't switch counting: the save is refused when the stored value has changed", async () => {
  const off: NewsSettings = { model: "claude-haiku-5-5", apifyBackup: false, searchWindow: "2d", countOnPrTab: false };
  const keys = await unlocked();
  db.reset({ app_settings: [{ id: 1, payload: { news: off } }] });
  steps.calls = [];
  // The tab loaded while counting was on; someone has turned test mode on since.
  const stale = await inAction((a) => a.setNewsSettingsAction({ ...off, countOnPrTab: true }, true), keys);
  assert.equal(stale.result.ok, false);
  assert.match(String((stale.result as { error?: string }).error), /changed since this page loaded/);
  assert.equal((db.row("app_settings", 1)?.payload as { news: Row }).news.countOnPrTab, false, "nothing saved");
  assert.deepEqual(steps.calls, [], "nothing published");
  // The same save from a tab that showed what is stored goes through.
  steps.answer = async () => ({ runId: "nr_2", started: true });
  const fresh = await inAction((a) => a.setNewsSettingsAction({ ...off, countOnPrTab: true }, false), keys);
  assert.equal(fresh.result.ok, true);
});

test("a publish that may have started without confirming says so, and is not retried", async () => {
  const off: NewsSettings = { model: "claude-haiku-5-5", apifyBackup: false, searchWindow: "2d", countOnPrTab: false };
  const keys = await unlocked();
  db.reset({ app_settings: [{ id: 1, payload: { news: off } }] });
  steps.calls = [];
  steps.answer = async () => ({ runId: "nr_3", started: false, uncertain: true, error: "The news bot did not confirm that it started." });
  const r = await inAction((a) => a.setNewsSettingsAction({ ...off, countOnPrTab: true }), keys);
  assert.equal(r.result.ok, true);
  assert.deepEqual((r.result as { publish?: unknown }).publish, { started: false, uncertain: true, error: "The news bot did not confirm that it started." });
  assert.equal(steps.calls.length, 1);
});

// ─── Manually check: the bot on what is already waiting, with no new search ──

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inA = (ms: number) => new Date(Date.now() + ms).toISOString();

/** The Dubai day news_runs files a step under (lib/news/store.ts dubaiDay). */
const dubaiToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** This deployment, as its news_runs rows are marked (lib/news/store.ts runEnv). */
const HERE = process.env.VERCEL_ENV || "development";

/** A step on this deployment's run log today, started a minute ago and still working. */
const workingStep = (over: Row = {}): Row => ({
  id: 1,
  run_id: "nr20261112T040000-abcd1234",
  run_day: dubaiToday(),
  step: "read",
  link: 3,
  trigger: "cron",
  env: HERE,
  started_at: ago(MINUTE),
  finished_at: null,
  ok: null,
  counts: {},
  error: null,
  ...over,
});

/** An unreadable article whose retry has come, with tries left: the morning's re-queue puts it back. */
const dueRetry = (id: string) => article({ id, status: "unreadable", read_attempts: 1, next_try_at: ago(HOUR), note: "the site refused the read (HTTP 403)" });

const manualCheck = () => inAction((a) => a.manualCheckAction());

test("Manually check is refused while this deployment's run log shows a step working, before anything is moved", async () => {
  db.reset({ ...REGISTRY, news_runs: [workingStep()], news_articles: [dueRetry("na_due")] });
  steps.calls = [];
  const { result } = await manualCheck();
  assert.deepEqual(result, { ok: false, error: "A run is working now. Its numbers appear below as it goes." });
  assert.deepEqual(steps.calls, []);
  // Only the run log was read: nothing was put back or counted.
  assert.deepEqual(db.requests.map((r) => `${r.method} ${r.table}`), ["GET news_runs"]);
  assert.equal(db.row("news_articles", "na_due")?.status, "unreadable");
});

test("a finished step, another deployment's run, or a run log that can't be read does not stand in Manually check's way", async () => {
  const elsewhere = HERE === "production" ? "preview" : "production";
  const cases: [string, Row[], string | null][] = [
    ["a step that finished", [workingStep({ finished_at: ago(MINUTE / 2), ok: true })], null],
    ["a step left open for good", [workingStep({ started_at: ago(HOUR) })], null],
    ["another deployment's run", [workingStep({ env: elsewhere })], null],
    ["a run log that can't be read", [workingStep()], "permission denied for table news_runs"],
  ];
  for (const [why, runs, fault] of cases) {
    db.reset({ ...REGISTRY, news_runs: runs, news_articles: [article({ id: "na_queued", status: "queued" })] });
    db.fault = (_method, table) => (table === "news_runs" ? fault : null);
    steps.calls = [];
    steps.answer = async () => ({ runId: "nr_mc", started: true });
    assert.deepEqual((await manualCheck()).result, { ok: true, waiting: 1, runId: "nr_mc" }, why);
    assert.deepEqual(steps.calls, [{ step: "read", trigger: "manual" }], why);
  }
  steps.answer = async () => ({ runId: "nr_test", started: true });
});

test("Manually check with nothing waiting starts nothing, and says nothing waits", async () => {
  db.reset({
    ...REGISTRY,
    // Test mode: held decisions wait for counting to be switched on, not for a run.
    app_settings: [{ id: 1, payload: { news: { countOnPrTab: false } } }],
    news_articles: [
      article({ id: "na_done" }),
      article({ id: "na_later", status: "unreadable", read_attempts: 1, next_try_at: inA(HOUR) }),
      article({ id: "na_tried", status: "unreadable", read_attempts: 3, next_try_at: ago(HOUR) }),
      article({ id: "na_ai_later", status: "read", ai_attempts: 1, next_try_at: inA(HOUR) }),
      article({ id: "na_held", status: "held" }),
      article({ id: "na_reading", status: "reading", claimed_by: "nr_other", claimed_at: ago(MINUTE) }),
      article({ id: "na_failed", status: "failed" }),
    ],
  });
  steps.calls = [];
  const { result } = await manualCheck();
  assert.deepEqual(result, { ok: true, waiting: 0 });
  assert.deepEqual(steps.calls, []);
  assert.equal(db.row("news_articles", "na_later")?.status, "unreadable");
  assert.equal(db.row("news_articles", "na_tried")?.status, "unreadable");
});

test("Manually check puts back what is due by the morning's rule, then starts a run at the read step and says how many wait", async () => {
  db.reset({
    ...REGISTRY,
    news_articles: [
      dueRetry("na_due"),
      article({ id: "na_queued", status: "queued" }),
      article({ id: "na_read", status: "read" }),
      // Counting is on (nothing stored says otherwise), so the chain publishes what is held.
      article({ id: "na_held", status: "held" }),
      // Claimed by a run that died twenty minutes ago: past the claim's lease.
      article({ id: "na_left", status: "checking", claimed_by: "nr_dead", claimed_at: ago(20 * MINUTE) }),
      article({ id: "na_later", status: "unreadable", read_attempts: 1, next_try_at: inA(HOUR) }),
      article({ id: "na_ai_later", status: "read", ai_attempts: 1, next_try_at: inA(HOUR) }),
      article({ id: "na_done" }),
    ],
  });
  let atStart: unknown = null;
  steps.calls = [];
  steps.answer = async () => {
    atStart = db.row("news_articles", "na_due")?.status;
    return { runId: "nr_mc", started: true };
  };
  const { result, revalidated } = await manualCheck();
  assert.deepEqual(result, { ok: true, waiting: 5, runId: "nr_mc" });
  assert.deepEqual(steps.calls, [{ step: "read", trigger: "manual" }]);
  // Put back before the run started, as the search step's re-queue puts it back: unreadable, under three tries, its time come.
  assert.equal(atStart, "queued");
  assert.equal(db.row("news_articles", "na_later")?.status, "unreadable");
  assert.ok(revalidated.some((t) => t.endsWith("/pr/settings")));
  steps.answer = async () => ({ runId: "nr_test", started: true });
});

test("Manually check whose re-queue or count fails says so, with the reason, and starts nothing", async () => {
  const timeout = "canceling statement due to statement timeout";
  const cases: [string, FakeSupabase["fault"], string][] = [
    ["the re-queue", (method, table) => (method === "PATCH" && table === "news_articles" ? timeout : null), `re-queueing unreadable articles failed: ${timeout}`],
    ["the count", (method) => (method === "HEAD" ? timeout : null), `counting what is waiting failed: ${timeout}`],
  ];
  for (const [why, fault, reason] of cases) {
    db.reset({ ...REGISTRY, news_articles: [dueRetry("na_due"), article({ id: "na_queued", status: "queued" })] });
    db.fault = fault;
    steps.calls = [];
    const { result } = await manualCheck();
    assert.deepEqual(result, { ok: false, error: `What is waiting could not be checked, so nothing was started: ${reason}` }, why);
    assert.deepEqual(steps.calls, [], why);
  }
});

test("a Manually check whose start got no answer says the run may be working, and one refused says why", async () => {
  db.reset({ ...REGISTRY, news_articles: [article({ id: "na_queued", status: "queued" })] });
  const noAnswer = "The news bot did not confirm that it started. It may still be running, so look at this morning's run in a few minutes.";
  steps.calls = [];
  steps.answer = async () => ({ runId: "nr_u", started: false, uncertain: true, error: noAnswer });
  assert.deepEqual((await manualCheck()).result, { ok: false, uncertain: true, error: noAnswer });
  assert.equal(steps.calls.length, 1, "asked once, never again over a run that may be working");
  steps.answer = async () => ({ runId: "nr_r", started: false, error: "The news bot could not be started: no address" });
  assert.deepEqual((await manualCheck()).result, { ok: false, error: "The news bot could not be started: no address" });
  steps.answer = async () => ({ runId: "nr_test", started: true });
});
