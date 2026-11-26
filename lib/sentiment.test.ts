import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSocialMention, readVerdict, socialPrompt } from "@/lib/sentiment";

// The People Sentiment tone, scored by Claude. Gemini failed open when it ran
// out of credit: every post came back with no verdict and none was stored.
// Here a post gets a verdict or a named failure, never a silent blank.

test("Claude's answer becomes a verdict on the fixed rubric", () => {
  assert.deepEqual(readVerdict({ relevant: true, noise: null, sentiment: "positive", score: 0.7, reason: "Praises the agent's service" }), {
    relevant: true,
    sentiment: "positive",
    score: 0.7,
    reason: "Praises the agent's service",
    noise: null,
  });
  // Scores stay on -1..1, case and spacing don't matter, and an unknown noise class is none.
  const v = readVerdict({ relevant: false, noise: " Namesake ", sentiment: "Negative", score: -3, reason: "" });
  assert.deepEqual(v, { relevant: false, sentiment: "negative", score: -1, reason: null, noise: "namesake" });
  assert.equal(readVerdict({ relevant: true, noise: "spam", sentiment: "neutral", score: 0, reason: "x" })?.noise, null);
});

test("an answer that is not a verdict is none, so the post waits instead of counting unscored", () => {
  assert.equal(readVerdict(null), null);
  assert.equal(readVerdict({ relevant: true, noise: null, sentiment: "happy", score: 0.5, reason: "x" }), null);
  assert.equal(readVerdict({ relevant: true, noise: null, sentiment: "positive", reason: "x" }), null);
});

test("the rubric is the one months were scored on", () => {
  const p = socialPrompt("betterhomes", "company", "linkedin");
  assert.match(p, /"betterhomes", a real-estate brokerage in DUBAI, UAE/);
  assert.match(p, /praise \/ recommendation > 0\.5; satisfied or mildly positive 0\.1\.\.0\.5; factual \/ neutral -0\.1\.\.0\.1/);
  assert.match(socialPrompt("Pat Lee", "person", "reddit"), /Pat Lee, a person linked to betterhomes/);
});

test("no Claude key is a failure that stops the run, not a blank verdict", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const a = await assessSocialMention("betterhomes", "company", "linkedin", "Great service from the team", "claude-haiku-5-5");
    assert.ok("failure" in a);
    assert.equal(a.failure.kind, "no_key");
    assert.equal(a.failure.stopRun, true);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
