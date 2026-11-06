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

test("every import records the old row's status as it was imported, so a person's later change on the old screen shows", () => {
  for (const status of ["new", "reviewed", "rejected"]) assert.equal(articleFromMention(mention({ status }))?.legacy_status, status);
  // As stored, the way migration 0023 recorded the earlier imports; nothing when there was none.
  assert.equal(articleFromMention(mention({ status: "rejected " }))?.legacy_status, "rejected ");
  assert.equal(articleFromMention(mention({ status: null }))?.legacy_status, null);
  // A story the old bot stored twice: the second row's own status goes with its duplicate.
  const out = planImport([mention({ id: "a1" }), mention({ id: "a2", status: "rejected" })], new Map());
  assert.deepEqual(
    [...out.rows, ...out.duplicates].map((a) => [a.id, a.status, a.legacy_status]),
    [
      ["lm_a1", "decided", "new"],
      ["lm_a2", "duplicate", "rejected"],
    ],
  );
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

test("planImport stores a second old row for a stored story as its duplicate, by Google link, address or headline and outlet", () => {
  const stored = articleFromMention(mention());
  assert.ok(stored);
  const seen = () => new Map(sameArticleKeys(stored).map((k) => [k, stored.id]));

  // The same row again: same id, nothing to do.
  const again = planImport([mention()], seen());
  assert.deepEqual([again.rows.length, again.duplicates.length, again.skipped], [0, 0, 1]);
  // Another row with the same Google link, the same address, or the same headline at the same outlet.
  for (const twin of [
    mention({ id: "b1", title: "Something else", url: GOOGLE, raw: { link: GOOGLE } }),
    mention({ id: "b2", title: "Something else", raw: {} }),
    mention({ id: "b3", url: null, raw: {}, title: "DUBAI PRICES RISE AGAIN, says Betterhomes", outlet_name: "zawya.com" }),
  ]) {
    const out = planImport([twin], seen());
    assert.equal(out.rows.length, 0, twin.id);
    assert.equal(out.duplicates.length, 1, twin.id);
    const d = out.duplicates[0];
    assert.deepEqual([d.id, d.status, d.dup_of, d.legacy_mention_id, d.google_link], [`lm_${twin.id}`, "duplicate", stored.id, twin.id, null]);
  }
  // The same headline at another outlet is another placement.
  const other = planImport([mention({ id: "b4", url: null, raw: {}, outlet_name: "Khaleej Times" })], seen());
  assert.equal(other.rows.length, 1);
  assert.equal(other.duplicates.length, 0);
  assert.equal(other.skipped, 0);
});

test("planImport makes the counting row of two old rows for one story the article, and the other its duplicate", () => {
  const out = planImport(
    [
      // Rejected, so the counting twin below speaks for the story even though it comes later.
      mention({ id: "a0", status: "rejected" }),
      mention({ id: "a1" }),
      mention({ id: "a2", source: "competitor_news" }),
      mention({ id: "a3", title: null }),
      // Written by the new bot: its article is stored already.
      mention({ id: "nb_na_123", metadata: { articleId: "na_123" }, url: "https://example.com/new", raw: {} }),
      mention({ id: "a4", title: "A different story", url: "https://gulfnews.com/business/property/x", raw: {} }),
    ],
    new Map(),
  );
  assert.deepEqual(
    out.rows.map((r) => r.id),
    ["lm_a1", "lm_a4"],
  );
  assert.deepEqual(
    out.duplicates.map((d) => [d.id, d.dup_of]),
    [
      ["lm_a2", "lm_a1"],
      ["lm_a0", "lm_a1"],
    ],
  );
  assert.equal(out.skipped, 2);
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
    withoutHandRejection: true,
  });
  // Every rival story, of any year and any status, that no person has judged, by hand included.
  assert.deepEqual(recheckFilter("rivals"), { source: "competitor_news", withoutPersonVerdict: true, withoutHandRejection: true });
  for (const kind of RECHECK_KINDS) assert.equal(isRecheckKind(kind), true);
  assert.equal(isRecheckKind("rivals_2026"), false);
  assert.equal(isRecheckKind("everything"), false);
  assert.equal(isRecheckKind(null), false);
});

test("a row rejected after the backfill recovered it was rejected by a person, unless a new screen or the new bot wrote it", () => {
  const recovered = { recoveredBy: "backfill", reason: "fact check: not about betterhomes", factCheck: { result: "pass", role: "data" } };
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: recovered }), true);
  // Still counting, or never recovered: nothing to mark.
  // The old fact check rejected recovered rows too, writing its own verdict over the pass: not a person's Reject.
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...recovered, factCheck: { result: "fail", why: "our name is not in the article" } } }), false);
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...recovered, factCheck: { result: "unread", prevStatus: "new" } } }), false);
  assert.equal(rejectedOnOldScreen({ status: "new", metadata: recovered }), false);
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { reason: "fact check: not about betterhomes" } }), false);
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: null }), false);
  // Marked once already, so running it again changes nothing.
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...recovered, personVerdict: "rejected" } }), false);
  // Rejected by the new bot's check, or by a person on the new Bot Activity: both leave the article's id.
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...recovered, articleId: "lm_1", reason: "news check: not about betterhomes" } }), false);
});

test("a rival row rejected by hand in the old feed's cleanup is a person's Reject, to be marked once", () => {
  const byHand = { competitor: "Sotheby's", rejected_by: "manual", rejected_reason: "manual cleanup: not the competitor brokerage" };
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: byHand }), true);
  // Whatever reason the old bot gave before the cleanup.
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...byHand, reason: "no brand in text" } }), true);
  // Marked once already, written by the new bot or a new screen since, or counting again: nothing to mark.
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...byHand, personVerdict: "rejected" } }), false);
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...byHand, articleId: "lm_1" } }), false);
  assert.equal(rejectedOnOldScreen({ status: "new", metadata: byHand }), false);
  assert.equal(rejectedOnOldScreen({ status: "rejected", metadata: { ...byHand, rejected_by: "" } }), false);
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
      // Read before, or failed: both go back.
      imported("b", { status: "unreadable", note: "the site refused the read (HTTP 403)" }),
      imported("d", { status: "failed", google_link: null, url: PUBLISHER }),
      // Held in test mode: checked already, waiting only for counting to come on.
      imported("c", { status: "held", note: null }),
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
  assert.deepEqual(ids, ["lm_a", "lm_b", "lm_d"]);
  assert.equal(RECHECK_NOTE, "re-checking the old bot's story");
});

test("a counted old row on its own company's website comes in held, with that rule's decision, for the next publish", () => {
  const AT = "2026-11-06T07:00:00.000Z";
  const allsopp = mention({
    source: "competitor_news",
    url: "https://www.allsoppandallsopp.com/dubai/about-us/news-videos/1976-dubais-handover-wave",
    raw: { link: GOOGLE },
    outlet_name: "Allsopp & Allsopp",
    title: "Dubai's Handover Wave: What New Supply Means for Buyers",
    metadata: { competitor: "Allsopp & Allsopp" },
  });
  const held = articleFromMention(allsopp, AT);
  assert.equal(held?.status, "held");
  assert.deepEqual(held?.decision, {
    mentions: [],
    irrelevantReason: "it is on Allsopp & Allsopp's own website, which doesn't count as coverage",
    possibleMoves: [],
    dropped: [],
    model: "none: the company's own website",
    checkedAt: AT,
  });
  // Stored with only Google's link, the publisher's name tells the site.
  assert.equal(articleFromMention(mention({ source: "competitor_news", url: GOOGLE, raw: { link: GOOGLE }, outlet_name: "Dubai Sotheby's International Realty", metadata: { competitor: "Sotheby's" } }), AT)?.status, "held");
  // Ours, on our own site.
  assert.equal(articleFromMention(mention({ url: "https://www.bhomes.com/en/blog/q3", raw: { link: GOOGLE }, outlet_name: "betterhomes" }), AT)?.status, "held");
  // Already out of the count, someone else's site, or another company's row on that site: imported as before.
  assert.equal(articleFromMention({ ...allsopp, status: "rejected" }, AT)?.status, "decided");
  assert.equal(articleFromMention(mention(), AT)?.status, "decided");
  assert.equal(articleFromMention({ ...allsopp, source: "googlenews", metadata: {} }, AT)?.status, "decided");
  // A copy of a stored story stays a copy, with no decision of its own.
  const seen = new Map<string, string>();
  const first = planImport([allsopp], seen, AT);
  assert.equal(first.rows[0]?.status, "held");
  const again = planImport([{ ...allsopp, id: "another_old_row" }], seen, AT);
  assert.equal(again.duplicates[0]?.status, "duplicate");
  assert.equal(again.duplicates[0]?.decision, null);
});

test("a late import of a story the old bot still counts is queued for the new bot's next run, not stored as decided", () => {
  const AT = "2026-11-06T07:00:00.000Z";
  const late = (over: Partial<LegacyMention> = {}) => articleFromMention(mention(over), AT, true);
  // Counting, with a link to read: queued, and the note says why.
  const queued = late();
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.note, RECHECK_NOTE);
  assert.equal(queued?.decision, null);
  // A person's Keep, or a row already out of the count, stays as it is.
  assert.equal(late({ status: "reviewed" })?.status, "decided");
  assert.equal(late({ status: "rejected" })?.status, "decided");
  // Nothing to read it from: it could only sit in the queue, so it stays decided.
  assert.equal(late({ url: null, raw: {} })?.status, "decided");
  // On its own company's website, the rule decides it without a read.
  assert.equal(late({ url: "https://www.bhomes.com/en/blog/q3", raw: { link: GOOGLE }, outlet_name: "betterhomes" })?.status, "held");
  // The first import, not late, stores it as decided, as before.
  assert.equal(articleFromMention(mention(), AT)?.status, "decided");
  // planImport passes it on.
  assert.equal(planImport([mention()], new Map(), AT, true).rows[0]?.status, "queued");
});
