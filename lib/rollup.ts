// Builds a monthly rollup from the real mentions data (news only).
import type { Mention } from "@/lib/types";
import { MONTHS } from "@/lib/pr";

const SENT_SCORE: Record<string, number> = { positive: 1, neutral: 0, mixed: 0, negative: -1 };
const SPOKESPEOPLE = ["Louis Harding", "Richard Waind", "Linda Mahoney", "Alex Leigh"];

function themesOf(title: string): string[] {
  const t = title.toLowerCase();
  const tags: string[] = [];
  if (/rent|tenant|lease|leasing/.test(t)) tags.push("Rental market");
  if (/report|market|transactions|sales|q[1-4]|billion/.test(t)) tags.push("Market report");
  if (/ceo|appoint|steps down|director|leadership|joins/.test(t)) tags.push("Leadership");
  if (/off-plan|off plan|offplan/.test(t)) tags.push("Off-plan");
  if (/top 50/.test(t)) tags.push("Top 50 Homes");
  if (/ramadan/.test(t)) tags.push("Ramadan outlook");
  if (/branded residence/.test(t)) tags.push("Branded residences");
  if (/millionaire|wealth|hnwi/.test(t)) tags.push("Wealth migration");
  return tags;
}

export interface RollupData {
  month: string | null;
  monthLabel: string;
  total: number;
  momPct: number | null;
  netSentiment: number | null;
  scored: number;
  sentimentCounts: { positive: number; neutral: number; negative: number; mixed: number };
  topStories: { title: string; outlet: string; sentiment: string | null; url: string | null }[];
  themes: { theme: string; count: number }[];
  spokespeople: { name: string; mentions: number }[];
}

export function computeRollup(mentions: Mention[]): RollupData {
  const dated = mentions.filter((m) => m.date);
  const months = [...new Set(dated.map((m) => m.date!.slice(0, 7)))].sort();
  const month = months.length ? months[months.length - 1] : null;
  const empty: RollupData = {
    month, monthLabel: "—", total: 0, momPct: null, netSentiment: null, scored: 0,
    sentimentCounts: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
    topStories: [], themes: [], spokespeople: [],
  };
  if (!month) return empty;

  const [y, mm] = month.split("-").map(Number);
  const monthLabel = `${MONTHS[mm - 1]} ${y}`;
  const inMonth = dated.filter((m) => m.date!.slice(0, 7) === month);
  const prevYm = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  const prevTotal = dated.filter((m) => m.date!.slice(0, 7) === prevYm).length;
  const momPct = prevTotal ? Math.round(((inMonth.length - prevTotal) / prevTotal) * 100) : null;

  const sentimentCounts = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  let scoreSum = 0, scored = 0;
  for (const m of inMonth) {
    if (m.sentiment) {
      sentimentCounts[m.sentiment] += 1;
      scoreSum += SENT_SCORE[m.sentiment] ?? 0;
      scored += 1;
    }
  }

  const topStories = [...inMonth]
    .sort((a, b) => b.reachEff - a.reachEff)
    .slice(0, 5)
    .map((m) => ({ title: m.title ?? "—", outlet: m.outlet ?? "—", sentiment: m.sentiment, url: m.url }));

  const themeCounts = new Map<string, number>();
  for (const m of inMonth) for (const th of themesOf(m.title ?? "")) themeCounts.set(th, (themeCounts.get(th) ?? 0) + 1);
  const themes = [...themeCounts.entries()].map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count);

  const spokespeople = SPOKESPEOPLE
    .map((name) => ({ name, mentions: inMonth.filter((m) => (m.title ?? "").toLowerCase().includes(name.toLowerCase())).length }))
    .filter((s) => s.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);

  return {
    month, monthLabel, total: inMonth.length, momPct,
    netSentiment: scored ? Math.round((scoreSum / scored) * 100) / 100 : null, scored,
    sentimentCounts, topStories, themes, spokespeople,
  };
}
