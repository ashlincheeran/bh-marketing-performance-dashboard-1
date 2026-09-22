// Score an off-the-shelf Apify news actor against the PR team's coverage sheet.
//
// WHY — we currently fetch Google News RSS, unwrap each link through Google's
// undocumented batchexecute RPC, then crawl the publisher page: three moving
// parts, the middle one an internal endpoint with no contract. Several store
// actors claim to do all three in one call. If one does, the fragile part stops
// being ours to maintain.
//
// This runs server-side rather than only on a CI runner because the deployed
// app already holds APIFY_TOKEN and has open network, so the comparison can be
// made from a preview deploy instead of waiting on a branch merge.
//
// SCHEMAS ARE READ, NOT GUESSED. An actor whose input schema declares no
// required fields drops unknown keys and SUCCEEDS with zero rows — that cost
// days on the LinkedIn actor. Each actor's declared fields are fetched first
// and the input built from them, and the reply says when nothing is required so
// an empty result is never mistaken for an empty internet.
import { mentionsBetterhomes } from "@/lib/match";

/** Candidates advertising real publisher URLs and/or full article text. */
export const ACTOR_CANDIDATES = [
  "dami_studio/google-news-scraper",
  "fetchsmith/google-news-scraper",
  "memo23/google-news-scraper",
  "tactful_anvil/google-news-scraper",
  "nexgendata/brand-mention-monitor",
];

/** Distinct Aug–Sep 2026 stories from the sheet, with their title fingerprints. */
const TRUTH: { story: string; needles: string[] }[] = [
  { story: "Business Bay overtakes Palm", needles: ["business bay overtakes", "business bay: dubai"] },
  { story: "August deals down 37%", needles: ["down 37%", "selective strength in august"] },
  { story: "Sales rebound 38%", needles: ["rebound 38", "bounce back 38"] },
  { story: "Transactions grow bigger", needles: ["stretch their budgets"] },
  { story: "LEOS British demand", needles: ["leos developments"] },
  { story: "Golden Visa threshold", needles: ["golden visa threshold"] },
  { story: "Mortgage decouples from Fed", needles: ["absorb fed rate", "federal reserve"] },
];

export interface ActorScore {
  actor: string;
  ok: boolean;
  error?: string;
  declaredFields?: string[];
  requiredFields?: string[];
  inputUsed?: Record<string, unknown>;
  rows?: number;
  realUrls?: number;      // urls that are the publisher's, not a Google wrapper
  withText?: number;      // bodies long enough to judge
  brandInBody?: number;   // …that OUR matcher passes — the whole point
  sheetStories?: string[];
  syndicatedKept?: number; // sheet counts placements; merging them loses data
  seconds?: number;
  sampleUrl?: string;
  sampleText?: string;
}

const api = (path: string, token: string) =>
  `https://api.apify.com/v2/${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

function pickField(props: Record<string, unknown>, wants: string[]): string | null {
  const keys = Object.keys(props);
  for (const w of wants) {
    const hit = keys.find((k) => k.toLowerCase() === w.toLowerCase());
    if (hit) return hit;
  }
  for (const w of wants) {
    const hit = keys.find((k) => k.toLowerCase().includes(w.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

const str = (o: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
};

export async function probeActor(actor: string, query: string, maxItems: number): Promise<ActorScore> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { actor, ok: false, error: "APIFY_TOKEN not set" };

  // 1) what does this actor actually accept?
  let props: Record<string, Record<string, unknown>> = {};
  let required: string[] = [];
  try {
    const res = await fetch(api(`acts/${actor.replace("/", "~")}/builds/default`, token), { cache: "no-store" });
    if (!res.ok) return { actor, ok: false, error: `schema HTTP ${res.status} — actor may be private or renamed` };
    const body = await res.json();
    const raw = body?.data?.inputSchema;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    props = parsed?.properties ?? {};
    required = parsed?.required ?? [];
  } catch (e) {
    return { actor, ok: false, error: `schema read failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 2) build input from the declared fields
  const input: Record<string, unknown> = {};
  const qField = pickField(props, ["query", "queries", "keyword", "keywords", "searchTerms", "search", "brand", "term"]);
  if (qField) input[qField] = props[qField]?.type === "array" ? [query] : query;
  const nField = pickField(props, ["maxItems", "maxResults", "maxArticles", "limit", "resultsLimit", "maxRecords"]);
  if (nField) input[nField] = maxItems;
  const tField = pickField(props, ["extractFullText", "fullText", "includeText", "scrapeFullText", "articleText", "includeContent"]);
  if (tField) input[tField] = true;
  const lField = pickField(props, ["language", "lang", "hl"]);
  if (lField) input[lField] = "en";
  const cField = pickField(props, ["country", "region", "gl", "sourceCountry"]);
  if (cField) input[cField] = "AE";

  const base: ActorScore = {
    actor,
    ok: false,
    declaredFields: Object.keys(props).slice(0, 20),
    requiredFields: required,
    inputUsed: input,
  };
  if (!qField) return { ...base, error: "no query-shaped field in schema — cannot drive this actor" };

  // 3) run it
  const started = Date.now();
  let rows: Record<string, unknown>[] = [];
  try {
    const res = await fetch(
      api(`acts/${actor.replace("/", "~")}/run-sync-get-dataset-items?timeout=90&memory=2048`, token),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), cache: "no-store" },
    );
    const text = await res.text();
    if (!res.ok) return { ...base, error: `run HTTP ${res.status} ${text.slice(0, 250)}` };
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return { ...base, error: `run failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 4) score
  const urls = rows.map((r) => str(r, ["url", "link", "articleUrl", "publisherUrl", "sourceUrl"]));
  const titles = rows.map((r) => str(r, ["title", "headline", "name"]));
  const bodies = rows.map((r) => str(r, ["text", "content", "articleText", "body", "fullText", "markdown"]));
  const outlets = rows.map((r) => str(r, ["source", "publisher", "domain", "sourceName", "outlet"]));

  const wrapped = urls.filter((u) => /news\.google\.com|\/rss\/articles\//i.test(u)).length;
  const withText = bodies.filter((b) => b.length > 400).length;
  const brandInBody = bodies.filter((b) => b.length > 400 && mentionsBetterhomes(b)).length;

  const hay = titles.map((t) => t.toLowerCase());
  const sheetStories = TRUTH.filter((t) => t.needles.some((n) => hay.some((h) => h.includes(n)))).map((t) => t.story);

  const byTitle = new Map<string, Set<string>>();
  titles.forEach((t, i) => {
    const k = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (!k) return;
    if (!byTitle.has(k)) byTitle.set(k, new Set());
    if (outlets[i]) byTitle.get(k)!.add(outlets[i]);
  });

  return {
    ...base,
    ok: true,
    rows: rows.length,
    realUrls: rows.length - wrapped,
    withText,
    brandInBody,
    sheetStories,
    syndicatedKept: [...byTitle.values()].filter((s) => s.size > 1).length,
    seconds: Math.round((Date.now() - started) / 1000),
    sampleUrl: urls.find(Boolean)?.slice(0, 160),
    sampleText: bodies.find((b) => b.length > 200)?.slice(0, 300),
  };
}
