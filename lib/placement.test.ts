import { test } from "node:test";
import assert from "node:assert/strict";
import { headline, named, onePerPlacement, withinAWeek, type Placement } from "@/lib/placement";

// Pure functions only: nothing here reads the database or the network.

type Row = Placement & { id: string; bot?: boolean };

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  brand: "betterhomes",
  date: "2026-11-04",
  title: "Dubai rents rise again",
  outlet: "Khaleej Times",
  url: null,
  ...over,
});

const ids = (rows: Row[]) => rows.map((r) => r.id);
const keep = (rows: Row[], onMerge?: (kept: Row, dropped: Row) => void) => onePerPlacement(rows, (r) => r, onMerge);

test("a headline is compared by its letters and digits alone", () => {
  assert.equal(headline("  Dubai RENTS rise, again!  "), "dubai rents rise again");
  assert.equal(headline(null), "");
  // Arabic has no letters a to z, so it has no headline to compare by.
  assert.equal(headline("ارتفاع الإيجارات"), "");
});

test("dates a week apart are the same story, eight days are not", () => {
  assert.equal(withinAWeek("2026-11-01", "2026-11-08"), true);
  assert.equal(withinAWeek("2026-11-01", "2026-11-09"), false);
  assert.equal(withinAWeek(null, null), true);
  assert.equal(withinAWeek("2026-11-01", null), false);
});

test("a publication is named when it is not a web address", () => {
  assert.equal(named("Khaleej Times"), true);
  assert.equal(named("khaleejtimes.com"), false);
  assert.equal(named(" gulfnews.ae "), false);
  assert.equal(named(null), false);
});

test("the same headline at the same publication in a week is one placement, under the publication's name", () => {
  const kept = keep([row("a", { outlet: "khaleejtimes.com" }), row("b", { date: "2026-11-06" })]);
  assert.deepEqual(ids(kept), ["b"]);
  // The first is kept when both are named, or neither.
  assert.deepEqual(ids(keep([row("a"), row("b", { date: "2026-11-02" })])), ["a"]);
  assert.deepEqual(ids(keep([row("a", { outlet: "khaleejtimes.com" }), row("b", { outlet: "www.khaleejtimes.com" })])), ["a"]);
});

test("two publications, two brands, or two weeks apart stay two placements", () => {
  assert.deepEqual(ids(keep([row("a"), row("b", { outlet: "Gulf News" })])), ["a", "b"]);
  assert.deepEqual(ids(keep([row("a"), row("b", { brand: "Knight Frank" })])), ["a", "b"]);
  assert.deepEqual(ids(keep([row("a"), row("b", { date: "2026-11-20" })])), ["a", "b"]);
});

test("a row with no headline is never folded", () => {
  assert.deepEqual(ids(keep([row("a", { title: null }), row("b", { title: "" }), row("c", { title: null })])), ["a", "b", "c"]);
});

test("the article's own address decides the publication when the feed's name differs", () => {
  const kept = keep([
    row("a", { outlet: "Gulf Daily News (Bahrain)", url: "https://www.gdnonline.com/Details/1" }),
    row("b", { outlet: "GDNOnline", url: "https://gdnonline.com/Details/1" }),
  ]);
  assert.deepEqual(ids(kept), ["a"]);
});

test("onMerge hears of every fold, so what a dropped twin knew reaches the row that counts", () => {
  const calls: string[] = [];
  const kept = keep(
    [
      row("a", { outlet: "khaleejtimes.com" }),
      row("b", { outlet: "khaleejtimes.com", date: "2026-11-05", bot: true }),
      row("c", { date: "2026-11-06" }),
      row("d", { outlet: "Gulf News" }),
    ],
    (k, dropped) => {
      calls.push(`${k.id}<${dropped.id}`);
      if (dropped.bot) k.bot = true;
    },
  );
  // b folds into a, then c takes a's place because it names the publication.
  assert.deepEqual(calls, ["a<b", "c<a"]);
  assert.deepEqual(ids(kept), ["c", "d"]);
  assert.equal(kept[0].bot, true, "the bot's find carried through two folds");
  assert.equal(kept[1].bot, undefined);
});

test("rows are returned in the order first seen, a replacement in its twin's place", () => {
  const kept = keep([row("a", { outlet: "khaleejtimes.com" }), row("x", { title: "Another story" }), row("b")]);
  assert.deepEqual(ids(kept), ["b", "x"]);
});

test("the news bot's same link is one story, whatever the feed called the outlet; the archive's rows stay as logged", () => {
  const link = "https://news.google.com/rss/articles/CBMi-gdn?oc=5";
  // Google News named one Gulf Daily News story two ways: two outlet keys, one link.
  assert.deepEqual(
    ids(keep([row("a", { outlet: "GDNOnline", url: link, link }), row("b", { outlet: "Gulf Daily News (Bahrain)", url: link, link })])),
    ["a"],
  );
  // The same link with tracking added, and with no headline at all, is still that story.
  assert.deepEqual(ids(keep([row("a", { url: link, link }), row("b", { title: null, outlet: "GDN", url: `${link}&utm_source=x`, link: `${link}&utm_source=x` })])), ["a"]);
  // Two rivals in one article are one story each.
  assert.deepEqual(ids(keep([row("a", { brand: "Allsopp", url: link, link }), row("b", { brand: "fäm", url: link, link })])), ["a", "b"]);
  // The PR team's archive logged one link for two publications under two headlines: two placements, as they count it.
  const shared = "https://www.investing.com/news/analysis-3283664";
  assert.deepEqual(
    ids(keep([row("a", { outlet: "Investing.com", url: shared }), row("b", { outlet: "The Edge Malaysia", title: "Dubai's property boom shows signs of fizzling out", url: shared })])),
    ["a", "b"],
  );
});

test("a copy that matches a folded row by its headline alone still folds into the story", () => {
  const link = "https://news.google.com/rss/articles/CBMi-x?oc=5";
  const rows = [
    row("a", { outlet: "GDNOnline", url: link, link }),
    // Folded into a by its link...
    row("b", { outlet: "Gulf Daily News", url: link, link }),
    // ...and the archive's copy under b's outlet name, which shares only b's headline and publication.
    row("c", { outlet: "Gulf Daily News", url: null }),
  ];
  assert.deepEqual(ids(keep(rows)), ["a"]);
});
