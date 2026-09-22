import type { Metadata } from "next";
import SeoDashboard from "@/components/SeoDashboard";
import { getSeoReport, currentMonth } from "@/lib/seoReport";

export const metadata: Metadata = {
  title: "SEO & AIO — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
// PostHog and GSC are quick; the month-by-month scan is the long one. The CRM
// half is fetched client-side, so nothing here waits on the slow `leads` view.
export const maxDuration = 90;

export default async function SeoPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  const initial = await getSeoReport(month ?? currentMonth());
  return <SeoDashboard initial={initial} />;
}
