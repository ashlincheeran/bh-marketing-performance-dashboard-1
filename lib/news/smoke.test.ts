import { test } from "node:test";
import assert from "node:assert/strict";
import { outletKey } from "@/lib/match";

test("the @ alias resolves inside tests", () => {
  assert.equal(outletKey("Khaleej Times"), outletKey(null, "https://www.khaleejtimes.com/x"));
});
