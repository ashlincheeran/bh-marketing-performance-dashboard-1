import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addCounts, aed, assistantName, change, cumulative, monthSpan, moved, pctText, quarterPair, ranked, sectionName, total, weightedPosition,
} from "@/lib/growthMath";

test("a sum short of a month is no sum", () => {
  assert.equal(total([1, 2, 3]), 6);
  assert.equal(total([1, null, 3]), null);
  assert.equal(total([]), 0);
});

test("change is against the earlier figure, and undefined against nothing", () => {
  assert.equal(change(133, 100), 0.33);
  assert.equal(change(5, 0), null);
  assert.equal(change(null, 4), null);
});

test("the quarter is the last three months and its comparison the three before", () => {
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
  assert.deepEqual(quarterPair(months), { now: ["10", "11", "12"], before: ["07", "08", "09"] });
});

test("running totals stop at a missing month", () => {
  assert.deepEqual(cumulative([1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(cumulative([1, null, 3]), [1, null, null]);
});

test("a quarter's position is weighted by impressions, months without any left out", () => {
  const p = weightedPosition([{ position: 10, impressions: 100 }, { position: 20, impressions: 300 }, null, { position: null, impressions: 0 }]);
  assert.equal(p, 17.5);
  assert.equal(weightedPosition([null]), null);
});

test("deltas and dirhams read the way the report writes them", () => {
  assert.equal(pctText(0.035), "▲ 3.5%");
  assert.equal(pctText(-0.16), "▼ 16%");
  assert.equal(pctText(null), "—");
  assert.equal(moved(0.33), "up 33%");
  assert.equal(moved(-0.08), "down 8%");
  assert.equal(moved(0.001), "level");
  assert.equal(aed(1_160_847), "AED 1.16M");
  assert.equal(aed(145_782), "AED 146K");
});

test("months read as the report's chips", () => {
  assert.equal(monthSpan("2026-08", "2026-10"), "Aug–Oct 2026");
  assert.equal(monthSpan("2025-11", "2026-01"), "Nov 2025 – Jan 2026");
  assert.equal(monthSpan("2026-10", "2026-10"), "October 2026");
});

test("sections and assistants are named from the data", () => {
  assert.equal(sectionName("home"), "Home page");
  assert.equal(sectionName("area-guides"), "Area guides");
  assert.equal(assistantName("chatgpt"), "ChatGPT");
  assert.equal(assistantName("manus", ["manus.im"]), "Manus.im");
});

test("counts add up across months, largest first", () => {
  assert.deepEqual(addCounts([{ a: 1, b: 2 }, null, { a: 3 }]), { a: 4, b: 2 });
  assert.deepEqual(ranked([{ chatgpt: 900, gemini: 30 }, { gemini: 40, claude: 5 }]).map((r) => r.key), ["chatgpt", "gemini", "claude"]);
});
