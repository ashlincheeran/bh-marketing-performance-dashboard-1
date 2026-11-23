import type { Metadata } from "next";
import localFont from "next/font/local";
import SeoDashboard from "@/components/SeoDashboard";
import { getGrowthReport } from "@/lib/organicGrowth";

export const metadata: Metadata = {
  title: "SEO & AIO — betterhomes Marketing Hub",
};

// The report's own type, as the design sets it: Inter and Space Grotesk (SIL Open Font
// License, ./fonts), kept with the app rather than fetched from Google Fonts on every build,
// where one failed download stopped a deployment.
const inter = localFont({ src: "./fonts/inter-latin-wght-normal.woff2", weight: "100 900", variable: "--font-report-sans", display: "swap" });
const grotesk = localFont({ src: "./fonts/space-grotesk-latin-wght-normal.woff2", weight: "300 700", variable: "--font-report-head", display: "swap" });

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
