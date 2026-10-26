import type { Metadata } from "next";
import PRDashboard from "@/components/PRDashboard";
import BotStatus from "@/components/BotStatus";
import CompetitorNews from "@/components/CompetitorNews";
import BotActivity from "@/components/BotActivity";
import { getMentions, getIngestRuns, getSov, getBotActivity, getFactCheckDrops, getCompetitorNews, getTrackedKeywords, getCachedInsights } from "@/lib/data";
import { buildCompetitiveInsights, dayLabel, insightCorpus, usableCachedInsights } from "@/lib/insights";
import { C } from "@/lib/theme";
import { todayIn } from "@/lib/dateRanges";

export const metadata: Metadata = {
  title: "PR & Media — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

function shiftMonths(ym: string, delta: number): string {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

const divider = <div style={{ borderTop: "2px solid var(--border)", margin: "34px 0 26px" }} />;

/** "YYYY-MM" of today in Dubai: the date range for a table with no dated mentions. */
function dubaiMonth(): string {
  const d = todayIn("Asia/Dubai");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default async function PRPage() {
  const [{ mentions, source, error }, runs, sov, botItems, drops, competitorNews, keywords, cachedInsights] = await Promise.all([
    getMentions(),
    getIngestRuns(),
    getSov(),
    getBotActivity(),
    getFactCheckDrops(),
    getCompetitorNews(),
    getTrackedKeywords(),
    getCachedInsights(),
  ]);

  // Seeded so an empty table renders empty states instead of throwing:
  // reduce() with no initial value fails on an empty array.
  const months = mentions.map((m) => m.date?.slice(0, 7)).filter((s): s is string => Boolean(s));
  const seed = months[0] ?? dubaiMonth();
  const minMonth = months.reduce((a, b) => (a < b ? a : b), seed);
  const maxMonth = months.reduce((a, b) => (a > b ? a : b), seed);
  const candidate = shiftMonths(maxMonth, -23);
  const defaultFrom = candidate > minMonth ? candidate : minMonth;

  // AI insights when the cached set survives the check against what its run
  // could have read; otherwise the deterministic fallback. The set cached on
  // 20 Oct credited rivals with "award wins" from an input holding no
  // competitor story at all.
  const cached = cachedInsights
    ? usableCachedInsights(
        cachedInsights.insights,
        insightCorpus(mentions, competitorNews, cachedInsights.generatedAt),
        keywords.competitor.map((k) => k.label || k.query),
      )
    : [];
  const insights = cached.length
    ? cached
    : buildCompetitiveInsights({ mentions, sov: sov.items, sovThrough: sov.through, competitorNews });
  const insightsMeta = {
    source: cached.length ? ("ai" as const) : ("auto" as const),
    generatedAt: cached.length ? (cachedInsights?.generatedAt ?? null) : null,
  };

  // Shown whenever the live read failed and getMentions fell back to the file
  // bundled with the app: same layout, same "Verified" badge, months out of date.
  const lastClip = mentions.reduce((a, m) => (m.date && m.date > a ? m.date : a), "");

  return (
    <>
      {source === "seed" && (
        <div className="chart-card" style={{ marginBottom: 18, borderColor: C.amber, background: "#fffdf7" }}>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <strong>Live press data could not be loaded.</strong> This page is showing the clipping file bundled with
            the app{lastClip ? `, which ends on ${dayLabel(lastClip)}` : ""}. Bot-found coverage, Share of Voice and the
            competitor feed are missing until the live data loads again.
            {error ? (
              <>
                <br />
                <span style={{ color: C.mid }}>Reason: {error}</span>
              </>
            ) : null}
          </div>
        </div>
      )}
      <BotStatus runs={runs} />
      <PRDashboard
        mentions={mentions}
        minMonth={minMonth}
        maxMonth={maxMonth}
        defaultFrom={defaultFrom}
        insights={insights}
        insightsMeta={insightsMeta}
        competitorNews={competitorNews}
      />
      {divider}
      <CompetitorNews items={competitorNews} />
      {divider}
      <BotActivity items={botItems} drops={drops} prKeywords={keywords.pr} competitorKeywords={keywords.competitor} />
    </>
  );
}
