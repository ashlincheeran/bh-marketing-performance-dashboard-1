import { test } from "node:test";
import assert from "node:assert/strict";
import { outletKey } from "@/lib/match";

test("a publication's name and its web address share a key", () => {
  assert.equal(outletKey("Khaleej Times"), outletKey(null, "https://www.khaleejtimes.com/business/x"));
  assert.equal(outletKey("khaleejtimes.com"), "khaleejtimes");
  assert.equal(outletKey("The National News"), outletKey(null, "https://www.thenationalnews.com/a"));
  assert.equal(outletKey("Gulf Today"), outletKey(null, "https://www.gulftoday.ae/a"));
  assert.equal(outletKey(null, "https://amp.gulfnews.com/a"), outletKey("Gulf News"));
  assert.equal(outletKey(null, "https://www.bbc.co.uk/news/x"), "bbc");
  assert.equal(outletKey("MENAFN"), outletKey("MenaFN"));
});

test("different publications that share a country ending keep different keys", () => {
  assert.notEqual(outletKey(null, "https://www.luzernerzeitung.ch/x"), outletKey(null, "https://www.tagblatt.ch/x"));
  assert.notEqual(outletKey("adevarul.ro"), outletKey("hotnews.ro"));
  assert.equal(outletKey("forbes.ro"), "forbesro");
  assert.notEqual(outletKey("forbes.ro"), outletKey("forbes.com"));
  assert.equal(outletKey(null, "https://www.arabnews.com.sa/x"), "arabnewssa");
});

test("an edition on its own subdomain is its own publication", () => {
  assert.equal(outletKey(null, "https://de.euronews.com/x"), "euronewsde");
  assert.notEqual(outletKey(null, "https://de.euronews.com/x"), outletKey(null, "https://fr.euronews.com/x"));
  assert.notEqual(outletKey(null, "https://epaper.khaleejtimes.com/x"), outletKey("Khaleej Times"));
  assert.equal(outletKey(null, "https://edition.cnn.com/x"), outletKey(null, "https://www.cnn.com/y"));
});

test("Google's wrapper link says nothing about the publisher", () => {
  assert.equal(outletKey("Zawya", "https://news.google.com/rss/articles/abc"), "zawya");
});

test("Google's own sites are recognised, and publishers are not", async () => {
  const { isGoogleOwned } = await import("@/lib/googleNews");
  for (const u of ["https://www.google.com/sorry/index", "https://consent.google.com/ml", "https://news.google.com/rss/articles/x", "https://www.google.ae/", "https://www.google.co.uk/", "https://ssl.gstatic.com/x", "https://lh3.googleusercontent.com/x", "not a url"]) {
    assert.equal(isGoogleOwned(u), true, u);
  }
  for (const u of ["https://www.khaleejtimes.com/x", "https://gulfnews.com/a", "https://www.youtube.com/watch?v=1", "https://googleblog.example.com/", "https://notgoogle.com/"]) {
    assert.equal(isGoogleOwned(u), false, u);
  }
});

test("a short site name behind www. is still the name", () => {
  assert.equal(outletKey(null, "https://www.ft.com/content/x"), outletKey(null, "https://ft.com/y"));
  assert.equal(outletKey(null, "https://www.pr.com/press-release/1"), outletKey("PR.com"));
  assert.notEqual(outletKey(null, "https://www.news.com.au/x"), outletKey(null, "https://www.today.com/x"));
});
