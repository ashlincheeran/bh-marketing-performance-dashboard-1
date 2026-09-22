#!/usr/bin/env node
/**
 * Does the news bot's article-body extraction actually work?
 *
 * WHY THIS EXISTS — every `mentions` row the bot has written since the flag was
 * added carries `hasBody: false` (2 exceptions in ~1,900 rows). With no body,
 * lib/ingest.ts decides brand relevance from `title + outlet` alone, so any
 * article that names betterhomes only in its text is filed "no brand in text".
 * That is not a theory: four September articles rejected that way are
 * Betterhomes stories, one quoting the CEO by name.
 *
 * The database can prove the body is missing. It cannot say WHY. This probe
 * separates the two candidates:
 *   A. the Google News wrapper link (/rss/articles/CBMi...) never resolves to
 *      the publisher, so the crawler reads an interstitial and returns nothing
 *   B. the actor/config is wrong for news pages generally
 * Passing the DIRECT publisher URL alongside the wrapper tells them apart: if
 * direct passes and wrapper fails, it is A, and the fix is link resolution, not
 * a different actor.
 *
 * Standalone on purpose: no app imports, no npm install, so it runs on a bare
 * GitHub runner — which, unlike the sandbox this repo is developed in, can
 * reach api.apify.com.
 *
 *   APIFY_TOKEN=... node scripts/probe-news-body.mjs
 */

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error("APIFY_TOKEN is not set. Add it as a repository secret.");
  process.exit(1);
}

// A real pair from the incident: the wrapper link the bot stored, and the
// publisher URL it should have ended up at. The article says, in its body,
// "according to an analysis of Dubai Land Department data by Betterhomes" —
// so a working extraction MUST contain the brand. That makes this a test with
// a known right answer rather than a vibe check on text length.
const WRAPPER =
  process.env.WRAPPER_URL ||
  "https://news.google.com/rss/articles/CBMivAFBVV95cUxNeDdDV0dZVF9vRTlodmFVTDNsTTRTa0w3aHZTXzZQVDFGSXlwMGdQT1lEZndYV3hJaDdKcGlUWVk4dVZXcl9XSTlnTmhiWWJEQ1dQbEhmMVF6MnUwaDN6WDJqS2JBTF85cFp2VXpQeWNqdk5xS2I0UkxvY1RoRVZLV093SmRaWUZ5eUVfR1RkSV9QVVhoTGowSy1CTTV1cHUtZ1hnZ1ZhTGlWT1VmcmJhNVVMZERqVklNT01BUdIBvAFBVV95cUxNeDdDV0dZVF9vRTlodmFVTDNsTTRTa0w3aHZTXzZQVDFGSXlwMGdQT1lEZndYV3hJaDdKcGlUWVk4dVZXcl9XSTlnTmhiWWJEQ1dQbEhmMVF6MnUwaDN6WDJqS2JBTF85cFp2VXpQeWNqdk5xS2I0UkxvY1RoRVZLV093SmRaWUZ5eUVfR1RkSV9QVVhoTGowSy1CTTV1cHUtZ1hnZ1ZhTGlWT1VmcmJhNVVMZERqVklNT01BUQ?oc=5";

const DIRECT =
  process.env.DIRECT_URL ||
  "https://www.khaleejtimes.com/business/business-bay-overtakes-palm-jumeirah-as-dubais-busiest-prime-property-market";

const PER_ATTEMPT_MS = Number(process.env.PER_ATTEMPT_MS || 180_000);

/** The exact check lib/match.ts runs, copied so the probe tests the real rule. */
function mentionsBetterhomes(text) {
  let t = (text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/better ?homes (?:&|and) gardens/g, " ");
  return /\bbetter ?homes\b/.test(t) || /\bbhomes\b/.test(t);
}

async function runActor(actor, input, timeoutMs) {
  const secs = Math.max(20, Math.round(timeoutMs / 1000));
  const endpoint =
    `https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(TOKEN)}&timeout=${secs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 400)}`);
    const items = JSON.parse(text);
    return Array.isArray(items) ? items : [];
  } finally {
    clearTimeout(t);
  }
}

function extractText(items) {
  if (!Array.isArray(items)) return "";
  return items.map((it) => String(it?.text || it?.markdown || "")).join("\n").trim();
}

/** Current production config, verbatim from lib/apify.ts — the control. */
const PRODUCTION = (url) => ({
  startUrls: [{ url }],
  maxCrawlPages: 1,
  maxCrawlDepth: 0,
  crawlerType: "playwright:firefox",
  proxyConfiguration: { useApifyProxy: true },
  readableTextCharThreshold: 80,
  saveMarkdown: false,
  maxResults: 1,
});

const ATTEMPTS = [
  ["PRODUCTION config · wrapper link", "apify/website-content-crawler", PRODUCTION(WRAPPER)],
  ["PRODUCTION config · direct link", "apify/website-content-crawler", PRODUCTION(DIRECT)],
  // depth 1 lets the crawler follow the Google interstitial's link out.
  ["depth=1 · wrapper link", "apify/website-content-crawler", { ...PRODUCTION(WRAPPER), maxCrawlDepth: 1, maxCrawlPages: 3, maxResults: 3 }],
  // chrome instead of firefox, in case the interstitial is browser-gated.
  ["chrome · wrapper link", "apify/website-content-crawler", { ...PRODUCTION(WRAPPER), crawlerType: "playwright:chrome" }],
  // residential proxy — news sites commonly block datacentre IPs outright.
  ["residential proxy · direct link", "apify/website-content-crawler", { ...PRODUCTION(DIRECT), proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] } }],
];

console.log(`Probing news body extraction`);
console.log(`  wrapper: ${WRAPPER.slice(0, 80)}…`);
console.log(`  direct : ${DIRECT}`);
console.log(`  expecting the body to contain "betterhomes"\n`);

const results = [];

// Serial: Apify caps memory across simultaneous runs and answers 402 past it,
// which would look like failures that are really just contention.
for (const [label, actor, input] of ATTEMPTS) {
  const started = Date.now();
  try {
    const rows = await runActor(actor, input, PER_ATTEMPT_MS);
    const text = extractText(rows);
    const brand = mentionsBetterhomes(text);
    const ms = Date.now() - started;
    const verdict = !text ? "EMPTY" : brand ? "PASS" : "TEXT-NO-BRAND";
    console.log(`${verdict}  ${label}`);
    console.log(`        rows=${rows.length} chars=${text.length} betterhomes=${brand} ${ms}ms`);
    if (text) console.log(`        head: ${JSON.stringify(text.slice(0, 220))}`);
    results.push({ label, verdict, chars: text.length, brand });
  } catch (e) {
    console.log(`FAIL  ${label}`);
    console.log(`        ${(e?.message ?? String(e)).replace(/\n+/g, " ").slice(0, 400)}`);
    results.push({ label, verdict: "FAIL", chars: 0, brand: false });
  }
  console.log("");
}

console.log("────────────────────────────────────");
const wrapperOk = results.find((r) => r.label.includes("wrapper") && r.brand);
const directOk = results.find((r) => r.label.includes("direct") && r.brand);

if (wrapperOk) {
  console.log(`Wrapper links CAN be read: "${wrapperOk.label}".`);
  console.log(`→ Fix is the crawler config in lib/apify.ts, nothing more.`);
} else if (directOk) {
  console.log(`Direct publisher links read fine ("${directOk.label}"), wrapper links do not.`);
  console.log(`→ The actor is fine. The bug is that lib/ingest.ts hands Apify the`);
  console.log(`  Google News /rss/articles/CBMi… wrapper. Resolve it to the real`);
  console.log(`  article URL first, then crawl that.`);
} else {
  console.log(`Nothing returned readable text containing the brand.`);
  console.log(`→ Read the per-attempt lines above; a FAIL names what Apify objected to,`);
  console.log(`  an EMPTY means the page loaded but yielded nothing above the threshold.`);
  process.exitCode = 1;
}
