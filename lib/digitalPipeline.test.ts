import { test } from "node:test";
import assert from "node:assert/strict";
import { campaignKeys, pipelineSql, readPipelineRows } from "@/lib/digitalPipeline";
import { DEAL_VALID, LEAD_SCOPE } from "@/lib/metabase";

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
});

test("a campaign name with a quote or a backslash cannot break out of its string", () => {
  const sql = pipelineSql("2026-01-01", "2026-01-31", ["o'neil \\ campaign"]);
  assert.ok(sql.includes("IN ('o''neil \\\\ campaign')"));
});

test("rows are read into campaign months and the sources of indirect deals", () => {
  const { cells, sources } = readPipelineRows([
    ["cell", "ggl_search_ct1", "2026-02", "12", "10", "2", "1", "3", "1", "45000.50", "5000", "9000", "2400000"],
    ["source", "ggl_search_ct1", "Bayut", "2", 0, 0, 0, 0, 0, "40000.50", 0, 0, 0],
  ]);
  assert.deepEqual(cells, [
    {
      campaign: "ggl_search_ct1",
      month: "2026-02",
      leads: 12,
      people: 10,
      viewed: 2,
      listings: 1,
      deals: 3,
      directDeals: 1,
      commission: 45000.5,
      directCommission: 5000,
      reservedCommission: 9000,
      dealValue: 2400000,
    },
  ]);
  assert.deepEqual(sources, [{ campaign: "ggl_search_ct1", source: "Bayut", deals: 2, commission: 40000.5 }]);
});
