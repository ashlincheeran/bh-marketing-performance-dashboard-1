import { test } from "node:test";
import assert from "node:assert/strict";
import { campaignKeys, pipelineSql, readPipelineRows, rememberedForNames, type PipelineData } from "@/lib/digitalPipeline";
import { DEAL_VALID, LEAD_SCOPE } from "@/lib/metabase";
import type { CacheStore } from "@/lib/cache";

test("campaign names are matched in lower case, trimmed, once each", () => {
  assert.deepEqual(campaignKeys([" GGL_Search_CT1 ", "ggl_search_ct1", "", "120211630943590318", "  "]), ["120211630943590318", "ggl_search_ct1"]);
});

test("the query reads the range's paid leads once, in the shared scope, and counts valid deals only", () => {
  const sql = pipelineSql("2026-01-01", "2026-11-18", ["ggl_search_ct1", "120211630943590318"]);
  assert.match(sql, /l\.created_at >= '2026-01-01' AND l\.created_at < DATE_ADD\('2026-11-18', INTERVAL 1 DAY\)/);
  assert.ok(sql.includes(LEAD_SCOPE), "leads are scoped the way every tab scopes them");
  assert.ok(sql.includes(DEAL_VALID), "deals are counted the way every tab counts them");
  assert.ok(sql.includes("IN ('ggl_search_ct1','120211630943590318')"));
  // DISTINCT keeps the leads scan to one: without it MySQL ran it once per use, 41 s for a month.
  assert.match(sql, /WITH paid AS \(\s*SELECT DISTINCT/);
  // The final commission once the CRM has one, the reserved one until then; never the larger of the two.
  assert.ok(sql.includes("COALESCE(NULLIF(d.final_gross_commission_amount,0), d.reserved_gross_commission_amount, 0)"));
  assert.doesNotMatch(sql, /GREATEST/);
  // Each person once, under their first paid lead.
  assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY cid ORDER BY at_, lid\)/);
  // A viewing counts when logged as scheduled or completed and dated up to now; cancelled ones never.
  // activities.datetime is UTC while the session runs in Dubai time, so both sides are UTC.
  assert.match(sql, /a\.status IN \('Completed','Scheduled'\)\s+AND a\.datetime >= CONVERT_TZ\(t\.first_at, @@session\.time_zone, '\+00:00'\) AND a\.datetime <= UTC_TIMESTAMP\(\)/);
  // Each campaign's codes come back as one row, never one per code.
  assert.match(sql, /JSON_ARRAYAGG\(JSON_ARRAY\(k\.code, k\.n\)\)/);
});

test("a campaign name with a quote or a backslash cannot break out of its string", () => {
  const sql = pipelineSql("2026-01-01", "2026-01-31", ["o'neil \\ campaign"]);
  assert.ok(sql.includes("IN ('o''neil \\\\ campaign')"));
});

test("rows are read into campaign months, the sources of indirect deals by month, and each campaign's codes", () => {
  const { cells, sources, codes } = readPipelineRows([
    ["cell", "ggl_search_ct1", "2026-02", "12", "10", "4", "2", "1", "3", "1", "45000.50", "5000", "9000", "2400000"],
    ["source", "ggl_search_ct1", "2026-02 Previous Seller/Landlord", "2", 0, 0, 0, 0, 0, 0, "40000.50", 0, 0, 0],
    ["code", "ggl_search_ct1", '[["ggl_search_ct1", 12], ["bh-list-with-us", 5]]', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ["code", "bh-webinar", [["webinar-2026", 3]], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ["code", "broken", "not json", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ]);
  assert.deepEqual(cells, [
    {
      campaign: "ggl_search_ct1",
      month: "2026-02",
      leads: 12,
      people: 10,
      viewed: 4,
      viewedDone: 2,
      listings: 1,
      deals: 3,
      directDeals: 1,
      commission: 45000.5,
      directCommission: 5000,
      reservedCommission: 9000,
      dealValue: 2400000,
    },
  ]);
  assert.deepEqual(sources, [{ campaign: "ggl_search_ct1", month: "2026-02", source: "Previous Seller/Landlord", deals: 2, commission: 40000.5 }]);
  assert.deepEqual(codes, [
    { campaign: "ggl_search_ct1", code: "ggl_search_ct1", leads: 12 },
    { campaign: "ggl_search_ct1", code: "bh-list-with-us", leads: 5 },
    { campaign: "bh-webinar", code: "webinar-2026", leads: 3 },
  ]);
});

/** Kept answers in memory, as lib/cache.test.ts keeps them. */
function memoryStore(): CacheStore {
  const rows = new Map<string, { payload: unknown; computedAt: string; stale: boolean }>();
  return {
    async read(key) {
      return rows.get(key) ?? null;
    },
    async write(key, payload, computedAt) {
      rows.set(key, { payload: JSON.parse(JSON.stringify(payload)), computedAt, stale: false });
    },
    async lock() {
      return true;
    },
    async markAllStale() {},
  };
}
const answer = (people: number): PipelineData => ({ connected: true, from: "2026-01-01", to: "2026-11-18", cells: [{ campaign: "x", month: "2026-01", leads: people, people, viewed: 0, viewedDone: 0, listings: 0, deals: 0, directDeals: 0, commission: 0, directCommission: 0, reservedCommission: 0, dealValue: 0 }], sources: [], codes: [], truncated: false });

test("an answer kept for other campaigns is shown at once, and a live look works it out again for these", async () => {
  const store = memoryStore();
  const now = () => Date.parse("2026-11-18T09:00:00Z");
  // The morning warm-up keeps an answer for the campaigns stored by then.
  await rememberedForNames("k", "morning", async () => answer(10), { store, now, fresh: true });
  // A campaign started since: the page's first ask gets the kept answer straight away...
  let asked = 0;
  const first = await rememberedForNames("k", "now", async () => (asked++, answer(12)), { store, now, later: () => {} });
  assert.equal(first.cells[0].people, 10);
  assert.equal(asked, 0);
  // ...and its live look, even within the minute, asks the CRM about these campaigns.
  const live = await rememberedForNames("k", "now", async () => (asked++, answer(12)), { store, now, maxAgeMs: 60_000 });
  assert.equal(live.cells[0].people, 12);
  assert.equal(live.names, "now");
  assert.equal(asked, 1);
  // The same campaigns again: the kept answer stands.
  const again = await rememberedForNames("k", "now", async () => assert.fail("asked again"), { store, now, maxAgeMs: 60_000 });
  assert.equal(again.cells[0].people, 12);
});
