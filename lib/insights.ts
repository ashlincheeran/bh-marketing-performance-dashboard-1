// Competitive, action-oriented insights: "here's what rivals are doing and what
// to do about it", not a summary of the dashboard.
//
// Two engines:
//   - Claude reads the actual competitor and betterhomes HEADLINES and writes
//     specific, topic-level recommendations ("Allsopp ran 4 stories on X, you
//     ran none: publish your own X piece"). generateSmartInsights() does it for
//     the last 75 days and refreshInsightsCache() stores the result, with the
//     headlines it read, so the page stays fast and can check every card
//     against its own evidence. insightsForRange() does it for the range the
//     PR team picked ("Receive Insights").
//   - buildCompetitiveInsights(...): the deterministic rule-based fallback used
//     when there is no usable cached set.
//
// Gemini wrote these until it ran out of credit (HTTP 402) in Oct 2026; the
// AI now is Claude, through the same key and model setting as the news bot.
import * as z from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MONTHS, isTier1, latestPublishedOn, type Insight } from "@/lib/pr";
import type { Mention } from "@/lib/types";
import { readAllRows, type SovItem, type CompetitorNewsItem } from "@/lib/data";
import { claudeClient, describeAiError, type AiFailure } from "@/lib/claude";
import { getAppSettings } from "@/lib/appSettings";
import { errorMessage } from "@/lib/coerce";
import { loadRegistry } from "@/lib/news/registry";
import type { Registry } from "@/lib/news/types";
import { INSIGHTS_SCOPE, type InsightEvidence } from "@/lib/insightsCache";

export { readInsightsCache } from "@/lib/insightsCache";

/** How far back the AI insights read headlines. */
export const INSIGHT_WINDOW_DAYS = 75;


// The one pointer card we always keep at the end: this panel is press only.
// It used to say social "lights up once the Apify social bot is connected (see
// the Social & Reviews tab)": there is no such tab, and Apify has been live
// since June.
export const SOCIAL_CARD: Insight = {
  kind: "test",
  label: "Social is on its own tabs",
  text: `This compares press coverage only. How betterhomes' Instagram, TikTok, Facebook and LinkedIn perform against rival agencies is on Socials Performance, and what people say about betterhomes online is on People Sentiment.`,
};

/** Cards retired from the copy above that may still sit in an older cached set. */
const RETIRED_LABELS = new Set(["Next: social & reviews"]);

/**
 * Companies the AI reaches for when it has nothing to compare against.
 *
 * With no competitor story in its input (none stored after 22 Jun 2026) Gemini
 * still wrote "Emulate Allsopp's Award Wins", and credited Engel & Völkers,
 * Emirates NBD, Bayut and Emaar with coverage it had never been shown. An
 * insight may name one of these, or a tracked competitor, only if its input
 * named it too.
 */
const MARKET_NAMES = [
  "allsopp", "engel", "volkers", "sotheby", "haus & haus", "haus and haus", "driven properties",
  "white & co", "white and co", "metropolitan premium", "bayut", "property finder", "propertyfinder",
  "dubizzle", "emaar", "damac", "nakheel", "sobha", "meraas", "aldar", "emirates nbd", "knight frank",
  "cbre", "jll", "savills", "cavendish maxwell", "espace", "fam properties", "provident", "luxhabitat",
  "exclusive links", "binghatti", "azizi", "omniyat", "ellington", "dubai holding", "valustrat",
  "property monitor",
];

// Lower-case, accents and possessives off, so "Völkers" and "Allsopp's" match.
function plain(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ");
}

/** "2026-06-22" → "22 Jun 2026". */
export function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""} ${day.slice(0, 4)}`;
}

// Whole words only: "white & co" must not match "white collar".
function says(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`).test(text);
}

// A tracked competitor's spellings, as lib/match.ts builds them.
function spellings(name: string): string[] {
  const n = plain(name).trim();
  return [...new Set([n, n.replace(/&/g, "and"), n.replace(/&/g, " ").replace(/\s+/g, " ").trim()])].filter(
    (s) => s.length >= 4,
  );
}

// With no competitor story in the input, any sentence about what competitors
// do is invented, named or not: "Competitors are publishing market data
// reports" came from an input holding none.
const RIVAL_TALK = /\b(competitors?|rivals?|other (agencies|brokerages))\b/;

/**
 * Drop every insight that names a company its input never mentioned, and,
 * when the input held no competitor story at all, every insight that talks
 * about competitors.
 *
 * `rivals` holds each tracked rival's names together (its label and its other
 * spellings), or a single name for a company with one. A company counts as
 * mentioned when the input has any of its names, so a card that writes
 * "Knight Frank UAE" is kept when the headlines say "Knight Frank".
 */
export function keepSupported<T extends { label: string; text: string }>(
  insights: T[],
  corpus: string,
  rivals: (string | string[])[],
  hasRivalStories = true,
): T[] {
  const given = plain(corpus);
  const companies = [
    ...MARKET_NAMES.map((n) => [n]),
    ...rivals.map((r) => [...new Set((Array.isArray(r) ? r : [r]).flatMap(spellings))]),
  ];
  return insights.filter((i) => {
    const said = plain(`${i.label} ${i.text}`);
    if (!hasRivalStories && RIVAL_TALK.test(said)) return false;
    return !companies.some((names) => names.some((n) => says(said, n)) && !names.some((n) => says(given, n)));
  });
}

/**
 * A cached AI set as it may be shown today: the retired card out, anything its
 * evidence can't support out (see keepSupported), the current pointer card on
 * the end. Empty when nothing usable is left, or when the set was saved
 * without its evidence, so the caller falls back to the rule-based set rather
 * than showing cards nobody can check.
 */
export function usableCachedInsights(
  insights: Insight[],
  evidence: InsightEvidence | null,
  rivals: string[][],
): Insight[] {
  if (!evidence) return [];
  const kept = keepSupported(
    insights.filter((i) => !RETIRED_LABELS.has(i.label) && i.label !== SOCIAL_CARD.label),
    evidence.text,
    rivals,
    evidence.hasRivalStories,
  );
  return kept.length ? [...kept, SOCIAL_CARD] : [];
}

// ── Asking Claude ─────────────────────────────────────────────────────────

/**
 * The answer asked for. kind is a plain string with its values in the
 * description, not an enum: this SDK moves an enum's values into the
 * description anyway, so the API does not enforce them, and one card with
 * "urgent" for its kind made the SDK's own parse throw away the whole paid
 * answer. kindOf maps it instead.
 */
const ANSWER = z.object({
  insights: z.array(
    z.object({
      kind: z.string().describe('One of "high", "medium" or "win"'),
      label: z.string(),
      text: z.string(),
    }),
  ),
});

/** A card's kind as the panel knows it; anything else reads as "medium", worth doing. */
export function kindOf(raw: string): "high" | "medium" | "win" {
  const k = raw.trim().toLowerCase();
  return k === "high" || k === "win" ? k : "medium";
}

/** What went wrong, in words the PR team can act on. */
function aiProblem(f: AiFailure): string {
  switch (f.kind) {
    case "no_key":
      return "No Claude key is set (ANTHROPIC_API_KEY), so no AI insights can be written.";
    case "credit":
      return "The AI is not answering: the Claude account is out of credit or has reached its spending limit.";
    case "auth":
      return "The Claude key was refused. Check ANTHROPIC_API_KEY in Vercel.";
    case "rate":
      return "The AI is busy right now. Try again in a minute.";
    case "server":
      return "The AI service had a problem. Try again in a few minutes.";
    case "network":
      return "The AI service could not be reached. Try again in a few minutes.";
    case "model":
      return "The AI model chosen in PR & Media settings is not available to this Claude key. Choose another model there.";
    case "refusal":
      return "The AI declined to answer this one.";
    default:
      return "The AI's answer could not be read. Try again.";
  }
}

/** Ask Claude for cards. Pure of the database; the caller checks them against the corpus. */
async function askClaude(system: string, user: string, max: number): Promise<{ insights: Insight[] } | { error: string }> {
  const client = claudeClient();
  if (!client) return { error: aiProblem({ kind: "no_key", message: "", stopRun: true }) };
  const model = (await getAppSettings()).news.model;
  try {
    const res = await client.messages.parse({
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: zodOutputFormat(ANSWER) },
    });
    if (res.stop_reason === "refusal") return { error: aiProblem({ kind: "refusal", message: "", stopRun: false }) };
    const parsed = res.parsed_output;
    if (res.stop_reason === "max_tokens" || !parsed) {
      return { error: aiProblem({ kind: "bad_answer", message: "", stopRun: false }) };
    }
    const insights = parsed.insights
      .map((i) => ({ kind: kindOf(i.kind), label: i.label.trim().slice(0, 60), text: i.text.trim().slice(0, 500) }))
      .filter((i) => i.label && i.text)
      .slice(0, max);
    return insights.length ? { insights } : { error: "The AI returned no insights. Try a wider date range." };
  } catch (e) {
    return { error: aiProblem(describeAiError(e)) };
  }
}

/** Every way each tracked rival is written, one list per rival, for checking what the AI may name. */
async function rivalNames(): Promise<string[][]> {
  return rivalNamesIn(await loadRegistry());
}

/** The same, from a registry already read. */
export function rivalNamesIn(reg: Registry): string[][] {
  return reg.companies.filter((c) => !c.isUs).map((c) => [c.label, ...c.names]);
}

const headlineKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The headlines the AI reads, grouped by rival, with the real number of
 * stories next to the sample shown. Counting the sample instead ("[Allsopp] 25
 * stories" when 31 were stored) let the AI quote counts that were not true.
 * Pure, so it can be tested.
 */
export function buildCorpus(
  rivals: { brand: string; title: string | null }[],
  ours: (string | null)[],
  opts: { perRival: number; ourMax: number; heading: string },
): { text: string; hasRivalStories: boolean; arabic: boolean } {
  const byBrand = new Map<string, { count: number; titles: string[]; seen: Set<string> }>();
  for (const r of rivals) {
    if (!r.title) continue;
    const g = byBrand.get(r.brand) ?? { count: 0, titles: [], seen: new Set<string>() };
    // The same headline stored twice is one story, here as on the page.
    const k = headlineKey(r.title);
    if (g.seen.has(k)) continue;
    g.seen.add(k);
    g.count += 1;
    if (g.titles.length < opts.perRival) g.titles.push(r.title);
    byBrand.set(r.brand, g);
  }
  const ourTitles = [...new Set(ours.filter((t): t is string => !!t))];
  const ourShown = ourTitles.slice(0, opts.ourMax);
  const hasRivalStories = byBrand.size > 0;
  const shown = (n: number, of: number) => (n < of ? `${of} stories, ${n} headlines shown` : `${of} stories`);
  let text = hasRivalStories ? `COMPETITORS' HEADLINES (${opts.heading}):\n` : "";
  for (const [brand, g] of [...byBrand.entries()].sort((a, b) => b[1].count - a[1].count)) {
    text += `\n[${brand}] ${shown(g.titles.length, g.count)}\n${g.titles.map((t) => `- ${t}`).join("\n")}\n`;
  }
  text +=
    `\nBETTERHOMES' HEADLINES (${opts.heading}): ${ourShown.length ? shown(ourShown.length, ourTitles.length) : "none"}\n` +
    (ourShown.length ? ourShown.map((t) => `- ${t}`).join("\n") : "- (none in this window)") +
    "\n";
  const arabic = [...byBrand.values()].some((g) => g.titles.some((t) => /[؀-ۿ]/.test(t))) || ourShown.some((t) => /[؀-ۿ]/.test(t));
  return { text, hasRivalStories, arabic };
}

const STRATEGIST =
  `You are a senior PR strategist for "betterhomes", a real-estate brokerage in DUBAI, UAE. ` +
  `You tell its PR team what to DO NEXT. Every insight is a concrete action ("publish…", "pitch…", "commission…"), ` +
  `specific to the topics, outlets and companies in the headlines you are given. Do not restate counts or describe a dashboard. ` +
  `Only use numbers that appear in the input. Write in British English, plainly, without em dashes.`;

function instructions(hasRivals: boolean, arabic: boolean, n: string): string {
  return (
    (hasRivals
      ? `Name only competitors that appear in the headlines below. Find: (1) topics a competitor is clearly winning that betterhomes is missing: name the competitor and the topic, and say what to publish; ` +
        `(2) angles, formats or languages competitors use that betterhomes doesn't (for example Arabic-language reports, rankings and awards, market-data reports, leadership features); ` +
        `(3) a strength betterhomes should double down on, if any. `
      : `No competitor coverage is stored for this period, so do NOT name, compare with or describe any other company, and make no claim about what competitors are doing. ` +
        `From betterhomes' own coverage find: (1) topics and formats that are working and worth repeating; (2) gaps: topics, outlet types, formats or languages it is missing; (3) a strength to double down on, if any. `) +
    (arabic
      ? `Some coverage is in Arabic: call out the Arabic-language opportunity if relevant. `
      : `This feed is English-language news; if betterhomes lacks Arabic-language PR for this bilingual market, flag it as a gap. `) +
    `Give ${n} insights. kind is "high" (an urgent gap or opportunity), "medium" (worth doing soon) or "win" (a strength to protect). ` +
    `label is a 3 to 6 word headline. text is 1 or 2 specific sentences naming the topic (and the competitor, if any) and the action.`
  );
}

/**
 * Claude's competitive insights for the last 75 days, with the evidence they
 * were written from. A failed read is an error, never an empty period: an
 * empty rival list would have the AI write "no competitor coverage" cards that
 * then sit in the cache as if they were true.
 */
async function generateSmartInsights(
  db: any,
): Promise<{ insights: Insight[]; evidence: InsightEvidence } | { error: string }> {
  if (!db) return { error: "The database is not configured." };
  const cutoff = new Date(Date.now() - INSIGHT_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  // Every row in the window, not the first 1,000: the counts in the prompt must be true.
  const read = (source: string, fields: string) =>
    readAllRows<Record<string, any>>((from, to) =>
      db
        .from("mentions")
        .select(fields)
        .eq("source", source)
        .neq("status", "rejected")
        .gte("published_on", cutoff)
        .order("published_on", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
  const [comp, ours] = await Promise.all([read("competitor_news", "id,title,metadata"), read("googlenews", "id,title")]);
  if (comp.error || ours.error) return { error: `Couldn't read recent coverage: ${comp.error ?? ours.error}` };
  const rivals = comp.rows.map((r) => ({
    brand: (r.metadata as { competitor?: string } | null)?.competitor ?? "Competitor",
    title: (r.title as string | null) ?? null,
  }));
  const ourTitles = ours.rows.map((r) => (r.title as string | null) ?? null);
  if (!rivals.length && !ourTitles.some(Boolean)) return { error: "No recent news to analyse yet." };

  const corpus = buildCorpus(rivals, ourTitles, { perRival: 25, ourMax: 40, heading: `last ${INSIGHT_WINDOW_DAYS} days` });
  const answer = await askClaude(
    STRATEGIST,
    `${instructions(corpus.hasRivalStories, corpus.arabic, "4 to 6")}\n\n${corpus.text}`,
    6,
  );
  if ("error" in answer) return answer;
  let names: string[][];
  try {
    names = await rivalNames();
  } catch (e) {
    return { error: `Couldn't read the rival list to check the insights: ${errorMessage(e)}` };
  }
  const kept = keepSupported(answer.insights, corpus.text, names, corpus.hasRivalStories);
  if (!kept.length) return { error: "Every suggestion named a company the headlines don't include, so none were kept." };
  return { insights: [...kept, SOCIAL_CARD], evidence: { text: corpus.text, hasRivalStories: corpus.hasRivalStories } };
}

/** Write fresh insights and store them, with their evidence, in insights_cache. */
export async function refreshInsightsCache(
  db: any,
): Promise<{ ok: boolean; source: "ai" | "none"; error?: string }> {
  const r = await generateSmartInsights(db);
  if ("error" in r) return { ok: false, source: "none", error: r.error };
  const { error } = await db.from("insights_cache").upsert(
    { scope: INSIGHTS_SCOPE, payload: { insights: r.insights, evidence: r.evidence }, source: "ai", generated_at: new Date().toISOString() },
    { onConflict: "scope" },
  );
  if (error) return { ok: false, source: "none", error: `The insights were written but could not be saved: ${error.message}` };
  return { ok: true, source: "ai" };
}

/**
 * "Receive Insights": Claude's strategy for the range the PR team picked,
 * from the same rows the page counts (every brand line, one per placement),
 * so the figures in the prompt match the tiles above it.
 */
export async function insightsForRange(
  from: string,
  to: string,
  data: {
    mentions: Pick<Mention, "date" | "title" | "tier" | "sentiment">[];
    competitorNews: Pick<CompetitorNewsItem, "brand" | "title" | "published_on">[];
  },
): Promise<{ ok: true; insights: Insight[]; from: string; to: string } | { ok: false; error: string }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(to) || from > to) {
    return { ok: false, error: "Pick a valid date range first." };
  }
  const month = (d: string | null) => (d ? d.slice(0, 7) : "");
  const inRange = (d: string | null) => !!d && month(d) >= from && month(d) <= to;
  const ours = data.mentions.filter((m) => inRange(m.date));
  const rivals = data.competitorNews.filter((c) => inRange(c.published_on));
  if (!ours.length && !rivals.length) return { ok: false, error: "There is no coverage in this range to analyse." };

  const total = ours.length;
  const t1 = ours.filter((m) => isTier1(m.tier)).length;
  const scored = ours.filter((m) => m.sentiment);
  const pos = scored.filter((m) => m.sentiment === "positive").length;
  const stats =
    `PERIOD: ${from} to ${to}\n` +
    `BETTERHOMES: ${total} mentions, ${t1} Tier-1 (${total ? Math.round((t1 / total) * 100) : 0}%), ` +
    `${scored.length ? `${Math.round((pos / scored.length) * 100)}% positive of ${scored.length} scored` : "no tone scored yet"}\n\n`;
  const corpus = buildCorpus(
    rivals.map((c) => ({ brand: c.brand, title: c.title })),
    ours.map((m) => m.title),
    { perRival: 30, ourMax: 60, heading: `${from} to ${to}` },
  );
  const answer = await askClaude(
    STRATEGIST,
    `The PR manager picked the period ${from} to ${to} and asked for insights. Give forward-looking strategy for what to do next, not a summary of the period. ` +
      `Never start with "In the period" or "betterhomes had X mentions": go straight to the action.\n` +
      `${instructions(corpus.hasRivalStories, corpus.arabic, "5 or 6")}\n\n${stats}${corpus.text}`,
    6,
  );
  if ("error" in answer) return { ok: false, error: answer.error };
  let names: string[][];
  try {
    names = await rivalNames();
  } catch (e) {
    return { ok: false, error: `Couldn't read the rival list to check the insights: ${errorMessage(e)}` };
  }
  const insights = keepSupported(answer.insights, stats + corpus.text, names, corpus.hasRivalStories);
  if (!insights.length) {
    return { ok: false, error: "Every suggestion named a company this range's coverage doesn't include, so none are shown. Try again." };
  }
  return { ok: true, insights, from, to };
}

// ── The rule-based fallback ───────────────────────────────────────────────

const THEME_RULES: [RegExp, string][] = [
  [/rent|tenant|lease|leasing/, "rental market"],
  [/report|market|transaction|sales|q[1-4]|billion|index/, "market reports"],
  [/ceo|appoint|hire|director|leadership|joins|promot/, "leadership moves"],
  [/off-plan|off plan|offplan|launch|project|tower|residence/, "new launches"],
  [/luxury|penthouse|villa|mansion|prime|high-end/, "luxury / prime"],
  [/ramadan|forecast|outlook|20\d\d/, "market outlook"],
  [/millionaire|wealth|hnwi|investor|migration/, "wealth & investors"],
  [/award|ranked|top \d|best/, "awards & rankings"],
];

function themesOf(title: string): string[] {
  const t = (title || "").toLowerCase();
  const out: string[] = [];
  for (const [re, label] of THEME_RULES) if (re.test(t)) out.push(label);
  return out;
}

function within30d(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  if (isNaN(d)) return false;
  return Date.now() - d <= 30 * 24 * 60 * 60 * 1000;
}

function topTheme(titles: string[]): { theme: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const t of titles) for (const th of themesOf(t)) counts.set(th, (counts.get(th) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length ? { theme: sorted[0][0], count: sorted[0][1] } : null;
}

export function buildCompetitiveInsights({
  mentions,
  sov,
  sovThrough = null,
  competitorNews,
  competitorError = null,
}: {
  mentions: Mention[];
  sov: SovItem[];
  /** Last day getSov() counted, when competitor coverage ends before today. */
  sovThrough?: string | null;
  competitorNews: CompetitorNewsItem[];
  /** Set when the competitor read failed, so no card claims nothing is stored. */
  competitorError?: string | null;
}): Insight[] {
  const out: Insight[] = [];
  // getSov() counts the year to date, not 30 days as this copy used to claim.
  const period = sovThrough ? `this year to ${dayLabel(sovThrough)}` : "this year";
  const rivalsRanked = sov.filter((s) => !s.isUs);
  // getSov() lists only brands with a story, so no row for us is a real 0.
  const us = sov.find((s) => s.isUs) ?? (rivalsRanked.length ? { brand: "betterhomes", mentions: 0, share: 0, isUs: true } : null);
  const topRival = rivalsRanked[0] ?? null;

  // 1) Share-of-Voice standing + the move
  if (competitorError) {
    out.push({
      kind: "test",
      label: "Share of Voice didn't load",
      text: `The coverage behind Share of Voice could not be read just now (${competitorError}), so Share of Voice and the rival angles are not shown. Reload the page to try again.`,
    });
  } else if (us && (topRival || us.mentions > 0)) {
    if (!topRival || us.mentions > topRival.mentions) {
      out.push({
        kind: "win",
        label: "You lead Share of Voice",
        text: `betterhomes leads news Share of Voice with ${us.mentions} mentions (${us.share}%) ${period}${
          topRival ? `, ahead of ${topRival.brand} (${topRival.mentions})` : ""
        }. Protect it: keep a steady monthly market-data release and pitch Tier-1 outlets first.`,
      });
    } else if (us.mentions === topRival.mentions) {
      out.push({
        kind: "medium",
        label: "Level at the top",
        text: `betterhomes and ${topRival.brand} are level on news Share of Voice ${period}, ${us.mentions} mentions each. One more data-led release a month would put you clear.`,
      });
    } else {
      const gap = topRival.mentions - us.mentions;
      out.push({
        kind: "high",
        label: "Close the SoV gap",
        text: `${topRival.brand} is out-publishing you: ${topRival.mentions} news mentions against your ${us.mentions} ${period} (${gap} ahead). Match it by lifting release cadence and attacking the theme below.`,
      });
    }
  } else if (!sov.length) {
    out.push({
      kind: "test",
      label: "No Share of Voice yet",
      text: `No competitor coverage is stored for this year, so there is nothing to rank your news volume against. This card returns once the news bot logs rival coverage again.`,
    });
  }

  // 2) The angle competitors are winning that we under-index on
  if (!competitorError) {
    const compRecent = competitorNews.filter((c) => within30d(c.published_on));
    const compTheme = topTheme(compRecent.map((c) => c.title ?? ""));
    if (compTheme) {
      const ourThemeCount = mentions.filter(
        (m) => within30d(m.date) && themesOf(m.title ?? "").includes(compTheme.theme),
      ).length;
      out.push({
        kind: ourThemeCount < compTheme.count ? "high" : "medium",
        label: "Angle rivals are winning",
        text: `Competitors ran ${compTheme.count} "${compTheme.theme}" stories in the last 30 days; you ran ${ourThemeCount}. Commission a betterhomes "${compTheme.theme}" angle with your own numbers and a spokesperson quote, and pitch it.`,
      });
    } else {
      const latest = latestPublishedOn(competitorNews);
      out.push({
        kind: "test",
        label: "No recent rival coverage",
        text: `No competitor story is stored for the last 30 days${
          latest ? ` (the latest is from ${dayLabel(latest)})` : ""
        }, so there is no rival angle to compare against. This card names the angles rivals are winning once their coverage is logged again.`,
      });
    }
  }

  // 3) Repeat the highest-reach play: do more of what already works
  const best = mentions
    .filter((m) => within30d(m.date) && m.reachEff > 0)
    .slice()
    .sort((a, b) => b.reachEff - a.reachEff)[0];
  if (best && best.outlet) {
    const theme = themesOf(best.title ?? "")[0];
    out.push({
      kind: "win",
      label: "Double down for reach",
      text: `Your highest-reach hit in the last 30 days was ${best.outlet}${
        theme ? ` on "${theme}"` : ""
      }. Go back to them first with your next story${
        theme ? ` in that theme` : ""
      }: repeating a proven outlet and angle is the fastest path to more reach.`,
    });
  }

  // 4) Tier-1 quality push (reach per story is highest here)
  const recent = mentions.filter((m) => within30d(m.date));
  if (recent.length > 0) {
    const t1 = recent.filter((m) => isTier1(m.tier)).length;
    const share = Math.round((t1 / recent.length) * 100);
    out.push({
      kind: share < 30 ? "high" : "win",
      label: "Tier-1 quality",
      text: `${t1} of your last-30-day clips (${share}%) are Tier-1. ${
        share < 30
          ? "Lift it by taking macro market data to Reuters, Bloomberg or Arabian Business: Tier-1 carries the most reach per story."
          : "Strong premium mix: keep feeding Tier-1 your exclusive data."
      }`,
    });
  }

  // 5) Whole-funnel reminder: the rest of the battle is on social
  out.push(SOCIAL_CARD);

  return out;
}
