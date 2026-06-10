import type { Metadata } from "next";
import PRDashboard from "@/components/PRDashboard";
import BotStatus from "@/components/BotStatus";
import RollupView from "@/components/RollupView";
import BotActivity from "@/components/BotActivity";
import { getMentions, getIngestRuns, getSov, getBotActivity } from "@/lib/data";
import { computeRollup } from "@/lib/rollup";
import { getKeywords } from "@/lib/keywords";

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
  const [{ mentions }, runs, sov, botItems] = await Promise.all([
    getMentions(),
    getIngestRuns(),
    getSov(),
    getBotActivity(),
  ]);
  const rollup = computeRollup(mentions);

  const months = mentions.map((m) => m.date?.slice(0, 7)).filter((s): s is string => Boolean(s));
  const minMonth = months.reduce((a, b) => (a < b ? a : b));
  const maxMonth = months.reduce((a, b) => (a > b ? a : b));
  const candidate = shiftMonths(maxMonth, -23);
  const defaultFrom = candidate > minMonth ? candidate : minMonth;

  return (
    <>
      <BotStatus runs={runs} />
      <PRDashboard mentions={mentions} minMonth={minMonth} maxMonth={maxMonth} defaultFrom={defaultFrom} />
      {divider}
      <RollupView rollup={rollup} sov={sov.items} capturedOn={sov.capturedOn} />
      {divider}
      <BotActivity items={botItems} keywords={getKeywords()} />
    </>
  );
}
