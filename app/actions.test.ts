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
  else throw new Error(`the stand-in does not know the filter ${op}`);
  return negate ? !ok : ok;
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
    const hit = (r: Row) => filters.every(([k, v]) => matches(r, k, v));
    const answer = (data: Row[], status = 200) =>
      method === "GET" || prefer.includes("return=representation") ? json(structuredClone(data), status) : new Response(null, { status: 204 });

    if (method === "GET") return answer(rows.filter(hit).map((r) => withAliases(r, url.searchParams.get("select"))));
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

/** Run an action the way Next runs one, with these cookies on the request. Returns its result and the paths it revalidated. */
async function inAction<T>(call: (a: Awaited<typeof loading>["actions"]) => Promise<T>, cookies: Record<string, string> = {}) {
  const { actions, work, unit } = await loading;
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
  assert.ok(revalidated.some((t) => t.endsWith("/pr")));
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
          irrelevantReason: "a person rejected it on Bot Activity",
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

test("the ad-account list needs the settings PIN", async () => {
  db.reset({ paid_config: [] });
  const accounts = { google: [{ id: " 123-456 ", name: "Main" }], meta: [], linkedin: [] };
  const locked = await inAction((a) => a.savePaidConfigAction(accounts));
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
  const stored = {
    supermetricsEnabled: false,
    note: "Monthly quota spent",
    seoSource: "direct",
    news: { model: "claude-haiku-5-5", apifyBackup: false, apifyMonthlyCap: 30, searchWindow: "2d", countOnPrTab: false, laterSetting: "kept" },
  };
  db.reset({ app_settings: [{ id: 1, payload: stored, updated_at: "2026-11-01T00:00:00.000Z" }] });
  steps.calls = [];
  const next = { model: "claude-opus-5-5", apifyBackup: true, apifyMonthlyCap: 9999, searchWindow: "7d", countOnPrTab: false } as const;

  const locked = await inAction((a) => a.setNewsSettingsAction(next));
  assert.deepEqual(locked.result, { ok: false, error: "Settings are locked. Enter the settings PIN and try again." });
  const { gate } = await loading;
  const appOnly = { [gate.COOKIES.app]: await gate.issueToken("app") };
  assert.equal((await inAction((a) => a.setNewsSettingsAction(next), appOnly)).result.ok, false);
  assert.deepEqual(db.row("app_settings", 1)?.payload, stored);

  const saved = await inAction((a) => a.setNewsSettingsAction(next), await unlocked());
  // A cap outside 0 to 500 falls back to the default, and the form is told what was stored.
  const cleaned = { model: "claude-opus-5-5", apifyBackup: true, apifyMonthlyCap: 30, searchWindow: "7d", countOnPrTab: false };
  assert.deepEqual(saved.result, { ok: true, settings: cleaned, publish: null });
  assert.deepEqual(db.row("app_settings", 1)?.payload, { ...stored, news: { ...cleaned, laterSetting: "kept" } });
  assert.ok(saved.revalidated.some((t) => t.endsWith("/settings")));
  assert.deepEqual(steps.calls, [], "still in test mode: nothing to publish");
});

test("turning counting on again starts the publish step, and says whether it started", async () => {
  const off: NewsSettings = { model: "claude-haiku-5-5", apifyBackup: false, apifyMonthlyCap: 30, searchWindow: "2d", countOnPrTab: false };
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
