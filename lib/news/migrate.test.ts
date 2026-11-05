import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECHECK_KINDS,
  RECHECK_NOTE,
  articleFromMention,
  isRecheckKind,
  planImport,
  publisherAddress,
  recheckFilter,
  recheckIds,
  rejectedOnOldScreen,
  sameArticleKeys,
  type ImportedState,
  type LegacyMention,
} from "@/lib/news/migrate";
import { outletKey, titleKey, urlKey } from "@/lib/news/keys";

const GOOGLE = "https://news.google.com/rss/articles/CBMiqgFBVV95cUxQSE5WRjN6Z3pZWmZ6bGJ4Z0VnUGN5b1dqMFFM?oc=5";
const PUBLISHER = "https://www.zawya.com/en/business/real-estate/dubai-prices-rise-abc123/";

/** An old bot's row as lib/ingest.ts wrote it: the address unwrapped, the feed's link in raw. */
function mention(over: Partial<LegacyMention> = {}): LegacyMention {
  return {
    id: "3f2a9c1b7d4e5f60",
    source: "googlenews",
    status: "new",
    url: PUBLISHER,
    title: "Dubai prices rise again, says betterhomes",
    outlet_name: "Zawya",
    published_on: "2026-09-04",
    created_at: "2026-09-04T05:12:40.123+00:00",
    metadata: { keywords: ["betterhomes dubai", "dubai real estate"], bodyStatus: "ok" },
    raw: { link: GOOGLE, resolved: PUBLISHER, source: "Zawya" },
    ...over,
  };
}

test("an old row with both links keeps the Google link and the publisher's address", () => {
  const a = articleFromMention(mention());
  assert.ok(a);
  assert.equal(a.id, "lm_3f2a9c1b7d4e5f60");
  assert.equal(a.legacy_mention_id, "3f2a9c1b7d4e5f60");
  assert.equal(a.google_link, GOOGLE);
  assert.equal(a.url, PUBLISHER);
  assert.equal(a.url_key, urlKey(PUBLISHER));
  assert.equal(a.url_key, "zawya.com/en/business/real-estate/dubai-prices-rise-abc123");
});

test("the keys are made the way the search step makes them, so a story found again is recognised", () => {
  const a = articleFromMention(mention({ title: "Dubai prices rise again, says betterhomes - Zawya" }));
  assert.ok(a);
  assert.equal(a.title_key, titleKey("Dubai prices rise again, says betterhomes", "Zawya"));
  assert.equal(a.outlet_key, outletKey("Zawya"));
  assert.equal(a.outlet, "Zawya");
  assert.equal(a.published_on, "2026-09-04");
});

test("a row that was never unwrapped stores the Google link and no address", () => {
  const a = articleFromMention(mention({ url: GOOGLE, raw: { link: GOOGLE, resolved: null } }));
  assert.ok(a);
  assert.equal(a.google_link, GOOGLE);
  assert.equal(a.url, null);
  assert.equal(a.url_key, null);
});

test("the Google link is found in the address when raw has none", () => {
  const a = articleFromMention(mention({ url: GOOGLE, raw: null }));
  assert.ok(a);
  assert.equal(a.google_link, GOOGLE);
  assert.equal(a.url, null);
});

test("a row with only a publisher's address stores no Google link", () => {
  const a = articleFromMention(mention({ raw: {} }));
  assert.ok(a);
  assert.equal(a.google_link, null);
  assert.equal(a.url, PUBLISHER);
});

test("the unwrapped address in raw is used when the row's own address is the Google link", () => {
  const a = articleFromMention(mention({ url: GOOGLE }));
  assert.ok(a);
  assert.equal(a.google_link, GOOGLE);
  assert.equal(a.url, PUBLISHER);
});

test("a consent or Google page kept as the address is not taken for the publisher's", () => {
  for (const wall of [
    "https://consent.google.com/ml?continue=https://news.google.com/rss/articles/x",
    "https://www.google.com/url?q=x",
    "https://consent.yahoo.com/v2/collectConsent?sessionId=1",
    "https://accounts.example.com/login",
  ]) {
    const a = articleFromMention(mention({ url: wall, raw: { link: GOOGLE, resolved: wall } }));
    assert.ok(a);
    assert.equal(a.url, null, wall);
    assert.equal(a.url_key, null, wall);
    assert.equal(a.google_link, GOOGLE);
  }
  assert.equal(publisherAddress("ftp://zawya.com/x"), null);
  assert.equal(publisherAddress("not an address"), null);
  assert.equal(publisherAddress(42), null);
  assert.equal(publisherAddress(` ${PUBLISHER} `), PUBLISHER);
});

test("found_by comes from metadata.keywords, then raw.keywords, else stays empty", () => {
  assert.deepEqual(articleFromMention(mention())?.found_by, ["betterhomes dubai", "dubai real estate"]);
  assert.deepEqual(
    articleFromMention(mention({ metadata: {}, raw: { link: GOOGLE, keywords: ["haus and haus dubai"] } }))?.found_by,
    ["haus and haus dubai"],
  );
  assert.deepEqual(articleFromMention(mention({ metadata: { keywords: "not a list" }, raw: {} }))?.found_by, []);
  assert.deepEqual(articleFromMention(mention({ metadata: null, raw: null }))?.found_by, []);
  // Blank and repeated terms are dropped, and at most 20 are kept, like the search step.
  const many = Array.from({ length: 30 }, (_, i) => `term ${i}`);
  assert.equal(articleFromMention(mention({ metadata: { keywords: [...many, " ", "term 1"] } }))?.found_by.length, 20);
});

test("every import is decided with no decision, and its note names the old status", () => {
  for (const status of ["new", "reviewed", "rejected"]) {
    const a = articleFromMention(mention({ status }));
    assert.ok(a);
    assert.equal(a.status, "decided");
    assert.equal(a.decision, null);
    assert.equal(a.note, `imported from the old bot (${status})`);
  }
  assert.equal(articleFromMention(mention({ status: null }))?.note, "imported from the old bot (no status)");
});

test("a rival's row imports the same way", () => {
  const a = articleFromMention(
    mention({ source: "competitor_news", metadata: { competitor: "Haus & Haus", keywords: ["haus and haus dubai"] } }),
  );
  assert.ok(a);
  assert.equal(a.id, "lm_3f2a9c1b7d4e5f60");
  assert.equal(a.status, "decided");
  assert.deepEqual(a.found_by, ["haus and haus dubai"]);
});

test("first_seen_at is when the old bot stored it, and left to the database when unknown", () => {
  assert.equal(articleFromMention(mention())?.first_seen_at, "2026-09-04T05:12:40.123Z");
  assert.equal("first_seen_at" in (articleFromMention(mention({ created_at: null })) ?? {}), false);
  assert.equal("first_seen_at" in (articleFromMention(mention({ created_at: "yesterday" })) ?? {}), false);
});

test("a row with no headline to store it under is left out", () => {
  assert.equal(articleFromMention(mention({ title: null })), null);
  assert.equal(articleFromMention(mention({ title: "   " })), null);
  // Nothing left once folded to letters and digits, as the search step would also skip.
  assert.equal(articleFromMention(mention({ title: "عقارات دبي" })), null);
  assert.equal(articleFromMention(mention({ id: "" })), null);
});

test("an odd published_on is dropped rather than stored", () => {
  assert.equal(articleFromMention(mention({ published_on: "4 Sep 2026" }))?.published_on, null);
  assert.equal(articleFromMention(mention({ published_on: null }))?.published_on, null);
});

test("planImport skips what is stored already, by id, Google link, address or headline and outlet", () => {
  const stored = articleFromMention(mention());
  assert.ok(stored);
  const seen = new Set(sameArticleKeys(stored));

  // The same row again: same id.
  assert.equal(planImport([mention()], new Set(seen)).rows.length, 0);
  // Another row with the same Google link.
  assert.equal(planImport([mention({ id: "b1", title: "Something else", url: GOOGLE, raw: { link: GOOGLE } })], new Set(seen)).rows.length, 0);
  // Another row with the same address.
  assert.equal(planImport([mention({ id: "b2", title: "Something else", raw: {} })], new Set(seen)).rows.length, 0);
  // The same headline at the same outlet, spelled as the feed spells it another day.
  assert.equal(
    planImport([mention({ id: "b3", url: null, raw: {}, title: "DUBAI PRICES RISE AGAIN, says Betterhomes", outlet_name: "zawya.com" })], new Set(seen))
      .rows.length,
    0,
  );
  // The same headline at another outlet is another placement.
  const other = planImport([mention({ id: "b4", url: null, raw: {}, outlet_name: "Khaleej Times" })], new Set(seen));
  assert.equal(other.rows.length, 1);
  assert.equal(other.skipped, 0);
});

test("planImport keeps the first of two old rows for one story and counts the rest as skipped", () => {
  const out = planImport(
    [
      mention({ id: "a1" }),
      mention({ id: "a2", source: "competitor_news" }),
      mention({ id: "a3", title: null }),
      // Written by the new bot: its article is stored already.
      mention({ id: "nb_na_123", metadata: { articleId: "na_123" }, url: "https://example.com/new", raw: {} }),
      mention({ id: "a4", title: "A different story", url: "https://gulfnews.com/business/property/x", raw: {} }),
    ],
    new Set(),
  );
  assert.deepEqual(
    out.rows.map((r) => r.id),
    ["lm_a1", "lm_a4"],
  );
  assert.equal(out.skipped, 3);
});

test("sameArticleKeys leaves out the keys an article does not have", () => {
  assert.deepEqual(sameArticleKeys({ id: "na_1", google_link: null, url_key: null, title_key: "t", outlet_key: "o" }), ["id na_1", "title t|o"]);
  assert.deepEqual(sameArticleKeys({ id: "na_1", google_link: "g", url_key: "u", title_key: "t", outlet_key: "" }), [
    "id na_1",
    "title t|",
    "link g",
    "address u",
  ]);
});

test("the re-check kinds pick the rows the task names", () => {
  assert.deepEqual(RECHECK_KINDS, ["unchecked_ours", "pending_reread", "rivals"]);
  // Ours, still counting, that the old fact check never looked at.
  assert.deepEqual(recheckFilter("unchecked_ours"), { source: "googlenews", status: "new", withoutFactCheck: true });
  // Ours, taken out of the count because the old fact check could not read the page, and no person has judged since.
  assert.deepEqual(recheckFilter("pending_reread"), {
    source: "googlenews",
    status: "rejected",
    factCheckResult: "unread",
    withoutPersonVerdict: true,
  });
  // Every rival story, of any year and any status, that no person has judged.
  assert.deepEqual(recheckFilter("rivals"), { source: "competitor_news", withoutPersonVerdict: true });
  for (const kind of RECHECK_KINDS) assert.equal(isRecheckKind(kind), true);
  assert.equal(isRecheckKind("rivals_2026"), false);
  assert.equal(isRecheckKind("everything"), false);
  assert.equal(isRecheckKind(null), false);
});

test("a row rejected after the backfill recovered it was rejected by a person, unless a new screen or the new bot wrote it", () => {
  const recovered = { recoveredBy: "backfill", reason: "fact check: not about betterhomes", factCheck: { result: "pass", role: "data" } };
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: recovered }), true);
  // Still counting, or never recovered: nothing to mark.
  assert.equal(rejectedOnOldScreen({ status: "new", metadata: recovered }), false);
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { reason: "fact check: not about betterhomes" } }), false);
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: null }), false);
  // Marked once already, so running it again changes nothing.
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...recovered, personVerdict: "rejected" } }), false);
  // Rejected by the new bot's check, or by a person on the new Bot Activity: both leave the article's id.
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...recovered, articleId: "lm_1", reason: "news check: not about betterhomes" } }), false);
});

test("a re-check sends back the imports its rows cover, and leaves alone what a run or a person holds", () => {
  const imported = (id: string, over: Partial<ImportedState> = {}): ImportedState => ({
    id: `lm_${id}`,
    legacy_mention_id: id,
    status: "decided",
    note: "imported from the old bot (new)",
    google_link: GOOGLE,
    url: null,
    ...over,
  });
  const covered = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
  const ids = recheckIds(
    [
      imported("a"),
      // Read before, held in test mode, or failed: all go back.
      imported("b", { status: "unreadable", note: "the site refused the read (HTTP 403)" }),
      imported("c", { status: "held", note: null }),
      imported("d", { status: "failed", google_link: null, url: PUBLISHER }),
      // A run holds it, or it copies another article.
      imported("e", { status: "reading" }),
      imported("f", { status: "checking" }),
      imported("g", { status: "duplicate" }),
      // Nothing to read.
      imported("h", { google_link: null, url: null }),
      // A person's verdict stands.
      imported("i", { note: "rejected by a person" }),
      imported("j", { note: "Kept by a person" }),
      // Its old row is not one this kind covers.
      imported("z"),
      { ...imported("y"), legacy_mention_id: null },
    ],
    covered,
  );
  assert.deepEqual(ids, ["lm_a", "lm_b", "lm_c", "lm_d"]);
  assert.equal(RECHECK_NOTE, "re-checking the old bot's story");
});
