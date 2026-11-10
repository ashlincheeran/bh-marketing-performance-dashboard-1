import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount, reset } from "@/components/testRender";
import type { PressMention } from "@/lib/pressMentions";

// Press mentions on the PR tab as a reader sees it: the real component,
// rendered by React DOM into a stand-in document (components/testRender.ts),
// for the tab's date range. Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/PressMentions.test.ts

const { default: PressMentions } = await load<typeof import("@/components/PressMentions")>("components/PressMentions.tsx");

type Props = Parameters<typeof PressMentions>[0];

const story = (key: string, date: string | null, companies: [string, boolean][], agencyOnly = false): PressMention => ({
  key,
  date,
  outlet: "Gulf News",
  title: `Headline ${key}`,
  url: null,
  companies: companies.map(([label, isUs]) => ({ label, isUs })),
  people: [],
  agencyOnly,
});

const props = (over: Partial<Props> = {}): Props => ({
  items: [
    story("n1", "2026-11-02", [["betterhomes", true]]),
    story("n2", "2026-11-01", [["Allsopp & Allsopp", false]]),
    story("j1", "2026-06-16", [["betterhomes", true], ["Knight Frank", false]]),
    story("a1", "2025-03-01", [["betterhomes", true]], true),
    story("u1", null, [["betterhomes", true]], true),
  ],
  companies: [
    { label: "betterhomes", isUs: true, count: 4 },
    { label: "Knight Frank", isUs: false, count: 1 },
    { label: "Allsopp & Allsopp", isUs: false, count: 1 },
  ],
  from: "2026-11",
  to: "2026-11",
  allTime: false,
  ...over,
});

async function screenFor(t: { after: (fn: () => void) => void }, over: Partial<Props> = {}) {
  reset();
  const screen = await mount(h(PressMentions, props(over)));
  t.after(() => screen.unmount());
  return screen;
}

test("a month's range lists that month's stories, and counts each company in it", async (t) => {
  const screen = await screenFor(t);
  const text = screen.text();
  assert.match(text, /2 press mentions in Nov 2026, latest from 2 Nov 2026\./);
  assert.ok(text.includes("Headline n1") && text.includes("Headline n2"));
  assert.ok(!text.includes("Headline j1"), "June's story is outside the range");
  // Knight Frank has no November story: still offered, at 0.
  assert.deepEqual(screen.buttons().slice(1, 5), ["All (2)", "betterhomes (1)", "Allsopp & Allsopp (1)", "Knight Frank (0)"]);
  // Both sides have November stories, all found by the bot: nothing to warn about.
  assert.ok(!text.includes("PR agency") && !text.includes("No rival stories"));
});

test("a wider range says which of ours only the PR agency holds, and the months with no rival story", async (t) => {
  const screen = await screenFor(t, { from: "2025-01", to: "2026-11" });
  const text = screen.text();
  assert.match(text, /4 press mentions from Jan 2025 to Nov 2026/);
  assert.ok(
    text.includes(
      "1 of the 3 betterhomes stories here come only from the PR agency's clippings, which the rivals don't have. Share of Voice compares only the stories the bot found for each company.",
    ),
  );
  assert.ok(text.includes("Rival stories are stored from Jun 2026, and none for Jul to Oct 2026."));
});

test("All time lists every story on record, the undated ones too", async (t) => {
  const screen = await screenFor(t, { from: "2025-01", to: "2026-11", allTime: true });
  assert.match(screen.text(), /5 press mentions on record, latest from 2 Nov 2026\./);
  assert.ok(screen.text().includes("Headline u1"));
});

test("a range with no story says so, rather than that none is stored", async (t) => {
  const screen = await screenFor(t, { from: "2024-01", to: "2024-02" });
  assert.ok(screen.text().includes("No press mentions in this date range."));
});
