import { test } from "node:test";
import assert from "node:assert/strict";
import { sentimentSummary } from "@/lib/peopleSentiment";
import type { SocialMention } from "@/lib/socialTypes";

const m = (o: Partial<SocialMention>): SocialMention =>
  ({ id: 1, channel: "instagram", subject: "betterhomes", subject_kind: "brand", url: null, author: null, posted_at: "2026-10-05", content: "", rating: null, likes: null, comments: null, shares: null, sentiment: "positive", sentiment_score: 0.5, sentiment_reason: null, status: "kept", ...o }) as SocialMention;

test("the Dashboard counts people sentiment as its tab does: checked posts, once each, in the range", () => {
  const rows = [
    m({ url: "a", sentiment_score: 0.6 }),
    // The same post filed under a second subject counts once.
    m({ url: "a", subject: "a consultant", subject_kind: "person", sentiment_score: 0.6 }),
    m({ url: "b", sentiment: "negative", sentiment_score: -0.2 }),
    // Not yet scored: pending, not counted.
    m({ url: "c", sentiment: null, sentiment_score: null }),
    // A search hit that names nobody tracked: hidden.
    m({ url: "d", channel: "reddit", content: "a post about something else", sentiment_score: -1 }),
    // Outside the range.
    m({ url: "e", posted_at: "2026-09-30", sentiment_score: 1 }),
  ];
  const s = sentimentSummary(rows, "betterhomesuae", "2026-10-01", "2026-10-31");
  assert.equal(s.posts, 2);
  assert.equal(Math.round((s.net ?? 0) * 100), 33); // (0.6 + 0.6 - 0.2) / 3
  // Without a range, every post counts, as on the tab.
  assert.equal(sentimentSummary(rows, "betterhomesuae").posts, 3);
  assert.equal(sentimentSummary([], "x", "2026-10-01", "2026-10-31").net, null);
});
