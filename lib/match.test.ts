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
