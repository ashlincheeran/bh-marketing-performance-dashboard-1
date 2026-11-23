import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, latestMonth, monthBounds, periodQuery, resolvePeriod } from "@/lib/growthPeriod";
import { addUpDays, isBrandSearch } from "@/lib/gsc";
import { coverageSites } from "@/lib/data";
import { growthCrmSql } from "@/lib/metabase";

test("months step across the year", () => {
  assert.equal(addMonths("2026-01", -2), "2025-11");
  assert.equal(addMonths("2025-12", 1), "2026-01");
  assert.deepEqual(monthBounds("2026-02"), { month: "2026-02", from: "2026-02-01", to: "2026-02-28" });
});

test("the latest month is the last one Search Console has published in full", () => {
  // 20 Nov 2026 in Dubai is 19 Nov in Los Angeles: published to the 16th, so October is whole.
  assert.equal(latestMonth(new Date("2026-11-20T08:00:00Z")), "2026-10");
  // 2 Nov in Los Angeles: published to 30 Oct, so October is not whole yet.
  assert.equal(latestMonth(new Date("2026-11-02T20:00:00Z")), "2026-09");
  // 3 Nov in Los Angeles: published to 31 Oct. And on 3 January 2027 the year turns over by itself.
  assert.equal(latestMonth(new Date("2026-11-03T20:00:00Z")), "2026-10");
  assert.equal(latestMonth(new Date("2027-01-03T20:00:00Z")), "2026-12");
});

test("a period is set against the same number of months just before, and its charts draw a year at least", () => {
  const p = resolvePeriod({}, "2026-10");
  assert.deepEqual([p.preset, p.from, p.to, p.compareFrom, p.compareTo], ["last3", "2026-08", "2026-10", "2026-05", "2026-07"]);
  assert.deepEqual([p.trend[0], p.trend.length, p.months[0], p.months.length], ["2025-11", 12, "2025-11", 12]);
  // In January 2027 the same link moves on by itself.
  const jan = resolvePeriod({ preset: "last3" }, "2026-12");
  assert.deepEqual([jan.from, jan.to, jan.compareFrom, jan.compareTo, jan.trend[0]], ["2026-10", "2026-12", "2026-07", "2026-09", "2026-01"]);
  // A year against the year before: twenty-four months asked for, twelve drawn.
  const year = resolvePeriod({ preset: "last12" }, "2026-10");
  assert.deepEqual([year.from, year.compareFrom, year.compareTo, year.months.length, year.trend.length], ["2025-11", "2024-11", "2025-10", 24, 12]);
  assert.deepEqual([resolvePeriod({ preset: "ytd" }, "2026-10").from, resolvePeriod({ preset: "last1" }, "2026-10").from], ["2026-01", "2026-10"]);
});

test("months picked by hand are kept in order, within the months every source holds", () => {
  const p = resolvePeriod({ from: "2026-09", to: "2026-03" }, "2026-10");
  assert.deepEqual([p.preset, p.from, p.to, p.compareFrom], ["custom", "2026-03", "2026-09", "2025-08"]);
  assert.deepEqual([resolvePeriod({ from: "2024-01", to: "2027-05" }, "2026-10").from, resolvePeriod({ from: "2024-01", to: "2027-05" }, "2026-10").to], ["2025-11", "2026-10"]);
  // Anything else is the default; a preset stays a preset in the address, so it keeps rolling.
  assert.equal(resolvePeriod({ preset: "nonsense", from: "bad" }, "2026-10").preset, "last3");
  assert.equal(periodQuery(resolvePeriod({ preset: "last6" }, "2026-10")), "preset=last6");
  assert.equal(periodQuery(resolvePeriod({ from: "2026-02", to: "2026-04" }, "2026-10")), "from=2026-02&to=2026-04");
});

test("days add up to months, position weighted by impressions", () => {
  const m = addUpDays([
    { date: "2026-10-01", clicks: 10, impressions: 100, position: 10 },
    { date: "2026-10-02", clicks: 20, impressions: 300, position: 20 },
    { date: "2026-11-01", clicks: 5, impressions: 0, position: 0 },
  ]);
  assert.deepEqual(m.get("2026-10"), { clicks: 30, impressions: 400, position: 17.5 });
  assert.deepEqual(m.get("2026-11"), { clicks: 5, impressions: 0, position: null });
});

test("brand searches are ours in any spacing, and not Better Homes & Gardens", () => {
  assert.equal(isBrandSearch("betterhomes dubai"), true);
  assert.equal(isBrandSearch("better homes rent"), true);
  assert.equal(isBrandSearch("better home dubai"), true);
  assert.equal(isBrandSearch("bhomes.com"), true);
  assert.equal(isBrandSearch("better homes and gardens"), false);
  assert.equal(isBrandSearch("apartments for sale in dubai"), false);
});

test("coverage sites are hosts, once each, without www or our own site", () => {
  assert.deepEqual(
    coverageSites(["https://www.khaleejtimes.com/a", "https://khaleejtimes.com/b", "https://bhomes.com/en", "not a url", null, "http://news.google.com/x"]),
    ["khaleejtimes.com", "news.google.com"],
  );
});

test("the CRM questions count people per month and line, and credit deals from the first organic enquiry", () => {
  const q = growthCrmSql("2026-08-01", "2026-10-31");
  assert.match(q.leads, /GROUP BY m, line WITH ROLLUP/);
  assert.match(q.leads, /li\.sub_type = 'Off Plan'/);
  assert.match(q.leads, /property-management/);
  assert.match(q.outcomes, /WITH touch AS/);
  assert.match(q.outcomes, /d\.status IN \('Reserved','Closed','Completed'\)/);
  assert.match(q.outcomes, /li\.created_at >= tc\.first_at/);
});
