import { test } from "node:test";
import assert from "node:assert/strict";
import { monthSpend, spendBetween, spendSource, spendWithin } from "@/lib/portalSpend";

test("a month the business gave is BH DXB and BH ELITE together, in AED", () => {
  assert.equal(monthSpend("2026-01"), (918 + 69) * 1000);
  assert.equal(monthSpend("2025-04"), (952 + 135) * 1000);
  assert.equal(monthSpend("2026-10"), (653 + 90) * 1000);
  assert.equal(spendSource("2026-10"), "2026-10");
  assert.equal(monthSpend("2024-12"), null);
  assert.equal(spendSource("2024-12"), null);
});

test("a month with no figure takes the same month of the latest year given, for good", () => {
  // November and December 2026: 2025's.
  assert.equal(monthSpend("2026-11"), (914 + 81) * 1000);
  assert.equal(spendSource("2026-11"), "2025-11");
  assert.equal(monthSpend("2026-12"), (866 + 128) * 1000);
  // 2027 is 2026's month by month, and its November and December 2025's again.
  assert.equal(monthSpend("2027-01"), (918 + 69) * 1000);
  assert.equal(spendSource("2027-10"), "2026-10");
  assert.equal(spendSource("2027-11"), "2025-11");
  assert.equal(monthSpend("2031-03"), (747 + 88) * 1000);
});

test("a range that starts or ends inside a month takes its share by days", () => {
  assert.equal(spendWithin("2026-11", "2026-11-01", "2026-11-15"), (995_000 * 15) / 30);
  assert.equal(spendWithin("2026-11", "2026-12-01", "2026-12-31"), 0);
  assert.equal(spendBetween("2026-01-01", "2026-02-28"), (987 + 970) * 1000);
  assert.equal(spendBetween("2026-10-17", "2026-11-03"), (743_000 * 15) / 31 + (995_000 * 3) / 30);
  // Leap-year February counts 29 days.
  assert.equal(spendWithin("2028-02", "2028-02-01", "2028-02-29"), (888 + 82) * 1000);
});
