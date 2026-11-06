import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, router, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { BotActivityItem, NewsArticleItem, NewsRunToday, PossibleMove, TrackedPerson } from "@/lib/data";

// Bot Activity as the PR team sees it: the real component, rendered by React
// DOM into a stand-in document, its buttons pressed, its server actions
// answered by stand-ins (components/testRender.ts). Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/BotActivity.test.ts

const { default: BotActivity } = await load<typeof import("@/components/BotActivity")>("components/BotActivity.tsx");

type Props = Parameters<typeof BotActivity>[0];

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

const props = (over: Partial<Props> = {}): Props => ({
  articles: [],
  run: today(),
  queue: null,
  moves: null,
  people: [],
  companies: ["betterhomes", "Knight Frank"],
  drops: [],
  prKeywords: [],
  competitorKeywords: [],
  keywordsError: null,
  countOnPrTab: true,
  scheduled: true,
  ...over,
});

/** Mounted for one test, and taken down after it whatever happens. */
async function screenFor(t: { after: (fn: () => void) => void }, over: Partial<Props> = {}) {
  reset();
  const screen = await mount(h(BotActivity, props(over)));
  t.after(() => screen.unmount());
  return screen;
}

/** The tab is still there: nothing reached the error boundary, and Bot Activity still shows. */
function stillThere(screen: { caught: unknown[]; text(): string }) {
  assert.deepEqual(screen.caught, []);
  assert.ok(screen.text().includes("Bot Activity"));
  assert.ok(!screen.text().includes("Something went wrong"));
}

test("a Reject whose call never finishes says so in the list, and the tab stays", async (t) => {
  const screen = await screenFor(t, { articles: [article()] });
  answer("rejectArticleAction", throwing());
  screen.click("Articles the bot found");
  await screen.until(() => screen.buttons().includes("Reject"), "the list to open");
  screen.click("Reject");
  await screen.until(() => screen.text().includes(notFinished("the Reject was saved")), "the error in the list");
  stillThere(screen);
  // Pressable again, not stuck on "Saving…".
  await screen.until(() => screen.enabled("Reject"), "Reject to be pressable again");
  assert.deepEqual(
    calls.map((c) => c.name),
    ["rejectArticleAction"],
  );
});

test("a Keep whose call never finishes says so too, and an action's own error still shows as it did", async (t) => {
  const screen = await screenFor(t, { articles: [article({ canKeep: true, canReject: false, result: "Rejected", group: "rejected" })] });
  answer("keepArticleAction", throwing("An unexpected response was received from the server."));
  screen.click("Articles the bot found");
  await screen.until(() => screen.buttons().includes("Keep"), "the list to open");
  screen.click("Keep");
  await screen.until(() => screen.text().includes(notFinished("the Keep was saved")), "the error in the list");
  stillThere(screen);

  answer("keepArticleAction", async () => ({ ok: false, error: "That article is no longer stored." }));
  await screen.until(() => screen.enabled("Keep"), "Keep to be pressable again");
  screen.click("Keep");
  await screen.until(() => screen.text().includes("That article is no longer stored."), "the action's own error");
  assert.ok(!screen.text().includes(notFinished("the Keep was saved")));
  stillThere(screen);
});

test("Run now whose call never finishes says the run may have started, and keeps looking", async (t) => {
  const screen = await screenFor(t);
  answer("runNewsBotAction", throwing());
  screen.click("Run now");
  await screen.until(() => screen.text().includes("it is not known whether the run started"), "the error under the run");
  stillThere(screen);
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

test("a keyword added or removed whose call never finishes says so under the list", async (t) => {
  const screen = await screenFor(t, { prKeywords: [{ id: 2, query: "betterhomes", label: null, createdAt: null, aliases: [], sites: [] }] });
  answer("addKeywordAction", throwing());
  answer("removeKeywordAction", throwing());

  screen.type("Search term", "betterhomes dubai");
  await screen.until(() => screen.enabled("+ Add"), "Add to be pressable");
  screen.click("+ Add");
  await screen.until(() => screen.text().includes(notFinished("the keyword was added")), "the error under the list");
  stillThere(screen);

  await screen.until(() => screen.enabled("×"), "the chip's remove button to be pressable");
  screen.click("×");
  await screen.until(() => screen.text().includes(notFinished("the keyword was removed")), "the error under the list");
  stillThere(screen);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["addKeywordAction", "removeKeywordAction"],
  );
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
  const screen = await screenFor(t, { drops: [drop] });
  answer("setMentionStatusAction", throwing());
  screen.click("Dropped by the fact check");
  await screen.until(() => screen.buttons().includes("Keep"), "the drops to open");
  screen.click("Keep");
  await screen.until(() => screen.text().includes(notFinished("the Keep was saved")), "the error under the drops");
  stillThere(screen);
});

test("a change to the spokespeople whose call never finishes says so in their card", async (t) => {
  const people: TrackedPerson[] = [{ id: 11, name: "Richard Waind", company: "betterhomes", role: "CEO", active: true, note: null }];
  const screen = await screenFor(t, { people });
  answer("setPersonActiveAction", throwing());
  screen.click("Spokespeople the bot looks for");
  await screen.until(() => screen.buttons().includes("Mark former"), "the list to open");
  screen.click("Mark former");
  await screen.until(() => screen.text().includes(notFinished("the change to the list was saved")), "the error in the card");
  stillThere(screen);
  await screen.until(() => screen.enabled("Mark former"), "Mark former to be pressable again");
});

const moves: PossibleMove[] = [
  {
    person: "Louis Harding",
    companyInArticle: "Knight Frank",
    articles: [{ id: "na_1", title: "Knight Frank on Dubai prime", outlet: "Gulf News", date: "2026-10-30", link: null }],
  },
];

test("a possible move says the list could not be read, never that the person is off it", async (t) => {
  const unread = await screenFor(t, { moves, people: null });
  assert.ok(unread.text().includes("Louis Harding, described at Knight Frank On the list: could not be read just now"));
  assert.ok(!unread.text().includes("not any more"));
  assert.ok(!unread.text().includes("On the list there now"));
  unread.unmount();

  const empty = await screenFor(t, { moves, people: [] });
  assert.ok(empty.text().includes("On the list: not any more"));
  empty.unmount();

  const listed = await screenFor(t, {
    moves,
    people: [
      { id: 1, name: "Louis Harding", company: "betterhomes", role: "Former CEO", active: false, note: null },
      { id: 2, name: "Louis Harding", company: "Knight Frank", role: "Head of Residential", active: true, note: null },
    ],
  });
  assert.ok(listed.text().includes("On the list there now"));
  assert.ok(listed.text().includes("On the list: betterhomes (former), Knight Frank (current)"));
});

test("before the day's first run, production names its 08:00 run and a preview says runs start by hand", async (t) => {
  const production = await screenFor(t, { scheduled: true });
  assert.ok(production.text().includes("The bot has not run yet today. It runs every day at 08:00 Dubai."));
  production.unmount();

  const preview = await screenFor(t, { scheduled: false });
  assert.ok(
    preview
      .text()
      .includes(
        "The bot has not run yet today. On this preview it runs only when someone presses Run now. The daily run at 08:00 Dubai happens in production.",
      ),
  );
  assert.ok(!preview.text().includes("It runs every day"));
  // Nor does the spokespeople card promise a morning search: only the new bot searches for people.
  // (The keyword lists are searched every morning: production's bot reads the same lists.)
  preview.click("Spokespeople the bot looks for");
  await preview.until(() => preview.text().includes("Each current person is also searched for on every run."), "the card to open");
  assert.ok(!preview.text().includes("searched for every morning"));
});
