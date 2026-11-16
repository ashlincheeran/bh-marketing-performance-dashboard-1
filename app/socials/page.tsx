import type { Metadata } from "next";
import SocialPerformance from "@/components/SocialPerformance";
import { getPerfConfig, getPerfMetrics, getPerfPosts, getPerfRuns } from "@/lib/data";

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
      <div className="section-header">
        <div>
          <div className="page-title">Socials Performance</div>
          <div className="page-sub">
            How betterhomes&apos; social channels compare with rival agencies on Instagram, TikTok, Facebook and
            LinkedIn.
          </div>
        </div>
      </div>
      <SocialPerformance config={config} metrics={metrics} posts={posts} runs={runs} />
    </>
  );
}
