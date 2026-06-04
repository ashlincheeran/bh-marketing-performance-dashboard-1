import type { Metadata } from "next";
import PRDashboard from "@/components/PRDashboard";
import { getMentions } from "@/lib/data";

export const metadata: Metadata = {
  title: "PR & Media — betterhomes Marketing Hub",
};

// Render per request so the page always reflects the latest data in Supabase.
export const dynamic = "force-dynamic";

function shiftMonths(ym: string, delta: number): string {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

export default async function PRPage() {
  const { mentions } = await getMentions();

  const months = mentions
    .map((m) => m.date?.slice(0, 7))
    .filter((s): s is string => Boolean(s));
  const minMonth = months.reduce((a, b) => (a < b ? a : b));
  const maxMonth = months.reduce((a, b) => (a > b ? a : b));

  // Default to the trailing ~2 years, clamped to the earliest data.
  const candidate = shiftMonths(maxMonth, -23);
  const defaultFrom = candidate > minMonth ? candidate : minMonth;

  return (
    <PRDashboard
      mentions={mentions}
      minMonth={minMonth}
      maxMonth={maxMonth}
      defaultFrom={defaultFrom}
    />
  );
}
