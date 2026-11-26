import { test } from "node:test";
import assert from "node:assert/strict";
import { isTracked, netScore, sentimentSummary, toPosts, trackedNames } from "@/lib/peopleSentiment";
import { mergeConfig, type SocialMention } from "@/lib/socialTypes";

const m = (o: Partial<SocialMention>): SocialMention =>
  ({ id: 1, channel: "instagram", subject: "betterhomes", subject_kind: "brand", url: null, author: null, posted_at: "2026-10-05", content: "", rating: null, likes: null, comments: null, shares: null, sentiment: "positive", sentiment_score: 0.5, sentiment_reason: null, status: "kept", ...o }) as SocialMention;

/** Tracking as saved on the tab: the company and one person. */
const cfg = mergeConfig({
  subjects: [
    { name: "betterhomes", kind: "company" },
    { name: "A Consultant", kind: "person" },
  ],
});

test("the Dashboard counts people sentiment as its tab does: checked posts, once each, in the range", () => {
  const rows = [
    m({ url: "a", sentiment_score: 0.6 }),
    // The same post filed under a second subject counts once.
    m({ url: "a", subject: "A Consultant", subject_kind: "person", sentiment_score: 0.6 }),
    m({ url: "b", sentiment: "negative", sentiment_score: -0.2 }),
    // Not yet scored: pending, not counted.
    m({ url: "c", sentiment: null, sentiment_score: null }),
    // A search hit that names nobody tracked: hidden.
    m({ url: "d", channel: "reddit", content: "a post about something else", sentiment_score: -1 }),
    // Outside the range.
    m({ url: "e", posted_at: "2026-09-30", sentiment_score: 1 }),
  ];
  const s = sentimentSummary(rows, cfg, "2026-10-01", "2026-10-31");
  assert.equal(s.posts, 2);
  // Per post, like the count: post a once at 0.6, post b at -0.2.
  assert.equal(Math.round((s.net ?? 0) * 100), 20);
  // Without a range, every post counts, as on the tab.
  assert.equal(sentimentSummary(rows, cfg).posts, 3);
  assert.equal(sentimentSummary([], cfg, "2026-10-01", "2026-10-31").net, null);
});

test("posts kept from someone taken off Tracking count nowhere, and count again if they are added back", () => {
  const rows = [
    m({ url: "a", sentiment_score: 0.5 }),
    // Saved while a second person was tracked; they have since been taken off.
    m({ url: "f", channel: "linkedin", subject: "A Former Subject", subject_kind: "person", content: "A Former Subject spoke today", sentiment_score: -0.9 }),
  ];
  const s = sentimentSummary(rows, cfg);
  assert.equal(s.posts, 1);
  assert.equal(s.net, 0.5);

  // Names match whatever their case or spacing.
  assert.equal(isTracked(m({ subject: " a consultant " }), trackedNames(cfg)), true);
  assert.equal(isTracked(rows[1], trackedNames(cfg)), false);

  const back = mergeConfig({ subjects: [...cfg.subjects, { name: "A Former Subject", kind: "person" }] });
  assert.equal(sentimentSummary(rows, back).posts, 2);
});

test("a post filed under two subjects is one post everywhere: its tone, its score and the net", () => {
  const rows = [
    // One LinkedIn post, scored once for the company and once for the person.
    m({ id: "1", channel: "linkedin", url: "x", content: "A Consultant of betterhomes at a market briefing", sentiment: "positive", sentiment_score: 0.6 }),
    m({ id: "2", channel: "linkedin", url: "x", content: "A Consultant of betterhomes at a market briefing", subject: "A Consultant", subject_kind: "person", sentiment: "neutral", sentiment_score: 0 }),
    // Another post, the same tone for both.
    m({ id: "3", url: "y", sentiment: "positive", sentiment_score: 0.4 }),
    m({ id: "4", url: "y", subject: "A Consultant", subject_kind: "person", sentiment: "positive", sentiment_score: 0.4 }),
    // The same address on another platform is another post.
    m({ id: "5", channel: "facebook", url: "x", sentiment: "negative", sentiment_score: -0.5 }),
  ];
  const posts = toPosts(rows);
  assert.equal(posts.length, 3);
  const [x, y, fb] = posts;
  assert.deepEqual(x.subjects, ["betterhomes", "A Consultant"]);
  assert.equal(x.sentiment, "mixed", "tones that differ by subject make the post mixed");
  assert.equal(x.score, 0.3);
  assert.equal(y.sentiment, "positive");
  assert.equal(y.score, 0.4);
  assert.equal(fb.rows.length, 1);
  // Net per post (0.3 + 0.4 - 0.5) / 3, not per row (0.6 + 0 + 0.4 + 0.4 - 0.5) / 5.
  assert.equal(Math.round((netScore(rows) ?? 0) * 1000), 67);
  assert.equal(sentimentSummary(rows, cfg).posts, 3);
  // A subject's own rows are one per post, so its net is unchanged.
  assert.equal(netScore(rows.filter((r) => r.subject === "A Consultant")), 0.2);
  assert.equal(toPosts([m({ url: "z", sentiment: null, sentiment_score: null })])[0].score, null);
});
