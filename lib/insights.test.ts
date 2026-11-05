import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOCIAL_CARD,
  buildCompetitiveInsights,
  buildCorpus,
  keepSupported,
  readInsightsCache,
  usableCachedInsights,
} from "@/lib/insights";
import type { Mention } from "@/lib/types";

test("the corpus gives each rival's real story count next to the sample shown", () => {
  const rivals = [
    ...Array.from({ length: 31 }, (_, i) => ({ brand: "Allsopp & Allsopp", title: `Allsopp story ${i}` })),
    { brand: "Knight Frank", title: "Knight Frank appoints Louis Harding" },
    // The same headline stored twice is one story.
    { brand: "Knight Frank", title: "Knight Frank appoints Louis Harding" },
  ];
  const c = buildCorpus(rivals, ["Betterhomes data shows rents rising", null], { perRival: 25, ourMax: 40, heading: "test" });
  assert.match(c.text, /\[Allsopp & Allsopp\] 31 stories, 25 headlines shown/);
  assert.match(c.text, /\[Knight Frank\] 1 stories/);
  assert.equal(c.text.match(/Knight Frank appoints/g)?.length, 1);
  assert.match(c.text, /BETTERHOMES' HEADLINES \(test\): 1 stories/);
  assert.equal(c.hasRivalStories, true);
  assert.equal(c.arabic, false);
});

test("with no rival story the corpus has no competitor section", () => {
  const c = buildCorpus([], ["Betterhomes report"], { perRival: 25, ourMax: 40, heading: "x" });
  assert.equal(c.hasRivalStories, false);
  assert.doesNotMatch(c.text, /COMPETITORS/);
});

test("an insight naming a company its input never mentioned is dropped", () => {
  const cards = [
    { label: "Match Allsopp on rankings", text: "Allsopp & Allsopp ran ranking stories." },
    { label: "Emulate Emaar", text: "Emaar is winning on launches." },
    { label: "Own the rental data", text: "Publish a monthly rent index." },
  ];
  const kept = keepSupported(cards, "[Allsopp & Allsopp] 3 stories\n- Allsopp ranked first", ["Allsopp & Allsopp"]);
  assert.deepEqual(
    kept.map((k) => k.label),
    ["Match Allsopp on rankings", "Own the rental data"],
  );
  // No rival story in the input: any talk of competitors is invented.
  assert.deepEqual(
    keepSupported([{ label: "Beat rivals", text: "Competitors are publishing reports." }], "ours only", [], false),
    [],
  );
});

test("a cached set saved without its evidence is not shown", () => {
  const cards = [{ kind: "high" as const, label: "Own the rental data", text: "Publish a monthly rent index." }];
  assert.deepEqual(usableCachedInsights(cards, null, []), []);
  const shown = usableCachedInsights(cards, { text: "rent index", hasRivalStories: false }, []);
  assert.equal(shown.length, 2);
  assert.equal(shown[1], SOCIAL_CARD);
});

test("both cache shapes are read, and junk is refused", () => {
  const card = { kind: "win", label: "A", text: "B" };
  assert.deepEqual(readInsightsCache([card]), { insights: [card], evidence: null });
  assert.deepEqual(readInsightsCache({ insights: [card], evidence: { text: "t", hasRivalStories: true } }), {
    insights: [card],
    evidence: { text: "t", hasRivalStories: true },
  });
  assert.equal(readInsightsCache(null), null);
  assert.equal(readInsightsCache({ insights: [] }), null);
  assert.deepEqual(readInsightsCache({ insights: [card], evidence: { text: 5 } }), { insights: [card], evidence: null });
});

const mention = (over: Partial<Mention>): Mention =>
  ({
    id: "m",
    date: null,
    year: null,
    month: null,
    tier: "T2",
    outlet: null,
    title: null,
    url: null,
    eav: null,
    reach: null,
    eavEff: 0,
    reachEff: 0,
    modeled: false,
    brand: "betterhomes",
    sentiment: null,
    source: "googlenews",
    factCheck: null,
    ...over,
  }) as Mention;

test("a tie at the top reads as level, not as a rival out-publishing us", () => {
  const cards = buildCompetitiveInsights({
    mentions: [mention({})],
    sov: [
      { brand: "Allsopp & Allsopp", mentions: 5, share: 50, isUs: false },
      { brand: "betterhomes", mentions: 5, share: 50, isUs: true },
    ],
    competitorNews: [],
  });
  assert.equal(cards[0].label, "Level at the top");
});

test("no counted story of ours is a real 0, and the gap card still shows", () => {
  const cards = buildCompetitiveInsights({
    mentions: [],
    sov: [{ brand: "Knight Frank", mentions: 4, share: 100, isUs: false }],
    competitorNews: [],
  });
  assert.equal(cards[0].label, "Close the SoV gap");
  assert.match(cards[0].text, /against your 0/);
});

test("a failed rival read says so instead of claiming nothing is stored", () => {
  const cards = buildCompetitiveInsights({ mentions: [], sov: [], competitorNews: [], competitorError: "timeout" });
  assert.equal(cards[0].label, "Share of Voice didn't load");
  assert.ok(!cards.some((c) => c.label === "No Share of Voice yet" || c.label === "No recent rival coverage"));
});
