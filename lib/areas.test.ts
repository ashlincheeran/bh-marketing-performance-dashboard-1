import { test } from "node:test";
import assert from "node:assert/strict";
import { areasSql, foldAreas } from "@/lib/areas";

test("the areas are counted as the Company tab counts the business, every channel", () => {
  const sql = areasSql("2026-01-01", "2026-11-23");
  // Leads and viewings in the shared lead scope, placed by the listing asked about; no channel filter.
  for (const q of [sql.leads, sql.viewings]) {
    assert.match(q, /lead_requirements/);
    assert.match(q, /lloc\.id IS NOT NULL/);
    assert.match(q, /l\.type IN \('Buyer','Seller','Tenant','Landlord'\)/);
    assert.match(q, /GoYzer/);
    // Every channel: no portal (or other channel) filter.
    assert.doesNotMatch(q, /'bayut'|'property finder'/);
  }
  assert.match(sql.viewings, /a\.type = 'Viewing' AND a\.status = 'Completed'/);
  // Deals by reservation date under the shared rule, so reservations count; commission as the Company tab's revenue.
  assert.match(sql.deals, /d\.reserved_at >= '2026-01-01' AND d\.reserved_at < DATE_ADD\('2026-11-23', INTERVAL 1 DAY\)/);
  assert.match(sql.deals, /d\.status IN \('Reserved','Closed','Completed'\)/);
  assert.match(sql.deals, /final_gross_commission_amount/);
});

test("rows fold into one row per area, biggest commission first, and a failed query adds nothing", () => {
  const areas = foldAreas(
    [["Dubai Marina", 900], ["Business Bay", 400]],
    null,
    [["Business Bay", 12, 2_000_000], ["Dubai Marina", 20, 1_500_000], ["Palm Jumeirah", 3, 900_000]],
  );
  assert.deepEqual(areas.map((a) => a.area), ["Business Bay", "Dubai Marina", "Palm Jumeirah"]);
  assert.deepEqual(areas[1], { area: "Dubai Marina", leads: 900, viewings: 0, deals: 20, commission: 1_500_000 });
  assert.equal(areas[2].leads, 0);
});
