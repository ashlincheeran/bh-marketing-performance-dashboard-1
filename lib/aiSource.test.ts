import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantKey, assistantKeySql } from "@/lib/aiSource";

// The names PostHog's AI channel brought in 2026, and the spellings the CRM
// holds for the same assistants: each should land on one name per assistant.

test("an assistant's site and its link tag land on the same name", () => {
  assert.equal(assistantKey("chatgpt.com"), "chatgpt");
  assert.equal(assistantKey("chatgpt"), "chatgpt");
  assert.equal(assistantKey("gemini.google.com"), "gemini");
  assert.equal(assistantKey("gemini"), "gemini");
  assert.equal(assistantKey("copilot.microsoft.com"), "copilot");
  assert.equal(assistantKey("copilot.com"), "copilot");
});

test("www and one-letter link prefixes are skipped; case and spaces don't matter", () => {
  assert.equal(assistantKey("www.perplexity.ai"), "perplexity");
  assert.equal(assistantKey("l.meta.ai"), "meta");
  assert.equal(assistantKey("  Claude.AI "), "claude");
});

test("an assistant no list ever named still gets a name", () => {
  assert.equal(assistantKey("manus.im"), "manus");
  assert.equal(assistantKey("www.doubao.com"), "doubao");
  assert.equal(assistantKey(""), "");
});

test("the HogQL twin applies the same rule to the expression it is given", () => {
  assert.equal(assistantKeySql("src"), "arrayFirst(p -> length(p) > 1 AND p != 'www', splitByChar('.', src))");
});
