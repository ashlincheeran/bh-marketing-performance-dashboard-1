import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { SettingsInfo } from "@/lib/settingsInfo";
import type { NewsSettings } from "@/lib/news/types";

// Settings as the admin sees it: the real panel, rendered by React DOM into a
// stand-in document, its buttons pressed, its server actions answered by
// stand-ins (components/testRender.ts). Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/SettingsPanel.test.ts

const panel = await load<typeof import("@/components/SettingsPanel")>("components/SettingsPanel.tsx");
const { default: SettingsPanel, publishMessage } = panel;

type Props = Parameters<typeof SettingsPanel>[0];

const info: SettingsInfo = {
  connections: [
    { name: "Supermetrics", powers: "Digital", configured: true, vars: ["SUPERMETRICS_API_KEY"] },
    { name: "Search Console (direct)", powers: "SEO", configured: true, vars: ["GSC_CLIENT_EMAIL", "GSC_PRIVATE_KEY"] },
    { name: "Apify", powers: "Socials", configured: true, vars: ["APIFY_TOKEN"] },
  ],
  counts: { seoKeywords: 12, prKeywords: 1, competitorKeywords: 9, benchmarkBrands: 4, paidAccounts: 3 },
  portalSpend: [],
  portalSpendTotal: 0,
  portalSpendSource: "the 2026 budget",
  lastIngest: null,
  pinsFromEnv: { app: true, settings: true },
  paidCache: { days: 0, rows: 0, oldest: null, newest: null, lastSyncedAt: null, restateDays: 7 },
};

/** Test mode: counting off, as the preview runs before the merge. */
const TEST_MODE: NewsSettings = {
  model: "claude-haiku-5-5",
  apifyBackup: false,
  apifyMonthlyCap: 30,
  searchWindow: "2d",
  countOnPrTab: false,
};

const props = (over: Partial<Props> = {}): Props => ({
  info,
  settings: { supermetricsEnabled: true, seoSource: "supermetrics", note: "", updatedAt: null },
  news: TEST_MODE,
  newsError: null,
  scheduled: true,
  claudeKeySet: true,
  newsHeld: 4,
  ...over,
});

/** Mounted for one test, and taken down after it whatever happens. */
async function screenFor(t: { after: (fn: () => void) => void }, over: Partial<Props> = {}) {
  reset();
  const screen = await mount(h(SettingsPanel, props(over)));
  t.after(() => screen.unmount());
  return screen;
}

/** The page is still there: nothing reached the error boundary. */
function stillThere(screen: { caught: unknown[]; text(): string }) {
  assert.deepEqual(screen.caught, []);
  assert.ok(screen.text().includes("News bot"));
  assert.ok(!screen.text().includes("Something went wrong"));
}

test("news settings that could not be read are said to be unread, with nothing to save", async (t) => {
  const screen = await screenFor(t, { news: null, newsError: "the news bot's settings could not be read: timeout" });
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

test("news settings that were read show as saved, test mode included", async (t) => {
  const screen = await screenFor(t);
  assert.ok(screen.text().includes("Off now: test mode."));
  assert.ok(screen.buttons().includes("Save news bot settings"));
  assert.ok(!screen.text().includes("could not be read just now"));
});

test("production names its 08:00 run, and a preview says its runs start by hand", async (t) => {
  const production = await screenFor(t, { scheduled: true });
  assert.ok(production.text().includes("Every morning at 08:00 Dubai the bot searches Google News"));
  production.unmount();

  const preview = await screenFor(t, { scheduled: false });
  assert.ok(
    preview
      .text()
      .includes(
        "On this preview the bot runs only when someone presses Run now on Bot Activity. The daily run at 08:00 Dubai happens in production. Each run searches Google News",
      ),
  );
  assert.ok(!preview.text().includes("Every morning at 08:00"));
});

test("a save that turns counting on and never finishes says neither the save nor the publish is known", async (t) => {
  const screen = await screenFor(t);
  answer("setNewsSettingsAction", throwing());
  screen.click("On");
  await screen.until(() => screen.text().includes("Saving publishes the 4 held decisions to the PR tab."), "the publish warning");
  screen.click("Save news bot settings");
  await screen.until(() => screen.text().includes("The request did not finish"), "the error under the save");
  stillThere(screen);
  assert.ok(
    screen
      .text()
      .includes(
        "The request did not finish, so it is not known whether the settings were saved, or whether publishing what was held started. Reload Settings to see what was saved, and look at Bot Activity before saving again.",
      ),
  );
  // Still shown as saved before: nothing is known to have changed.
  assert.ok(screen.text().includes("Off now: test mode."));
});

test("any other save that never finishes says the save is not known", async (t) => {
  const screen = await screenFor(t);
  answer("setNewsSettingsAction", throwing());
  screen.click("Claude Sonnet 5.5");
  await screen.until(() => screen.enabled("Save news bot settings"), "the save to be pressable");
  screen.click("Save news bot settings");
  await screen.until(() => screen.text().includes(notFinished("the settings were saved", "Settings")), "the error under the save");
  stillThere(screen);
});

test("the Supermetrics switch and the SEO source say so when their call never finishes", async (t) => {
  const screen = await screenFor(t);
  answer("setSupermetricsEnabledAction", throwing());
  answer("setSeoSourceAction", throwing());
  screen.click("Turn OFF for everyone");
  await screen.until(() => screen.text().includes(notFinished("the Supermetrics switch was changed", "Settings")), "the switch's error");
  stillThere(screen);
  // Still shown as on: nothing is known to have changed.
  assert.ok(screen.text().includes("ON"));

  await screen.until(() => screen.enabled("Use Google Search Console API"), "the SEO choice to be pressable");
  screen.click("Use Google Search Console API");
  await screen.until(() => screen.text().includes(notFinished("the SEO source was changed", "Settings")), "the SEO error");
  stillThere(screen);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["setSupermetricsEnabledAction", "setSeoSourceAction"],
  );
});

test("a save that turned counting on says whether the publish started, may be running, or did not start", async (t) => {
  const screen = await screenFor(t);
  answer("setNewsSettingsAction", async () => ({
    ok: true,
    settings: { ...TEST_MODE, countOnPrTab: true },
    publish: {
      started: false,
      error: "The news bot did not confirm that it started. It may still be running, so look at Bot Activity in a few minutes.",
    },
  }));
  screen.click("On");
  await screen.until(() => screen.enabled("Save news bot settings"), "the save to be pressable");
  screen.click("Save news bot settings");
  await screen.until(() => screen.text().includes("Saved, and counting is on."), "the save's message");
  assert.ok(screen.text().includes("but it may well be running"));
  assert.ok(!screen.text().includes("did not start"));
  assert.ok(screen.text().includes("On now."));
  stillThere(screen);
});

test("the publish message: started, may be running, or did not start, with one full stop", () => {
  assert.deepEqual(publishMessage({ started: true }), {
    ok: true,
    text: "Saved. Counting is on, and everything held is being published to the PR tab now. Bot Activity shows it as it goes.",
  });

  // No answer in time: it may be running, so no retry is advised before Bot Activity is checked.
  const mayRun = {
    ok: false,
    text: "Saved, and counting is on. The news bot did not confirm that publishing started, but it may well be running. Look at Bot Activity in a few minutes. Only if no publish step shows there, switch counting off and save, then on and save.",
  };
  assert.deepEqual(
    publishMessage({
      started: false,
      error: "The news bot did not confirm that it started. It may still be running, so look at Bot Activity in a few minutes.",
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
