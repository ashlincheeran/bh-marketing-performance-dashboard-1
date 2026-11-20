import { test } from "node:test";
import assert from "node:assert/strict";
import { newChannels, sourceLabel } from "@/lib/company";

// The Company tab's channels: the named ones, and any other source big enough
// to stand alone. Rows as the CRM aggregates return them: [month, channel,
// division, count, ...], an unnamed source arriving as "src:<name>".

const row = (ch: string, n: number) => ["2026-10", ch, "Sales", n];

test("a source's name reads as a channel", () => {
  assert.equal(sourceLabel("outdoor media/signage"), "Outdoor Media/Signage");
  assert.equal(sourceLabel("calls better homes agent direct"), "Calls Better Homes Agent Direct");
  assert.equal(sourceLabel("walk-in"), "Walk-In");
});

test("an unnamed source with 1% of the leads or of the deals gets its own channel; smaller ones stay in Other", () => {
  // 1,000 leads: Pinterest 10 (1%), Engage app 9 (0.9%). 100 deals: external broker 1 (1%).
  const leads = [row("Property Finder", 981), row("src:pinterest", 10), row("src:engage app", 9)];
  const deals = [row("Bayut", 99), row("src:external broker", 1)];
  assert.deepEqual([...newChannels(leads, deals)], [
    ["src:external broker", "External Broker"],
    ["src:pinterest", "Pinterest"],
  ]);
});

test("at most four new channels, biggest share first; named channels never count", () => {
  const leads = [
    row("Website", 500),
    ...["a", "b", "c", "d", "e"].map((x, i) => row(`src:${x}`, 100 - i * 10)),
  ];
  assert.deepEqual([...newChannels(leads, []).values()], ["A", "B", "C", "D"]);
  assert.equal(newChannels([row("Website", 10)], []).size, 0);
});
