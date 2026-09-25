import type { Metadata } from "next";
import WebsiteAnalytics from "@/components/WebsiteAnalytics";
import { getWebMetrics } from "@/lib/posthog";

export const metadata: Metadata = {
  title: "Website — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
// Headroom for PostHog's three-at-a-time queue, which this tab can share with a
// loading SEO tab. Five queries normally finish well inside the old 30 s.
export const maxDuration = 90;

export default async function WebsitePage() {
  // This month (UTC), matching the date picker's default.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
  const to = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const initial = await getWebMetrics(30, from, to);
  return <WebsiteAnalytics initial={initial} />;
}
