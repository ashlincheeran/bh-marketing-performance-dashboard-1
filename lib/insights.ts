// Competitive, action-oriented insights — "here's what rivals are doing and what
// to do about it", not a summary of the dashboard.
//
// Two engines:
//   - generateSmartInsights(db): Gemini reads the actual competitor vs betterhomes
//     HEADLINES and writes specific, topic-level recommendations ("Allsopp ran 4
//     stories on X, you ran none — publish your own X piece"). This is the primary
//     engine; results are cached in insights_cache so the page stays fast.
//   - buildCompetitiveInsights(...): deterministic rule-based fallback used when
//     there's no Gemini key or no cache yet.
import type { Insight } from "@/lib/pr";
import type { Mention } from "@/lib/types";
import type { SovItem, CompetitorNewsItem } from "@/lib/data";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// The one forward-looking roadmap nudge we always keep at the end.
const SOCIAL_CARD: Insight = {
  kind: "test",
  label: "Next: social & reviews",
  text: `This compares PR only. Instagram, LinkedIn, Facebook, Reddit and Trustpilot Share of Voice vs competitors light up once the Apify social bot is connected (see the Social & Reviews tab) — that completes the "who's winning where" picture.`,
};

const ALLOWED_KINDS = new Set(["win", "high", "medium", "test"]);

function parseInsightJson(text: string): Insight[] | null {
  // Strip code fences and grab the first [...] block.
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const out: Insight[] = [];
    for (const it of arr) {
      const label = String(it?.label ?? "").trim();
      const body = String(it?.text ?? "").trim();
      if (!label || !body) continue;
      const kind = ALLOWED_KINDS.has(it?.kind) ? it.kind : "medium";
      out.push({ kind, label: label.slice(0, 60), text: body.slice(0, 400) });
    }
    return out.length ? out.slice(0, 6) : null;
  } catch {
    return null;
  }
}

/**
 * Gemini-powered competitive insights. Reads recent competitor + betterhomes
 * headlines and returns specific, topic-level content recommendations.
 * Returns null (caller falls back) if no key, no data, or an error.
 */
export async function generateSmartInsights(db: any): Promise<Insight[] | null> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || !db) return null;

  const cutoff = new Date(Date.now() - 75 * 864e5).toISOString().slice(0, 10);
  const [{ data: comp }, { data: ours }] = await Promise.all([
    db
      .from("mentions")
      .select("title,published_on,outlet_name,metadata")
      .eq("source", "competitor_news")
      .neq("status", "rejected")
      .gte("published_on", cutoff)
      .order("published_on", { ascending: false })
      .limit(400),
    db
      .from("mentions")
      .select("title,published_on,outlet_name")
      .eq("source", "googlenews")
      .eq("brand", "betterhomes")
      .neq("status", "rejected")
      .gte("published_on", cutoff)
      .order("published_on", { ascending: false })
      .limit(200),
  ]);

  const compRows = (comp ?? []) as { title: string; metadata: { competitor?: string } | null }[];
  const ourRows = (ours ?? []) as { title: string }[];
  if (compRows.length === 0 && ourRows.length === 0) return null;

  // group competitor titles by brand (cap per brand to keep the prompt compact)
  const byBrand = new Map<string, string[]>();
  for (const r of compRows) {
    const b = r.metadata?.competitor ?? "Competitor";
    const arr = byBrand.get(b) ?? [];
    if (arr.length < 25 && r.title) arr.push(r.title);
    byBrand.set(b, arr);
  }
  const ourTitles = ourRows.map((r) => r.title).filter(Boolean).slice(0, 40);
  const arabic = [...compRows, ...ourRows].some((r) => /[؀-ۿ]/.test(r.title || ""));

  let corpus = "COMPETITORS' RECENT HEADLINES (last ~75 days):\n";
  for (const [brand, titles] of byBrand) {
    corpus += `\n[${brand}] — ${titles.length} stories\n${titles.map((t) => `- ${t}`).join("\n")}\n`;
  }
  corpus +=
    `\nBETTERHOMES' RECENT HEADLINES — ${ourTitles.length} stories\n` +
    (ourTitles.length ? ourTitles.map((t) => `- ${t}`).join("\n") : "- (none in this window)") +
    "\n";

  const prompt =
    `You are a senior PR strategist for "betterhomes", a real-estate brokerage in DUBAI, UAE. ` +
    `Below are recent news headlines for betterhomes and its Dubai competitors. ` +
    `Tell the betterhomes PR team what to DO NEXT. Be specific and reference the REAL competitors and REAL topics in the data below. ` +
    `Find: (1) topics a competitor is clearly winning that betterhomes is missing — name the competitor and the topic, and tell them what to publish; ` +
    `(2) angles/formats/languages competitors use that betterhomes doesn't (for example Arabic-language reports, ranking/awards stories, market-data reports, leadership features); ` +
    `(3) a strength betterhomes should double down on, if any. ` +
    `Do NOT just restate counts or describe the dashboard. Every insight must be a concrete action ("publish…", "pitch…", "commission…"). ` +
    (arabic
      ? `Some competitor coverage appears to be in Arabic — call out the Arabic-language opportunity if relevant. `
      : `Note: this feed is English-language news; if betterhomes lacks Arabic-language PR for this bilingual market, flag it as a gap. `) +
    `\n\n${corpus}\n\n` +
    `Return ONLY a JSON array of 4-6 objects, each: {"kind": "...", "label": "...", "text": "..."}. ` +
    `kind is one of: "high" (urgent gap/opportunity), "medium" (worth doing), "win" (a strength to protect). ` +
    `label = a 3-6 word headline. text = 1-2 specific sentences naming the competitor/topic and the action. ` +
    `Example: {"kind":"high","label":"Match Allsopp on rankings","text":"Allsopp & Allsopp ran 4 'ranked #1' stories this period; betterhomes ran none. Publish a betterhomes performance-ranking release with your own sales data and pitch Arabian Business."}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1200 },
        }),
        cache: "no-store",
      },
    );
    const data = await res.json();
    const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    const parsed = parseInsightJson(text);
    if (!parsed) return null;
    return [...parsed, SOCIAL_CARD];
  } catch {
    return null;
  }
}

/** Generate smart insights and store them in insights_cache. Returns what it stored. */
export async function refreshInsightsCache(db: any): Promise<{ ok: boolean; source: "ai" | "none" }> {
  const ai = await generateSmartInsights(db);
  if (!ai) return { ok: false, source: "none" };
  await db.from("insights_cache").upsert(
    { scope: "pr", payload: ai, source: "ai", generated_at: new Date().toISOString() },
    { onConflict: "scope" },
  );
  return { ok: true, source: "ai" };
}

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
  competitorNews,
}: {
  mentions: Mention[];
  sov: SovItem[];
  competitorNews: CompetitorNewsItem[];
}): Insight[] {
  const out: Insight[] = [];
  const us = sov.find((s) => s.isUs) ?? null;
  const leader = sov.length ? sov[0] : null; // getSov() sorts desc by mentions

  // 1) Share-of-Voice standing + the move
  if (us && leader) {
    if (leader.isUs) {
      const second = sov.find((s) => !s.isUs);
      out.push({
        kind: "win",
        label: "You lead Share of Voice",
        text: `betterhomes leads news Share of Voice — ${us.mentions} mentions (${us.share}%) in the last 30 days${
          second ? `, ahead of ${second.brand} (${second.mentions})` : ""
        }. Protect it: keep a steady monthly market-data release and pitch Tier-1 outlets first.`,
      });
    } else {
      const gap = leader.mentions - us.mentions;
      out.push({
        kind: "high",
        label: "Close the SoV gap",
        text: `${leader.brand} is out-publishing you — ${leader.mentions} news mentions vs your ${us.mentions} in 30 days (${gap} ahead). They're winning on volume; match it by lifting release cadence and attacking the theme below.`,
      });
    }
  } else if (!sov.length) {
    out.push({
      kind: "test",
      label: "Share of Voice pending",
      text: `No Share-of-Voice snapshot yet — it lands on the next daily bot run, then this panel ranks your news volume against every tracked competitor.`,
    });
  }

  // 2) The angle competitors are winning that we under-index on
  const compRecent = competitorNews.filter((c) => within30d(c.published_on));
  const compTheme = topTheme(compRecent.map((c) => c.title ?? ""));
  if (compTheme) {
    const ourThemeCount = mentions.filter(
      (m) => within30d(m.date) && themesOf(m.title ?? "").includes(compTheme.theme),
    ).length;
    out.push({
      kind: ourThemeCount < compTheme.count ? "high" : "medium",
      label: "Angle rivals are winning",
      text: `Competitors ran ${compTheme.count} "${compTheme.theme}" stories in the last 30 days; you ran ${ourThemeCount}. Commission a betterhomes "${compTheme.theme}" angle — your own numbers plus a spokesperson quote — and pitch it. That's reach they're earning and you're not.`,
    });
  } else {
    out.push({
      kind: "test",
      label: "Competitor feed filling",
      text: `The competitor coverage feed is still populating (first daily runs). Once it has data, this card names the exact angles rivals are winning so you can counter-program.`,
    });
  }

  // 3) Repeat the highest-reach play — do more of what already works
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
      } — repeating a proven outlet + angle is the fastest path to more reach.`,
    });
  }

  // 4) Tier-1 quality push (reach per story is highest here)
  const recent = mentions.filter((m) => within30d(m.date));
  if (recent.length > 0) {
    const t1 = recent.filter((m) => m.tier === "T1-Global" || m.tier === "T1-Local").length;
    const share = Math.round((t1 / recent.length) * 100);
    out.push({
      kind: share < 30 ? "high" : "win",
      label: "Tier-1 quality",
      text: `${t1} of your last-30-day clips (${share}%) are Tier-1. ${
        share < 30
          ? "Lift it by taking macro market data to Reuters / Bloomberg / Arabian Business — Tier-1 carries the most reach per story."
          : "Strong premium mix — keep feeding Tier-1 your exclusive data."
      }`,
    });
  }

  // 5) Whole-funnel reminder — the rest of the battle is on social
  out.push({
    kind: "test",
    label: "Next: social & reviews",
    text: `This compares PR only. Instagram, LinkedIn, Facebook, Reddit and Trustpilot Share of Voice vs competitors light up once the Apify social bot is connected (see the Social & Reviews tab) — that completes the "who's winning where" picture.`,
  });

  return out;
}
