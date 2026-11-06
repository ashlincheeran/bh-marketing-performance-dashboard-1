import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { ReportSettings } from "@/lib/reportTypes";

// The weekly email's card in Settings: the real component, rendered by React
// DOM into a stand-in document, its buttons pressed, its server action
// answered by a stand-in (components/testRender.ts). Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/WeeklyEmailSettings.test.ts

const { default: WeeklyEmailSettings } = await load<typeof import("@/components/WeeklyEmailSettings")>(
  "components/WeeklyEmailSettings.tsx",
);

type Props = Parameters<typeof WeeklyEmailSettings>[0];

const STORED: ReportSettings = {
  enabled: true,
  weekday: 1,
  page: "/",
  subject: "Weekly marketing dashboard",
  intro: "",
  recipients: [
    { email: "pr@bhomes.com", name: "PR team", role: "to" },
    { email: "ceo@bhomes.com", name: "", role: "cc" },
  ],
  lastSentAt: null,
  lastResult: null,
};

/** Mounted for one test, and taken down after it whatever happens. */
async function screenFor(t: { after: (fn: () => void) => void }, over: Partial<Props> = {}) {
  reset();
  const props: Props = { initial: STORED, readError: null, sender: "reports@bhomes.com", baseUrl: "https://dash.bhomes.com", ...over };
  const screen = await mount(h(WeeklyEmailSettings, props));
  t.after(() => screen.unmount());
  return screen;
}

test("settings that could not be read are said to be unread, with nothing to save", async (t) => {
  const screen = await screenFor(t, { initial: null, readError: "canceling statement due to statement timeout" });
  const text = screen.text();
  assert.ok(
    text.includes(
      "The weekly email's settings could not be read just now, so they are not shown and can't be saved: a save now would replace the stored recipient list. Reload the page to try again.",
    ),
  );
  assert.ok(text.includes("Reason: canceling statement due to statement timeout"));
  // Not the defaults: no "OFF", no empty list, and no button that could save them over the stored list.
  assert.ok(!text.includes("OFF"));
  assert.ok(!text.includes("Nobody yet"));
  assert.deepEqual(screen.buttons(), []);
});

test("settings that were read show as stored, and a save sends the list as it was read", async (t) => {
  const screen = await screenFor(t);
  assert.ok(screen.text().includes("ON"));
  assert.ok(screen.text().includes("pr@bhomes.com"));
  assert.ok(screen.text().includes("1 To · 1 Cc · 0 Bcc · 0 paused"));

  answer("saveReportSettingsAction", async () => ({ ok: true, settings: { ...STORED, enabled: false } }));
  screen.click("Turn off");
  await screen.until(() => screen.text().includes("Saved. The weekly email is off."), "the save's message");
  assert.deepEqual((calls[0].args[0] as ReportSettings).recipients, STORED.recipients);
});

test("a save whose call never finishes says so in the card, and the page stays", async (t) => {
  const screen = await screenFor(t);
  answer("saveReportSettingsAction", throwing());
  screen.click("Turn off");
  await screen.until(() => screen.text().includes(notFinished("the weekly email settings were saved")), "the error in the card");
  assert.deepEqual(screen.caught, []);
  assert.ok(screen.text().includes("Weekly email"));
  assert.ok(!screen.text().includes("Something went wrong"));
  // Still shown as it was stored: nothing is known to have changed.
  assert.ok(screen.text().includes("ON"));
  assert.ok(screen.text().includes("pr@bhomes.com"));
});
