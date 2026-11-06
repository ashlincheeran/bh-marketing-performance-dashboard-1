import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { SettingsInfo } from "@/lib/settingsInfo";

// Settings as the admin sees it: the real panel, rendered by React DOM into a
// stand-in document, its buttons pressed, its server actions answered by
// stand-ins (components/testRender.ts). Nothing reaches a server. The news
// bot's card is on PR & Media settings now, and components/BotActivity.test.ts
// tests it there.
//
// Run this file on its own: node scripts/test.mjs components/SettingsPanel.test.ts

const { default: SettingsPanel } = await load<typeof import("@/components/SettingsPanel")>("components/SettingsPanel.tsx");

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
  pinsFromEnv: { app: true, settings: false },
  paidCache: { days: 0, rows: 0, oldest: null, newest: null, lastSyncedAt: null, restateDays: 7 },
};

const props = (over: Partial<Props> = {}): Props => ({
  info,
  settings: { supermetricsEnabled: true, seoSource: "supermetrics", note: "", updatedAt: null },
  settingsError: null,
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
  assert.ok(screen.text().includes("Supermetrics API"));
  assert.ok(!screen.text().includes("Something went wrong"));
}

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

test("the news bot's card has moved: one line says where, and links there", async (t) => {
  const screen = await screenFor(t);
  const text = screen.text();
  assert.ok(text.includes("PR & Media settings, the news bot included, are on the PR & Media page under the settings icon."));
  const links = screen.links();
  assert.ok(links.some((a) => a.href === "/pr/settings" && a.text === "PR & Media settings"));
  // The keyword lists are edited there too.
  assert.ok(links.some((a) => a.href === "/pr/settings" && a.text.includes("News and competitor keywords")));
  assert.ok(!links.some((a) => a.href === "/bot"));
  // None of the news bot's own settings is left here.
  for (const gone of ["Count on the PR tab", "AI that sorts the articles", "Apify backup", "Save news bot settings", "Last news run"]) {
    assert.ok(!text.includes(gone), gone);
  }
  // What was in that card's footer and is not the news bot's stays.
  assert.ok(text.includes("People Sentiment and Socials Performance refresh weekly, Mondays at 09:00 and 09:40 Dubai."));
  assert.ok(text.includes("PINs: app set via DASHBOARD_PIN · settings using the built-in default."));
  stillThere(screen);
});
