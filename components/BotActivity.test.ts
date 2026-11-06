import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, router, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { BotActivityItem, NewsArticleItem, NewsRunToday, PossibleMove } from "@/lib/data";
import type { NewsSettings } from "@/lib/news/types";

// The news bot's panels on PR & Media settings as the PR team sees them: the
// real components, rendered by React DOM into a stand-in document, their
// buttons pressed, their server actions answered by stand-ins
// (components/testRender.ts). Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/BotActivity.test.ts

const panels = await load<typeof import("@/components/BotActivity")>("components/BotActivity.tsx");
const { ArticleList, FactCheckDrops, NewsBotSettings, PossibleMoves, RunSummary, TestModeBanner, publishMessage } = panels;

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
const today = (over: Partial<NewsRunToday> = {}): NewsRunToday => ({
  day: "2026-11-06",
  steps: 0,
  counts: {},
  lastStepAt: null,
  problem: null,
  running: false,
  ...over,
});

/** Test mode: counting off, as the preview runs before the merge. */
const TEST_MODE: NewsSettings = {
  model: "claude-haiku-5-5",
  apifyBackup: false,
  apifyMonthlyCap: 30,
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
  const screen = await screenFor(t, h(RunSummary, { run: today(), queue: null, countOnPrTab: true, scheduled: true }));
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
  const production = await screenFor(t, h(RunSummary, { run: today(), queue: null, countOnPrTab: true, scheduled: true }));
  assert.ok(production.text().includes("The bot has not run yet today. It runs every day at 08:00 Dubai."));
  production.unmount();

  const preview = await screenFor(t, h(RunSummary, { run: today(), queue: null, countOnPrTab: true, scheduled: false }));
  assert.ok(
    preview
      .text()
      .includes(
        "The bot has not run yet today. On this preview it runs only when someone presses Run now. The daily run at 08:00 Dubai happens in production.",
      ),
  );
  assert.ok(!preview.text().includes("It runs every day"));
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

test("production names its 08:00 run, and a preview says its runs start by hand", async (t) => {
  const production = await screenFor(t, h(NewsBotSettings, settingsProps({ scheduled: true })));
  assert.ok(production.text().includes("Every morning at 08:00 Dubai the bot searches Google News"));
  production.unmount();

  const preview = await screenFor(t, h(NewsBotSettings, settingsProps({ scheduled: false })));
  assert.ok(
    preview
      .text()
      .includes(
        "On this preview the bot runs only when someone presses Run now below. The daily run at 08:00 Dubai happens in production. Each run searches Google News",
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
