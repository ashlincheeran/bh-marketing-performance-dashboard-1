#!/usr/bin/env node
/**
 * Which search keywords actually surface our real press coverage?
 *
 * WHY THIS EXISTS — the PR team keeps a hand-maintained sheet of every
 * placement. For Aug–Sep 2026 it lists 23; the bot kept 0. Arguing about which
 * keywords to add is guesswork without a scoreboard, so this measures RECALL
 * against that sheet: run each candidate query against Google News RSS and see
 * which of the known-true articles come back.
 *
 * The point is to settle two things that cannot be settled from the sandbox
 * (news.google.com is blocked there by network policy, hence the runner):
 *   1. Does Google News match on ARTICLE BODY, not just headline? If a
 *      brand query returns "Business Bay overtakes Palm Jumeirah" — a headline
 *      with no brand word in it — then Google read the body and the keyword
 *      itself is proof the brand is in the text. That would let ingest trust
 *      brand-query provenance even when its own body fetch fails.
 *   2. Is the US edition (gl=US, what lib/ingest.ts uses) costing us UAE trade
 *      press versus the AE edition?
 *
 * Every query is run against both editions and scored the same way, so the
 * output is a table you can act on rather than an opinion.
 *
 *   node scripts/probe-keyword-recall.mjs
 *
 * No token needed — Google News RSS is public. No app imports, no npm install.
 */

/** Distinct Aug–Sep 2026 placements from the PR sheet: the articles a good
 *  keyword set MUST return. Syndications of one story are grouped so a query
 *  that finds any copy scores the story once. */
const TRUTH = [
  { story: "Dubai overtakes London $10m+ bracket", when: "2026-08-03", needles: ["overtakes london", "296 vs 16"] },
  { story: "ORA Y Views villas at Bayn",           when: "2026-08-08", needles: ["y views", "ora unveils boutique", "ghantoot"] },
  { story: "July recovery: sales +2%, luxury +22%", when: "2026-08-13", needles: ["luxury transactions climb", "modest recovery in july", "sales rise 2%"] },
  { story: "Golden Visa threshold reshapes buying", when: "2026-09-03", needles: ["golden visa threshold"] },
  { story: "Dubai mortgage decouples from Fed",     when: "2026-09-02", needles: ["absorb fed rate", "driving dubai", "federal reserve"] },
  { story: "Binghatti multibillion-dollar pact",    when: "2026-09-02", needles: ["binghatti in talks"] },
  { story: "WSJ war ruining year for wealthy Gulf", when: "2026-09-03", needles: ["wealthy gulf", "bahrain grand prix"] },
  { story: "Business Bay overtakes Palm Jumeirah",  when: "2026-09-04", needles: ["business bay overtakes", "business bay: dubai"] },
  { story: "August deals down 37%, more selective", when: "2026-09-04", needles: ["down 37%", "selective strength in august"] },
  { story: "LEOS British demand data",              when: "2026-09-14", needles: ["leos developments"] },
  { story: "Sales rebound 38% from 3-year low",     when: "2026-09-16", needles: ["rebound 38%", "bounce back 38%", "rebound 38"] },
  { story: "Transactions grow bigger, budgets",     when: "2026-09-16", needles: ["stretch their budgets"] },
];

/** Current production list (lib/keywords.ts DEFAULT_QUERIES + tracked_keywords). */
const CURRENT = [
  "betterhomes dubai", "betterhomes dubai property market", "betterhomes real estate",
  "PRIME by betterhomes", "Richard Waind betterhomes", "CEO betterhomes",
  "property market updates", "webinar", "dubai real estate", "dubai property markets",
  "dubai mortgage", "dubai offplan", "dubai secondary market", "dubai communities",
];

/** Proposed additions — brand variants the matcher already accepts but we never
 *  search for, named spokespeople, and the topics the sheet's own stories sit on. */
const PROPOSED = [
  "betterhomes",
  "better homes dubai",
  "bhomes",
  "betterhomes data",
  "betterhomes analysis dubai",
  "Richard Waind",
  "Alex Leigh betterhomes",
  "dubai golden visa property",
  "dubai prime property",
  "dubai branded residences",
  "dubai land department data analysis",
  "dubai residential market report",
];

const EDITIONS = [
  { tag: "US", qs: "hl=en-US&gl=US&ceid=US:en" },   // what lib/ingest.ts uses today
  { tag: "AE", qs: "hl=en-AE&gl=AE&ceid=AE:en" },
];

const SLEEP_MS = Number(process.env.SLEEP_MS || 1200); // be polite to Google
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Same parser as lib/ingest.ts, so the probe sees exactly what the bot sees. */
function parseGoogleNews(xml) {
  const items = [];
  for (const block of xml.split("<item>").slice(1)) {
    const item = block.split("</item>")[0];
    const grab = (re) => item.match(re)?.[1]?.trim() ?? "";
    const rawTitle = decodeEntities(grab(/<title>([\s\S]*?)<\/title>/));
    if (!rawTitle) continue;
    const source = decodeEntities(grab(/<source[^>]*>([\s\S]*?)<\/source>/));
    const pub = grab(/<pubDate>([\s\S]*?)<\/pubDate>/);
    let date = null;
    if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10); }
    items.push({ title: rawTitle, source, date });
  }
  return items;
}

async function fetchKeyword(keyword, editionQs) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&${editionQs}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { error: `HTTP ${res.status}`, items: [] };
    return { items: parseGoogleNews(await res.text()) };
  } catch (e) {
    return { error: e?.message ?? String(e), items: [] };
  }
}

/** Which TRUTH stories does this result set contain? */
function storiesHit(items) {
  const hay = items.map((i) => i.title.toLowerCase());
  const hit = new Set();
  for (const t of TRUTH) {
    if (t.needles.some((n) => hay.some((h) => h.includes(n)))) hit.add(t.story);
  }
  return hit;
}

/** How much of what a query returns is old news? That is what eats the
 *  per-run budget: ingest processes 14 brand-new items in KEYWORD order, so a
 *  query whose top results are years old spends the budget on nothing. */
function freshness(items) {
  const cutoff = "2026-08-01";
  const dated = items.filter((i) => i.date);
  if (!dated.length) return { dated: 0, recent: 0, oldest: null };
  return {
    dated: dated.length,
    recent: dated.filter((i) => i.date >= cutoff).length,
    oldest: dated.reduce((a, b) => (a.date < b.date ? a : b)).date,
  };
}

console.log(`Keyword recall against the PR sheet (Aug–Sep 2026)`);
console.log(`  ${TRUTH.length} distinct stories to find`);
console.log(`  ${CURRENT.length} current keywords, ${PROPOSED.length} proposed`);
console.log(`  editions: ${EDITIONS.map((e) => e.tag).join(", ")}\n`);

const rows = [];

for (const [group, list] of [["CURRENT", CURRENT], ["PROPOSED", PROPOSED]]) {
  console.log(`\n═══ ${group} ═══\n`);
  for (const kw of list) {
    for (const ed of EDITIONS) {
      const { items, error } = await fetchKeyword(kw, ed.qs);
      await sleep(SLEEP_MS);
      if (error) {
        console.log(`  ERR  [${ed.tag}] "${kw}" — ${error}`);
        continue;
      }
      const hits = storiesHit(items);
      const f = freshness(items);
      rows.push({ group, kw, edition: ed.tag, n: items.length, hits: [...hits], recent: f.recent, oldest: f.oldest });
      const mark = hits.size ? `★${hits.size}` : "  ·";
      console.log(
        `  ${mark}  [${ed.tag}] "${kw}"  n=${String(items.length).padStart(3)}  ` +
        `since-Aug=${String(f.recent).padStart(3)}  oldest=${f.oldest ?? "—"}`,
      );
      if (hits.size) for (const h of hits) console.log(`         └─ ${h}`);
    }
  }
}

/**
 * No data, no verdict.
 *
 * Run from a cloud IP, Google answers every RSS request with 403, and this
 * probe used to go on to print "0/12 stories" and a confident conclusion about
 * body matching — a finding drawn from nothing. That is the exact failure this
 * whole investigation was about, reproduced inside the tool built to find it.
 * An empty result set means the measurement did not happen, so say that and
 * stop, with a non-zero exit so CI cannot read it as a pass.
 */
if (rows.length === 0) {
  console.log(`\n────────────────────────────────────`);
  console.log(`NO DATA — every request failed, so there is no verdict.`);
  console.log(`Google refuses News RSS to many cloud IP ranges. Run this from a`);
  console.log(`network Google will answer (the deployed app, or a residential line).`);
  process.exit(2);
}

console.log(`\n────────────────────────────────────`);
console.log(`RECALL BY EDITION`);
for (const ed of EDITIONS) {
  const found = new Set();
  rows.filter((r) => r.edition === ed.tag).forEach((r) => r.hits.forEach((h) => found.add(h)));
  console.log(`  ${ed.tag}: ${found.size}/${TRUTH.length} stories`);
}

console.log(`\nRECALL BY GROUP (both editions pooled)`);
for (const g of ["CURRENT", "PROPOSED"]) {
  const found = new Set();
  rows.filter((r) => r.group === g).forEach((r) => r.hits.forEach((h) => found.add(h)));
  console.log(`  ${g}: ${found.size}/${TRUTH.length} stories`);
}

const everFound = new Set();
rows.forEach((r) => r.hits.forEach((h) => everFound.add(h)));
const missed = TRUTH.filter((t) => !everFound.has(t.story));
console.log(`\nNEVER FOUND BY ANY QUERY (${missed.length}/${TRUTH.length})`);
for (const m of missed) console.log(`  ${m.when}  ${m.story}`);

console.log(`\nDEAD WEIGHT — queries that found nothing and return mostly old items`);
for (const r of rows.filter((r) => !r.hits.length && r.recent === 0 && r.n > 0)) {
  console.log(`  [${r.edition}] "${r.kw}"  n=${r.n}  oldest=${r.oldest}`);
}

console.log(`\nBODY-MATCH EVIDENCE — brand queries returning brand-free headlines`);
const brandQueries = rows.filter((r) => /betterhomes|better homes|bhomes|waind|alex leigh/i.test(r.kw));
const bodyProof = brandQueries.filter((r) =>
  r.hits.some((h) => !/betterhomes/i.test(h)) );
if (bodyProof.length) {
  console.log(`  Google matched the BODY, not the headline, for:`);
  for (const r of bodyProof) console.log(`    [${r.edition}] "${r.kw}" → ${r.hits.join("; ")}`);
  console.log(`  → ingest can treat "surfaced by a brand query" as brand evidence,`);
  console.log(`    which works even while its own body fetch is broken.`);
} else {
  console.log(`  None. Brand queries only matched brand-bearing headlines, so`);
  console.log(`  keyword provenance is NOT a substitute for reading the body.`);
}
