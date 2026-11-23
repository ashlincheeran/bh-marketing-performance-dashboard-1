import { test } from "node:test";
import assert from "node:assert/strict";
import { ENQUIRY_CHANNELS, VISIT_CHANNELS, lookupPath, visitChannel, zeroes } from "@/lib/website";

test("a link or a path reaches the page look-up as a plain lower-case path, and nothing else does", () => {
  assert.equal(lookupPath("https://www.bhomes.com/en/buy/?beds=2#top"), "/en/buy");
  assert.equal(lookupPath("www.bhomes.com/EN/Rent/"), "/en/rent");
  assert.equal(lookupPath("bhomes.com/en/blog"), "/en/blog");
  assert.equal(lookupPath("en/property-management"), "/en/property-management");
  // The home page is the empty path, as PostHog's paths read with the slash dropped.
  assert.equal(lookupPath("https://www.bhomes.com/"), "");
  assert.equal(lookupPath("/"), "");
  // Nothing that could change a query gets through.
  assert.equal(lookupPath("/en/buy' OR 1=1 --"), null);
  assert.equal(lookupPath("/en/buy;DROP"), null);
  assert.equal(lookupPath(""), null);
  assert.equal(lookupPath("   "), null);
  assert.equal(lookupPath(null), null);
});

test("PostHog's channel names map to the tab's, with Direct on its own and anything new as Other", () => {
  assert.equal(visitChannel("Organic Search"), "organic");
  assert.equal(visitChannel("AI"), "ai");
  assert.equal(visitChannel("Paid Social"), "paidSocial");
  assert.equal(visitChannel("Direct"), "direct");
  assert.equal(visitChannel("Paid Video"), "other");
  assert.equal(visitChannel(""), "other");
  // Every channel the charts stack has a zero to start from.
  assert.deepEqual(Object.keys(zeroes(VISIT_CHANNELS)), VISIT_CHANNELS.map((c) => c.key));
  assert.deepEqual(Object.values(zeroes(ENQUIRY_CHANNELS)), ENQUIRY_CHANNELS.map(() => 0));
});
