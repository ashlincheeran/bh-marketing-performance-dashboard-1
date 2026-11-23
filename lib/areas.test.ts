import { test } from "node:test";
import assert from "node:assert/strict";
import { LISTINGS_SQL, areasSql, foldAreas, monthPieces } from "@/lib/areas";

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
  // Each lead's first requirement found in one grouped pass for the range's leads, not lead by lead.
  assert.match(sql.leads, /GROUP BY r\.lead_id\s*\) fr ON fr\.lead_id = l\.id/);
  assert.match(sql.leads, /rl\.created_at >= '2026-01-01'/);
  assert.doesNotMatch(sql.leads, /WHERE r\.lead_id = l\.id/);
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
  assert.deepEqual(areas[1], { area: "Dubai Marina", leads: 900, viewings: 0, deals: 20, commission: 1_500_000, listings: 0 });
  assert.equal(areas[2].leads, 0);
});

test("a range is counted in month pieces, its first and last cut to the range", () => {
  assert.deepEqual(monthPieces("2026-01-01", "2026-03-15"), [
    { from: "2026-01-01", to: "2026-01-31", whole: true },
    { from: "2026-02-01", to: "2026-02-28", whole: true },
    { from: "2026-03-01", to: "2026-03-15", whole: false },
  ]);
  assert.deepEqual(monthPieces("2025-12-10", "2026-01-31"), [
    { from: "2025-12-10", to: "2025-12-31", whole: false },
    { from: "2026-01-01", to: "2026-01-31", whole: true },
  ]);
  assert.deepEqual(monthPieces("2026-10-01", "2026-10-31"), [{ from: "2026-10-01", to: "2026-10-31", whole: true }]);
});

test("listings are the stock held today, by its property's area, whatever the range", () => {
  // Active listings on a property, placed as a deal's listing is placed (lib/portals.ts); no date in it.
  assert.match(LISTINGS_SQL, /li\.status = 'Active'/);
  assert.match(LISTINGS_SQL, /li\.listable_type = 'Property'/);
  assert.match(LISTINGS_SQL, /JOIN properties p ON p\.id = li\.listable_id/);
  assert.match(LISTINGS_SQL, /COALESCE\(loc2\.name, loc1\.name, loc\.name\)/);
  assert.doesNotMatch(LISTINGS_SQL, /created_at|activated_at|20\d\d-/);
  const areas = foldAreas(null, null, [["Dubai Marina", 20, 1_500_000]], [["Dubai Marina", 581], ["Yas Island", 290]]);
  assert.deepEqual(areas.find((a) => a.area === "Dubai Marina"), { area: "Dubai Marina", leads: 0, viewings: 0, deals: 20, commission: 1_500_000, listings: 581 });
  assert.equal(areas.find((a) => a.area === "Yas Island")?.listings, 290);
});
