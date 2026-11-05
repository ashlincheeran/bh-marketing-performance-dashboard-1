import { test } from "node:test";
import assert from "node:assert/strict";
import { articleId, outletKey, stripOutletSuffix, titleKey, urlKey } from "@/lib/news/keys";

test("Google's outlet suffix is stripped from the headline", () => {
  assert.equal(
    stripOutletSuffix("Knight Frank appoints Louis Harding - Consultancy-me.com", "Consultancy-me.com"),
    "Knight Frank appoints Louis Harding",
  );
  assert.equal(stripOutletSuffix("Dubai rents fall | Gulf News", "Gulf News"), "Dubai rents fall");
  assert.equal(stripOutletSuffix("Rents fall - again", null), "Rents fall - again");
});

test("the same headline from two feeds gets the same key", () => {
  const a = titleKey("Dubai’s busiest prime property market - Khaleej Times", "Khaleej Times");
  const b = titleKey("Dubai's busiest prime property market", "Khaleej Times");
  assert.equal(a, b);
  assert.equal(titleKey("fäm Properties report", null), "fam properties report");
});

test("addresses that are the same page compare equal", () => {
  assert.equal(urlKey("https://www.gulfnews.com/business/x/?utm_source=g#top"), "gulfnews.com/business/x");
  assert.equal(urlKey("https://gulfnews.com/business/x"), "gulfnews.com/business/x");
  assert.equal(urlKey("https://mid-east.info/?p=296478"), "mid-east.info?p=296478");
  assert.equal(urlKey("not a url"), null);
  assert.equal(urlKey("ftp://x.com/a"), null);
});

test("ids are stable and prefer the Google link", () => {
  const id1 = articleId({ googleLink: "https://news.google.com/rss/articles/abc", titleKey: "t", outletKey: "o" });
  const id2 = articleId({ googleLink: "https://news.google.com/rss/articles/abc", url: "https://x.com/a", titleKey: "z", outletKey: "z" });
  assert.equal(id1, id2);
  assert.match(id1, /^na_[0-9a-f]{20}$/);
  assert.notEqual(id1, articleId({ titleKey: "t", outletKey: "o" }));
});

test("outlet names and addresses share keys", () => {
  assert.equal(outletKey("Gulf News"), outletKey(null, "https://gulfnews.com/a"));
});
