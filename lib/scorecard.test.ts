import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, monthsIn, n, ordinal, perMonth, quarters, total } from "@/lib/scorecard";
import type { PaidData } from "@/lib/paid";
import type { PipelineData } from "@/lib/digitalPipeline";

const day = (date: string, platform: "google" | "meta", campaign: string, campaignId: string | null, cost: number, impressions = 0, clicks = 0, leads = 0) => ({
  date, platform, campaign, campaignId, cost, impressions, clicks, leads,
});
const row = (platform: "google" | "meta", campaign: string, campaignId: string | null) =>
  ({ platform, campaign, campaignId }) as PaidData["rows"][number];
const cell = (campaign: string, month: string, f: Partial<PipelineData["cells"][number]>) => ({
  campaign, month, leads: 0, viewed: 0, viewedDone: 0, listings: 0, deals: 0, commission: 0, reservedCommission: 0, dealValue: 0, ...f,
});

const PAID = {
  rows: [row("google", "GGL_Search_CT1", null), row("meta", "BH-Webinar", "1202")],
  byDateFine: [
    day("2026-02-03", "google", "GGL_Search_CT1", null, 1000, 50000, 900, 4),
    day("2026-02-20", "google", "GGL_Search_CT1", null, 500, 20000, 300, 1),
    day("2026-04-02", "meta", "BH-Webinar", "1202", 2000, 80000, 1200, 30),
    day("2025-12-31", "meta", "BH-Webinar", "1202", 999, 1, 1, 1), // outside the range
  ],
};
const PIPE = {
  cells: [
    cell("ggl_search_ct1", "2026-02", { leads: 10, viewed: 2, viewedDone: 1, deals: 1, commission: 20000 }),
    // A Meta campaign's leads carry its name or its id: both are its own.
    cell("bh-webinar", "2026-04", { leads: 5 }),
    cell("1202", "2026-04", { leads: 7, deals: 1, commission: 9000, reservedCommission: 9000 }),
    cell("not-an-ad-campaign", "2026-04", { leads: 99 }),
  ],
  codes: [
    { campaign: "bh-webinar", code: "webinar-2026", leads: 4 },
    { campaign: "1202", code: "webinar-2026", leads: 6 },
    { campaign: "1202", code: "bh-investors", leads: 2 },
  ],
};

test("months run from the range's first to its last, across a year end", () => {
  assert.deepEqual(monthsIn("2025-11-15", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

test("each ad campaign is one row, joining its CRM leads by name and by Meta id, and nothing outside the ads", () => {
  const m = buildModel(PAID, PIPE, "2026-01-01", "2026-11-18");
  assert.deepEqual(m.campaigns.map((c) => [c.id, c.keys]), [
    ["google|ggl_search_ct1", ["ggl_search_ct1"]],
    ["meta|bh-webinar", ["bh-webinar", "1202"]],
  ]);
  const meta = total(m, ["meta|bh-webinar"], m.months.map((_, i) => i));
  assert.equal(meta.leads, 12);
  assert.equal(meta.deals, 1);
  assert.equal(meta.resComm, 9000);
  assert.equal(meta.spend, 2000, "the December day is outside the range");
  // Its codes, added across its name and id, the one with the most leads first; never merged into one another.
  assert.deepEqual(m.campaigns[1].codes, [
    { code: "webinar-2026", leads: 10 },
    { code: "bh-investors", leads: 2 },
  ]);
  const all = total(m, m.campaigns.map((c) => c.id), m.months.map((_, i) => i));
  assert.equal(all.leads, 22, "the CRM key no ad campaign carries is left out");
  assert.equal(all.impr, 150000);
  assert.equal(all.pleads, 35);
});

test("the ad half stands on its own while the CRM is still answering", () => {
  const m = buildModel(PAID, null, "2026-01-01", "2026-11-18");
  const all = total(m, m.campaigns.map((c) => c.id), m.months.map((_, i) => i));
  assert.equal(all.spend, 3500);
  assert.equal(all.leads, 0);
  assert.deepEqual(m.campaigns[1].codes, []);
});

test("quarters follow the calendar: 'to date' only while the range runs to today, '(part)' where it cuts one short", () => {
  const today = "2026-11-18";
  const months = monthsIn("2026-01-01", today);
  assert.deepEqual(quarters(months, "2026-01-01", today, today).map((q) => [q.label, q.idx]), [
    ["Q1 2026", [0, 1, 2]],
    ["Q2 2026", [3, 4, 5]],
    ["Q3 2026", [6, 7, 8]],
    ["Q4 2026 to date", [9, 10]],
  ]);
  // Starting inside a quarter, or ending inside one before today, covers part of it.
  assert.deepEqual(quarters(monthsIn("2026-02-10", "2026-06-30"), "2026-02-10", "2026-06-30", today).map((q) => q.label), ["Q1 2026 (part)", "Q2 2026"]);
  assert.deepEqual(quarters(monthsIn("2026-07-01", "2026-08-15"), "2026-07-01", "2026-08-15", today).map((q) => q.label), ["Q3 2026 (part)"]);
});

test("numbers are written in the unit they round into, never 1000K", () => {
  const cases: [number | null, string][] = [
    [null, "—"], [0, "0"], [999.4, "999"], [999.5, "1.0K"], [1234, "1.2K"], [9949, "9.9K"], [9950, "10K"],
    [15400, "15K"], [999_499, "999K"], [999_500, "1.00M"], [2_345_678, "2.35M"], [9_994_000, "9.99M"], [9_995_000, "10.0M"], [-1500, "-1.5K"],
  ];
  for (const [v, want] of cases) assert.equal(n(v), want, `n(${v})`);
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 18, 21, 22, 23, 31].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "18th", "21st", "22nd", "23rd", "31st"]);
});

test("each month's sum over the chosen campaigns", () => {
  const m = buildModel(PAID, PIPE, "2026-01-01", "2026-04-30");
  const months = perMonth(m, ["google|ggl_search_ct1"]);
  assert.deepEqual(months.map((f) => f.spend), [0, 1500, 0, 0]);
  assert.deepEqual(months.map((f) => f.leads), [0, 10, 0, 0]);
});
