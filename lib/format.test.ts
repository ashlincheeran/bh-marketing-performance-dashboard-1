import { test } from "node:test";
import assert from "node:assert/strict";
import { dayMonth, fmt1, fmtAED, fmtAEDExact, fmtAEDShort, fmtInt, fmtMoney, monthShort, sharePct } from "@/lib/format";

test("dirhams read the same on every tab", () => {
  assert.equal(fmtAED(111_500_000), "AED 111.5M");
  assert.equal(fmtAED(4_240_000), "AED 4.24M");
  assert.equal(fmtAED(603_000), "AED 603K");
  assert.equal(fmtAED(1_204_000_000), "AED 1.20B");
  assert.equal(fmtAED(null), "—");
  assert.equal(fmtAEDShort(24_400_000), "AED 24M");
  assert.equal(fmtAEDShort(4_240_000), "AED 4.2M");
  assert.equal(fmtAEDExact(3651.4), "AED 3,651");
  assert.equal(fmtAEDExact(null), "—");
  assert.equal(fmtMoney(12_000, "USD"), "USD 12K");
});

test("counts, shares and dates read the same on every tab", () => {
  assert.equal(fmtInt(17434), "17,434");
  assert.equal(fmtInt(null), "—");
  assert.equal(fmt1(5), "5.0");
  assert.equal(fmt1(null), "—");
  assert.equal(sharePct(0.22), "22%");
  assert.equal(sharePct(0.004), "<1%");
  assert.equal(sharePct(0), "0%");
  assert.equal(monthShort("2026-10"), "Oct 26");
  assert.equal(dayMonth("2026-11-20"), "20 Nov");
  assert.equal(dayMonth("2026-11-20T09:00:00Z"), "20 Nov");
});
