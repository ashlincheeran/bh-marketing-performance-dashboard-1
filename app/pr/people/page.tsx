import type { Metadata } from "next";
import PeopleSentiment from "@/components/PeopleSentiment";
import PrTabs from "@/components/PrTabs";
import { getSocialConfig, getSocialMentions, getSocialRuns } from "@/lib/data";

export const metadata: Metadata = {
  title: "People sentiment · PR & Media · betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

// People sentiment, a tab of PR & Media: what people say online about
// betterhomes and its people. It used to be its own tab at /people, which now
// sends people here.
export default async function PrPeoplePage() {
  const [config, mentions, runs] = await Promise.all([getSocialConfig(), getSocialMentions(), getSocialRuns()]);
  return (
    <>
      <PrTabs active="people" />
      <PeopleSentiment config={config} mentions={mentions} runs={runs} />
    </>
  );
}
