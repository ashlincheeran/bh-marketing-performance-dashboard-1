import type { Metadata } from "next";
import SeoWebsite from "@/components/SeoWebsite";
import { getWebMetrics } from "@/lib/posthog";

export const metadata: Metadata = {
  title: "SEO & Website — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default async function SeoPage() {
  const initial = await getWebMetrics(30);
  return <SeoWebsite initial={initial} />;
}
