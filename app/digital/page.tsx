import type { Metadata } from "next";
import DigitalDashboard from "@/components/DigitalDashboard";
import { getPaidConfig } from "@/lib/data";

export const metadata: Metadata = {
  title: "Digital Pipeline Scorecard — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

// No ad data is fetched on the server: Supermetrics can take a while, and the
// page must open at once. Only the account choice (one quick Supabase read) is
// read here; the page loads the ad data, then the CRM, in the browser.
export default async function DigitalPage() {
  const config = await getPaidConfig();
  return <DigitalDashboard config={config} />;
}
