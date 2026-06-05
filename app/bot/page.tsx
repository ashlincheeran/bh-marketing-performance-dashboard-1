import type { Metadata } from "next";
import BotActivity from "@/components/BotActivity";
import BotStatus from "@/components/BotStatus";
import { getBotActivity, getIngestRuns } from "@/lib/data";
import { getKeywords } from "@/lib/keywords";

export const metadata: Metadata = {
  title: "Bot Activity — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default async function BotPage() {
  const [items, runs] = await Promise.all([getBotActivity(), getIngestRuns()]);
  return (
    <>
      <BotStatus runs={runs} />
      <BotActivity items={items} keywords={getKeywords()} />
    </>
  );
}
