import type { Metadata } from "next";
import SocialPerformance from "@/components/SocialPerformance";
import { PageHeader } from "@/components/ui";
import { getPerfConfig, getPerfMetrics, getPerfPosts, getPerfRuns } from "@/lib/data";
import { PERF_PLATFORMS } from "@/lib/perfTypes";

const PLATFORM_NAMES = PERF_PLATFORMS.map((p) => p.name);

export const metadata: Metadata = {
  title: "Socials Performance · betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default async function SocialsPage() {
  const [config, metrics, posts, runs] = await Promise.all([
    getPerfConfig(),
    getPerfMetrics(),
    getPerfPosts(),
    getPerfRuns(),
  ]);
  return (
    <>
      <PageHeader
        title="Socials Performance"
        sub={`How betterhomes' social channels compare with rival agencies on ${PLATFORM_NAMES.slice(0, -1).join(", ")} and ${PLATFORM_NAMES[PLATFORM_NAMES.length - 1]}.`}
      />
      <SocialPerformance config={config} metrics={metrics} posts={posts} runs={runs} />
    </>
  );
}
