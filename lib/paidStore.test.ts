import { test } from "node:test";
import assert from "node:assert/strict";
import { contiguousBlocks, dateRange, fetchedWhole } from "@/lib/paidStore";

// A day of ad data counts as final only once a fetch has seen all of it.
// 30 Sep and 27 Oct 2026 were fetched while still running and never again,
// so the Digital tab showed them half-loaded for good.

const at = (iso: string) => Date.parse(iso);

test("a day fetched while it was still running, or the morning after, is fetched again", () => {
  // Fetched at 10:00 UTC on the day itself: half the day was still to come.
  assert.equal(fetchedWhole("2026-09-30", at("2026-09-30T10:00:00Z")), false);
  // The morning after in Dubai is still the evening before in a Pacific-time account.
  assert.equal(fetchedWhole("2026-09-30", at("2026-10-01T04:20:00Z")), false);
  // Two days on, the day has ended everywhere.
  assert.equal(fetchedWhole("2026-09-30", at("2026-10-02T00:00:00Z")), true);
  assert.equal(fetchedWhole("2026-09-30", at("2026-10-13T04:20:00Z")), true);
});

test("days and blocks are worked out the same as before", () => {
  assert.deepEqual(dateRange("2026-09-29", "2026-10-02"), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  assert.deepEqual(contiguousBlocks(["2026-09-30", "2026-10-27", "2026-10-28"]), [
    { from: "2026-09-30", to: "2026-09-30" },
    { from: "2026-10-27", to: "2026-10-28" },
  ]);
});
