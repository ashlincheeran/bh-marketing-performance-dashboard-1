#!/usr/bin/env node
/**
 * Are the off-the-shelf Apify news actors better than what we built?
 *
 * WHAT WE DO TODAY — fetch Google News RSS ourselves, unwrap each link through
 * Google's undocumented batchexecute RPC, then crawl the publisher page with
 * website-content-crawler. Three moving parts, and the middle one is an
 * internal endpoint with no contract that already broke once.
 *
 * Several store actors claim to do all three in a single call and hand back the
 * real publisher URL plus the full article text, for roughly $3–9 per thousand
 * articles. If that holds, the fragile part stops being ours to maintain.
 *
 * WHAT COUNTS AS BETTER — not the marketing copy. Scored on:
 *   1. real URLs      — is `url` the publisher's, or another news.google.com wrapper?
 *   2. full text      — is there a body, and is it long enough to judge?
 *   3. OUR check      — does mentionsBetterhomes() pass on that body? This is the
 *                       one that matters: the brand sits in the body, never the
 *                       headline, and reading the body is the entire fix.
 *   4. recall         — how many of the PR sheet's known Aug–Sep stories come back
 *   5. syndication    — does it keep the four copies of one story, or merge them?
 *                       The sheet counts placements, so merging LOSES data.
 *
 * SCHEMAS ARE READ, NOT GUESSED. An Apify actor whose input schema declares no
 * required fields silently drops unknown keys and SUCCEEDS with zero rows —
 * that cost days on the LinkedIn actor. So each actor's schema is fetched first
 * and the input built from the fields it actually declares.
 *
 *   APIFY_TOKEN=... node scripts/probe-news-actors.mjs
 *
 * Runs on a GitHub runner; api.apify.com is blocked by network policy in the
 * dev sandbox. Costs a few pounds at most — maxItems is held low deliberately.
 */

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error("APIFY_TOKEN is not set. Add it as a repository secret.");
  process.exit(1);
}

const QUERY = process.env.PROBE_QUERY || "betterhomes dubai";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 15);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 240_000);

/** Candidates that advertise real publisher URLs and/or full article text. */
const CANDIDATES = [
  "dami_studio/google-news-scraper",
  "fetchsmith/google-news-scraper",
  "memo23/google-news-scraper",
  "tactful_anvil/google-news-scraper",
  "nexgendata/brand-mention-monitor",
];

/** Distinct Aug–Sep 2026 stories from the PR sheet. */
const TRUTH = [
  { story: "Business Bay overtakes Palm", needles: ["business bay overtakes", "business bay: dubai"] },
  { story: "August deals down 37%",       needles: ["down 37%", "selective strength in august"] },
  { story: "Sales rebound 38%",           needles: ["rebound 38", "bounce back 38"] },
  { story: "Transactions grow bigger",    needles: ["stretch their budgets"] },
  { story: "LEOS British demand",         needles: ["leos developments"] },
  { story: "Golden Visa threshold",       needles: ["golden visa threshold"] },
  { story: "Mortgage decouples from Fed", needles: ["absorb fed rate", "federal reserve"] },
];

/** lib/match.ts, copied so the probe tests the rule we actually ship. */
function mentionsBetterhomes(text) {
  let t = (text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/['’]/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/better ?homes (?:&|and) gardens/g, " ");
  return /\bbetter ?homes\b/.test(t) || /\bbhomes\b/.test(t);
}

const api = (path) =>
  `https://api.apify.com/v2/${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;

/** The actor's declared input fields — the only reliable guide to its keys. */
async function inputSchema(actor) {
  const res = await fetch(api(`acts/${actor.replace("/", "~")}/builds/default`));
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const body = await res.json();
  const schema = body?.data?.inputSchema;
  const parsed = typeof schema === "string" ? JSON.parse(schema) : schema;
  return { properties: parsed?.properties ?? {}, required: parsed?.required ?? [] };
}

/** Pick the field this actor uses for a concept, from what it declares. */
function pickField(properties, candidates) {
  const keys = Object.keys(properties);
  for (const want of candidates) {
    const hit = keys.find((k) => k.toLowerCase() === want.toLowerCase());
    if (hit) return hit;
  }
  for (const want of candidates) {
    const hit = keys.find((k) => k.toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

function buildInput(properties) {
  const input = {};
  const notes = [];

  const qField = pickField(properties, ["query", "queries", "keyword", "keywords", "searchTerms", "search", "brand", "term"]);
  if (qField) {
    input[qField] = properties[qField]?.type === "array" ? [QUERY] : QUERY;
    notes.push(`query→${qField}`);
  }

  const nField = pickField(properties, ["maxItems", "maxResults", "maxArticles", "limit", "resultsLimit", "maxRecords"]);
  if (nField) { input[nField] = MAX_ITEMS; notes.push(`max→${nField}`); }

  const tField = pickField(properties, ["extractFullText", "fullText", "includeText", "scrapeFullText", "articleText", "includeContent"]);
  if (tField) { input[tField] = true; notes.push(`fullText→${tField}`); }

  const lField = pickField(properties, ["language", "lang", "hl"]);
  if (lField) input[lField] = "en";
  const cField = pickField(properties, ["country", "region", "gl", "sourceCountry"]);
  if (cField) input[cField] = "AE";

  return { input, notes };
}

async function runActor(actor, input) {
  const secs = Math.round(RUN_TIMEOUT_MS / 1000);
  const url = api(`acts/${actor.replace("/", "~")}/run-sync-get-dataset-items?timeout=${secs}&memory=2048`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    const items = JSON.parse(text);
    return Array.isArray(items) ? items : [];
  } finally {
    clearTimeout(t);
  }
}

const str = (o, keys) => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
};

function score(rows) {
  const urls = rows.map((r) => str(r, ["url", "link", "articleUrl", "publisherUrl", "sourceUrl"]));
  const titles = rows.map((r) => str(r, ["title", "headline", "name"]));
  const bodies = rows.map((r) => str(r, ["text", "content", "articleText", "body", "fullText", "markdown"]));
  const outlets = rows.map((r) => str(r, ["source", "publisher", "domain", "sourceName", "outlet"]));

  const wrapped = urls.filter((u) => /news\.google\.com|\/rss\/articles\//i.test(u)).length;
  const withText = bodies.filter((b) => b.length > 400).length;
  const brandInBody = bodies.filter((b) => b.length > 400 && mentionsBetterhomes(b)).length;

  const hay = titles.map((t) => t.toLowerCase());
  const hits = TRUTH.filter((t) => t.needles.some((n) => hay.some((h) => h.includes(n)))).map((t) => t.story);

  // Same headline from several outlets = placements kept, not merged.
  const byTitle = new Map();
  titles.forEach((t, i) => {
    const k = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (!k) return;
    if (!byTitle.has(k)) byTitle.set(k, new Set());
    if (outlets[i]) byTitle.get(k).add(outlets[i]);
  });
  const syndicated = [...byTitle.values()].filter((s) => s.size > 1).length;

  return { n: rows.length, wrapped, withText, brandInBody, hits, syndicated, urls, bodies };
}

console.log(`Apify news actor probe`);
console.log(`  query "${QUERY}" · maxItems ${MAX_ITEMS} · ${CANDIDATES.length} actors\n`);

const results = [];

// Serial: Apify caps memory across simultaneous runs and answers 402 past it.
for (const actor of CANDIDATES) {
  console.log(`═══ ${actor} ═══`);
  const schema = await inputSchema(actor);
  if (schema.error) {
    console.log(`  SCHEMA FAIL  ${schema.error} — actor may be private or renamed\n`);
    results.push({ actor, verdict: "no schema" });
    continue;
  }
  const { input, notes } = buildInput(schema.properties);
  console.log(`  fields: ${Object.keys(schema.properties).slice(0, 14).join(", ")}`);
  console.log(`  required: ${schema.required.length ? schema.required.join(", ") : "(none declared — wrong keys fail SILENTLY)"}`);
  console.log(`  input: ${JSON.stringify(input)}  [${notes.join(" ")}]`);

  const started = Date.now();
  try {
    const rows = await runActor(actor, input);
    const s = score(rows);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  rows=${s.n}  realUrls=${s.n - s.wrapped}/${s.n}  withText=${s.withText}  brandInBody=${s.brandInBody}  ${secs}s`);
    console.log(`  sheet stories returned: ${s.hits.length ? s.hits.join("; ") : "none"}`);
    console.log(`  syndicated groups kept: ${s.syndicated}`);
    if (s.urls[0]) console.log(`  sample url : ${s.urls[0].slice(0, 110)}`);
    if (s.bodies[0]) console.log(`  sample text: ${JSON.stringify(s.bodies[0].slice(0, 160))}`);
    results.push({ actor, ...s, secs });
  } catch (e) {
    console.log(`  RUN FAIL  ${(e?.message ?? String(e)).replace(/\n+/g, " ").slice(0, 400)}`);
    results.push({ actor, verdict: "run failed" });
  }
  console.log("");
}

console.log(`────────────────────────────────────`);
console.log(`actor                                rows  realUrl  text  brand  sheet  synd`);
for (const r of results) {
  if (r.verdict) { console.log(`${r.actor.padEnd(36)} ${r.verdict}`); continue; }
  console.log(
    `${r.actor.padEnd(36)} ${String(r.n).padStart(4)}  ` +
    `${String(r.n - r.wrapped).padStart(7)}  ${String(r.withText).padStart(4)}  ` +
    `${String(r.brandInBody).padStart(5)}  ${String(r.hits.length).padStart(5)}  ${String(r.syndicated).padStart(4)}`,
  );
}

const usable = results.filter((r) => !r.verdict && r.wrapped === 0 && r.brandInBody > 0);
console.log(`\nVERDICT`);
if (usable.length) {
  usable.sort((a, b) => b.hits.length - a.hits.length || b.brandInBody - a.brandInBody);
  const w = usable[0];
  console.log(`  ${w.actor} returns real URLs and bodies our own brand check passes on.`);
  console.log(`  It found ${w.hits.length}/${TRUTH.length} of the sheet's stories and kept ${w.syndicated} syndicated groups.`);
  console.log(`  → worth switching: it replaces the RSS fetch, the batchexecute decoder AND the`);
  console.log(`    per-article crawl, so the part that breaks stops being ours to maintain.`);
} else {
  console.log(`  None cleared the bar (real URLs AND a body our brand check passes).`);
  console.log(`  → keep the current pipeline. The per-actor lines above say why each failed;`);
  console.log(`    a schema with no required fields means wrong keys were dropped silently.`);
}
