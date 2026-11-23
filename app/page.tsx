import type { Metadata } from "next";
import CeoDashboard from "@/components/CeoDashboard";
import { rangeFor, todayIn } from "@/lib/dateRanges";

export const metadata: Metadata = {
  title: "Dashboard — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default function Home() {
  // The year to date on Dubai's calendar: what every tile opens on, until the Period picker changes it.
  const { from, to } = rangeFor("this_year", todayIn("Asia/Dubai"));
  return (
    <>
      <div className="page-title">Dashboard</div>
      <div className="page-sub">Commercial and marketing performance at a glance — every figure links to its tab.</div>
      <CeoDashboard initialFrom={from} initialTo={to} />
    </>
  );
}
