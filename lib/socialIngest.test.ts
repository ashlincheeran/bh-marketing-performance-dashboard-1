import { test } from "node:test";
import assert from "node:assert/strict";
import { itemsPerPlatform } from "@/lib/socialIngest";
import { DEFAULT_SOCIAL_CONFIG } from "@/lib/socialTypes";

// The run's Items / platform comes from the request body. The People
// Sentiment screen keeps it to 5..100, and so must the server, since every
// item asked for is scraped and billed by Apify.

test("items per platform keep to the Items box's 5 to 100", () => {
  assert.equal(itemsPerPlatform(15, 24), 15);
  assert.equal(itemsPerPlatform(5, 24), 5);
  assert.equal(itemsPerPlatform(100, 24), 100);
  assert.equal(itemsPerPlatform(0, 24), 5);
  assert.equal(itemsPerPlatform(-1, 24), 5);
  assert.equal(itemsPerPlatform(5000, 24), 100);
  assert.equal(itemsPerPlatform(12.4, 24), 12);
});

test("a missing or nonsense value takes the stored default, itself kept to 5 to 100", () => {
  for (const asked of [undefined, null, "", "many", NaN, -Infinity, {}]) {
    assert.equal(itemsPerPlatform(asked, 15), 15, `asked ${String(asked)}`);
  }
  assert.equal(itemsPerPlatform("30", 15), 30);
  assert.equal(itemsPerPlatform(undefined, 0), 5);
  assert.equal(itemsPerPlatform(undefined, 1000), 100);
  assert.equal(itemsPerPlatform(undefined, DEFAULT_SOCIAL_CONFIG.defaults.maxItems), DEFAULT_SOCIAL_CONFIG.defaults.maxItems);
});
