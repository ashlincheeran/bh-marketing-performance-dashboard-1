import type { Metadata } from "next";
import WebsiteAnalytics from "@/components/WebsiteAnalytics";
import { getWebMetrics } from "@/lib/posthog";
import { rangeFor, todayIn } from "@/lib/dateRanges";

export const metadata: Metadata = {
  title: "Website — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
// Room for PostHog's queue: one query may take its whole 240 s budget (hogql in
// lib/posthog), and this tab can share the queue with a loading SEO tab. At
// 90 s the platform cut a busy load off before the budget gave up and said
// which cards had not loaded, so nothing rendered at all.
export const maxDuration = 300;

export default async function WebsitePage() {
  // This month on Dubai's calendar, as the date picker and the SEO tab count it.
  // UTC's calendar showed 1–31 October as "This month" until 04:00 on 1 November.
  const { from, to } = rangeFor("this_month", todayIn("Asia/Dubai"));
  const initial = await getWebMetrics(30, from, to);
  return <WebsiteAnalytics initial={initial} />;
}
