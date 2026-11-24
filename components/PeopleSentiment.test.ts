import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import { mergeConfig, type SocialMention } from "@/lib/socialTypes";

// The People sentiment tab as a viewer sees it: the real component, fed made-up
// posts. Nothing reaches a server, and no run is started.
//
// Run this file on its own: node scripts/test.mjs components/PeopleSentiment.test.ts

const { default: PeopleSentiment } = await load<typeof import("@/components/PeopleSentiment")>("components/PeopleSentiment.tsx");

const post = (o: Partial<SocialMention>): SocialMention =>
  ({ id: 1, channel: "linkedin", subject: "betterhomes", subject_kind: "company", url: null, author: null, posted_at: "2026-11-05", content: "", rating: null, likes: 0, comments: 0, shares: 0, sentiment: "positive", sentiment_score: 0.5, sentiment_reason: null, status: "kept", ...o }) as SocialMention;

/** Tracking as saved: the company and one person. */
const config = mergeConfig({
  subjects: [
    { name: "betterhomes", kind: "company" },
    { name: "Pat Lee", kind: "person" },
  ],
});

const mentions = [
  post({ id: "1", channel: "instagram", url: "a" }),
  post({ id: "2", url: "b", subject: "Pat Lee", subject_kind: "person", content: "Pat Lee spoke at a market briefing", sentiment_score: 0.2 }),
  // Saved while someone else was tracked; they have since been taken off.
  post({ id: "3", url: "c", subject: "Sam Ray", subject_kind: "person", content: "Sam Ray on the market", sentiment: "negative", sentiment_score: -0.4 }),
  post({ id: "4", url: "d", subject: "Sam Ray", subject_kind: "person", content: "Sam Ray again", sentiment: "neutral", sentiment_score: 0 }),
];

test("only the subjects in Tracking show and count; posts kept from someone taken off are hidden, and said to be", async () => {
  const screen = await mount(h(PeopleSentiment, { config, mentions, runs: [] }));
  await screen.until(() => screen.text().includes("By subject"), "the subject cards");
  const text = screen.text();
  assert.ok(!text.includes("Sam Ray"), "someone no longer tracked shows nowhere");
  assert.match(text, /2 AI-checked posts, dated .* · 2 posts about people no longer in Tracking, hidden/);
  assert.match(text, /By subject betterhomes\+50 1 AI-checked posts.* Pat Lee\+20 1 AI-checked posts/);

  // Taking the person off Tracking takes their card and posts out at once.
  screen.click("Run the sentiment bot");
  await screen.until(() => screen.enabled("Remove"), "the Tracking chips");
  screen.click("Remove");
  await screen.until(() => !screen.text().includes("Pat Lee"), "Pat Lee's card to go");
  assert.match(screen.text(), /1 AI-checked post, dated .* · 3 posts about people no longer in Tracking, hidden/);
  screen.unmount();
});
