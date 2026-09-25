#!/usr/bin/env node
/**
 * Which discovery source should the news bot actually be built on?
 *
 * WHY THIS EXISTS — today the bot finds articles through Google News RSS, which
 * hands back a wrapper link (/rss/articles/CBMi…) instead of the article. Until
 * late 2024 that wrapper decoded offline; it no longer does, so the only way to
 * learn where a link points is Google's internal `batchexecute` RPC: fetch the
 * article page for a signature and timestamp, then POST them back. That works —
 * it recovered two real mentions — but look at what it rests on. An
 * undocumented endpoint that has already changed once, a consent cookie, hard
 * rate limits, and two HTTP round trips per article before any content is read.
 * That is a workaround holding up the pipeline, not a foundation.
 *
 * The honest fix is to stop needing it: use a source that returns the
 * publisher's URL in the first place. Two candidates, and this probe measures
 * both rather than assuming:
 *
 *   GDELT DOC 2.0 — free, no API key, documented, full-text search over a
 *     rolling 3-month window, returns url + domain directly. The open question
 *     is whether it indexes Gulf trade press, which is where our coverage
 *     lives. If it does not, it does not matter how clean the API is.
 *
 *   PUBLISHER RSS — the PR sheet shows coverage concentrating in about ten
 *     outlets. Their own feeds are direct, free, stable, and often carry the
 *     full article text, which would remove the Apify crawl too. The cost is
 *     maintaining a feed list and missing the long tail.
 *
 * Scored against the PR team's own Aug–Sep 2026 log, so "better" means
 * "returns the coverage we know exists", not "looks nicer".
 *
 *   node scripts/probe-discovery-sources.mjs
 *
 * No key, no npm install, no writes. Runs on a GitHub runner because
 * api.gdeltproject.org is blocked by network policy in the dev sandbox.
 */

const SLEEP_MS = Number(process.env.SLEEP_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Known-true coverage: distinct Aug–Sep 2026 stories from the PR sheet. */
const TRUTH = [
  { story: "Dubai overtakes London $10m+",        needles: ["overtakes london", "296 vs 16"] },
  { story: "ORA Y Views villas at Bayn",          needles: ["y views", "ora unveils boutique", "ghantoot"] },
  { story: "July: sales +2%, luxury +22%",        needles: ["luxury transactions climb", "modest recovery in july", "sales rise 2%"] },
  { story: "Golden Visa threshold",               needles: ["golden visa threshold"] },
  { story: "Mortgage decouples from Fed",         needles: ["absorb fed rate", "federal reserve", "driving dubai"] },
  { story: "Binghatti multibillion pact",         needles: ["binghatti in talks"] },
  { story: "WSJ wealthy Gulf",                    needles: ["wealthy gulf", "bahrain grand prix"] },
  { story: "Business Bay overtakes Palm",         needles: ["business bay overtakes", "business bay: dubai"] },
  { story: "August deals down 37%",               needles: ["down 37%", "selective strength in august"] },
  { story: "LEOS British demand",                 needles: ["leos developments"] },
  { story: "Sales rebound 38%",                   needles: ["rebound 38", "bounce back 38"] },
  { story: "Transactions grow bigger",            needles: ["stretch their budgets"] },
];

const QUERIES = [
  "betterhomes",
  '"better homes" dubai',
  "betterhomes dubai",
  "bhomes",
  '"Richard Waind"',
];

/** The outlets the PR sheet actually records coverage in. */
const OUTLET_DOMAINS = [
  "zawya.com", "khaleejtimes.com", "arabianbusiness.com", "gdnonline.com",
  "menafn.com", "tradearabia.com", "gulfnews.com", "indexbox.io",
  "tradingview.com", "thefinanceworld.com", "luxhabitat.ae", "businesstimes.com.sg",
];

/** Feed paths worth trying per host, commonest first. */
const FEED_PATHS = ["/rss", "/feed", "/rss.xml", "/feed/", "/rss/feed", "/en/rss", "/arss"];

async function getJson(url, label) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; bh-pr-probe/1.0)" },
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status} ${text.slice(0, 120)}` };
    try {
      return { data: JSON.parse(text) };
    } catch {
      // GDELT answers malformed queries with an HTML/plain error page.
      return { error: `non-JSON (${text.slice(0, 120).replace(/\s+/g, " ")})` };
    }
  } catch (e) {
    return { error: `${label}: ${e?.message ?? String(e)}` };
  }
}

const gdeltUrl = (query, extra = "") =>
  `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
  `&mode=artlist&maxrecords=250&format=json&sort=datedesc${extra}`;

function storiesHit(titles) {
  const hay = titles.map((t) => t.toLowerCase());
  const hit = new Set();
  for (const t of TRUTH) if (t.needles.some((n) => hay.some((h) => h.includes(n)))) hit.add(t.story);
  return hit;
}

console.log(`Discovery source probe — scored against the PR sheet (Aug–Sep 2026)`);
console.log(`  ${TRUTH.length} known stories to find\n`);

// ── 1. GDELT: does it return our coverage, and with real URLs? ──────────────
console.log(`═══ GDELT DOC 2.0 ═══\n`);
const gdeltFound = new Set();
const gdeltDomains = new Map();
let gdeltWrapped = 0;
let gdeltTotal = 0;

for (const q of QUERIES) {
  const { data, error } = await getJson(gdeltUrl(q, "&timespan=3months"), "gdelt");
  await sleep(SLEEP_MS);
  if (error) {
    console.log(`  ERR  "${q}" — ${error}`);
    continue;
  }
  const arts = data?.articles ?? [];
  gdeltTotal += arts.length;
  for (const a of arts) {
    const d = String(a.domain || "").toLowerCase();
    if (d) gdeltDomains.set(d, (gdeltDomains.get(d) ?? 0) + 1);
    // The whole point: is the url the publisher's, or another wrapper?
    if (/news\.google\.com|\/rss\/articles\//i.test(String(a.url || ""))) gdeltWrapped++;
  }
  const hits = storiesHit(arts.map((a) => String(a.title || "")));
  hits.forEach((h) => gdeltFound.add(h));
  console.log(`  ${hits.size ? `★${hits.size}` : "  ·"}  "${q}"  n=${arts.length}`);
  for (const h of hits) console.log(`         └─ ${h}`);
}

console.log(`\n  GDELT recall: ${gdeltFound.size}/${TRUTH.length} stories`);
console.log(`  wrapper URLs returned: ${gdeltWrapped}/${gdeltTotal} ${gdeltWrapped === 0 ? "(all direct — no decode step at all)" : "(!)"}`);

// ── 2. Does GDELT index the outlets that actually cover us? ─────────────────
console.log(`\n═══ GDELT coverage of our outlets ═══\n`);
const indexed = [];
for (const domain of OUTLET_DOMAINS) {
  const { data, error } = await getJson(gdeltUrl(`domain:${domain} dubai`, "&timespan=1month"), "gdelt-domain");
  await sleep(SLEEP_MS);
  const n = error ? 0 : (data?.articles ?? []).length;
  if (!error && n > 0) indexed.push(domain);
  console.log(`  ${n > 0 ? "YES" : " no"}  ${domain.padEnd(24)} ${error ? error.slice(0, 60) : `${n} articles/month`}`);
}
console.log(`\n  ${indexed.length}/${OUTLET_DOMAINS.length} of our outlets are indexed by GDELT`);

// ── 3. Publisher RSS: direct, free, and possibly full-text ─────────────────
console.log(`\n═══ Publisher RSS feeds ═══\n`);
const liveFeeds = [];
for (const domain of OUTLET_DOMAINS) {
  let found = null;
  for (const path of FEED_PATHS) {
    const url = `https://www.${domain}${path}`;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; bh-pr-probe/1.0)" },
        redirect: "follow",
        cache: "no-store",
      });
      if (!res.ok) continue;
      const body = await res.text();
      if (!/<rss|<feed|<rdf:RDF/i.test(body)) continue;
      const items = (body.match(/<item[\s>]/gi) ?? []).length + (body.match(/<entry[\s>]/gi) ?? []).length;
      // Full text in the feed would remove the Apify crawl for this outlet.
      const fullText = /<content:encoded/i.test(body);
      found = { url, items, fullText };
      break;
    } catch {
      /* try the next path */
    }
    await sleep(300);
  }
  if (found) {
    liveFeeds.push(domain);
    console.log(`  YES  ${domain.padEnd(24)} ${found.items} items  ${found.fullText ? "FULL TEXT in feed" : "headlines only"}`);
    console.log(`       ${found.url}`);
  } else {
    console.log(`   no  ${domain.padEnd(24)} no feed found at ${FEED_PATHS.length} common paths`);
  }
}

// No data, no verdict — see probe-keyword-recall.mjs for why this guard exists.
if (gdeltTotal === 0 && liveFeeds.length === 0) {
  console.log(`\n────────────────────────────────────`);
  console.log(`NO DATA — no GDELT article and no feed came back, so there is no verdict.`);
  process.exit(2);
}

// ── verdict ────────────────────────────────────────────────────────────────
console.log(`\n────────────────────────────────────`);
console.log(`GDELT recall      ${gdeltFound.size}/${TRUTH.length} stories · ${indexed.length}/${OUTLET_DOMAINS.length} outlets indexed · ${gdeltWrapped} wrapper URLs`);
console.log(`Publisher feeds   ${liveFeeds.length}/${OUTLET_DOMAINS.length} outlets expose a usable RSS feed`);
const missed = TRUTH.filter((t) => !gdeltFound.has(t.story));
if (missed.length) {
  console.log(`\nGDELT did not return:`);
  for (const m of missed) console.log(`  ${m.story}`);
}
console.log(`
Read it this way:
  GDELT recall high AND outlets indexed  → move discovery to GDELT; the
    batchexecute decoder becomes a fallback rather than the load-bearing path.
  GDELT weak BUT feeds live              → drive the known outlets from their
    own feeds and keep Google News only for the long tail.
  Both weak                              → the wrapper decoder stays primary,
    and a paid news API is the next thing to price.`);
