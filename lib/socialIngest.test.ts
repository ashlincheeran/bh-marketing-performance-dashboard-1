import { test } from "node:test";
import assert from "node:assert/strict";
import { failureHint, itemsPerPlatform, runVerdict } from "@/lib/socialIngest";
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

// Before 20 Nov 2026 every run was logged as fine: three weeks of Apify
// refusing every platform, then weeks of a scorer out of credit, read as quiet
// weeks. The verdict now says what went wrong, and a run that is not ok raises
// a notification.

const base = { channels: 5, failed: [] as string[], fresh: 0, stored: 0, aiStopped: null, aiError: null };

test("a run that stored what it found, or found nothing new, is fine", () => {
  assert.deepEqual(runVerdict({ ...base, fresh: 12, stored: 12 }), { ok: true, error: null });
  assert.deepEqual(runVerdict(base), { ok: true, error: null });
});

test("every platform refused is a failed run, with Apify's words", () => {
  const failed = ["instagram", "linkedin", "reddit", "glassdoor", "facebook"].map(
    (ch) => `${ch} (HTTP 402 not-enough-usage-to-run-paid-actor: You have reached your monthly usage limit.)`,
  );
  const v = runVerdict({ ...base, failed });
  assert.equal(v.ok, false);
  assert.match(v.error ?? "", /^every platform failed: instagram \(HTTP 402 .*monthly usage limit/);
  // And the run log's hint says what it is, not a memory cap.
  assert.match(failureHint("reddit", failed[2]), /monthly allowance has run out/);
  assert.match(failureHint("reddit", "HTTP 402 actor-memory-limit-exceeded"), /concurrent-memory cap/);
});

test("one platform failing is said, and the run still counts as working", () => {
  const v = runVerdict({ ...base, failed: ["glassdoor (no Glassdoor company URL set)"], fresh: 10, stored: 10 });
  assert.equal(v.ok, true);
  assert.equal(v.error, "failed: glassdoor (no Glassdoor company URL set)");
});

test("an AI that can't answer stops the run with the reason; new posts left unscored are said to be", () => {
  const stopped = runVerdict({ ...base, fresh: 40, aiStopped: "The Claude account is out of credit or at its usage limit (HTTP 400): Your credit balance is too low" });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error ?? "", /^the AI could not score posts: The Claude account is out of credit/);
  const unscored = runVerdict({ ...base, fresh: 67, aiError: "Claude had a problem on its side (HTTP 529): Overloaded" });
  assert.equal(unscored.ok, false);
  assert.equal(unscored.error, "67 new posts could not be scored or stored (last AI error: Claude had a problem on its side (HTTP 529): Overloaded)");
});
