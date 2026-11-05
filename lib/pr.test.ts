import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparisonNote,
  enrichMentions,
  filterRange,
  isMonthIn,
  monthSpan,
  monthlySeries,
  periodBefore,
  shiftMonth,
  tierByMonth,
  topOutlets,
} from "@/lib/pr";
import type { Mention, Outlet, RawMention } from "@/lib/types";

let seq = 0;
function raw(p: Partial<RawMention>): RawMention {
  seq += 1;
  return {
    id: `r${seq}`,
    date: "2026-03-10",
    year: 2026,
    month: 3,
    tier: "T2",
    outlet: null,
    title: `Story ${seq}`,
    url: null,
    eav: null,
    reach: null,
    brand: "betterhomes",
    sentiment: null,
    ...p,
  };
}
const clip = (p: Partial<RawMention>): Mention => enrichMentions([raw(p)], [])[0];
function clips(n: number, p: Partial<RawMention>): Mention[] {
  return Array.from({ length: n }, () => clip(p));
}

const CARD: Outlet[] = [
  // The typo row comes first, so the key map must not keep it for having been seen first.
  { outlet: "Khaleej TImes", tier: "T2", default_eav: null, default_reach: null },
  { outlet: "Khaleej Times", tier: "T2", default_eav: 2200, default_reach: 500000 },
  { outlet: "Gulf Business", tier: "T2", default_eav: 5000, default_reach: 50000 },
  { outlet: "ryb.ru", tier: "T3", default_eav: 700, default_reach: 9000 },
];
const valued = (p: Partial<RawMention>) => {
  const [m] = enrichMentions([raw(p)], CARD);
  return { eav: m.eavEff, reach: m.reachEff, modeled: m.modeled };
};

test("the rate card is found by exact name", () => {
  assert.deepEqual(valued({ outlet: "Khaleej Times" }), { eav: 2200, reach: 500000, modeled: true });
});

test("a publication named by its address or a typo gets its own figures", () => {
  assert.deepEqual(valued({ outlet: "khaleejtimes.com" }), { eav: 2200, reach: 500000, modeled: true });
  // Its exact card row has no figures; the key match fills them.
  assert.deepEqual(valued({ outlet: "Khaleej TImes" }), { eav: 2200, reach: 500000, modeled: true });
  assert.deepEqual(valued({ outlet: "Khaleej Times (Online & Print)", url: "https://www.khaleejtimes.com/business/realty/a" }), {
    eav: 2200,
    reach: 500000,
    modeled: true,
  });
});

test("measured figures and an exact match win over the key match", () => {
  assert.deepEqual(valued({ outlet: "khaleejtimes.com", eav: 900, reach: 1000 }), { eav: 900, reach: 1000, modeled: false });
  // Syndicated on another site: the outlet's own card row still decides.
  assert.deepEqual(valued({ outlet: "Gulf Business", url: "https://www.khaleejtimes.com/x" }), {
    eav: 5000,
    reach: 50000,
    modeled: true,
  });
});

test("an unknown outlet, or an address that is only a country ending, gets nothing", () => {
  assert.deepEqual(valued({ outlet: "Unheard Of Weekly" }), { eav: 0, reach: 0, modeled: false });
  // outletKey() reduces vedomosti.ru to "ru", which must not find the "ryb.ru" row.
  assert.deepEqual(valued({ outlet: "Vedomosti (Russia)", url: "https://www.vedomosti.ru/a" }), { eav: 0, reach: 0, modeled: false });
  assert.deepEqual(valued({ outlet: null, url: "https://news.google.com/rss/articles/abc" }), { eav: 0, reach: 0, modeled: false });
});

test("undated clips are in no range unless asked for", () => {
  const ms = [clip({ date: "2025-06-01" }), clip({ date: null, year: null, month: null }), clip({ date: "2026-01-05" })];
  assert.equal(filterRange(ms, "2025-01", "2026-12").length, 2);
  assert.equal(filterRange(ms, "2025-01", "2026-12", true).length, 3);
  assert.equal(filterRange(ms, "2026-01", "2026-12", true).length, 2);
});

test("only a real month inside the bounds is accepted", () => {
  for (const bad of ["", "2025-1", "2025-13", "2025-00", "Oct 2026", "10/2026", "0002-05", "2025-01-01"]) {
    assert.equal(isMonthIn(bad, "2020-01", "2026-11"), false, bad);
  }
  assert.equal(isMonthIn("2025-01", "2020-01", "2026-11"), true);
  assert.equal(isMonthIn("2020-01", "2020-01", "2026-11"), true);
  assert.equal(isMonthIn("2026-12", "2020-01", "2026-11"), false);
  assert.equal(isMonthIn("2019-12", "2020-01", "2026-11"), false);
});

test("months shift and count across years", () => {
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2025-11", 3), "2026-02");
  assert.equal(shiftMonth("2025-06", -24), "2023-06");
  assert.equal(monthSpan("2024-12", "2026-11"), 24);
  assert.equal(monthSpan("2025-03", "2025-03"), 1);
});

test("the period before A is as long as A, cut short where the records start", () => {
  assert.deepEqual(periodBefore("2024-12", "2026-11", "2020-01"), { from: "2022-12", to: "2024-11" });
  assert.deepEqual(periodBefore("2020-06", "2022-05", "2020-01"), { from: "2020-01", to: "2020-05" });
  // A starts in the first month on file: nothing before it, never a B inside A.
  assert.equal(periodBefore("2020-01", "2026-04", "2020-01"), null);
});

test("the compare note says when B is unlike A, and nothing when they are alike", () => {
  const A = { from: "2024-12", to: "2026-11" };
  assert.equal(comparisonNote(A, { from: "2022-12", to: "2024-11" }, "2020-01"), "");
  assert.equal(
    comparisonNote({ from: "2020-06", to: "2022-05" }, { from: "2020-01", to: "2020-05" }, "2020-01"),
    "Period B is 5 months and Period A 24 months, so the changes compare periods of different lengths: the records start in Jan 2020.",
  );
  // The old "Period before A" with A in the first month on file: one month, inside A.
  assert.equal(
    comparisonNote({ from: "2020-01", to: "2026-04" }, { from: "2020-01", to: "2020-01" }, "2020-01"),
    "Period B overlaps Period A, so the clips they share count on both sides. " +
      "Period B is 1 month and Period A 76 months, so the changes compare periods of different lengths: the records start in Jan 2020.",
  );
  // Chosen by hand, longer than A: no word about where the records start.
  assert.equal(
    comparisonNote({ from: "2025-01", to: "2025-06" }, { from: "2023-01", to: "2024-12" }, "2020-01"),
    "Period B is 24 months and Period A 6 months, so the changes compare periods of different lengths.",
  );
  assert.equal(
    comparisonNote({ from: "2025-01", to: "2025-06" }, { from: "2025-01", to: "2025-06" }, "2020-01"),
    "Period B overlaps Period A, so the clips they share count on both sides.",
  );
});

test("a malformed month gives no chart months instead of thousands", () => {
  assert.equal(monthlySeries([], "", "2025-12").labels.length, 0);
  assert.equal(monthlySeries([], "2025-1", "2025-12").labels.length, 0);
  assert.equal(tierByMonth([], "", "2025-12").months.length, 0);
  assert.equal(monthlySeries([], "2025-01", "2025-12").labels.length, 12);
});

test("Mentions by Tier has a column for every month of the range, empty ones too", () => {
  const ms = [clip({ date: "2025-01-10", tier: "T1-Local" }), clip({ date: "2025-03-02", tier: "T2" })];
  const t = tierByMonth(ms, "2025-01", "2025-04");
  assert.deepEqual(t.months, ["2025-01", "2025-02", "2025-03", "2025-04"]);
  assert.deepEqual(t.labels, monthlySeries(ms, "2025-01", "2025-04").labels);
  assert.deepEqual(t.series["T1-Local"], [1, 0, 0, 0]);
  assert.deepEqual(t.series.T2, [0, 0, 1, 0]);
  assert.deepEqual(tierByMonth(ms, "2024-11", "2025-02").labels, ["Nov 24", "Dec 24", "Jan 25", "Feb 25"]);
  // Without a range, the months that have clips, as before.
  assert.deepEqual(tierByMonth(ms).months, ["2025-01", "2025-03"]);
});

const bars = (ms: Mention[]) => topOutlets(ms, 20).map((o) => `${o.outlet}:${o.count}:${o.tier}`);

test("every spelling of an outlet's name shares one bar, named and coloured by the majority", () => {
  const ms = [
    ...clips(3, { outlet: "MENAFN", tier: "T3" }),
    clip({ outlet: "MenaFN", tier: "T2" }),
    // The first clip seen is the odd tier out: the bar takes the most common tier.
    clip({ outlet: "khaleejtimes.com", tier: "Other" }),
    ...clips(2, { outlet: "Khaleej Times", tier: "T1-Local" }),
  ];
  assert.deepEqual(bars(ms), ["MENAFN:4:T3", "Khaleej Times:3:T1-Local"]);
});

test("a name whose clips link to a publication known by another name joins it", () => {
  const ms = [
    ...clips(4, { outlet: "The National News", url: null }),
    ...clips(2, { outlet: "The National", url: "https://www.thenationalnews.com/business/a" }),
    clip({ outlet: "The National", url: null }),
  ];
  assert.deepEqual(bars(ms), ["The National News:7:T2"]);
});

test("an address moves a name only when it is another outlet's and covers half its clips", () => {
  const ms = [
    // One syndicated link among many clips does not move Gulf Business into Zawya.
    ...clips(5, { outlet: "Gulf Business" }),
    clip({ outlet: "Gulf Business", url: "https://www.zawya.com/en/press-release/a" }),
    ...clips(4, { outlet: "Zawya" }),
    // A LinkedIn post: linkedin is no outlet's name here, so nothing moves.
    clip({ outlet: "Dubai Eye", url: "https://www.linkedin.com/posts/a" }),
    clip({ outlet: "Finance Middle East", url: "https://www.linkedin.com/posts/b" }),
  ];
  assert.deepEqual(bars(ms), ["Gulf Business:6:T2", "Zawya:4:T2", "Dubai Eye:1:T2", "Finance Middle East:1:T2"]);
});

test("outlets on a country ending outletKey() doesn't list stay apart", () => {
  const ms = [
    clip({ outlet: "ryb.ru" }),
    ...clips(2, { outlet: "DP (Russia)", url: "https://www.dp.ru/a" }),
    ...clips(2, { outlet: "Forbes (Russia)", url: "https://www.forbes.ru/b" }),
  ];
  assert.deepEqual(bars(ms).sort(), ["DP (Russia):2:T2", "Forbes (Russia):2:T2", "ryb.ru:1:T2"]);
});

test("names that point at each other neither loop nor lose clips", () => {
  const ms = [
    clip({ outlet: "Alpha News", url: "https://betadaily.com/a" }),
    clip({ outlet: "Beta Daily", url: "https://alphanews.com/b" }),
  ];
  const out = topOutlets(ms, 10);
  assert.equal(out.reduce((a, o) => a + o.count, 0), 2);
});
