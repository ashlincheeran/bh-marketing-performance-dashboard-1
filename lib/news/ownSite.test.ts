import { test } from "node:test";
import assert from "node:assert/strict";
import { namesOnly, ownSiteDecision, ownSiteIn, ownSiteOf, ownSiteReason, withoutOwnSite } from "@/lib/news/ownSite";
import { buildRegistry } from "@/lib/news/registry";
import { trackedRegistry, trackedRival } from "@/lib/news/testCompanies";
import type { Candidate, DecidedMention, Decision } from "@/lib/news/types";

// Every company the bot tracks, with the websites its row lists.
const ALL = trackedRegistry().companies;
const at = (url: string | null, outlet: string | null = null) => ownSiteOf({ url, outlet }, ALL);
const tracked = (label: string) => ALL.filter((c) => c.label === label);

test("each company's own website is known by its address, a subdomain included", () => {
  // The pages in the 6 Nov 2026 test run, and each company's home page.
  assert.equal(at("https://www.allsoppandallsopp.com/dubai/about-us/news-videos/1976-dubais-handover-wave"), "Allsopp & Allsopp");
  assert.equal(at("https://sothebysrealty.ae/agent/peter-smithson/"), "Sotheby's");
  assert.equal(at("https://www.luxhabitat.ae/the-journal/new-milestone-set-with-aed-420-million-sale/"), "Sotheby's");
  assert.equal(at("https://www.bhomes.com/en/blog/rents"), "betterhomes");
  assert.equal(at("https://betterhomes.ae/"), "betterhomes");
  assert.equal(at("https://www.hausandhaus.com/news"), "Haus & Haus");
  assert.equal(at("https://www.drivenproperties.com/blog/x"), "Driven Properties");
  assert.equal(at("https://whiteandcogroup.com/insights"), "White & Co");
  assert.equal(at("https://whiteandco.ae/"), "White & Co");
  assert.equal(at("https://invest.metropolitan.realestate/"), "Metropolitan");
  assert.equal(at("https://famproperties.com/news/x"), "fäm Properties");
  // A firm with a site per country, under any ending.
  assert.equal(at("https://www.knightfrank.ae/research/dubai-residential"), "Knight Frank");
  assert.equal(at("https://www.knightfrank.co.uk/news/x"), "Knight Frank");
  assert.equal(at("https://content.knightfrank.com/research/x"), "Knight Frank");
  assert.equal(at("https://www.engelvoelkers.com/ae/en/news"), "Engel & Völkers");
  assert.equal(at("https://www.sothebysrealty.com/eng/sales/detail/x"), "Sotheby's");
  // Every company the bot tracks today has its sites listed.
  for (const c of ALL) assert.ok(c.sites.length, `${c.label} has no sites listed`);
});

test("a look-alike address is somebody else's site", () => {
  for (const url of [
    "https://www.khaleejtimes.com/business/property/allsoppandallsopp-ranked-first",
    "https://knightfranknews.com/x",
    "https://notbhomes.com/x",
    "https://bhomes.com.evil.example/x",
    "https://www.sothebys.com/en/auctions/watches",
    "https://www.bhg.com/homes",
    "https://gulfnews.com/business/property/knightfrank-report",
  ]) {
    assert.equal(at(url), null, url);
  }
  // A Google link says nothing about the publisher, so its name is read instead.
  assert.equal(at("https://news.google.com/rss/articles/abc", "Allsopp & Allsopp"), "Allsopp & Allsopp");
  assert.equal(at("not an address", null), null);
  assert.equal(at(null, null), null);
});

test("with no address, the publisher's name as Google gives it tells the site, but never a bare word", () => {
  assert.equal(at(null, "Allsopp & Allsopp"), "Allsopp & Allsopp");
  assert.equal(at(null, "Allsopp and Allsopp"), "Allsopp & Allsopp");
  assert.equal(at(null, "Dubai Sotheby’s International Realty"), "Sotheby's");
  assert.equal(at(null, "Luxhabitat"), "Sotheby's");
  assert.equal(at(null, "luxhabitat.ae"), "Sotheby's");
  assert.equal(at(null, "haus & haus"), "Haus & Haus");
  assert.equal(at(null, "fam Properties"), "fäm Properties");
  assert.equal(at(null, "Knight Frank UAE"), "Knight Frank");
  assert.equal(at(null, "bhomes"), "betterhomes");
  // "Metropolitan" alone is any number of publications, and "Better Homes" is the American magazine's words too.
  assert.equal(at(null, "Metropolitan"), null);
  assert.equal(at(null, "Better Homes"), null);
  assert.equal(at(null, "Better Homes & Gardens"), null);
  assert.equal(at(null, "Khaleej Times"), null);
  // An address that says otherwise wins over the name.
  assert.equal(at("https://www.zawya.com/en/press-release/x", "Allsopp & Allsopp"), null);
});

test("only the companies asked about are matched, each by its label", () => {
  const page = { url: "https://www.allsoppandallsopp.com/dubai/news/x", outlet: "Allsopp & Allsopp" };
  assert.equal(ownSiteOf(page, [...tracked("betterhomes"), ...tracked("Knight Frank")]), null);
  assert.equal(ownSiteOf(page, tracked("Allsopp & Allsopp")), "Allsopp & Allsopp");
  assert.equal(ownSiteOf({ url: "https://www.engelvoelkers.com/x" }, tracked("Engel & Völkers")), "Engel & Völkers");
  assert.equal(ownSiteOf(page, []), null);
  // A rival added later in Settings, with no sites listed, is told by its publisher's name alone.
  const savills = buildRegistry([{ label: "Savills", query: "savills dubai" }], []).companies;
  assert.equal(ownSiteOf({ url: null, outlet: "Savills" }, savills), "Savills");
  assert.equal(ownSiteOf({ url: "https://www.savills.ae/research" }, savills), null);
  const reg = buildRegistry([trackedRival("Knight Frank")], []);
  assert.equal(ownSiteIn({ url: "https://www.knightfrank.ae/x" }, reg), "Knight Frank");
  assert.equal(ownSiteIn({ url: "https://www.allsoppandallsopp.com/x" }, reg), null);
});

test("the websites are each company's own list, so one added or removed in settings counts from the next run", () => {
  const page = { url: "https://www.savills.ae/research/dubai", outlet: "Savills" };
  const withSite = buildRegistry([{ label: "Savills", query: "savills dubai", sites: ["savills.*"] }], []);
  assert.equal(ownSiteIn(page, withSite), "Savills");
  assert.equal(ownSiteIn({ url: "https://www.savills.co.uk/x" }, withSite), "Savills");
  // Knight Frank's row without its sites: its pages are anyone's again, and only its publisher's name tells it.
  const noSites = buildRegistry([{ ...trackedRival("Knight Frank"), sites: [] }], []);
  assert.equal(ownSiteIn({ url: "https://www.knightfrank.ae/research/x" }, noSites), null);
  assert.equal(ownSiteIn({ url: null, outlet: "Knight Frank UAE" }, noSites), "Knight Frank");
  // betterhomes' websites come from its 'us' row: without it, bhomes.com is not known as ours by address,
  // though its publisher's name still is.
  const noRow = buildRegistry([], []);
  assert.equal(ownSiteIn({ url: "https://www.bhomes.com/en/blog/rents" }, noRow), null);
  assert.equal(ownSiteIn({ url: null, outlet: "bhomes" }, noRow), "betterhomes");
  assert.equal(ownSiteIn({ url: "https://www.bhomes.com/en/blog/rents" }, buildRegistry([], [], { sites: ["bhomes.com"] })), "betterhomes");
});

const reg = buildRegistry(
  [{ label: "Knight Frank", query: "knight frank dubai" }],
  [
    { name: "Louis Harding", company: "Knight Frank", role: "Partner", aliases: [], active: true, note: null },
    { name: "Louis Harding", company: "betterhomes", role: "Former CEO", aliases: [], active: false, note: null },
    { name: "Richard Waind", company: "betterhomes", role: "CEO", aliases: [], active: true, note: null },
  ],
);
const c = (n: number, companies: string[], people: string[] = []): Candidate => ({ n, text: `sentence ${n}`, companies, people });

test("a page names only its publisher when every sentence names that company or its people", () => {
  assert.equal(namesOnly([c(1, ["Knight Frank"]), c(2, [], ["Louis Harding"])], "Knight Frank", reg), true);
  // Anyone else named sends it to the AI as usual.
  assert.equal(namesOnly([c(1, ["Knight Frank"]), c(2, ["betterhomes"])], "Knight Frank", reg), false);
  assert.equal(namesOnly([c(1, ["Knight Frank"]), c(2, [], ["Richard Waind"])], "Knight Frank", reg), false);
  // Louis Harding is on file for both: on Knight Frank's site he is theirs, on ours he is a former one of ours.
  assert.equal(namesOnly([c(1, [], ["Louis Harding"])], "betterhomes", reg), true);
  assert.equal(namesOnly([], "Knight Frank", reg), false);
});

const KF: DecidedMention = { company: "Knight Frank", sentence: 1, quote: "Knight Frank said prices rose.", role: "data", sentiment: "neutral" };
const US_M: DecidedMention = { company: "betterhomes", sentence: 2, quote: "betterhomes said rents held.", role: "data", sentiment: "neutral" };
const answer = (mentions: DecidedMention[]): Decision => ({
  mentions,
  irrelevantReason: null,
  possibleMoves: [],
  dropped: [],
  model: "claude-haiku-5-5",
  checkedAt: "2026-11-06T06:00:00.000Z",
});

test("the publisher is taken out of a decision, with the reason, and everyone else stands", () => {
  const both = withoutOwnSite(answer([KF, US_M]), "Knight Frank");
  assert.deepEqual(both.mentions, [US_M]);
  assert.equal(both.irrelevantReason, null);
  assert.deepEqual(both.dropped, [{ company: "Knight Frank", sentence: 1, why: ownSiteReason("Knight Frank") }]);
  const alone = withoutOwnSite(answer([KF]), "Knight Frank");
  assert.deepEqual(alone.mentions, []);
  assert.equal(alone.irrelevantReason, "it is on Knight Frank's own website, which doesn't count as coverage");
  // Nothing to take out: the same decision back.
  const same = answer([US_M]);
  assert.equal(withoutOwnSite(same, "Knight Frank"), same);
  assert.equal(withoutOwnSite(same, null), same);
  assert.deepEqual(ownSiteDecision("Sotheby's", "2026-11-06T06:00:00.000Z"), {
    mentions: [],
    irrelevantReason: "it is on Sotheby's own website, which doesn't count as coverage",
    possibleMoves: [],
    dropped: [],
    model: "none: the company's own website",
    checkedAt: "2026-11-06T06:00:00.000Z",
  });
});
