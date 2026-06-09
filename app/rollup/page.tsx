import type { Metadata } from "next";
import RollupView from "@/components/RollupView";
import { getMentions, getSov } from "@/lib/data";
import { computeRollup } from "@/lib/rollup";

export const metadata: Metadata = {
  title: "Monthly Rollup — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default async function RollupPage() {
  const [{ mentions }, sov] = await Promise.all([getMentions(), getSov()]);
  const rollup = computeRollup(mentions);
  return <RollupView rollup={rollup} sov={sov.items} capturedOn={sov.capturedOn} />;
}
