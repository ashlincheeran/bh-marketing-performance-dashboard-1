import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_RETRY_MS,
  FINISH_GRACE_MS,
  MAX_LINKS,
  STEP_BUDGET_MS,
  UNREADABLE_RETRY_MS,
  aiFailurePatch,
  apifyReadsIn,
  apifyWithinCap,
  companiesNamedIn,
  dubaiMonth,
  firstLink,
  COUNTING_OFF,
  INSIGHTS_TIMEOUT_MS,
  handOff,
  handOffOrigin,
  handOffRequest,
  insightsBudgetMs,
  isCronRequest,
  newRunId,
  nextMove,
  originFromHeaders,
  parseLinkRequest,
  readOutcome,
  rejectedByPerson,
  runLink,
  runStep,
  startNewsStep,
  startPool,
  summariseRun,
  type ChainDeps,
  type Ending,
  type HandOff,
  type LinkRequest,
  type LinkResult,
  type StartStep,
  type StepDeps,
} from "@/lib/news/run";
import { buildRegistry } from "@/lib/news/registry";
import { buildQueries } from "@/lib/news/search";
import { DEFAULT_NEWS_SETTINGS } from "@/lib/appSettings";
import type { AiFailure } from "@/lib/claude";
import type { SameStory } from "@/lib/news/write";
import type {
  ArticleRow,
  ArticleStatus,
  Candidate,
  DecidedMention,
  Decision,
  NewsSettings,
  ReadResult,
  StepCounts,
  StepResult,
} from "@/lib/news/types";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const REG = buildRegistry(
  [{ label: "Knight Frank", query: "knight frank dubai" }],
  [{ name: "Louis Harding", company: "Knight Frank", role: "CEO", aliases: [], active: true, note: null }],
);

const START = Date.parse("2026-11-05T04:00:00.000Z");

function article(over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: "na_1",
    google_link: "https://news.google.com/rss/articles/abc?oc=5",
    url: null,
    url_key: null,
    title: "Prices rise in Dubai",
    title_key: "prices rise in dubai",
    outlet: "Zawya",
    outlet_key: "zawya",
    published_on: "2026-11-05",
    found_by: ["dubai real estate"],
    status: "queued",
    read_attempts: 0,
    ai_attempts: 0,
    body_status: null,
    body_chars: null,
    read_via: null,
    candidates: null,
    decision: null,
    legacy_mention_id: null,
    dup_of: null,
    note: null,
    error: null,
    next_try_at: null,
    claimed_at: null,
    claimed_by: null,
    first_seen_at: "2026-11-05T04:00:00.000Z",
    updated_at: "2026-11-05T04:00:00.000Z",
    ...over,
  };
}

const candidate = (n: number, text: string, companies: string[], people: string[] = []): Candidate => ({ n, text, companies, people });

const decision = (mentions: DecidedMention[] = []): Decision => ({
  mentions,
  irrelevantReason: mentions.length ? null : "not about any tracked company",
  possibleMoves: [],
  dropped: [],
  model: "claude-haiku-5-5",
  checkedAt: "2026-11-05T04:10:00.000Z",
});

const read = (over: Partial<ReadResult> = {}): ReadResult => ({ text: "", status: "empty", via: "plain", resolvedUrl: null, ...over });

/** Long enough to count as read in full, and naming nobody tracked. */
const PLAIN_TEXT = Array.from({ length: 12 }, (_, i) => `Dubai's property market grew again in month ${i + 1}, with more homes sold.`).join("\n");

/**
 * An in-memory news_articles table and everything else a step reaches, with
 * a clock the test moves. Claims honour next_try_at, as claim_news_articles does.
 */
function world(articles: ArticleRow[], over: Partial<StepDeps> = {}, settings: Partial<NewsSettings> = {}) {
  const clock = { now: START };
  const rows = new Map(articles.map((a) => [a.id, { ...a }]));
  const log = {
    claims: [] as { from: ArticleStatus; to: ArticleStatus; limit: number; got: string[] }[],
    saves: [] as { id: string; patch: Partial<ArticleRow> }[],
    released: [] as { ids: string[]; status: ArticleStatus; error: string | null }[],
    finished: [] as { ok: boolean; counts: StepCounts; error: string | null | undefined }[],
    started: [] as { step: string; runId: string; link: number; trigger: string }[],
  };
  const deps: StepDeps = {
    claim: async (from, to, limit, runId) => {
      const picked = [...rows.values()]
        .filter((a) => a.status === from && (!a.next_try_at || Date.parse(a.next_try_at) <= clock.now))
        .slice(0, limit);
      for (const a of picked) Object.assign(a, { status: to, claimed_by: runId });
      log.claims.push({ from, to, limit, got: picked.map((a) => a.id) });
      return picked.map((a) => ({ ...a }));
    },
    saveArticle: async (id, patch) => {
      log.saves.push({ id, patch });
      Object.assign(rows.get(id) as ArticleRow, patch, { claimed_by: null });
    },
    saveResolvedUrl: async (id, url) => {
      Object.assign(rows.get(id) as ArticleRow, { url });
      return { duplicateOf: null };
    },
    release: async (ids, status, error) => {
      log.released.push({ ids: [...ids], status, error });
      for (const id of ids) Object.assign(rows.get(id) as ArticleRow, { status, error, claimed_by: null });
    },
    waiting: async (status) => [...rows.values()].filter((a) => a.status === status).length,
    requeueDueUnreadable: async () => 0,
    insertFound: async () => ({ fresh: 0, repeats: 0, skipped: 0 }),
    startRun: async (step, runId, link, trigger) => {
      log.started.push({ step, runId, link, trigger });
      return 7;
    },
    finishRun: async (_id, ok, counts, error) => {
      log.finished.push({ ok, counts: { ...counts }, error });
    },
    loadRegistry: async () => REG,
    loadOutlets: async () => [],
    prKeywords: async () => [],
    newsSettings: async () => ({ ...DEFAULT_NEWS_SETTINGS, ...settings }),
    search: async () => ({ items: [], failures: [] }),
    readArticle: async () => read(),
    classifyArticle: async () => ({ decision: decision() }),
    writeDecision: async () => ({ ours: 0, rivals: 0, added: 0 }),
    withdrawLegacyRow: async () => false,
    withdrawLegacyRows: async () => ({ withdrawn: 0, personDecided: 0 }),
    // Held articles oldest first, as the store reads them.
    heldArticles: async (offset, limit) =>
      [...rows.values()]
        .filter((a) => a.status === "held")
        .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at) || a.id.localeCompare(b.id))
        .slice(offset, offset + limit)
        .map((a) => ({ ...a })),
    importedDuplicates: async () =>
      [...rows.values()]
        .filter((a) => a.status === "duplicate" && a.legacy_mention_id && a.dup_of)
        .map((a) => ({ id: a.id, legacy_mention_id: a.legacy_mention_id, dup_of: a.dup_of })),
    claudeConfigured: () => true,
    apifyReadsThisMonth: async () => 0,
    now: () => clock.now,
    ...over,
  };
  return { deps, rows, log, clock };
}

const CTX = { runId: "nr20261105T040000-abcd1234", link: 1, trigger: "cron", budgetMs: STEP_BUDGET_MS };

// ─── Pure parts ─────────────────────────────────────────────────────────────

test("a run id is nr, the start time and a random part, safe in an address", () => {
  const id = newRunId(new Date("2026-11-05T04:00:07.250Z"));
  assert.match(id, /^nr20261105T040007-[0-9a-f]{8}$/);
  assert.notEqual(newRunId(), newRunId());
  const first = firstLink("manual");
  assert.equal(first.step, "search");
  assert.equal(first.link, 0);
  assert.equal(first.trigger, "manual");
  assert.match(first.runId, /^nr\d{8}T\d{6}-[0-9a-f]{8}$/);
  // A chain can also start at publish, seed or a re-check, which carries its kind.
  assert.equal(firstLink("manual", "publish").step, "publish");
  assert.equal("kind" in firstLink("manual", "publish"), false);
  const recheck = firstLink("cron", "recheck", "rivals");
  assert.deepEqual([recheck.step, recheck.kind, recheck.link, recheck.trigger], ["recheck", "rivals", 0, "cron"]);
});

test("the chain goes search, read until the queue is empty, check until nothing waits, then the summary", () => {
  assert.deepEqual(nextMove("search", { more: false }, 0), { kind: "link", step: "read", link: 1 });
  assert.deepEqual(nextMove("read", { more: true }, 1), { kind: "link", step: "read", link: 2 });
  assert.deepEqual(nextMove("read", { more: false }, 2), { kind: "link", step: "check", link: 3 });
  assert.deepEqual(nextMove("check", { more: true }, 3), { kind: "link", step: "check", link: 4 });
  assert.deepEqual(nextMove("check", { more: false }, 4), { kind: "summary" });
  assert.deepEqual(nextMove("recheck", { more: false }, 0), { kind: "link", step: "read", link: 1 });
  assert.deepEqual(nextMove("seed", { more: false }, 0), { kind: "none" });
});

test("publish runs again while held articles wait, then the summary; a check that leaves some held goes on to publish", () => {
  assert.deepEqual(nextMove("publish", { more: true }, 0), { kind: "link", step: "publish", link: 1 });
  assert.deepEqual(nextMove("publish", { more: false }, 1), { kind: "summary" });
  assert.deepEqual(nextMove("publish", { more: false, error: "the outlets could not be read" }, 1), { kind: "summary" });
  assert.deepEqual(nextMove("check", { more: false, publishNext: true }, 4), { kind: "link", step: "publish", link: 5 });
  // Checking comes first while articles wait for it, and an AI that failed ends the run as before.
  assert.deepEqual(nextMove("check", { more: true, publishNext: true }, 4), { kind: "link", step: "check", link: 5 });
  assert.deepEqual(nextMove("check", { more: false, publishNext: true, aiError: "no credit" }, 4), { kind: "summary" });
});

test("an AI that can't answer, or a step that failed, ends the run with its summary", () => {
  assert.deepEqual(nextMove("check", { more: true, aiError: "no Claude key (ANTHROPIC_API_KEY)" }, 3), { kind: "summary" });
  assert.deepEqual(nextMove("read", { more: true, error: "claiming articles failed" }, 1), { kind: "summary" });
  assert.deepEqual(nextMove("search", { more: false, error: "rivals could not be read" }, 0), { kind: "summary" });
  assert.deepEqual(nextMove("recheck", { more: false, error: "re-queueing failed" }, 0), { kind: "summary" });
});

test("a run stops at 40 links, with a note that says so", () => {
  assert.equal(MAX_LINKS, 40);
  assert.deepEqual(nextMove("read", { more: true }, 38), { kind: "link", step: "read", link: 39 });
  const last = nextMove("read", { more: true }, 39);
  assert.equal(last.kind, "summary");
  assert.match((last as { note?: string }).note ?? "", /40 links/);
  assert.equal(nextMove("check", { more: true }, 2, 3).kind, "summary");
});

test("the Dubai month starts at Dubai midnight, and December rolls into January", () => {
  assert.deepEqual(dubaiMonth(new Date("2026-11-05T04:00:00Z")), { first: "2026-11-01", next: "2026-12-01" });
  // 21:00 UTC on 30 November is already 1 December in Dubai.
  assert.deepEqual(dubaiMonth(new Date("2026-11-30T21:00:00Z")), { first: "2026-12-01", next: "2027-01-01" });
  assert.deepEqual(dubaiMonth(new Date("2026-12-31T19:59:00Z")), { first: "2026-12-01", next: "2027-01-01" });
  assert.deepEqual(dubaiMonth(new Date("2026-12-31T20:00:00Z")), { first: "2027-01-01", next: "2027-02-01" });
});

test("Apify reads add up from the read steps' counts, and the cap is a ceiling", () => {
  assert.equal(apifyReadsIn([{ counts: { apifyReads: 4 } }, { counts: { apifyReads: 2, read: 9 } }, { counts: {} }, { counts: null }]), 6);
  assert.equal(apifyReadsIn([{ counts: { apifyReads: -3 } }, { counts: { apifyReads: "5" } }, { counts: { apifyReads: 1.7 } }]), 1);
  assert.equal(apifyWithinCap(28, 1, 30), true);
  assert.equal(apifyWithinCap(29, 1, 30), false);
  assert.equal(apifyWithinCap(30, 0, 30), false);
  assert.equal(apifyWithinCap(0, 0, 0), false);
});

test("the companies an article names come from its candidates, each once", () => {
  assert.deepEqual(
    companiesNamedIn([
      candidate(1, "a", ["betterhomes"]),
      candidate(2, "b", ["Knight Frank", "betterhomes"]),
      candidate(3, "c", [], ["Louis Harding"]),
    ]),
    ["betterhomes", "Knight Frank"],
  );
  assert.deepEqual(companiesNamedIn(null), []);
  assert.deepEqual(companiesNamedIn([]), []);
});

test("a read with names found is read, with its candidates", () => {
  const cands = [candidate(1, "betterhomes said prices rose.", ["betterhomes"])];
  const out = readOutcome(article({ read_attempts: 1 }), read({ text: "x".repeat(900), status: "thin", via: "plain", note: "only 900 characters" }), { candidates: cands }, new Date(START));
  assert.equal(out.status, "read");
  assert.deepEqual(out.patch, {
    body_status: "thin",
    body_chars: 900,
    read_via: "plain",
    read_attempts: 2,
    note: "only 900 characters",
    error: null,
    status: "read",
    candidates: cands,
    next_try_at: null,
  });
});

test("a read in full that names nobody is no_names, and a failed read is unreadable until tomorrow", () => {
  const full = readOutcome(article(), read({ text: PLAIN_TEXT, status: "ok" }), { candidates: [] }, new Date(START));
  assert.equal(full.status, "no_names");
  assert.equal(full.patch.status, "no_names");
  assert.equal(full.patch.next_try_at, null);
  assert.equal(full.patch.read_attempts, 1);
  // Bot Activity gives the note as the reason.
  assert.equal(full.patch.note, "read in full, and it names no tracked company or person");
  const blocked = readOutcome(article(), read({ status: "blocked", note: "the site refused the read (HTTP 403)" }), { candidates: [] }, new Date(START));
  assert.equal(blocked.patch.note, "the site refused the read (HTTP 403)");
  assert.equal(readOutcome(article(), read({ status: "error" }), { candidates: [] }, new Date(START)).patch.note, null);

  for (const status of ["thin", "blocked", "empty", "unresolved", "error"] as const) {
    const out = readOutcome(article({ read_attempts: 1 }), read({ status, text: status === "thin" ? "a little" : "" }), { candidates: [] }, new Date(START));
    assert.equal(out.status, "unreadable", status);
    assert.equal(out.patch.read_attempts, 2);
    assert.equal(out.patch.next_try_at, new Date(START + UNREADABLE_RETRY_MS).toISOString());
  }
  assert.equal(UNREADABLE_RETRY_MS, 20 * 3600 * 1000);
});

test("an AI failure sends the article back to read for later, and to failed on the third", () => {
  const first = aiFailurePatch(article({ ai_attempts: 0 }), "Claude had a problem on its side (HTTP 529)", new Date(START));
  assert.deepEqual(first, {
    status: "read",
    ai_attempts: 1,
    error: "Claude had a problem on its side (HTTP 529)",
    next_try_at: new Date(START + AI_RETRY_MS).toISOString(),
  });
  assert.equal(aiFailurePatch(article({ ai_attempts: 1 }), "x", new Date(START)).status, "read");
  assert.deepEqual(aiFailurePatch(article({ ai_attempts: 2 }), "x", new Date(START)), { status: "failed", ai_attempts: 3, error: "x" });
});

test("the summary adds up each figure from its own step", () => {
  const s = summariseRun(
    [
      { step: "search", ok: true, counts: { fresh: 12, found: 80, repeats: 60, skipped: 8 }, error: null },
      { step: "read", ok: true, counts: { read: 5, noNames: 4, unreadable: 2 }, error: null },
      { step: "read", ok: true, counts: { read: 1, noNames: 1 }, error: null },
      // Five rows now count, but one of them was the old bot's row brought up to date: four are new.
      { step: "check", ok: true, counts: { checked: 6, ours: 2, rivals: 3, rejected: 1, added: 4 }, error: null },
      { step: "publish", ok: true, counts: { published: 2, ours: 1, rivals: 2, added: 3 }, error: null },
      // A seed in the same run must not count as found.
      { step: "seed", ok: true, counts: { fresh: 900 }, error: null },
    ],
    "cron",
  );
  assert.deepEqual(s, { trigger: "cron", ok: true, found: 12, considered: 6, inserted: 7, skipped: 6, error: null });
});

test("the summary carries the AI's failure first, then any step's, then how the chain ended", () => {
  const rows = [
    { step: "search", ok: false, counts: {}, error: "every search failed, the first with: HTTP 503" },
    { step: "check", ok: false, counts: { aiFailures: 1 }, error: "The Claude account is out of credit" },
  ];
  assert.equal(summariseRun(rows, "manual").error, "The Claude account is out of credit");
  assert.equal(summariseRun(rows, "manual").ok, false);
  assert.equal(summariseRun(rows.slice(0, 1), "cron").error, "every search failed, the first with: HTTP 503");

  const cut: Ending = { error: "the read step could not be started (HTTP 401)", failed: true };
  const handOffFailed = summariseRun([{ step: "search", ok: true, counts: { fresh: 3 }, error: null }], "cron", cut);
  assert.equal(handOffFailed.ok, false);
  assert.equal(handOffFailed.error, cut.error);

  const capped = summariseRun([{ step: "read", ok: true, counts: { read: 2 }, error: null }], "cron", { error: "stopped after 40 links", failed: false });
  assert.equal(capped.ok, true);
  assert.equal(capped.error, "stopped after 40 links");
  // A step still running (ok null) is not a failure.
  assert.equal(summariseRun([{ step: "read", ok: null, counts: null, error: null }], "cron").ok, true);
});

test("the route's query becomes a link, and a bad one is refused", () => {
  const q = (s: string) => new URLSearchParams(s);
  const make = () => "nrNEW";
  assert.deepEqual(parseLinkRequest(q("step=read&run=nr20261105T040000-abcd1234&link=3&trigger=cron"), "manual", make), {
    step: "read",
    runId: "nr20261105T040000-abcd1234",
    link: 3,
    trigger: "cron",
  });
  // No run id starts a new run at link 0, under the caller's trigger.
  assert.deepEqual(parseLinkRequest(q("step=search"), "manual", make), { step: "search", runId: "nrNEW", link: 0, trigger: "manual" });
  for (const kind of ["unchecked_ours", "pending_reread", "rivals"]) {
    assert.deepEqual(parseLinkRequest(q(`step=recheck&kind=${kind}`), "cron", make), {
      step: "recheck",
      runId: "nrNEW",
      link: 0,
      trigger: "cron",
      kind,
    });
  }
  assert.deepEqual(parseLinkRequest(q("step=publish&run=nrP&link=2&trigger=manual"), "cron", make), {
    step: "publish",
    runId: "nrP",
    link: 2,
    trigger: "manual",
  });
  assert.equal(parseLinkRequest(q("step=seed"), "manual", make).hasOwnProperty("kind"), false);
  const noKind = parseLinkRequest(q("step=recheck"), "cron", make);
  assert.ok("error" in noKind);
  assert.equal(noKind.error, "a recheck needs kind=unchecked_ours, kind=pending_reread, kind=rivals");

  for (const bad of [
    "",
    "step=held",
    "step=read&run=../../etc",
    "step=read&run=" + "x".repeat(65),
    "step=read&link=-1",
    "step=read&link=2.5",
    "step=read&link=40",
    "step=read&trigger=weekly",
    "step=recheck",
    "step=recheck&kind=everything",
    // The old name of the rivals' re-check.
    "step=recheck&kind=rivals_2026",
  ]) {
    assert.ok("error" in parseLinkRequest(q(bad), "cron", make), bad);
  }
});

test("only the exact cron secret, as a Bearer header, passes", () => {
  const h = (auth?: string) => new Headers(auth ? { authorization: auth } : {});
  assert.equal(isCronRequest(h("Bearer s3cret"), "s3cret"), true);
  assert.equal(isCronRequest(h("Bearer wrong"), "s3cret"), false);
  assert.equal(isCronRequest(h("s3cret"), "s3cret"), false);
  assert.equal(isCronRequest(h(), "s3cret"), false);
  // With no secret set, nothing passes, not even an empty Bearer.
  assert.equal(isCronRequest(h("Bearer "), ""), false);
  assert.equal(isCronRequest(h("Bearer undefined"), undefined), false);
});

test("the hand-off posts to this deployment's /api/news with the cron secret, and the bypass when there is one", () => {
  const run = { runId: "nr20261105T040000-abcd1234", trigger: "cron" as const };
  const req = handOffRequest("https://bh-dash.vercel.app/pr?x=1", { step: "read", link: 2 }, run, { CRON_SECRET: "s3cret" });
  assert.ok(!("error" in req));
  assert.equal(req.url, "https://bh-dash.vercel.app/api/news?step=read&run=nr20261105T040000-abcd1234&link=2&trigger=cron");
  assert.deepEqual(req.headers, { authorization: "Bearer s3cret" });

  const preview = handOffRequest("https://bh-dash-git-x.vercel.app", { step: "check", link: 9 }, { ...run, trigger: "manual" }, {
    CRON_SECRET: "s3cret",
    VERCEL_AUTOMATION_BYPASS_SECRET: "bypass123",
  });
  assert.ok(!("error" in preview));
  assert.deepEqual(preview.headers, { authorization: "Bearer s3cret", "x-vercel-protection-bypass": "bypass123" });
  assert.match(preview.url, /trigger=manual$/);

  const recheck = handOffRequest("http://localhost:3000", { step: "recheck", link: 0 }, { ...run, kind: "unchecked_ours" }, { CRON_SECRET: "s" });
  assert.ok(!("error" in recheck));
  assert.match(recheck.url, /^http:\/\/localhost:3000\/api\/news\?step=recheck&.*&kind=unchecked_ours$/);

  assert.ok("error" in handOffRequest("https://bh-dash.vercel.app", { step: "read", link: 1 }, run, {}));
  assert.ok("error" in handOffRequest("not an address", { step: "read", link: 1 }, run, { CRON_SECRET: "s" }));
  assert.ok("error" in handOffRequest("ftp://bh-dash.vercel.app", { step: "read", link: 1 }, run, { CRON_SECRET: "s" }));
  assert.ok("error" in handOffRequest(null, { step: "read", link: 1 }, run, { CRON_SECRET: "s" }));

  // In production the next link goes to the public domain, with the bypass still sent when there is one.
  const live = handOffRequest("https://bh-dash-abc123-team.vercel.app", { step: "publish", link: 3 }, run, {
    CRON_SECRET: "s3cret",
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "dash.bhomes.com",
    VERCEL_AUTOMATION_BYPASS_SECRET: "bypass123",
  });
  assert.ok(!("error" in live));
  assert.equal(live.url, "https://dash.bhomes.com/api/news?step=publish&run=nr20261105T040000-abcd1234&link=3&trigger=cron");
  assert.deepEqual(live.headers, { authorization: "Bearer s3cret", "x-vercel-protection-bypass": "bypass123" });
  // Even when the request's own address is not known.
  const unknown = handOffRequest(null, { step: "read", link: 1 }, run, { CRON_SECRET: "s", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "dash.bhomes.com" });
  assert.ok(!("error" in unknown));
  assert.match(unknown.url, /^https:\/\/dash\.bhomes\.com\/api\/news\?/);
});

test("the hand-off goes to the production domain in production, and to the request's own address anywhere else", () => {
  const prod = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "dash.bhomes.com" };
  const deployment = "https://bh-dash-abc123-team.vercel.app";
  assert.equal(handOffOrigin(deployment, prod), "https://dash.bhomes.com");
  assert.equal(handOffOrigin(null, prod), "https://dash.bhomes.com");
  // Written with its protocol, or with a slash at the end, it is still the domain.
  assert.equal(handOffOrigin(deployment, { ...prod, VERCEL_PROJECT_PRODUCTION_URL: "https://dash.bhomes.com/" }), "https://dash.bhomes.com");
  assert.equal(handOffOrigin(deployment, { ...prod, VERCEL_PROJECT_PRODUCTION_URL: " bh-dash.vercel.app " }), "https://bh-dash.vercel.app");
  // A preview keeps its own address (with the bypass header), and so does production without the variable.
  assert.equal(handOffOrigin(deployment, { ...prod, VERCEL_ENV: "preview" }), deployment);
  assert.equal(handOffOrigin(deployment, { VERCEL_ENV: "production" }), deployment);
  assert.equal(handOffOrigin(deployment, { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "  " }), deployment);
  assert.equal(handOffOrigin("http://localhost:3000", {}), "http://localhost:3000");
  assert.equal(handOffOrigin(null, {}), null);
  // A value that is no address leaves the request's own.
  assert.equal(handOffOrigin(deployment, { ...prod, VERCEL_PROJECT_PRODUCTION_URL: "not a domain" }), deployment);
});

test("a server action's address comes from the forwarded host, else the host", () => {
  assert.equal(originFromHeaders(new Headers({ host: "bh-dash.vercel.app" })), "https://bh-dash.vercel.app");
  assert.equal(
    originFromHeaders(new Headers({ host: "internal:3000", "x-forwarded-host": "dash.bhomes.com, proxy", "x-forwarded-proto": "https" })),
    "https://dash.bhomes.com",
  );
  assert.equal(originFromHeaders(new Headers({ host: "localhost:3000" })), "http://localhost:3000");
  assert.equal(originFromHeaders(new Headers({ host: "localhost:3000", "x-forwarded-proto": "https" })), "https://localhost:3000");
  assert.equal(originFromHeaders(new Headers({ host: "bh.example", "x-forwarded-proto": "javascript" })), null);
  assert.equal(originFromHeaders(new Headers({})), null);
});

test("the pool keeps to its lanes, stops starting work when told, and hands back the rest", async () => {
  let active = 0;
  let most = 0;
  let started = 0;
  const pool = startPool(
    Array.from({ length: 10 }, (_, i) => i),
    3,
    () => started < 5,
    async () => {
      started++;
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    },
  );
  await pool.done;
  assert.equal(most, 3);
  assert.equal(started, 5);
  assert.deepEqual(pool.drain(), [5, 6, 7, 8, 9]);
  assert.deepEqual(pool.drain(), []);

  const empty = startPool([], 4, () => true, async () => assert.fail("nothing to do"));
  await empty.done;
  assert.deepEqual(empty.drain(), []);
});

// ─── The hand-off ───────────────────────────────────────────────────────────

/** Run with the cron secret set, as on a deployment, and put the environment back after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const RUN: LinkRequest = { step: "read", runId: "nr20261105T040000-abcd1234", link: 1, trigger: "cron" };

test("a 202 from /api/news is a hand-off made, and the call is what the route expects", async () => {
  await withEnv({ CRON_SECRET: "s3cret", VERCEL_AUTOMATION_BYPASS_SECRET: undefined }, async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ started: "check" }), { status: 202 });
    }) as typeof fetch;
    assert.deepEqual(await handOff("https://bh-dash.vercel.app", { step: "check", link: 2 }, RUN, fake), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://bh-dash.vercel.app/api/news?step=check&run=nr20261105T040000-abcd1234&link=2&trigger=cron");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "manual");
    assert.deepEqual(calls[0].init.headers, { authorization: "Bearer s3cret" });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });
});

test("a refusal, a redirect or no connection is a certain failure; no answer in time is not", async () => {
  await withEnv({ CRON_SECRET: "s3cret" }, async () => {
    const answer = (status: number, body = "") => (async () => new Response(body, { status })) as typeof fetch;
    const refused = await handOff("https://x.vercel.app", { step: "read", link: 1 }, RUN, answer(401, '{"error":"unauthorized"}'));
    assert.equal(refused.ok, false);
    assert.equal((refused as Extract<HandOff, { ok: false }>).certain, true);
    assert.match((refused as Extract<HandOff, { ok: false }>).error, /HTTP 401: \{"error":"unauthorized"\}/);

    const login = await handOff("https://x.vercel.app", { step: "read", link: 1 }, RUN, answer(307));
    assert.deepEqual([login.ok, (login as Extract<HandOff, { ok: false }>).certain], [false, true]);

    const down = await handOff("https://x.vercel.app", { step: "read", link: 1 }, RUN, (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }) as typeof fetch);
    assert.equal((down as Extract<HandOff, { ok: false }>).certain, true);
    assert.match((down as Extract<HandOff, { ok: false }>).error, /ECONNREFUSED/);

    const slow = await handOff("https://x.vercel.app", { step: "read", link: 1 }, RUN, (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch);
    assert.deepEqual(slow, { ok: false, error: "/api/news did not answer within 20 seconds", certain: false });
  });
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const noSecret = await handOff("https://x.vercel.app", { step: "read", link: 1 }, RUN, (async () => assert.fail("no call")) as typeof fetch);
    assert.deepEqual([noSecret.ok, (noSecret as Extract<HandOff, { ok: false }>).certain], [false, true]);
  });
  const noAddress = await handOff(null, { step: "read", link: 1 }, RUN, (async () => assert.fail("no call")) as typeof fetch);
  assert.deepEqual([noAddress.ok, (noAddress as Extract<HandOff, { ok: false }>).certain], [false, true]);
});

// ─── The chain ──────────────────────────────────────────────────────────────

function chain(result: LinkResult | StepResult, handed: HandOff = { ok: true }) {
  const seen = {
    steps: [] as { step: string; budgetMs: number; link: number; runId: string; trigger: string }[],
    handOffs: [] as { origin: string | null; step: string; link: number }[],
    summaries: [] as (Ending | null)[],
    seeds: 0,
    rechecks: 0,
    insights: 0,
  };
  const clock = { now: START };
  const deps: ChainDeps = {
    runStep: async (step, ctx) => {
      seen.steps.push({ step, ...ctx });
      return result;
    },
    seed: async () => {
      seen.seeds++;
    },
    recheck: async () => {
      seen.rechecks++;
      return result;
    },
    handOff: async (origin, next) => {
      seen.handOffs.push({ origin, step: next.step, link: next.link });
      return handed;
    },
    writeSummary: async (_run, ending) => {
      seen.summaries.push(ending);
    },
    refreshInsights: async () => {
      seen.insights++;
      return { ok: true };
    },
    claudeConfigured: () => true,
    countingOn: async () => true,
    now: () => clock.now,
  };
  return { deps, seen, clock };
}

test("a link runs its step with the real budget and hands on the next", async () => {
  const { deps, seen } = chain({ counts: {}, more: false });
  await runLink({ step: "search", runId: "nrA", link: 0, trigger: "cron" }, "https://x.vercel.app", deps);
  assert.deepEqual(seen.steps, [{ step: "search", runId: "nrA", link: 0, trigger: "cron", budgetMs: 200_000 }]);
  assert.deepEqual(seen.handOffs, [{ origin: "https://x.vercel.app", step: "read", link: 1 }]);
  assert.deepEqual(seen.summaries, []);
});

test("the last check writes the summary instead of handing on", async () => {
  const { deps, seen } = chain({ counts: { checked: 3 }, more: false });
  await runLink({ step: "check", runId: "nrA", link: 4, trigger: "manual" }, "https://x.vercel.app", deps);
  assert.deepEqual(seen.handOffs, []);
  assert.deepEqual(seen.summaries, [null]);

  const ai = chain({ counts: {}, more: false, aiError: "no Claude key (ANTHROPIC_API_KEY)" });
  await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, "https://x.vercel.app", ai.deps);
  assert.deepEqual(ai.seen.summaries, [null]);

  const capped = chain({ counts: {}, more: true });
  await runLink({ step: "read", runId: "nrA", link: 39, trigger: "cron" }, "https://x.vercel.app", capped.deps);
  assert.deepEqual(capped.seen.handOffs, []);
  assert.equal(capped.seen.summaries.length, 1);
  assert.equal(capped.seen.summaries[0]?.failed, false);
});

test("a hand-off that surely failed ends the run with a summary; one that may have arrived writes none", async () => {
  const failed = chain({ counts: {}, more: false }, { ok: false, error: "/api/news answered HTTP 401", certain: true });
  await runLink({ step: "search", runId: "nrA", link: 0, trigger: "cron" }, "https://x.vercel.app", failed.deps);
  assert.equal(failed.seen.summaries.length, 1);
  assert.equal(failed.seen.summaries[0]?.failed, true);
  assert.match(failed.seen.summaries[0]?.error ?? "", /read step could not be started \(\/api\/news answered HTTP 401\)/);

  const unsure = chain({ counts: {}, more: false }, { ok: false, error: "no answer", certain: false });
  await runLink({ step: "search", runId: "nrA", link: 0, trigger: "cron" }, "https://x.vercel.app", unsure.deps);
  assert.deepEqual(unsure.seen.summaries, []);
});

test("a seed runs alone, and a recheck goes on to read", async () => {
  const seed = chain({ counts: {}, more: false });
  await runLink({ step: "seed", runId: "nrS", link: 0, trigger: "manual" }, "https://x.vercel.app", seed.deps);
  assert.equal(seed.seen.seeds, 1);
  assert.deepEqual([seed.seen.steps, seed.seen.handOffs, seed.seen.summaries], [[], [], []]);

  const recheck = chain({ counts: { requeued: 40 }, more: false });
  await runLink({ step: "recheck", runId: "nrR", link: 0, trigger: "manual", kind: "rivals" }, "https://x.vercel.app", recheck.deps);
  assert.equal(recheck.seen.rechecks, 1);
  assert.deepEqual(recheck.seen.handOffs, [{ origin: "https://x.vercel.app", step: "read", link: 1 }]);
});

test("runLink never throws, even when its parts do", async () => {
  const { deps } = chain({ counts: {}, more: false });
  deps.runStep = async () => {
    throw new Error("boom");
  };
  const original = console.error;
  console.error = () => undefined;
  try {
    await runLink({ step: "read", runId: "nrA", link: 1, trigger: "cron" }, null, deps);
  } finally {
    console.error = original;
  }
});

// ─── The steps, on stand-ins ────────────────────────────────────────────────

test("search re-queues, searches with the Settings window, stores what it found and goes on to read", async () => {
  let asked: { queries: string[]; budgetMs: number } | null = null;
  const w = world([], {
    requeueDueUnreadable: async () => 2,
    prKeywords: async () => ["betterhomes dubai"],
    search: async (queries, budgetMs) => {
      asked = { queries: queries.map((q) => q.query), budgetMs };
      return {
        items: [{ title: "A", link: "https://news.google.com/rss/articles/a", outlet: "Zawya", publishedOn: "2026-11-05", query: "betterhomes dubai" }],
        failures: [{ query: '"Louis Harding" dubai when:7d', error: "HTTP 503" }],
      };
    },
    insertFound: async (items) => ({ fresh: items.length, repeats: 0, skipped: 0 }),
  }, { searchWindow: "7d" });
  const r = await runStep("search", { ...CTX, link: 0 }, w.deps);
  // The searches are lib/news/search.ts's, built from the registry, the PR keywords and Settings' window.
  const expected = buildQueries(REG, ["betterhomes dubai"], "7d").map((q) => q.query);
  assert.ok(expected.includes("betterhomes dubai when:7d"));
  assert.ok(expected.includes("knight frank dubai when:7d"));
  assert.ok(expected.includes('"Louis Harding" dubai when:7d'));
  assert.deepEqual(asked, { queries: expected, budgetMs: 120_000 });
  assert.deepEqual(r, {
    counts: { requeued: 2, queries: expected.length, queryFailures: 1, found: 1, fresh: 1, repeats: 0, skipped: 0 },
    more: false,
  });
  assert.deepEqual(w.log.started, [{ step: "search", runId: CTX.runId, link: 0, trigger: "cron" }]);
  assert.equal(w.log.finished[0].ok, true);
});

test("a morning on which every search failed is logged as a failure, and the chain still goes on", async () => {
  const w = world([], {
    prKeywords: async () => ["betterhomes dubai"],
    search: async (queries) => ({ items: [], failures: queries.map((q) => ({ query: q.query, error: "HTTP 429" })) }),
  });
  const r = await runStep("search", { ...CTX, link: 0 }, w.deps);
  assert.equal(r.error, undefined);
  assert.equal(w.log.finished[0].ok, false);
  assert.match(w.log.finished[0].error ?? "", /every search failed, the first with: HTTP 429/);
});

test("read saves each article's outcome and counts it", async () => {
  // Each article's Google link ends in its id, so the stand-in reader can tell them apart.
  const queued = (id: string, over: Partial<ArticleRow> = {}) => article({ id, google_link: `https://news.google.com/rss/articles/${id}`, ...over });
  const w = world([
    // Blocked, but the headline names us: still read, with the headline as its candidate.
    queued("na_named", { title: "betterhomes says prices rise" }),
    queued("na_plain"),
    queued("na_blocked", { read_attempts: 1 }),
    queued("na_copy"),
    queued("na_done", { status: "decided" }),
  ]);
  const reads = new Map<string, ReadResult>([
    ["na_named", read({ status: "blocked", note: "the site refused the read (HTTP 403)" })],
    ["na_plain", read({ status: "ok", text: PLAIN_TEXT, resolvedUrl: "https://gulfnews.com/a", note: "924 characters" })],
    ["na_blocked", read({ status: "blocked", resolvedUrl: "https://khaleejtimes.com/a" })],
    ["na_copy", read({ status: "ok", text: PLAIN_TEXT, resolvedUrl: "https://zawya.com/a" })],
  ]);
  w.deps.readArticle = async (input) => reads.get(String(input.googleLink).split("/").pop() ?? "") ?? assert.fail(`unexpected read of ${input.googleLink}`);
  w.deps.saveResolvedUrl = async (id) => (id === "na_copy" ? { duplicateOf: "na_other" } : { duplicateOf: null });

  const r = await runStep("read", CTX, w.deps);
  assert.equal(r.more, false);
  assert.deepEqual(r.counts, { read: 1, unreadable: 1, noNames: 1, duplicates: 1, apifyReads: 0, remaining: 0 });
  assert.equal(w.rows.get("na_named")?.status, "read");
  assert.deepEqual(w.rows.get("na_named")?.candidates?.map((c) => c.companies), [["betterhomes"]]);
  assert.equal(w.rows.get("na_plain")?.status, "no_names");
  assert.equal(w.rows.get("na_plain")?.body_chars, PLAIN_TEXT.length);
  assert.equal(w.rows.get("na_plain")?.note, "read in full (924 characters), and it names no tracked company or person");
  assert.equal(w.rows.get("na_named")?.note, "the site refused the read (HTTP 403)");
  assert.equal(w.rows.get("na_blocked")?.status, "unreadable");
  assert.equal(w.rows.get("na_blocked")?.read_attempts, 2);
  assert.equal(w.rows.get("na_blocked")?.next_try_at, new Date(START + UNREADABLE_RETRY_MS).toISOString());
  // saveResolvedUrl saved the copy as a duplicate itself, so read saves nothing more for it.
  assert.equal(w.log.saves.some((s) => s.id === "na_copy"), false);
  assert.equal(w.rows.get("na_done")?.status, "decided");
  assert.deepEqual(w.log.claims.map((c) => [c.from, c.to, c.limit]), [["queued", "reading", 8]]);
});

test("read stops claiming when its budget runs out and puts back what it had not started", async () => {
  const queued = Array.from({ length: 10 }, (_, i) => article({ id: `na_${i}` }));
  const w = world(queued);
  // Every read takes 100 seconds of the step's 150.
  w.deps.readArticle = async () => {
    w.clock.now += 100_000;
    return read({ status: "ok", text: PLAIN_TEXT });
  };
  const r = await runStep("read", { ...CTX, budgetMs: 150_000 }, w.deps);
  // Two lanes started before the budget ran out; the other six of the batch went back in the queue
  // as they were, so an error an article was waiting with is kept.
  assert.ok(w.log.saves.filter((s) => s.patch.status === "queued").every((s) => Object.keys(s.patch).join() === "status"));
  assert.equal(r.counts.noNames, 2);
  assert.equal(r.more, true);
  assert.equal(r.counts.remaining, 8);
  assert.equal(w.log.claims.length, 1);
  assert.equal([...w.rows.values()].filter((a) => a.status === "queued").length, 8);
  assert.equal([...w.rows.values()].filter((a) => a.status === "reading").length, 0);
  assert.ok([...w.rows.values()].every((a) => a.claimed_by === null));
});

test("read stops waiting for a read that runs past its time, and leaves that article to the lease", async () => {
  const w = world(Array.from({ length: 8 }, (_, i) => article({ id: `na_${i}` })));
  let finish: (r: ReadResult) => void = () => undefined;
  w.deps.readArticle = () => {
    // The first read jumps to 20 milliseconds before the step must stop waiting, and then hangs.
    w.clock.now += STEP_BUDGET_MS + FINISH_GRACE_MS - 20;
    return new Promise<ReadResult>((resolve) => {
      finish = resolve;
    });
  };
  const r = await runStep("read", CTX, w.deps);
  assert.equal(r.more, true);
  assert.equal(r.counts.remaining, 7);
  assert.equal([...w.rows.values()].filter((a) => a.status === "reading").length, 1);
  assert.equal(w.log.finished.length, 1);
  // When the read does finish, its article is still saved.
  finish(read({ status: "ok", text: PLAIN_TEXT }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal([...w.rows.values()].filter((a) => a.status === "no_names").length, 1);
});

test("read keeps claiming batches until the queue is empty", async () => {
  const w = world(Array.from({ length: 19 }, (_, i) => article({ id: `na_${i}` })));
  w.deps.readArticle = async () => read({ status: "ok", text: PLAIN_TEXT });
  const r = await runStep("read", CTX, w.deps);
  assert.equal(r.counts.noNames, 19);
  assert.equal(r.more, false);
  assert.deepEqual(w.log.claims.map((c) => c.got.length), [8, 8, 3]);
});

test("Apify is allowed only while this month's reads stay under the cap, counted once per step", async () => {
  let monthCounted = 0;
  const w = world(
    Array.from({ length: 4 }, (_, i) => article({ id: `na_${i}` })),
    {
      apifyReadsThisMonth: async () => {
        monthCounted++;
        return 28;
      },
    },
    { apifyBackup: true, apifyMonthlyCap: 30 },
  );
  const allowed: boolean[] = [];
  w.deps.readArticle = async (_input, opts) => {
    assert.equal(opts.apifyBackup, true);
    const ok = await opts.apifyAllowed();
    allowed.push(ok);
    if (ok) await opts.onApifyRead?.();
    return read({ status: ok ? "ok" : "blocked", via: ok ? "apify" : "plain", text: ok ? PLAIN_TEXT : "" });
  };
  const r = await runStep("read", CTX, w.deps);
  // 28 used this month: two more fit under 30, however many lanes ask at once.
  assert.deepEqual(allowed.filter(Boolean).length, 2);
  assert.equal(r.counts.apifyReads, 2);
  assert.equal(monthCounted, 1);
});

test("Apify is not started once too little of the step is left for it", async () => {
  const w = world([article()], {}, { apifyBackup: true, apifyMonthlyCap: 30 });
  let allowed: boolean | null = null;
  w.deps.readArticle = async (_input, opts) => {
    allowed = await opts.apifyAllowed();
    return read();
  };
  await runStep("read", { ...CTX, budgetMs: 30_000 }, w.deps);
  assert.equal(allowed, false);
});

test("an article whose read breaks is saved as unreadable, and the step is logged as having a problem", async () => {
  const w = world([article({ id: "na_bad" }), article({ id: "na_good" })]);
  w.deps.readArticle = async () => read({ status: "ok", text: PLAIN_TEXT, resolvedUrl: "https://zawya.com/x" });
  let firstSave = true;
  w.deps.saveResolvedUrl = async (id) => {
    if (id === "na_bad" && firstSave) {
      firstSave = false;
      throw new Error("address check failed: timeout");
    }
    return { duplicateOf: null };
  };
  const r = await runStep("read", CTX, w.deps);
  assert.equal(r.error, undefined);
  assert.equal(r.counts.unreadable, 1);
  assert.equal(r.counts.noNames, 1);
  assert.equal(w.rows.get("na_bad")?.status, "unreadable");
  assert.match(w.rows.get("na_bad")?.note ?? "", /the read failed: address check failed: timeout/);
  assert.equal(w.log.finished[0].ok, false);
  // Worded as Bot Activity reads a step's failed articles (lib/data.ts).
  assert.match(w.log.finished[0].error ?? "", /^1 article failed, the first: na_bad: address check failed/);
});

test("check without a Claude key claims nothing and stops the run", async () => {
  const w = world([article({ status: "read", candidates: [candidate(1, "betterhomes said so.", ["betterhomes"])] })], {
    claudeConfigured: () => false,
  });
  const r = await runStep("check", CTX, w.deps);
  assert.equal(r.aiError, "no Claude key (ANTHROPIC_API_KEY)");
  assert.equal(r.more, false);
  assert.deepEqual(w.log.claims, []);
  assert.equal(r.counts.remaining, 1);
  assert.deepEqual(w.log.finished, [{ ok: false, counts: { remaining: 1 }, error: "no Claude key (ANTHROPIC_API_KEY)" }]);
});

test("check sorts each article, writes what counts and saves the decision", async () => {
  const ours = [candidate(1, "betterhomes said prices rose.", ["betterhomes"]), candidate(2, "Louis Harding of Knight Frank agreed.", ["Knight Frank"], ["Louis Harding"])];
  const none = [candidate(1, "Better Homes and Gardens is a magazine.", [])];
  const w = world([
    article({ id: "na_both", status: "read", title: "Prime prices up, say agents", candidates: ours }),
    article({ id: "na_none", status: "read", title: "Ten garden ideas", candidates: none, published_on: "2026-11-04" }),
  ]);
  const asked: { title: string; companiesNamed: string[]; model: string }[] = [];
  w.deps.classifyArticle = async (a, _candidates, spot, _reg, model) => {
    asked.push({ title: a.title, companiesNamed: spot.companiesNamed, model });
    if (a.title === "Ten garden ideas") return { decision: decision() };
    return {
      decision: decision([
        { company: "betterhomes", sentence: 1, quote: ours[0].text, role: "data", sentiment: "neutral" },
        { company: "Knight Frank", sentence: 2, quote: ours[1].text, role: "spokesperson", sentiment: "positive" },
      ]),
    };
  };
  const written: string[] = [];
  w.deps.writeDecision = async (a, d) => {
    written.push(a.id);
    const ours = d.mentions.some((m) => m.company === "betterhomes") ? 1 : 0;
    const rivals = d.mentions.filter((m) => m.company !== "betterhomes").length;
    return { ours, rivals, added: ours + rivals };
  };
  const r = await runStep("check", CTX, w.deps);
  // withdrawn: the end-of-check sweep of imported duplicates, none here.
  assert.deepEqual(r, { counts: { checked: 2, ours: 1, rivals: 1, rejected: 1, aiFailures: 0, added: 2, held: 0, remaining: 0, withdrawn: 0 }, more: false });
  assert.deepEqual(written.sort(), ["na_both", "na_none"]);
  assert.equal(w.rows.get("na_both")?.status, "decided");
  assert.equal(w.rows.get("na_both")?.decision?.mentions.length, 2);
  assert.equal(w.rows.get("na_both")?.error, null);
  assert.equal(w.rows.get("na_none")?.status, "decided");
  assert.equal(w.rows.get("na_none")?.decision?.mentions.length, 0);
  // The companies named come from the stored candidates; the model from Settings.
  const named = Object.fromEntries(asked.map((x) => [x.title, x.companiesNamed]));
  assert.deepEqual(named, { "Prime prices up, say agents": ["betterhomes", "Knight Frank"], "Ten garden ideas": [] });
  assert.ok(asked.every((x) => x.model === "claude-haiku-5-5"));
  assert.deepEqual(w.log.claims[0].limit, 6);
});

test("an AI failure on one article sends it back for later, and the step does not ask about it again", async () => {
  const w = world([
    article({ id: "na_odd", status: "read", candidates: [candidate(1, "betterhomes said so.", ["betterhomes"])] }),
    article({ id: "na_last_try", status: "read", ai_attempts: 2, candidates: [candidate(1, "bhomes data.", ["betterhomes"])] }),
  ]);
  let calls = 0;
  w.deps.classifyArticle = async () => {
    calls++;
    return { failure: { kind: "bad_answer", message: "Claude's answer was cut off at 1500 tokens.", stopRun: false } satisfies AiFailure };
  };
  const r = await runStep("check", CTX, w.deps);
  assert.equal(calls, 2);
  assert.equal(r.aiError, undefined);
  assert.equal(r.counts.aiFailures, 2);
  assert.equal(r.counts.checked, 0);
  assert.equal(w.rows.get("na_odd")?.status, "read");
  assert.equal(w.rows.get("na_odd")?.ai_attempts, 1);
  assert.equal(w.rows.get("na_odd")?.next_try_at, new Date(START + AI_RETRY_MS).toISOString());
  assert.equal(w.rows.get("na_last_try")?.status, "failed");
  // Nothing claimable is left, so the chain moves on rather than asking again at once.
  assert.equal(r.more, false);
  assert.equal(w.log.finished[0].ok, true);
});

test("when the AI itself fails, everything the step holds goes back to read with the reason, and the step stops", async () => {
  const queued = Array.from({ length: 8 }, (_, i) => article({ id: `na_${i}`, status: "read", candidates: [candidate(1, "betterhomes said so.", ["betterhomes"])] }));
  const w = world(queued);
  const credit: AiFailure = { kind: "credit", message: "The Claude account is out of credit or at its usage limit (HTTP 400)", stopRun: true };
  let calls = 0;
  w.deps.classifyArticle = async () => {
    calls++;
    // The first call meets the empty balance; the two already in flight beside it still answer.
    return calls === 1 ? { failure: credit } : { decision: decision() };
  };
  const r = await runStep("check", CTX, w.deps);
  assert.equal(r.aiError, credit.message);
  assert.equal(r.more, false);
  assert.equal(calls, 3);
  assert.equal(r.counts.checked, 2);
  assert.equal(r.counts.aiFailures, 1);
  // One claim only: the step stopped instead of claiming more.
  assert.equal(w.log.claims.length, 1);
  assert.equal(w.log.released.length, 1);
  assert.equal(w.log.released[0].status, "read");
  assert.equal(w.log.released[0].error, credit.message);
  // The failed one and the three the batch had not started.
  assert.equal(w.log.released[0].ids.length, 4);
  assert.equal([...w.rows.values()].filter((a) => a.status === "checking").length, 0);
  assert.equal([...w.rows.values()].filter((a) => a.status === "read").length, 6);
  assert.deepEqual(w.log.finished[0], {
    ok: false,
    counts: { checked: 2, ours: 0, rivals: 0, rejected: 2, aiFailures: 1, added: 0, held: 0, remaining: 6 },
    error: credit.message,
  });
});

test("a step that fails outright reports the error and logs it", async () => {
  const w = world([article({ status: "read", candidates: [] })], {
    loadOutlets: async () => {
      throw new Error("the outlets could not be read: timeout");
    },
  });
  const r = await runStep("check", CTX, w.deps);
  assert.deepEqual(r, { counts: {}, more: false, error: "the outlets could not be read: timeout" });
  assert.deepEqual(w.log.finished, [{ ok: false, counts: {}, error: "the outlets could not be read: timeout" }]);
  assert.equal(w.rows.get("na_1")?.status, "read");
});

test("a step whose log can't be opened still runs", async () => {
  const w = world([], {
    startRun: async () => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
    },
  });
  const original = console.error;
  console.error = () => undefined;
  try {
    const r = await runStep("read", CTX, w.deps);
    assert.equal(r.error, undefined);
    assert.equal(r.more, false);
  } finally {
    console.error = original;
  }
});

// ─── The end of a chain: the PR insights ────────────────────────────────────

test("the insights get at most a minute, and never past the link's 290 seconds", () => {
  assert.equal(INSIGHTS_TIMEOUT_MS, 60_000);
  assert.equal(insightsBudgetMs(0), 60_000);
  assert.equal(insightsBudgetMs(230_000), 60_000);
  assert.equal(insightsBudgetMs(250_000), 40_000);
  assert.equal(insightsBudgetMs(290_000), 0);
  assert.equal(insightsBudgetMs(400_000), 0);
});

test("the end of a chain writes the summary, then refreshes the PR insights", async () => {
  const done = chain({ counts: { checked: 3 }, more: false });
  await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, "https://x.vercel.app", done.deps);
  assert.deepEqual([done.seen.summaries, done.seen.insights], [[null], 1]);

  // A publish chain ends the same way.
  const published = chain({ counts: { published: 4 }, more: false });
  await runLink({ step: "publish", runId: "nrP", link: 1, trigger: "manual" }, "https://x.vercel.app", published.deps);
  assert.deepEqual([published.seen.summaries.length, published.seen.insights], [1, 1]);

  // So does one whose next link surely could not be started.
  const cut = chain({ counts: {}, more: false }, { ok: false, error: "/api/news answered HTTP 401", certain: true });
  await runLink({ step: "search", runId: "nrA", link: 0, trigger: "cron" }, "https://x.vercel.app", cut.deps);
  assert.deepEqual([cut.seen.summaries.length, cut.seen.insights], [1, 1]);

  // Not while the chain goes on, nor after a seed, which is not a run.
  const middle = chain({ counts: {}, more: false });
  await runLink({ step: "read", runId: "nrA", link: 1, trigger: "cron" }, "https://x.vercel.app", middle.deps);
  const seed = chain({ counts: {}, more: false });
  await runLink({ step: "seed", runId: "nrS", link: 0, trigger: "manual" }, "https://x.vercel.app", seed.deps);
  assert.deepEqual([middle.seen.insights, seed.seen.insights], [0, 0]);

  // Not when the run stopped because the AI failed, which the insights' own call would meet too, nor without a key.
  const ai = chain({ counts: {}, more: false, aiError: "The Claude account is out of credit" });
  await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, "https://x.vercel.app", ai.deps);
  assert.deepEqual([ai.seen.summaries.length, ai.seen.insights], [1, 0]);
  const noKey = chain({ counts: {}, more: false });
  noKey.deps.claudeConfigured = () => false;
  await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, "https://x.vercel.app", noKey.deps);
  assert.deepEqual([noKey.seen.summaries.length, noKey.seen.insights], [1, 0]);

  // Nor in test mode: nothing was counted, and the cached set is the live PR tab's too.
  const testing = chain({ counts: { held: 5 }, more: false });
  testing.deps.countingOn = async () => false;
  await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, "https://x.vercel.app", testing.deps);
  assert.deepEqual([testing.seen.summaries.length, testing.seen.insights], [1, 0]);
  // Settings that can't be read count as counting, as getAppSettings has it.
  const unread = chain({ counts: {}, more: false });
  unread.deps.countingOn = async () => {
    throw new Error("app_settings could not be read");
  };
  await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, "https://x.vercel.app", unread.deps);
  assert.equal(unread.seen.insights, 1);

  // A summary that could not be saved does not keep the insights from being refreshed.
  const unsaved = chain({ counts: {}, more: false });
  unsaved.deps.writeSummary = async () => {
    throw new Error("the run's summary could not be saved: timeout");
  };
  const original = console.error;
  console.error = () => undefined;
  try {
    await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, "https://x.vercel.app", unsaved.deps);
  } finally {
    console.error = original;
  }
  assert.equal(unsaved.seen.insights, 1);
});

test("an insights refresh that fails, throws, hangs or has no time left is logged and never stops the link", async (t) => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (m: unknown) => {
    errors.push(String(m));
  };
  try {
    const failing = chain({ counts: {}, more: false });
    failing.deps.refreshInsights = async () => ({ ok: false, error: "The AI is busy right now. Try again in a minute." });
    await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, null, failing.deps);
    assert.match(errors.pop() ?? "", /nrA: the PR insights were not refreshed: The AI is busy right now/);

    const throwing = chain({ counts: {}, more: false });
    throwing.deps.refreshInsights = async () => {
      throw new Error("boom");
    };
    await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, null, throwing.deps);
    assert.match(errors.pop() ?? "", /the PR insights could not be refreshed: boom/);

    // The step took 280 of the function's seconds: ten are left, too few to start.
    const late = chain({ counts: {}, more: false });
    late.deps.runStep = async () => {
      late.clock.now += 280_000;
      return { counts: {}, more: false };
    };
    await runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, null, late.deps);
    assert.equal(late.seen.insights, 0);
    assert.match(errors.pop() ?? "", /too little of the link's time was left/);

    // One that never answers is given up on after its minute.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hung = chain({ counts: {}, more: false });
    hung.deps.refreshInsights = () => new Promise(() => undefined);
    const running = runLink({ step: "check", runId: "nrA", link: 4, trigger: "cron" }, null, hung.deps);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(INSIGHTS_TIMEOUT_MS);
    await running;
    assert.match(errors.pop() ?? "", /the PR insights did not refresh within 60 seconds/);
  } finally {
    console.error = original;
  }
});

// ─── Duplicates of imported stories ─────────────────────────────────────────

test("the read step leaves an imported duplicate's old row alone: the article it copies may not be checked yet", async () => {
  for (const countOnPrTab of [true, false]) {
    const w = world(
      [
        article({ id: "lm_a", legacy_mention_id: "old_a", google_link: "https://news.google.com/rss/articles/lm_a" }),
        article({ id: "na_b", google_link: "https://news.google.com/rss/articles/na_b" }),
      ],
      {},
      { countOnPrTab },
    );
    const withdrawn: string[] = [];
    w.deps.readArticle = async () => read({ status: "ok", text: PLAIN_TEXT, resolvedUrl: "https://zawya.com/x" });
    w.deps.saveResolvedUrl = async () => ({ duplicateOf: "na_owner" });
    w.deps.withdrawLegacyRow = async (a) => {
      withdrawn.push(a.id);
      return true;
    };
    w.deps.withdrawLegacyRows = async (stories) => {
      withdrawn.push(...stories.map((x) => x.id));
      return { withdrawn: stories.length, personDecided: 0 };
    };
    const r = await runStep("read", CTX, w.deps);
    assert.equal(r.counts.duplicates, 2);
    assert.deepEqual(withdrawn, []);
    assert.equal(r.counts.withdrawn, undefined);
    assert.equal(w.log.finished[0].ok, true);
  }
});

test("the last check of a chain sweeps the imported duplicates whose article has a verdict, only while counting", async () => {
  for (const countOnPrTab of [true, false]) {
    const w = world([], {}, { countOnPrTab });
    const swept: string[] = [];
    w.deps.importedDuplicates = async () => [{ id: "lm_a", legacy_mention_id: "old_a", dup_of: "na_owner" }];
    w.deps.withdrawLegacyRows = async (stories) => {
      swept.push(...stories.map((x) => x.id));
      return { withdrawn: stories.length, personDecided: 0 };
    };
    const r = await runStep("check", CTX, w.deps);
    if (countOnPrTab) {
      assert.deepEqual(swept, ["lm_a"]);
      assert.equal(r.counts.withdrawn, 1);
    } else {
      // Test mode: nothing on the PR tab changes until counting is turned on.
      assert.deepEqual(swept, []);
      assert.equal(r.counts.withdrawn, undefined);
    }
  }
});

test("a sweep that fails is logged with the check, and the check's own work stands", async () => {
  const w = world([]);
  w.deps.importedDuplicates = async () => {
    throw new Error("reading the imported duplicates failed: timeout");
  };
  const r = await runStep("check", CTX, w.deps);
  assert.equal(r.more, false);
  assert.equal(w.log.finished[0].ok, false);
  assert.equal(
    w.log.finished[0].error,
    "the old rows of imported duplicates could not be taken out of the count: reading the imported duplicates failed: timeout",
  );
});

// ─── Apify inside the step's budget ─────────────────────────────────────────

test("Apify is not started with less than 150 seconds of the step's budget left, though the grace is still to come", async () => {
  // How Apify is answered when `spent` of the step's 200 seconds have gone by before the read.
  const allowedAfter = async (spent: number) => {
    const w = world([article()], {}, { apifyBackup: true, apifyMonthlyCap: 30 });
    const claim = w.deps.claim;
    w.deps.claim = async (...args) => {
      const got = await claim(...args);
      w.clock.now += spent;
      return got;
    };
    let allowed: boolean | null = null;
    w.deps.readArticle = async (_input, opts) => {
      allowed = await opts.apifyAllowed();
      return read();
    };
    await runStep("read", CTX, w.deps);
    return allowed;
  };
  assert.equal(await allowedAfter(0), true);
  assert.equal(await allowedAfter(50_000), true);
  // 140 seconds of the budget left, 185 with the grace: one Apify read could still run past the link.
  assert.equal(await allowedAfter(60_000), false);
});

// ─── Test mode: held decisions ──────────────────────────────────────────────

const OURS_MENTION: DecidedMention = { company: "betterhomes", sentence: 1, quote: "betterhomes said prices rose.", role: "data", sentiment: "neutral" };

test("with counting off, check holds each decision on its article and writes nothing to mentions", async () => {
  const w = world(
    [
      article({ id: "na_ours", status: "read", candidates: [candidate(1, "betterhomes said prices rose.", ["betterhomes"])] }),
      article({ id: "na_none", status: "read", title: "Ten garden ideas", candidates: [candidate(1, "Better Homes and Gardens is a magazine.", [])] }),
    ],
    {},
    { countOnPrTab: false },
  );
  let settingsRead = 0;
  const settings = w.deps.newsSettings;
  w.deps.newsSettings = async () => {
    settingsRead++;
    return settings();
  };
  w.deps.classifyArticle = async (a) => ({ decision: a.title === "Ten garden ideas" ? decision() : decision([OURS_MENTION]) });
  w.deps.writeDecision = async () => assert.fail("nothing may reach mentions in test mode");
  const r = await runStep("check", CTX, w.deps);
  assert.deepEqual(r, {
    counts: { checked: 2, ours: 0, rivals: 0, rejected: 1, aiFailures: 0, added: 0, held: 2, remaining: 0 },
    more: false,
  });
  assert.equal(w.rows.get("na_ours")?.status, "held");
  assert.deepEqual(w.rows.get("na_ours")?.decision?.mentions, [OURS_MENTION]);
  assert.equal(w.rows.get("na_ours")?.error, null);
  // A rejection is held too: publishing it is what takes an old row out of the count.
  assert.equal(w.rows.get("na_none")?.status, "held");
  assert.equal(w.rows.get("na_none")?.decision?.mentions.length, 0);
  // Read once for the whole step.
  assert.equal(settingsRead, 1);
});

test("with counting on, a check that leaves held articles behind sends the chain on to publish them", async () => {
  const cands = [candidate(1, "betterhomes said so.", ["betterhomes"])];
  const w = world([article({ id: "na_new", status: "read", candidates: cands }), article({ id: "na_old", status: "held", decision: decision() })]);
  const r = await runStep("check", CTX, w.deps);
  assert.equal(r.publishNext, true);
  assert.equal(r.more, false);
  assert.deepEqual(nextMove("check", r, 3), { kind: "link", step: "publish", link: 4 });

  const none = world([article({ id: "na_new", status: "read", candidates: cands })]);
  assert.equal("publishNext" in (await runStep("check", CTX, none.deps)), false);
  // In test mode held articles are expected, and wait for counting to be switched on.
  const testing = world([article({ id: "na_new", status: "read", candidates: cands }), article({ id: "na_old", status: "held" })], {}, { countOnPrTab: false });
  assert.equal("publishNext" in (await runStep("check", CTX, testing.deps)), false);
});

test("an article a person rejected on Bot Activity is decided, and nothing of it is written", async () => {
  const w = world([
    article({ id: "na_rej", status: "read", note: "rejected by a person", candidates: [candidate(1, "betterhomes said prices rose.", ["betterhomes"])] }),
  ]);
  w.deps.classifyArticle = async () => ({ decision: decision([OURS_MENTION]) });
  w.deps.writeDecision = async () => assert.fail("a person's Reject stands over the bot's");
  const r = await runStep("check", CTX, w.deps);
  assert.equal(w.rows.get("na_rej")?.status, "decided");
  assert.deepEqual([r.counts.checked, r.counts.ours, r.counts.added], [1, 0, 0]);
  assert.equal(rejectedByPerson({ note: "Rejected by a person" }), true);
  assert.equal(rejectedByPerson({ note: "kept by a person" }), false);
  assert.equal(rejectedByPerson({ note: null }), false);
});

// ─── The publish step ───────────────────────────────────────────────────────

function heldArticle(id: string, firstSeen: string, over: Partial<ArticleRow> = {}): ArticleRow {
  return article({ id, status: "held", first_seen_at: firstSeen, decision: decision([OURS_MENTION]), ...over });
}

/** `n` held articles, na_00 the oldest. */
const heldRun = (n: number) =>
  Array.from({ length: n }, (_, i) => heldArticle(`na_${String(i).padStart(2, "0")}`, new Date(START - (n - i) * 60_000).toISOString()));

test("publish does nothing while counting is off, and says why in its log", async () => {
  const w = world([heldArticle("na_1", "2026-11-01T04:00:00.000Z")], {}, { countOnPrTab: false });
  w.deps.writeDecision = async () => assert.fail("nothing may be written");
  w.deps.importedDuplicates = async () => assert.fail("nothing may be swept");
  const r = await runStep("publish", { ...CTX, link: 0 }, w.deps);
  assert.deepEqual(r, { counts: { remaining: 1 }, more: false });
  // Not a failure: logged with its reason, and the chain ends with its summary.
  assert.deepEqual(w.log.finished, [{ ok: true, counts: { remaining: 1 }, error: COUNTING_OFF }]);
  assert.deepEqual(w.log.started.map((s) => s.step), ["publish"]);
  assert.equal(w.rows.get("na_1")?.status, "held");
  assert.deepEqual(nextMove("publish", r, 0), { kind: "summary" });
});

test("publish writes every held decision, oldest first in pages of twenty, and saves each as decided", async () => {
  const articles = heldRun(45);
  const w = world([...articles].reverse());
  const order: string[] = [];
  w.deps.writeDecision = async (a, d) => {
    order.push(a.id);
    assert.deepEqual(d, a.decision);
    return { ours: 1, rivals: 0, added: 1 };
  };
  const pages: [number, number][] = [];
  const page = w.deps.heldArticles;
  w.deps.heldArticles = async (offset, limit) => {
    pages.push([offset, limit]);
    return page(offset, limit);
  };
  let loads = 0;
  w.deps.loadRegistry = async () => {
    loads++;
    return REG;
  };
  const r = await runStep("publish", { ...CTX, link: 0 }, w.deps);
  assert.deepEqual(order, articles.map((a) => a.id));
  assert.deepEqual(pages, [
    [0, 20],
    [0, 20],
    [0, 20],
  ]);
  assert.deepEqual(r, { counts: { published: 45, ours: 45, rivals: 0, added: 45, withdrawn: 0, remaining: 0 }, more: false });
  assert.ok([...w.rows.values()].every((a) => a.status === "decided" && a.decision?.mentions.length === 1));
  assert.deepEqual(w.log.saves[0].patch, { status: "decided", error: null, next_try_at: null });
  // The registry and the rate card once for the whole step.
  assert.equal(loads, 1);
  assert.equal(w.log.finished[0].ok, true);
});

test("publish leaves a person's Reject standing, sends one held without a decision back to be checked, and moves past one that fails", async () => {
  const w = world([
    heldArticle("na_a", "2026-11-01T04:00:00.000Z"),
    heldArticle("na_b", "2026-11-01T05:00:00.000Z", { note: "rejected by a person" }),
    heldArticle("na_c", "2026-11-01T06:00:00.000Z", { decision: null }),
    heldArticle("na_d", "2026-11-01T07:00:00.000Z"),
  ]);
  const written: string[] = [];
  w.deps.writeDecision = async (a) => {
    if (a.id === "na_a") throw new Error("adding mentions failed: timeout");
    written.push(a.id);
    return { ours: 1, rivals: 1, added: 2 };
  };
  const r = await runStep("publish", CTX, w.deps);
  assert.deepEqual(written, ["na_d"]);
  assert.deepEqual(
    ["na_a", "na_b", "na_c", "na_d"].map((id) => w.rows.get(id)?.status),
    ["held", "decided", "read", "decided"],
  );
  assert.deepEqual(r.counts, { published: 1, ours: 1, rivals: 1, added: 2, withdrawn: 0, remaining: 1 });
  // Nothing else was left, so the chain ends: the one that failed waits for the next publish.
  assert.equal(r.more, false);
  assert.equal(w.log.finished[0].ok, false);
  assert.match(w.log.finished[0].error ?? "", /^1 article failed, the first: na_a: adding mentions failed: timeout$/);
});

test("publish pages on past the articles it had to leave held", async () => {
  const w = world(heldRun(25));
  w.deps.writeDecision = async (a) => {
    if (a.id === "na_00") throw new Error("adding mentions failed: timeout");
    return { ours: 1, rivals: 0, added: 1 };
  };
  const pages: number[] = [];
  const page = w.deps.heldArticles;
  w.deps.heldArticles = async (offset, limit) => {
    pages.push(offset);
    return page(offset, limit);
  };
  const r = await runStep("publish", CTX, w.deps);
  assert.deepEqual(pages, [0, 1]);
  assert.deepEqual([r.counts.published, r.counts.remaining, r.more], [24, 1, false]);
});

test("publish stops at its budget and runs again while held articles wait, leaving the sweep to the last link", async () => {
  const w = world(heldRun(30));
  w.deps.writeDecision = async () => {
    w.clock.now += 20_000;
    return { ours: 1, rivals: 0, added: 1 };
  };
  let sweeps = 0;
  w.deps.importedDuplicates = async () => {
    sweeps++;
    return [];
  };
  const r = await runStep("publish", { ...CTX, budgetMs: 100_000 }, w.deps);
  // The sweep waits for the link that finishes the held articles.
  assert.equal(sweeps, 0);
  assert.equal(r.more, true);
  assert.ok((r.counts.published ?? 0) > 0);
  assert.equal((r.counts.published ?? 0) + (r.counts.remaining ?? 0), 30);
  assert.equal([...w.rows.values()].filter((a) => a.status === "held").length, r.counts.remaining);
  assert.equal(r.counts.withdrawn, undefined);
  assert.equal(w.log.finished[0].ok, true);
  assert.deepEqual(nextMove("publish", r, 0), { kind: "link", step: "publish", link: 1 });
});

test("once nothing is held, publish takes the old rows of imported duplicates out of the count", async () => {
  const w = world([
    article({ id: "lm_a", status: "duplicate", legacy_mention_id: "old_a", dup_of: "na_owner" }),
    // Found by the new bot: it has no old row.
    article({ id: "na_b", status: "duplicate", dup_of: "na_owner" }),
  ]);
  let swept: SameStory[] = [];
  w.deps.withdrawLegacyRows = async (stories) => {
    swept = stories;
    return { withdrawn: 1, personDecided: 0 };
  };
  const r = await runStep("publish", CTX, w.deps);
  assert.deepEqual(swept, [{ id: "lm_a", legacy_mention_id: "old_a", dup_of: "na_owner" }]);
  assert.deepEqual(r, { counts: { published: 0, ours: 0, rivals: 0, added: 0, withdrawn: 1, remaining: 0 }, more: false });
  assert.equal(w.log.finished[0].ok, true);

  // A sweep that fails is logged, and what was published before it stays published.
  const broken = world([heldArticle("na_1", "2026-11-01T04:00:00.000Z")]);
  broken.deps.writeDecision = async () => ({ ours: 1, rivals: 0, added: 1 });
  broken.deps.importedDuplicates = async () => {
    throw new Error("reading the imported duplicates failed: timeout");
  };
  const r2 = await runStep("publish", CTX, broken.deps);
  assert.equal(broken.rows.get("na_1")?.status, "decided");
  assert.equal(r2.counts.published, 1);
  assert.equal(broken.log.finished[0].ok, false);
  assert.equal(
    broken.log.finished[0].error,
    "the old rows of imported duplicates could not be taken out of the count: reading the imported duplicates failed: timeout",
  );
});

// ─── Starting a chain ───────────────────────────────────────────────────────

test("startNewsStep refuses a re-check without a kind, or a step no chain starts at, before starting anything", async () => {
  const noKind = await startNewsStep("recheck", "manual");
  assert.equal(noKind.started, false);
  assert.equal(noKind.error, "A re-check needs one of these kinds: unchecked_ours, pending_reread, rivals.");
  const oldKind = await startNewsStep("recheck", "manual", { kind: "rivals_2026" as never });
  assert.equal(oldKind.started, false);
  const midway = await startNewsStep("check" as StartStep, "manual");
  assert.equal(midway.started, false);
  assert.equal(midway.error, 'The news bot cannot start at "check".');
});
