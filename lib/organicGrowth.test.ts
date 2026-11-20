import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, monthBounds, reportMonths } from "@/lib/organicGrowth";
import { addUpDays, isBrandSearch } from "@/lib/gsc";
import { coverageSites } from "@/lib/data";
import { growthCrmSql } from "@/lib/metabase";

test("months step across the year", () => {
  assert.equal(addMonths("2026-01", -2), "2025-11");
  assert.equal(addMonths("2025-12", 1), "2026-01");
  assert.deepEqual(monthBounds("2026-02"), { month: "2026-02", from: "2026-02-01", to: "2026-02-28" });
});

test("the report ends on the last month Search Console has published in full", () => {
  // 20 Nov 2026 in Dubai is 19 Nov in Los Angeles: published to the 16th, so October is whole.
  const nov = reportMonths(new Date("2026-11-20T08:00:00Z"));
  assert.equal(nov.length, 12);
  assert.equal(nov[0], "2025-11");
  assert.equal(nov[11], "2026-10");
  // 2 Nov in Los Angeles: published to 30 Oct, so October is not whole yet.
  assert.equal(reportMonths(new Date("2026-11-02T20:00:00Z"))[11], "2026-09");
  // 3 Nov in Los Angeles: published to 31 Oct.
  assert.equal(reportMonths(new Date("2026-11-03T20:00:00Z"))[11], "2026-10");
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
