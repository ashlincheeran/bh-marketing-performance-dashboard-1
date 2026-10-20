import type { Metadata } from "next";
import PortalsDashboard from "@/components/PortalsDashboard";
import { getPortalsData } from "@/lib/portals";

export const metadata: Metadata = {
  title: "Portals — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
export const maxDuration = 90; // above the 50 s leads query

export default async function PortalsPage() {
  // Default to the year to date, matching the picker's initial selection.
  const initial = await getPortalsData();
  return (
    <>
      <div className="page-title">Portals</div>
      <div className="page-sub">
        Property Finder, Bayut and Dubizzle — leads, deals and commission from the CRM against actual portal
        spend, split by Sale and Leasing, and ranked by the areas producing the deals.
      </div>
      <PortalsDashboard initial={initial} />
    </>
  );
}
