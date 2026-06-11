// Competitive, action-oriented insights — "here's what rivals are doing and what
// to do about it", not a summary of the dashboard. Everything is derived from real
// data (our mentions + live Share of Voice + the competitor news feed); where data
// is thin we say so rather than invent a recommendation.
import type { Insight } from "@/lib/pr";
import type { Mention } from "@/lib/types";
import type { SovItem, CompetitorNewsItem } from "@/lib/data";

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
