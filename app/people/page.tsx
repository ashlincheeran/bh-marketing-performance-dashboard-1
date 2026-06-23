import type { Metadata } from "next";
import PeopleSentiment from "@/components/PeopleSentiment";
import { getSocialConfig, getSocialMentions, getSocialRuns } from "@/lib/data";

export const metadata: Metadata = {
  title: "People Sentiment — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const [config, mentions, runs] = await Promise.all([
    getSocialConfig(),
    getSocialMentions(),
    getSocialRuns(),
  ]);
  return <PeopleSentiment config={config} mentions={mentions} runs={runs} />;
}
