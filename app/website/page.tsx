import type { Metadata } from "next";
import WebsiteDashboard from "@/components/WebsiteDashboard";
import { getWebsiteReport } from "@/lib/websiteGrowth";

export const metadata: Metadata = {
  title: "Website — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
// PostHog answers three questions at a time, so a cold period waits its turn (lib/posthog.ts). Ended months are
// kept for a week, so this is the first look after a month ends; the CRM half is fetched by the page.
export const maxDuration = 300;

export default async function WebsitePage({ searchParams }: { searchParams: Promise<{ preset?: string; from?: string; to?: string }> }) {
  // A rolling preset by name (worked out on the day, so a bookmark moves on), or a first and last month.
  const initial = await getWebsiteReport(await searchParams);
  return <WebsiteDashboard initial={initial} />;
}
