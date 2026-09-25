import type { Metadata } from "next";
import SeoDashboard from "@/components/SeoDashboard";
import { getSeoReport } from "@/lib/seoReport";

export const metadata: Metadata = {
  title: "SEO & AIO — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
// PostHog answers three queries at a time, so this page's twenty or so wait
// their turn (see hogql in lib/posthog). Given room to finish rather than be
// cut off: a slower page is better than one with blank cards. The CRM half is
// fetched client-side, so nothing here waits on the slow `leads` view.
export const maxDuration = 300;

export default async function SeoPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; from?: string; to?: string; month?: string }>;
}) {
  // A preset by name (resolved on the server, so it stays rolling), two dates,
  // or a month from links made before the range control. None → this month.
  const initial = await getSeoReport(await searchParams);
  return <SeoDashboard initial={initial} />;
}
