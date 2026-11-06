import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsPerAccount } from "@/lib/perfIngest";
import { DEFAULT_PERF_CONFIG } from "@/lib/perfTypes";

// The run's Items / account comes from the request body. The Social
// Performance screen keeps it to 5..100, and so must the server: 0 tells the
// LinkedIn actor to fetch every post, each one billed.

test("posts per account keep to the Items box's 5 to 100", () => {
  assert.equal(itemsPerAccount(24, 15), 24);
  assert.equal(itemsPerAccount(5, 15), 5);
  assert.equal(itemsPerAccount(100, 15), 100);
  assert.equal(itemsPerAccount(0, 15), 5, "0 would mean every post");
  assert.equal(itemsPerAccount(-3, 15), 5);
  assert.equal(itemsPerAccount(1, 15), 5);
  assert.equal(itemsPerAccount(101, 15), 100);
  assert.equal(itemsPerAccount(1e9, 15), 100);
  assert.equal(itemsPerAccount(Infinity, 15), 15, "not a number a person could type, so the default");
  assert.equal(itemsPerAccount(7.6, 15), 8, "a whole number, as the actors expect");
});

test("a missing or nonsense value takes the stored default, itself kept to 5 to 100", () => {
  for (const asked of [undefined, null, "", " ", "lots", NaN, {}, [], true]) {
    assert.equal(itemsPerAccount(asked, 24), 24, `asked ${JSON.stringify(asked)}`);
  }
  assert.equal(itemsPerAccount("40", 24), 40, "a number sent as text still counts");
  assert.equal(itemsPerAccount(undefined, 0), 5);
  assert.equal(itemsPerAccount(undefined, 500), 100);
  assert.equal(itemsPerAccount(undefined, undefined), 5);
  assert.equal(itemsPerAccount(undefined, DEFAULT_PERF_CONFIG.defaults.maxItems), DEFAULT_PERF_CONFIG.defaults.maxItems);
});
