import type { Metadata } from "next";
import PRDashboard from "@/components/PRDashboard";
import BotStatus from "@/components/BotStatus";
import CompetitorNews from "@/components/CompetitorNews";
import BotActivity from "@/components/BotActivity";
import {
  getMentions,
  getIngestRuns,
  getSov,
  getFactCheckDrops,
  getCompetitorNews,
  getTrackedKeywords,
  getCachedInsights,
  getNewsArticles,
  getNewsRunToday,
  getNewsQueue,
  getTrackedPeople,
  getPossibleMoves,
} from "@/lib/data";
import { INSIGHT_WINDOW_DAYS, buildCompetitiveInsights, dayLabel, usableCachedInsights } from "@/lib/insights";
import { getAppSettings } from "@/lib/appSettings";
import { US, buildRegistry } from "@/lib/news/registry";
import { dubaiDay } from "@/lib/news/store";
import { C } from "@/lib/theme";
import { todayIn } from "@/lib/dateRanges";

export const metadata: Metadata = {
  title: "PR & Media — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
// Run now and turning counting on start the news bot from this page's server
// actions; when /api/news can't take the first step, it runs here, for up to
// about 265 seconds, so the page's function needs the same room as the route.
export const maxDuration = 300;

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
  const [
    { mentions, source, error },
    runs,
    sov,
    drops,
    competitorNews,
    keywords,
    cachedInsights,
    newsArticles,
    newsRun,
    newsQueue,
    people,
    moves,
    settings,
  ] = await Promise.all([
    getMentions(),
    getIngestRuns(),
    getSov(),
    getFactCheckDrops(),
    getCompetitorNews(),
    getTrackedKeywords(),
    getCachedInsights(),
    getNewsArticles(),
    getNewsRunToday(),
    getNewsQueue(),
    getTrackedPeople(),
    getPossibleMoves(),
    getAppSettings(),
  ]);

  // The companies the bot tracks, as its registry names them (lib/news/registry.ts):
  // betterhomes and every active rival, with the ways each is written. Built from
  // the keyword list already read, so it is the same list the editor shows. Unknown
  // when that list could not be read.
  const registry = keywords.error
    ? null
    : buildRegistry(keywords.competitor.map((k) => ({ label: k.label ?? k.query, query: k.query })), []);
  // The companies a spokesperson can be added at.
  const companies = registry ? registry.companies.map((c) => c.label) : [US.label];
  // Every way a rival is written, for checking which companies a cached AI card may name.
  const rivalNames = registry ? registry.companies.filter((c) => !c.isUs).flatMap((c) => [c.label, ...c.names]) : null;
  // When the bot began looking for each rival, as a Dubai day, so a rival tracked
  // only lately isn't read as one the press ignored before then.
  const rivalsTrackedSince: Record<string, string> = {};
  for (const k of keywords.competitor) {
    const at = k.createdAt ? new Date(k.createdAt) : null;
    const label = (k.label || k.query).trim();
    if (label && at && !Number.isNaN(at.getTime())) rivalsTrackedSince[label] = dubaiDay(at);
  }
  // A failed rival read is said as such, never shown as no rival coverage. The
  // rule-based cards use getSov's figures too; the tab works out its own Share
  // of Voice from the rivals' stories, so only their read matters to it.
  const insightsRivalError = competitorNews.error ?? sov.error;

  // Seeded so an empty table renders empty states instead of throwing:
  // reduce() with no initial value fails on an empty array.
  const months = mentions.map((m) => m.date?.slice(0, 7)).filter((s): s is string => Boolean(s));
  const seed = months[0] ?? dubaiMonth();
  const minMonth = months.reduce((a, b) => (a < b ? a : b), seed);
  const maxMonth = months.reduce((a, b) => (a > b ? a : b), seed);
  const candidate = shiftMonths(maxMonth, -23);
  const defaultFrom = candidate > minMonth ? candidate : minMonth;

  // AI insights when the cached set survives the check against the headlines
  // its run read, saved with it; otherwise the deterministic fallback. The set
  // cached on 20 Oct credited rivals with "award wins" from an input holding no
  // competitor story at all. Without the rival list there is nothing to check
  // the cards against, so they are not shown.
  const cached =
    cachedInsights && rivalNames
      ? usableCachedInsights(cachedInsights.insights, cachedInsights.evidence, rivalNames)
      : [];
  const insights = cached.length
    ? cached
    : buildCompetitiveInsights({
        mentions,
        sov: sov.items,
        sovThrough: sov.through,
        competitorNews: competitorNews.items,
        competitorError: insightsRivalError,
      });
  const insightsMeta = {
    source: cached.length ? ("ai" as const) : ("auto" as const),
    generatedAt: cached.length ? (cachedInsights?.generatedAt ?? null) : null,
    windowDays: INSIGHT_WINDOW_DAYS,
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
        competitorNews={competitorNews.items}
        competitorError={competitorNews.error}
        trackedBrands={registry ? companies : undefined}
        rivalsTrackedSince={rivalsTrackedSince}
      />
      {divider}
      <CompetitorNews items={competitorNews.items} error={competitorNews.error} />
      {divider}
      <BotActivity
        articles={newsArticles}
        run={newsRun}
        queue={newsQueue}
        moves={moves}
        people={people}
        companies={companies}
        drops={drops}
        prKeywords={keywords.pr}
        competitorKeywords={keywords.competitor}
        keywordsError={keywords.error}
        countOnPrTab={settings.news.countOnPrTab}
        // Vercel runs crons in production only: a preview's bot runs when someone presses Run now.
        scheduled={process.env.VERCEL_ENV === "production"}
      />
    </>
  );
}
