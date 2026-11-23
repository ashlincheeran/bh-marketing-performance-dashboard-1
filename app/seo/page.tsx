import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import SeoDashboard from "@/components/SeoDashboard";
import { getGrowthReport } from "@/lib/organicGrowth";

export const metadata: Metadata = {
  title: "SEO & AIO — betterhomes Marketing Hub",
};

// The report's own type, as the design sets it.
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-report-sans" });
const grotesk = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-report-head" });

export const dynamic = "force-dynamic";
// PostHog answers three queries at a time, so a cold year waits its turn (lib/posthog.ts). Closed months are
// kept for a week, so this is the first look after a month ends; the CRM half is fetched by the page.
export const maxDuration = 300;

export default async function SeoPage({ searchParams }: { searchParams: Promise<{ preset?: string; from?: string; to?: string }> }) {
  // A rolling preset by name (worked out on the day, so a bookmark moves on), or a first and last month.
  const initial = await getGrowthReport(await searchParams);
  return (
    <div className={`${inter.variable} ${grotesk.variable}`}>
      <SeoDashboard initial={initial} />
    </div>
  );
}
