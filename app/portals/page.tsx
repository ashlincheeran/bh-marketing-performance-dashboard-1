import type { Metadata } from "next";
import PortalsDashboard from "@/components/PortalsDashboard";
import { PageHeader } from "@/components/ui";
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
      <PageHeader
        title="Portals"
        sub="Property Finder, Bayut and Dubizzle from the CRM: leads, completed viewings, and reservations with their commission, split by Sale and Leasing, and the areas producing them."
      />
      <PortalsDashboard initial={initial} />
    </>
  );
}
