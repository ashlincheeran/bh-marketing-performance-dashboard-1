import { test } from "node:test";
import assert from "node:assert/strict";
import { monthPieces } from "@/lib/seoReport";

// The Dashboard's SEO card adds up the SEO tab's months (getSeoTile), so a
// range is cut into calendar months, the first and last clipped to it.

test("a range is its calendar months, the ends clipped", () => {
  assert.deepEqual(monthPieces("2026-08-14", "2026-10-03"), [
    { month: "2026-08", from: "2026-08-14", to: "2026-08-31" },
    { month: "2026-09", from: "2026-09-01", to: "2026-09-30" },
    { month: "2026-10", from: "2026-10-01", to: "2026-10-03" },
  ]);
  // Whole months stay whole, so they are the SEO tab's own months.
  assert.deepEqual(monthPieces("2026-01-01", "2026-02-28"), [
    { month: "2026-01", from: "2026-01-01", to: "2026-01-31" },
    { month: "2026-02", from: "2026-02-01", to: "2026-02-28" },
  ]);
  // Across New Year, and within one day.
  assert.deepEqual(monthPieces("2025-12-30", "2026-01-02").map((p) => p.month), ["2025-12", "2026-01"]);
  assert.deepEqual(monthPieces("2026-11-05", "2026-11-05"), [{ month: "2026-11", from: "2026-11-05", to: "2026-11-05" }]);
});
