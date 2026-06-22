import type { Metadata } from "next";
import PRDashboard from "@/components/PRDashboard";
import BotStatus from "@/components/BotStatus";
import ShareOfVoice from "@/components/ShareOfVoice";
import CompetitorNews from "@/components/CompetitorNews";
import BotActivity from "@/components/BotActivity";
import { getMentions, getIngestRuns, getSov, getBotActivity, getCompetitorNews, getTrackedKeywords } from "@/lib/data";
import { buildCompetitiveInsights } from "@/lib/insights";

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

export default async function PRPage() {
  const [{ mentions }, runs, sov, botItems, competitorNews, keywords] = await Promise.all([
    getMentions(),
    getIngestRuns(),
    getSov(),
    getBotActivity(),
    getCompetitorNews(),
    getTrackedKeywords(),
  ]);

  const months = mentions.map((m) => m.date?.slice(0, 7)).filter((s): s is string => Boolean(s));
  const minMonth = months.reduce((a, b) => (a < b ? a : b));
  const maxMonth = months.reduce((a, b) => (a > b ? a : b));
  const candidate = shiftMonths(maxMonth, -23);
  const defaultFrom = candidate > minMonth ? candidate : minMonth;

  const insights = buildCompetitiveInsights({ mentions, sov: sov.items, competitorNews });

  return (
    <>
      <BotStatus runs={runs} />
      <PRDashboard
        mentions={mentions}
        minMonth={minMonth}
        maxMonth={maxMonth}
        defaultFrom={defaultFrom}
        insights={insights}
      />
      {divider}
      <ShareOfVoice sov={sov.items} capturedOn={sov.capturedOn} />
      {divider}
      <CompetitorNews items={competitorNews} />
      {divider}
      <BotActivity items={botItems} prKeywords={keywords.pr} competitorKeywords={keywords.competitor} />
    </>
  );
}
