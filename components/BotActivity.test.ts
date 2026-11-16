import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, router, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { BotActivityItem, LogLine, NewsArticleItem, NewsQueue, PanelRun, PossibleMove, RunPanel } from "@/lib/data";
import type { NewsSettings } from "@/lib/news/types";

// The news bot's panels on PR & Media settings as the PR team sees them: the
// real components, rendered by React DOM into a stand-in document, their
// buttons pressed, their server actions answered by stand-ins
// (components/testRender.ts). Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/BotActivity.test.ts

const panels = await load<typeof import("@/components/BotActivity")>("components/BotActivity.tsx");
const { ArticleList, FactCheckDrops, NewsBotSettings, PossibleMoves, RunSummary, TestModeBanner, manualCheckMessage, publishMessage, queueWords } =
  panels;

const article = (over: Partial<NewsArticleItem> = {}): NewsArticleItem => ({
  id: "na_0123456789abcdef0123",
  title: "Dubai rents rise again",
  outlet: "Khaleej Times",
  date: "2026-11-04",
  link: "https://www.khaleejtimes.com/business/property/rents-rise-again",
  status: "decided",
  result: "Ours",
  tone: "positive",
  group: "ours",
  person: null,
  readByApify: false,
  countNote: null,
  quotes: [],
  reason: null,
  refused: [],
  canKeep: false,
  canReject: true,
  ruledOut: false,
  ...over,
});

/** Today in Dubai, before the day's first run. */
const today = (over: Partial<PanelRun> = {}): PanelRun => ({
  day: "2026-11-06",
  steps: 0,
  counts: {},
  lastStepAt: null,
  problem: null,
  running: false,
  latest: null,
  ...over,
});

type SummaryProps = Parameters<typeof RunSummary>[0];

/**
 * RunSummary's props: this morning's run as the page reads it (lib/data.ts getRunPanel), the day's run and the
 * queue, with the bar and the log, then the card's own settings.
 */
const summary = ({
  run = today(),
  queue = null,
  progress = null,
  log = [],
  ...rest
}: Partial<Omit<RunPanel, "at">> & Partial<Omit<SummaryProps, "panel">> = {}): SummaryProps => ({
  panel: { run, queue, progress, log, at: "2026-11-06T04:30:00.000Z" },
  countOnPrTab: true,
  scheduled: true,
  ...rest,
});

/** Test mode: counting off, as the preview runs before the merge. */
const TEST_MODE: NewsSettings = {
  model: "claude-haiku-5-5",
  apifyBackup: false,
  searchWindow: "2d",
  countOnPrTab: false,
};

type SettingsProps = Parameters<typeof NewsBotSettings>[0];

const settingsProps = (over: Partial<SettingsProps> = {}): SettingsProps => ({
  initial: TEST_MODE,
  readError: null,
  scheduled: true,
  claudeKeySet: true,
  apifyConfigured: true,
  lastRun: null,
  heldCount: 4,
  ...over,
});

/** `element` mounted for one test, and taken down after it whatever happens. */
async function screenFor(t: { after: (fn: () => void) => void }, element: ReturnType<typeof h>) {
  reset();
  const screen = await mount(element);
  t.after(() => screen.unmount());
  return screen;
}

/** The page is still there: nothing reached the error boundary, and the panel still shows `title`. */
function stillThere(screen: { caught: unknown[]; text(): string }, title: string) {
  assert.deepEqual(screen.caught, []);
  assert.ok(screen.text().includes(title));
  assert.ok(!screen.text().includes("Something went wrong"));
}

test("a Reject whose call never finishes says so in the list, and the page stays", async (t) => {
  const screen = await screenFor(t, h(ArticleList, { articles: [article()] }));
  answer("rejectArticleAction", throwing());
  screen.click("Articles the bot found");
  await screen.until(() => screen.buttons().includes("Reject"), "the list to open");
  screen.click("Reject");
  await screen.until(() => screen.text().includes(notFinished("the Reject was saved")), "the error in the list");
  stillThere(screen, "Articles the bot found");
  // Pressable again, not stuck on "Saving…".
  await screen.until(() => screen.enabled("Reject"), "Reject to be pressable again");
  assert.deepEqual(
    calls.map((c) => c.name),
    ["rejectArticleAction"],
  );
});

test("a Keep whose call never finishes says so too, and an action's own error still shows as it did", async (t) => {
  const screen = await screenFor(
    t,
    h(ArticleList, { articles: [article({ canKeep: true, canReject: false, result: "Rejected", group: "rejected" })] }),
  );
  answer("keepArticleAction", throwing("An unexpected response was received from the server."));
  screen.click("Articles the bot found");
  await screen.until(() => screen.buttons().includes("Keep"), "the list to open");
  screen.click("Keep");
  await screen.until(() => screen.text().includes(notFinished("the Keep was saved")), "the error in the list");
  stillThere(screen, "Articles the bot found");

  answer("keepArticleAction", async () => ({ ok: false, error: "That article is no longer stored." }));
  await screen.until(() => screen.enabled("Keep"), "Keep to be pressable again");
  screen.click("Keep");
  await screen.until(() => screen.text().includes("That article is no longer stored."), "the action's own error");
  assert.ok(!screen.text().includes(notFinished("the Keep was saved")));
  stillThere(screen, "Articles the bot found");
});

test("the stories ruled out automatically sit under one closed line, which opens to list them, with Keep", async (t) => {
  const gardens = article({
    id: "na_gardens",
    title: "Better Homes & Gardens names its colour of the year",
    outlet: "Better Homes & Gardens",
    status: "skipped",
    result: "Skipped",
    tone: "none",
    group: "rejected",
    reason: "The headline names Better Homes & Gardens, another company.",
    canKeep: true,
    canReject: false,
    ruledOut: true,
  });
  const nobody = article({ id: "na_nobody", title: "Dubai Marina towers rise", status: "no_names", result: "No names", tone: "none", group: "rejected", canKeep: true, canReject: false, ruledOut: true });
  const screen = await screenFor(t, h(ArticleList, { articles: [article(), gardens, nobody] }));
  // The count says what was set apart, and the rest adds up without it.
  assert.ok(screen.text().includes("Articles the bot found (3) · 1 ours, 0 rivals only, 0 rejected, 0 waiting, 2 ruled out automatically"));

  screen.click("Articles the bot found");
  const line =
    "2 stories ruled out automatically: look-alike names such as Better Homes & Gardens, pages naming no tracked company, and companies' own websites";
  await screen.until(() => screen.text().includes(line), "the ruled-out line");
  // By default only what counts is listed.
  assert.ok(screen.text().includes("Dubai rents rise again"));
  assert.ok(!screen.text().includes("Better Homes & Gardens names its colour of the year"));
  assert.ok(screen.buttons().includes("All (1)"));
  assert.ok(!screen.buttons().includes("Keep"));

  screen.click("2 stories ruled out automatically");
  await screen.until(() => screen.text().includes("Better Homes & Gardens names its colour of the year"), "the ruled-out list");
  assert.ok(screen.text().includes("Dubai Marina towers rise"));
  // A person can still keep one.
  answer("keepArticleAction", async () => ({ ok: true }));
  screen.click("Keep");
  await screen.until(() => calls.length === 1, "the Keep");
  assert.deepEqual(calls, [{ name: "keepArticleAction", args: ["na_gardens"] }]);
  await screen.until(() => router.refreshes >= 1, "the page to look again");
  stillThere(screen, "Articles the bot found");
});

test("an article Apify read says so under its result, beside the AI's decision and why", async (t) => {
  const quote = "Richard Waind, CEO of betterhomes, said rents rose again.";
  const screen = await screenFor(
    t,
    h(ArticleList, {
      articles: [
        article({ id: "na_apify", readByApify: true, quotes: [{ company: "betterhomes", isUs: true, role: "spokesperson", quote }] }),
        article({ id: "na_plain", title: "Prime prices hold", result: "Rejected", tone: "none", group: "rejected", reason: "It is about a magazine.", canKeep: true, canReject: false }),
      ],
    }),
  );
  screen.click("Articles the bot found");
  await screen.until(() => screen.text().includes("Dubai rents rise again"), "the list to open");
  const text = screen.text();
  // Under the AI's result, and only for the article Apify read.
  assert.ok(text.includes("Ours Read by Apify betterhomes, spokesperson quoted:"), text);
  assert.ok(text.includes(quote));
  assert.equal(text.split("Read by Apify").length - 1, 1);
  assert.ok(text.includes("Rejected It is about a magazine."));
});

test("with nothing ruled out there is no such line, and one story is said as one", async (t) => {
  const none = await screenFor(t, h(ArticleList, { articles: [article()] }));
  none.click("Articles the bot found");
  await none.until(() => none.text().includes("Dubai rents rise again"), "the list to open");
  assert.ok(!none.text().includes("ruled out automatically"));
  none.unmount();

  const one = await screenFor(t, h(ArticleList, { articles: [article({ status: "no_names", group: "rejected", ruledOut: true, canKeep: true, canReject: false })] }));
  one.click("Articles the bot found");
  await one.until(() => one.text().includes("1 story ruled out automatically:"), "the ruled-out line");
  assert.ok(one.text().includes("No articles here."));
});

test("Run now whose call never finishes says the run may have started, and keeps looking", async (t) => {
  const screen = await screenFor(t, h(RunSummary, summary({ run: today(), queue: null, countOnPrTab: true, scheduled: true })));
  answer("runNewsBotAction", throwing());
  screen.click("Run now");
  await screen.until(() => screen.text().includes("it is not known whether the run started"), "the error under the run");
  stillThere(screen, "This morning's run");
  assert.ok(
    screen
      .text()
      .includes(
        "This page looks again for the next two minutes, and its numbers fill in if it did. Press Run now again only if nothing shows by then.",
      ),
  );
  // It looked again straight away, as after any start.
  assert.ok(router.refreshes >= 1);
});

test("before the day's first run, production names its 08:00 run and a preview says runs start by hand", async (t) => {
  const production = await screenFor(t, h(RunSummary, summary({ run: today(), queue: null, countOnPrTab: true, scheduled: true })));
  assert.ok(production.text().includes("The bot has not run yet today. It runs every day at 08:00 Dubai."));
  production.unmount();

  const preview = await screenFor(t, h(RunSummary, summary({ run: today(), queue: null, countOnPrTab: true, scheduled: false })));
  assert.ok(
    preview
      .text()
      .includes(
        "The bot has not run yet today. On this preview it runs only when someone presses Run now or Manually check. The daily run at 08:00 Dubai happens in production.",
      ),
  );
  assert.ok(!preview.text().includes("It runs every day"));
});

// ── Manually check, beside Run now ───────────────────────────────────────

/** A stand-in answer that waits until the test lets it go, so the screen can be read while the call is pending. */
function held() {
  let release: (value: unknown) => void = () => undefined;
  const reply = () => new Promise((resolve) => (release = resolve));
  return { reply, release: (value: unknown) => release(value) };
}

test("Manually check sits beside Run now, says what it does, and both wait while a run is working", async (t) => {
  const idle = await screenFor(t, h(RunSummary, summary({ run: today(), queue: null, countOnPrTab: true, scheduled: true })));
  // The two run buttons, then the log's toggle.
  assert.deepEqual(idle.buttons(), ["Manually check", "Run now", "▸ What the bot is doing · nothing yet today · click to expand"]);
  assert.ok(idle.enabled("Manually check") && idle.enabled("Run now"));
  // Its tooltip says what it does, in plain words (a button is found by its title too).
  assert.ok(idle.enabled("Read and check what is already waiting, with no new search: articles not yet read or sorted, and unreadable ones due another try"));
  idle.unmount();

  const working = await screenFor(t, h(RunSummary, summary({ run: today({ steps: 2, running: true }), queue: null, countOnPrTab: true, scheduled: true })));
  assert.deepEqual(working.buttons().slice(0, 2), ["Manually check", "Running…"]);
  assert.equal(working.enabled("Manually check"), false);
  assert.equal(working.enabled("Running…"), false);
  assert.deepEqual(calls, []);
});

test("while one button's call is pending both wait, and only the pressed one says so", async (t) => {
  const screen = await screenFor(t, h(RunSummary, summary({ run: today(), queue: null, countOnPrTab: true, scheduled: true })));
  const check = held();
  answer("manualCheckAction", check.reply);
  screen.click("Manually check");
  await screen.until(() => screen.buttons().includes("Checking…"), "Manually check to say it is checking");
  assert.deepEqual(screen.buttons().slice(0, 2), ["Checking…", "Run now"]);
  assert.equal(screen.enabled("Checking…"), false);
  assert.equal(screen.enabled("Run now"), false);
  check.release({ ok: true, waiting: 12, runId: "nr_mc" });
  await screen.until(() => screen.enabled("Run now") && screen.enabled("Manually check"), "both buttons to be pressable again");

  const run = held();
  answer("runNewsBotAction", run.reply);
  screen.click("Run now");
  await screen.until(() => screen.buttons().includes("Starting…"), "Run now to say it is starting");
  assert.deepEqual(screen.buttons().slice(0, 2), ["Manually check", "Starting…"]);
  assert.equal(screen.enabled("Manually check"), false);
  assert.equal(screen.enabled("Starting…"), false);
  run.release({ ok: true, runId: "nr_run" });
  await screen.until(() => screen.buttons().slice(0, 2).join() === "Manually check,Run now" && screen.enabled("Manually check"), "both buttons back");
  assert.deepEqual(
    calls.map((c) => c.name),
    ["manualCheckAction", "runNewsBotAction"],
  );
  stillThere(screen, "This morning's run");
});

test("with nothing due, Manually check says what still waits for a later try rather than that the bot is up to date", async (t) => {
  assert.equal(manualCheckMessage(0, 0), "Nothing is waiting: the bot is up to date.");
  assert.equal(
    manualCheckMessage(0, 1),
    "Nothing is due yet: the waiting article is due another try within the hour. Press Manually check again then.",
  );
  assert.equal(
    manualCheckMessage(0, 5),
    "Nothing is due yet: the 5 waiting articles are due another try within the hour. Press Manually check again then.",
  );
  // A run was started: what waits for later is not its business.
  assert.equal(manualCheckMessage(3, 5), "Checking 3 waiting articles. This morning's run shows the numbers as they come in.");

  // The AI failed on five articles a moment ago: they wait in read for their next try, which the card counts.
  const queue: NewsQueue = { queued: 0, reading: 0, read: 5, checking: 0, held: 0, unreadable: 0, failed: 0 };
  const screen = await screenFor(t, h(RunSummary, summary({ run: today(), queue, countOnPrTab: true, scheduled: true })));
  answer("manualCheckAction", async () => ({ ok: true, waiting: 0, later: 5 }));
  screen.click("Manually check");
  await screen.until(() => screen.text().includes("Nothing is due yet"), "the message");
  assert.ok(screen.text().includes("Still waiting: 0 to be read and 5 for the AI."));
  assert.ok(screen.text().includes("the 5 waiting articles are due another try within the hour"));
  assert.ok(!screen.text().includes("the bot is up to date"));
});

test("Manually check says how many waiting articles it is checking, or that nothing is waiting, and the page looks again at once", async (t) => {
  assert.equal(manualCheckMessage(0), "Nothing is waiting: the bot is up to date.");
  assert.equal(manualCheckMessage(1), "Checking 1 waiting article. This morning's run shows the numbers as they come in.");
  assert.equal(manualCheckMessage(12), "Checking 12 waiting articles. This morning's run shows the numbers as they come in.");
  assert.equal(manualCheckMessage(1234), "Checking 1,234 waiting articles. This morning's run shows the numbers as they come in.");

  const screen = await screenFor(t, h(RunSummary, summary({ run: today(), queue: null, countOnPrTab: true, scheduled: true })));
  answer("manualCheckAction", async () => ({ ok: true, waiting: 12, runId: "nr_mc" }));
  screen.click("Manually check");
  await screen.until(() => screen.text().includes("Checking 12 waiting articles. This morning's run shows the numbers as they come in."), "the message");
  assert.ok(router.refreshes >= 1);

  answer("manualCheckAction", async () => ({ ok: true, waiting: 1, runId: "nr_mc2" }));
  await screen.until(() => screen.enabled("Manually check"), "Manually check to be pressable again");
  screen.click("Manually check");
  await screen.until(() => screen.text().includes("Checking 1 waiting article. This morning's run shows"), "the message for one");

  answer("manualCheckAction", async () => ({ ok: true, waiting: 0 }));
  await screen.until(() => screen.enabled("Manually check"), "Manually check to be pressable again");
  screen.click("Manually check");
  await screen.until(() => screen.text().includes("Nothing is waiting: the bot is up to date."), "the nothing-waiting message");
  // One message at a time, under the buttons.
  assert.ok(!screen.text().includes("Checking 1 waiting article"));
  assert.ok(screen.text().indexOf("Run now") < screen.text().indexOf("Nothing is waiting"));
  stillThere(screen, "This morning's run");
});

test("Manually check's errors show under the buttons, and a call that did not finish says a run may have started", async (t) => {
  const screen = await screenFor(t, h(RunSummary, summary({ run: today(), queue: null, countOnPrTab: true, scheduled: true })));
  for (const error of [
    "A run is working now. Its numbers appear below as it goes.",
    "What is waiting could not be checked, so nothing was started: re-queueing unreadable articles failed: canceling statement due to statement timeout",
    "The news bot did not confirm that it started. It may still be running, so look at this morning's run in a few minutes.",
  ]) {
    answer("manualCheckAction", async () => ({ ok: false, error, ...(error.includes("did not confirm") ? { uncertain: true } : {}) }));
    await screen.until(() => screen.enabled("Manually check"), "Manually check to be pressable");
    screen.click("Manually check");
    await screen.until(() => screen.text().includes(error), "the action's own error");
  }
  answer("manualCheckAction", throwing());
  await screen.until(() => screen.enabled("Manually check"), "Manually check to be pressable");
  screen.click("Manually check");
  await screen.until(() => screen.text().includes("it is not known whether a run started"), "the unfinished call's message");
  assert.ok(
    screen
      .text()
      .includes(
        "This page looks again for the next two minutes, and its numbers fill in if one did. Press Manually check again only if nothing shows by then.",
      ),
  );
  stillThere(screen, "This morning's run");
});

// ── Live updates: the card looks again at /api/news/status ───────────────

/**
 * The card's looks again (LIVE_EVERY_MS and IDLE_EVERY_MS in BotActivity.tsx), held for the test to make: each look
 * the card plans, 3 seconds on while a run works and 30 when idle, waits here until the test runs it, so a test sees
 * what the card would do without waiting for it. Every other timer runs as usual.
 */
function holdLooks(t: { after: (fn: () => void) => void }) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const planned = new Map<object, { ms: number; look: () => void }>();
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 3_000 && ms !== 30_000) return realSet(fn, ms, ...args);
    const handle = {};
    planned.set(handle, { ms, look: () => fn(...args) });
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    if (!planned.delete(handle as object)) realClear(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  t.after(() => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  });
  return {
    /** How far off each look the card has planned is, in milliseconds. */
    planned: () => [...planned.values()].map((p) => p.ms),
    /** Make every look planned now. */
    run() {
      const due = [...planned.values()];
      planned.clear();
      for (const p of due) p.look();
    },
    /** Wait for the card to plan its next look, which it does once it has drawn itself, then make it. */
    async next(screen: { until: (check: () => boolean, what: string) => Promise<void> }) {
      await screen.until(() => planned.size > 0, "the card to plan its next look");
      this.run();
    },
  };
}

/** A stand-in for the browser's fetch: each look gets the next answer, and the last one again once they run out. */
function answerLooks(t: { after: (fn: () => void) => void }, ...answers: (() => Promise<Response>)[]) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return next ? next() : Promise.reject(new TypeError("Failed to fetch"));
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = real));
  return asked;
}

/** The status route's answer: `panel`, or with no panel, the proxy's 401 for a settings PIN that has run out. */
const looked =
  (panel: RunPanel | null, status = 200) =>
  async () =>
    new Response(JSON.stringify(panel ?? { error: "locked", scope: "settings" }), { status, headers: { "content-type": "application/json" } });

/** A look that waits until the test lets it answer. */
function heldLook() {
  let answerNow: (r: Response) => void = () => undefined;
  return {
    reply: () => new Promise<Response>((resolve) => (answerNow = resolve)),
    answer: (panel: RunPanel) => answerNow(new Response(JSON.stringify(panel), { status: 200 })),
  };
}

/** A run reading articles: `done` read so far, of them `named` naming someone, and `left` still queued. */
const reading = (done: number, left: number, named = 0): RunPanel => ({
  run: today({ steps: 2, running: true, counts: { found: 109, fresh: 59, read: named, noNames: done - named }, lastStepAt: "2026-11-06T04:01:00.000Z" }),
  queue: { queued: left, reading: 0, read: 0, checking: 0, held: 0, unreadable: 0, failed: 0 },
  progress: { label: `Reading articles: ${done} of ${done + left}`, share: done / (done + left), state: "working" },
  log: [],
  at: "2026-11-06T04:01:00.000Z",
});

const live = (panel: RunPanel): SummaryProps => ({ panel, countOnPrTab: true, scheduled: true });

test("after Manually check starts a run, or may have, the card looks every 3 seconds; with nothing due it looks every 30", async (t) => {
  const noAnswer = "The news bot did not confirm that it started. It may still be running, so look at this morning's run in a few minutes.";
  const cases: [string, () => Promise<unknown>, boolean][] = [
    ["a run started", async () => ({ ok: true, waiting: 12, runId: "nr_mc" }), true],
    ["a call that did not finish", throwing(), true],
    ["a start that got no answer", async () => ({ ok: false, uncertain: true, error: noAnswer }), true],
    ["nothing due", async () => ({ ok: true, waiting: 0, later: 0 }), false],
  ];
  const looks = holdLooks(t);
  for (const [why, reply, watches] of cases) {
    // A page with no run today looks every 30 seconds, while the tab is in view.
    const screen = await screenFor(t, h(RunSummary, summary()));
    await screen.until(() => looks.planned().join() === "30000", `${why}: an idle look`);
    answer("manualCheckAction", reply);
    screen.click("Manually check");
    await screen.until(() => screen.enabled("Manually check") && router.refreshes >= 1, `${why}: the call to end`);
    await screen.until(() => looks.planned().join() === String(watches ? 3_000 : 30_000), `${why}: the next look`);
    screen.unmount();
    // Gone with the card.
    assert.deepEqual(looks.planned(), [], why);
  }
});

test("the numbers, the queue line and the bar rise when a look brings new ones, every 3 seconds while a run works", async (t) => {
  const looks = holdLooks(t);
  const asked = answerLooks(t, looked(reading(62, 42, 30)));
  const screen = await screenFor(t, h(RunSummary, live(reading(6, 98))));
  assert.ok(screen.text().includes("Reading articles: 6 of 104"));
  assert.ok(screen.text().includes("0 Read, names found"));
  assert.ok(screen.text().includes("98 Still waiting"));
  await screen.until(() => looks.planned().join() === "3000", "a look 3 seconds on");
  looks.run();
  await screen.until(() => screen.text().includes("Reading articles: 62 of 104"), "the bar after the look");
  assert.ok(screen.text().includes("30 Read, names found"));
  assert.ok(screen.text().includes("32 No names"));
  assert.ok(screen.text().includes("42 Still waiting"));
  assert.ok(screen.text().includes("Still waiting: 42 to be read and 0 for the AI."));
  assert.deepEqual(asked, ["/api/news/status"]);
  // Still working: the next look is 3 seconds on, and the buttons wait for the run.
  await screen.until(() => looks.planned().join() === "3000", "the next look");
  assert.equal(screen.enabled("Manually check"), false);
  assert.equal(router.refreshes, 0);
  stillThere(screen, "This morning's run");
});

test("a look that fails keeps the last numbers and tries again at the next look, and a part it could not read stays as it was", async (t) => {
  const looks = holdLooks(t);
  const unreadRun: RunPanel = { ...reading(70, 34, 31), run: null, progress: null, log: null };
  answerLooks(t, () => Promise.reject(new TypeError("Failed to fetch")), looked(null, 500), looked(unreadRun), looked(reading(62, 42, 30)));
  const screen = await screenFor(t, h(RunSummary, live(reading(6, 98))));
  for (const what of ["a dropped connection", "a server error"]) {
    await looks.next(screen);
    await screen.until(() => looks.planned().join() === "3000", `${what}: the next look`);
    assert.ok(screen.text().includes("Reading articles: 6 of 104"), what);
  }
  // The run log could not be read this time: the run and its bar stay, and the queue moves on.
  await looks.next(screen);
  await screen.until(() => screen.text().includes("34 Still waiting"), "the queue from the look");
  assert.ok(screen.text().includes("Reading articles: 6 of 104"));
  assert.ok(screen.text().includes("0 Read, names found"));
  await looks.next(screen);
  await screen.until(() => screen.text().includes("Reading articles: 62 of 104"), "the next good look");
  assert.ok(!screen.text().includes("Live updates paused"));
});

test("a look that finds the run has ended reads the page again, once, so the rest of the page catches up", async (t) => {
  const looks = holdLooks(t);
  const ended: RunPanel = {
    ...reading(104, 0, 2),
    run: today({ steps: 3, running: false, counts: { found: 109, fresh: 59, read: 2, noNames: 102, checked: 2 }, lastStepAt: "2026-11-06T04:02:02.000Z" }),
    progress: { label: "Finished at 08:02", share: 1, state: "done" },
  };
  const asked = answerLooks(t, looked(ended));
  const screen = await screenFor(t, h(RunSummary, live(reading(6, 98))));
  await looks.next(screen);
  await screen.until(() => screen.text().includes("Finished at 08:02"), "the run to end");
  await screen.until(() => router.refreshes === 1, "the page to be read again");
  assert.ok(screen.enabled("Run now") && screen.enabled("Manually check"));
  // Idle now: the next look is 30 seconds on, and finds it still ended, which reads the page no more.
  await screen.until(() => looks.planned().join() === "30000", "an idle look");
  looks.run();
  await screen.until(() => asked.length === 2 && looks.planned().length === 1, "the second look");
  assert.equal(router.refreshes, 1);
});

test("a fresh read of the page replaces what the looks found", async (t) => {
  const looks = holdLooks(t);
  answerLooks(t, looked(reading(62, 42, 30)));
  const screen = await screenFor(t, h(RunSummary, live(reading(6, 98))));
  await looks.next(screen);
  await screen.until(() => screen.text().includes("Reading articles: 62 of 104"), "the look");
  await screen.rerender(h(RunSummary, live(reading(80, 24, 40))));
  await screen.until(() => screen.text().includes("Reading articles: 80 of 104"), "the page's own read");
  assert.ok(screen.text().includes("40 Read, names found"));
});

test("a look the settings PIN turns away stops the looks and says so quietly, keeping the numbers it had", async (t) => {
  const looks = holdLooks(t);
  const asked = answerLooks(t, looked(null, 401));
  const screen = await screenFor(t, h(RunSummary, live(reading(6, 98))));
  await looks.next(screen);
  await screen.until(() => screen.text().includes("Live updates paused: enter the settings PIN again (reload the page)."), "the paused note");
  assert.deepEqual(looks.planned(), []);
  assert.deepEqual(asked, ["/api/news/status"]);
  assert.ok(screen.text().includes("Reading articles: 6 of 104"));
  stillThere(screen, "This morning's run");
});

test("never two looks at once: one still on its way holds back the next, even once the card looks every 3 seconds", async (t) => {
  const looks = holdLooks(t);
  const first = heldLook();
  const asked = answerLooks(t, first.reply, looked(reading(62, 42, 30)));
  const screen = await screenFor(t, h(RunSummary, summary()));
  await looks.next(screen);
  // On its way: nothing more is planned until it answers.
  assert.equal(asked.length, 1);
  assert.deepEqual(looks.planned(), []);
  // Manually check starts a run, so the card looks every 3 seconds from now on.
  answer("manualCheckAction", async () => ({ ok: true, waiting: 12, runId: "nr_mc" }));
  screen.click("Manually check");
  await screen.until(() => looks.planned().join() === "3000", "a look 3 seconds on");
  looks.run();
  // The first look has not answered: this one waits for the next tick.
  await screen.until(() => looks.planned().join() === "3000", "the look put off");
  assert.equal(asked.length, 1);
  // The first look's late answer is from before the run started, and the card no longer goes by it.
  first.answer(reading(10, 94));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!screen.text().includes("Reading articles: 10 of 104"));
  looks.run();
  await screen.until(() => screen.text().includes("Reading articles: 62 of 104"), "the next look");
  assert.equal(asked.length, 2);
});

test("the log is closed at first, says how many entries and that it is live, and opens to show its lines, newest first", async (t) => {
  holdLooks(t);
  const log: LogLine[] = [
    { at: "2026-11-06T04:01:42.000Z", time: "08:01:42", tone: "info", text: "Reading now: 12 done so far…" },
    {
      at: "2026-11-06T04:01:40.000Z",
      time: "08:01:40",
      tone: "info",
      text: "Names nobody we track · Gulf News",
      title: "Dubai rents rise again",
      link: "https://gulfnews.com/a",
    },
    { at: "2026-11-06T04:00:34.000Z", time: "08:00:34", tone: "info", text: "Read started (round 2)" },
  ];
  const screen = await screenFor(t, h(RunSummary, summary({ run: today({ steps: 2, running: true }), log })));
  assert.ok(screen.text().includes("▸ What the bot is doing · 3 entries · live · click to expand"));
  assert.ok(!screen.text().includes("Reading now"));
  screen.click("What the bot is doing");
  await screen.until(() => screen.text().includes("08:01:42 Reading now: 12 done so far…"), "the log to open");
  const text = screen.text();
  assert.ok(text.includes("▾ What the bot is doing · 3 entries · live · click to collapse"));
  assert.ok(text.includes("08:01:40 Names nobody we track · Gulf News · Dubai rents rise again"));
  assert.ok(text.indexOf("08:01:42") < text.indexOf("08:01:40") && text.indexOf("08:01:40") < text.indexOf("08:00:34 Read started (round 2)"));
  // The headline opens the article in a new tab.
  assert.deepEqual(
    screen.links().find((l) => l.text === "Dubai rents rise again"),
    { text: "Dubai rents rise again", href: "https://gulfnews.com/a", target: "_blank", rel: "noopener noreferrer" },
  );
  screen.click("What the bot is doing");
  await screen.until(() => !screen.text().includes("Reading now"), "the log to close");
  screen.unmount();

  // Once the run has ended it is not live; before any run, and when it could not be read, it says so.
  const ended = await screenFor(t, h(RunSummary, summary({ run: today({ steps: 3 }), log })));
  assert.ok(ended.text().includes("What the bot is doing · 3 entries · click to expand"));
  ended.unmount();
  const empty = await screenFor(t, h(RunSummary, summary()));
  assert.ok(empty.text().includes("What the bot is doing · nothing yet today · click to expand"));
  empty.click("What the bot is doing");
  await empty.until(() => empty.text().includes("Nothing yet today."), "the empty log");
  empty.unmount();
  const unread = await screenFor(t, h(RunSummary, summary({ log: null })));
  unread.click("What the bot is doing");
  await unread.until(() => unread.text().includes("The log could not be read just now."), "the unread log");
});

test("the progress bar sits under the buttons, amber where a run stopped, and none shows before the day's first run", async (t) => {
  holdLooks(t);
  const stopped = await screenFor(
    t,
    h(RunSummary, summary({ run: today({ steps: 1 }), progress: { label: "Stopped at 10:15 with 98 still waiting", share: 6 / 104, state: "stopped" } })),
  );
  const text = stopped.text();
  assert.ok(text.indexOf("Run now") < text.indexOf("Stopped at 10:15 with 98 still waiting"));
  assert.ok(text.indexOf("Stopped at 10:15 with 98 still waiting") < text.indexOf("Found"));
  stopped.unmount();
  const none = await screenFor(t, h(RunSummary, summary()));
  assert.ok(!none.text().includes("Reading articles") && !none.text().includes("Finished at"));
});

test("a Keep on a story the fact check dropped whose call never finishes says so", async (t) => {
  const drop: BotActivityItem = {
    id: "3f2a9c1b7d4e5f60",
    published_on: "2026-10-01",
    outlet_name: "Gulf News",
    title: "Rents rise in Dubai Marina",
    url: null,
    status: "rejected",
    sentiment: null,
    reason: "fact check: no sentence names betterhomes",
  };
  const screen = await screenFor(t, h(FactCheckDrops, { drops: [drop] }));
  answer("setMentionStatusAction", throwing());
  screen.click("Dropped by the fact check");
  await screen.until(() => screen.buttons().includes("Keep"), "the drops to open");
  screen.click("Keep");
  await screen.until(() => screen.text().includes(notFinished("the Keep was saved")), "the error under the drops");
  stillThere(screen, "Dropped by the fact check");
  assert.deepEqual(calls, [{ name: "setMentionStatusAction", args: ["3f2a9c1b7d4e5f60", "reviewed"] }]);
});

test("no drops, no card", async (t) => {
  // In a box of its own, since a screen waits for something to be drawn.
  const screen = await screenFor(t, h("div", null, h(FactCheckDrops, { drops: [] })));
  assert.equal(screen.text(), "");
});

const moves: PossibleMove[] = [
  {
    person: "Louis Harding",
    companyInArticle: "Knight Frank",
    articles: [{ id: "na_1", title: "Knight Frank on Dubai prime", outlet: "Gulf News", date: "2026-10-30", link: null }],
  },
];

test("a possible move says the list could not be read, never that the person is off it", async (t) => {
  const unread = await screenFor(t, h(PossibleMoves, { moves, people: null }));
  assert.ok(unread.text().includes("Louis Harding, described at Knight Frank On the list: could not be read just now"));
  assert.ok(!unread.text().includes("not any more"));
  assert.ok(!unread.text().includes("On the list there now"));
  unread.unmount();

  const empty = await screenFor(t, h(PossibleMoves, { moves, people: [] }));
  assert.ok(empty.text().includes("On the list: not any more"));
  // The companies' cards are above it on the page.
  assert.ok(empty.text().includes("mark them former in their company's card above"));
  empty.unmount();

  const listed = await screenFor(
    t,
    h(PossibleMoves, {
      moves,
      people: [
        { id: 1, name: "Louis Harding", company: "betterhomes", role: "Former CEO", active: false, note: null },
        { id: 2, name: "Louis Harding", company: "Knight Frank", role: "Head of Residential", active: true, note: null },
      ],
    }),
  );
  assert.ok(listed.text().includes("On the list there now"));
  assert.ok(listed.text().includes("On the list: betterhomes (former), Knight Frank (current)"));
});

test("test mode says how many are held, and that counting is turned on below, on this page", async (t) => {
  const four = await screenFor(t, h(TestModeBanner, { held: 4 }));
  assert.ok(four.text().includes("Test mode: counting on the PR tab is switched off."));
  assert.ok(four.text().includes("4 articles are held."));
  assert.ok(four.text().includes("To publish everything held to the PR tab, turn counting on below."));
  four.unmount();

  const unknown = await screenFor(t, h(TestModeBanner, { held: null }));
  assert.ok(unknown.text().includes("How many are held could not be read just now."));
});

test("news settings that could not be read are said to be unread, with nothing to save", async (t) => {
  const screen = await screenFor(
    t,
    h(NewsBotSettings, settingsProps({ initial: null, readError: "the news bot's settings could not be read: timeout" })),
  );
  const text = screen.text();
  assert.ok(
    text.includes(
      "The news bot's settings could not be read just now, so they are not shown and can't be saved: a save now could switch test mode off by mistake. Reload the page to try again.",
    ),
  );
  assert.ok(text.includes("Reason: the news bot's settings could not be read: timeout"));
  // Not the defaults, whose counting is on: no "On now.", no form, no save.
  assert.ok(!text.includes("On now."));
  assert.ok(!text.includes("Count on the PR tab"));
  assert.ok(!screen.buttons().some((b) => b.includes("Save news bot settings")));
  // The rest of the card still says what it knows.
  assert.ok(text.includes("Claude key (ANTHROPIC_API_KEY): Set"));
  assert.ok(text.includes("No news runs recorded yet."));
});

test("news settings that were read show as saved, test mode included, with the last run", async (t) => {
  const lastRun = { ran_at: "2026-11-06T04:05:00.000Z", trigger: "cron", ok: true, inserted: 3 };
  const screen = await screenFor(t, h(NewsBotSettings, settingsProps({ lastRun })));
  assert.ok(screen.text().includes("Off now: test mode."));
  assert.ok(screen.buttons().includes("Save news bot settings"));
  assert.ok(!screen.text().includes("could not be read just now"));
  // In Dubai time whatever the viewer's clock: 04:05 UTC is 08:05 in Dubai.
  assert.match(screen.text(), /Last news run 6 Nov 2026, 08:05 Dubai time \(cron\), ok, 3 counted\./);
  // Its decisions are held for review here, on PR & Media settings.
  assert.ok(screen.text().includes("holds its decisions for review on this page"));
  assert.ok(!screen.text().includes("Bot Activity"));
});

test("the Apify backup keeps On and Off, says what it reads with no monthly limit, and has no cap to set", async (t) => {
  const screen = await screenFor(t, h(NewsBotSettings, settingsProps()));
  const text = screen.text();
  assert.ok(
    text.includes(
      "When it is on, Apify reads every article from a search for betterhomes, a rival or a person that the bot could not open itself, with no monthly limit. The AI then sorts what Apify reads, as it sorts every other article. Each Apify read uses the Apify plan's allowance.",
    ),
  );
  // No cap: no "Up to N reads a month", and nothing about one.
  for (const gone of ["reads a month", "Up to", "up to the cap", "monthly cap", "calendar month"]) assert.ok(!text.includes(gone), gone);
  // Its On and Off buttons, beside counting's.
  assert.deepEqual(
    screen.buttons().filter((b) => b === "On" || b === "Off" || b === "Off (test mode)"),
    ["On", "Off (test mode)", "Off", "On"],
  );
  // A save sends the settings as they are, with no cap among them.
  answer("setNewsSettingsAction", async (next) => ({ ok: true, settings: next, publish: null }));
  screen.click("Claude Sonnet 5.5");
  await screen.until(() => screen.enabled("Save news bot settings"), "the save to be pressable");
  screen.click("Save news bot settings");
  await screen.until(() => screen.text().includes("Saved. The next run uses these settings."), "the save's message");
  assert.deepEqual(calls[0].args[0], { ...TEST_MODE, model: "claude-sonnet-5-5" });
  stillThere(screen, "News bot");
});

test("production names its 08:00 run, and a preview says its runs start by hand", async (t) => {
  const production = await screenFor(t, h(NewsBotSettings, settingsProps({ scheduled: true })));
  assert.ok(production.text().includes("Every morning at 08:00 Dubai the bot searches Google News"));
  production.unmount();

  const preview = await screenFor(t, h(NewsBotSettings, settingsProps({ scheduled: false })));
  assert.ok(
    preview
      .text()
      .includes(
        "On this preview the bot runs only when someone presses Run now or Manually check below. The daily run at 08:00 Dubai happens in production. Run now searches Google News",
      ),
  );
  assert.ok(!preview.text().includes("Every morning at 08:00"));
});

test("a save that turns counting on and never finishes says neither the save nor the publish is known", async (t) => {
  const screen = await screenFor(t, h(NewsBotSettings, settingsProps()));
  answer("setNewsSettingsAction", throwing());
  screen.click("On");
  await screen.until(() => screen.text().includes("Saving publishes the 4 held decisions to the PR tab."), "the publish warning");
  screen.click("Save news bot settings");
  await screen.until(() => screen.text().includes("The request did not finish"), "the error under the save");
  stillThere(screen, "News bot");
  assert.ok(
    screen
      .text()
      .includes(
        "The request did not finish, so it is not known whether the settings were saved, or whether publishing what was held started. Reload the page to see what was saved, and look at this morning's run before saving again.",
      ),
  );
  // Still shown as saved before: nothing is known to have changed.
  assert.ok(screen.text().includes("Off now: test mode."));
});

test("any other save that never finishes says the save is not known", async (t) => {
  const screen = await screenFor(t, h(NewsBotSettings, settingsProps()));
  answer("setNewsSettingsAction", throwing());
  screen.click("Claude Sonnet 5.5");
  await screen.until(() => screen.enabled("Save news bot settings"), "the save to be pressable");
  screen.click("Save news bot settings");
  await screen.until(() => screen.text().includes(notFinished("the settings were saved")), "the error under the save");
  stillThere(screen, "News bot");
});

test("a save that turned counting on says whether the publish started, may be running, or did not start", async (t) => {
  const screen = await screenFor(t, h(NewsBotSettings, settingsProps()));
  answer("setNewsSettingsAction", async () => ({
    ok: true,
    settings: { ...TEST_MODE, countOnPrTab: true },
    publish: {
      started: false,
      error: "The news bot did not confirm that it started. It may still be running, so look at this morning's run in a few minutes.",
    },
  }));
  screen.click("On");
  await screen.until(() => screen.enabled("Save news bot settings"), "the save to be pressable");
  screen.click("Save news bot settings");
  await screen.until(() => screen.text().includes("Saved, and counting is on."), "the save's message");
  assert.ok(screen.text().includes("but it may well be running"));
  assert.ok(!screen.text().includes("did not start"));
  assert.ok(screen.text().includes("On now."));
  stillThere(screen, "News bot");
});

test("the publish message: started, may be running, or did not start, with one full stop", () => {
  assert.deepEqual(publishMessage({ started: true }), {
    ok: true,
    text: "Saved. Counting is on, and everything held is being published to the PR tab now. This morning's run below shows it as it goes.",
  });

  // No answer in time: it may be running, so no retry is advised before the run is checked.
  const mayRun = {
    ok: false,
    text: "Saved, and counting is on. The news bot did not confirm that publishing started, but it may well be running. Look at this morning's run below in a few minutes. Only if no publish step shows there, switch counting off and save, then on and save.",
  };
  assert.deepEqual(
    publishMessage({
      started: false,
      error: "The news bot did not confirm that it started. It may still be running, so look at this morning's run in a few minutes.",
    }),
    mayRun,
  );
  assert.deepEqual(publishMessage({ started: false, uncertain: true, error: "the hand-off got no answer" }), mayRun);

  // Known not to have started: the reason, then the way to try again, each sentence ending once.
  assert.deepEqual(publishMessage({ started: false, error: "The news bot could not be started: no cron secret." }), {
    ok: false,
    text: "Saved, and counting is on, but publishing what was held did not start: The news bot could not be started: no cron secret. To try again, switch counting off and save, then switch it on and save.",
  });
  assert.equal(
    publishMessage({ started: false }).text,
    "Saved, and counting is on, but publishing what was held did not start: no reason was given. To try again, switch counting off and save, then switch it on and save.",
  );
  assert.ok(!publishMessage({ started: false, error: "x." }).text.includes(".."));
});

/** The queue right now: nothing waiting but the 202 articles the bot could not read. */
const queue = (over: Partial<NewsQueue> = {}): NewsQueue => ({
  queued: 0,
  reading: 0,
  read: 0,
  checking: 0,
  held: 0,
  unreadable: 202,
  failed: 0,
  ...over,
});

test("this morning's run says which unreadable articles to check by hand, which still count from the old bot, and which came from general searches", async (t) => {
  const named = "34 articles from searches for betterhomes, a rival or a person could not be read. Check them by hand below.";
  const general = "168 more came from general market searches and are rarely about anyone we track.";
  assert.deepEqual(queueWords(queue(), true, { named: 34, counted: 0, general: 168 }), [named, general]);
  // Only one kind.
  assert.deepEqual(queueWords(queue(), true, { named: 34, counted: 0, general: 0 }), [named]);
  assert.deepEqual(queueWords(queue(), true, { named: 0, counted: 0, general: 168 }), [
    "168 articles from general market searches could not be read. They are rarely about anyone we track.",
  ]);
  assert.deepEqual(queueWords(queue(), true, { named: 0, counted: 0, general: 0 }), []);
  // One of each is said as one.
  assert.deepEqual(queueWords(queue(), true, { named: 1, counted: 0, general: 1 }), [
    "1 article from searches for betterhomes, a rival or a person could not be read. Check it by hand below.",
    "1 more came from general market searches and is rarely about anyone we track.",
  ]);
  assert.deepEqual(queueWords(queue(), true, { named: 0, counted: 0, general: 1 }), [
    "1 article from general market searches could not be read. It is rarely about anyone we track.",
  ]);
  assert.deepEqual(queueWords(queue(), true, { named: 1234, counted: 0, general: 0 }), [
    "1,234 articles from searches for betterhomes, a rival or a person could not be read. Check them by hand below.",
  ]);
  // The old bot's stories that still count are said apart, never as general searches.
  const today36 = queueWords(queue(), true, { named: 36, counted: 51, general: 103 });
  assert.deepEqual(today36, [
    "36 articles from searches for betterhomes, a rival or a person could not be read. Check them by hand below.",
    "51 more are still counted on the PR tab from the old bot.",
    "103 more came from general market searches and are rarely about anyone we track.",
  ]);
  assert.deepEqual(queueWords(queue(), true, { named: 0, counted: 1, general: 2 }), [
    "1 article that could not be read is still counted on the PR tab from the old bot.",
    "2 more came from general market searches and are rarely about anyone we track.",
  ]);
  assert.deepEqual(queueWords(queue(), true, { named: 2, counted: 1, general: 0 }).slice(1), ["1 more is still counted on the PR tab from the old bot."]);
  assert.deepEqual(queueWords(queue(), true, { named: 0, counted: 51, general: 0 }), [
    "51 articles that could not be read are still counted on the PR tab from the old bot.",
  ]);
  // When the split could not be read, only how many is said, from the queue.
  assert.deepEqual(queueWords(queue(), true, null), ["202 articles could not be read. Those with tries left are tried again on a later morning, and while the Apify backup is on, each one from a search for betterhomes, a rival or a person gets one try through Apify."]);
  // The rest of the queue is said as before, around it.
  assert.deepEqual(queueWords(queue({ queued: 3, read: 2, failed: 1 }), true, { named: 34, counted: 0, general: 168 }).slice(0, 3), [
    "Still waiting: 3 to be read and 2 for the AI.",
    named,
    general,
  ]);

  const screen = await screenFor(
    t,
    h(RunSummary, summary({ run: today(), queue: queue(), countOnPrTab: true, scheduled: true, unreadable: { named: 36, counted: 51, general: 103 } })),
  );
  assert.ok(screen.text().includes(today36.join(" ")));
  assert.ok(!screen.text().includes("Those with tries left"));
  screen.unmount();
  // A page that passes no split says what it said before.
  const before = await screenFor(t, h(RunSummary, summary({ run: today(), queue: queue(), countOnPrTab: true, scheduled: true })));
  assert.ok(before.text().includes("202 articles could not be read. Those with tries left are tried again on a later morning, and while the Apify backup is on, each one from a search for betterhomes, a rival or a person gets one try through Apify."));
});
