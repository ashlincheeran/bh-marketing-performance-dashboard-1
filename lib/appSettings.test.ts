import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NEWS_SETTINGS, cleanNewsSettings } from "@/lib/appSettings";

// Pure: the news bot's settings as cleanNewsSettings reads whatever app_settings holds. Nothing here reads
// the database.

test("the news bot's settings have no monthly cap on Apify reads: one still stored is dropped and read by nothing", () => {
  const stored = { model: "claude-sonnet-5-5", apifyBackup: true, apifyMonthlyCap: 30, searchWindow: "7d", countOnPrTab: false };
  const clean = cleanNewsSettings(stored);
  assert.deepEqual(clean, { model: "claude-sonnet-5-5", apifyBackup: true, searchWindow: "7d", countOnPrTab: false });
  assert.equal("apifyMonthlyCap" in clean, false);
  // Whatever it held, a cap of none, of thousands, or not a number at all.
  for (const apifyMonthlyCap of [0, 9999, "30", null]) {
    assert.equal("apifyMonthlyCap" in cleanNewsSettings({ ...stored, apifyMonthlyCap }), false, String(apifyMonthlyCap));
  }
  assert.equal("apifyMonthlyCap" in DEFAULT_NEWS_SETTINGS, false);
});

test("the rest of the news bot's settings fall back one by one, and only an explicit true turns the Apify backup on", () => {
  assert.deepEqual(cleanNewsSettings(null), DEFAULT_NEWS_SETTINGS);
  assert.deepEqual(cleanNewsSettings({ model: "claude-retired-1", apifyBackup: "yes", searchWindow: "30d", countOnPrTab: "no" }), {
    ...DEFAULT_NEWS_SETTINGS,
    countOnPrTab: true,
  });
  assert.equal(cleanNewsSettings({ apifyBackup: true }).apifyBackup, true);
  assert.equal(DEFAULT_NEWS_SETTINGS.apifyBackup, false);
  // Only an explicit false is test mode.
  assert.equal(cleanNewsSettings({ countOnPrTab: false }).countOnPrTab, false);
});
