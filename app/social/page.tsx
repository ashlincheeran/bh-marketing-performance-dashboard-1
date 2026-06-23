import type { Metadata } from "next";
import SocialReviews from "@/components/SocialReviews";

export const metadata: Metadata = {
  title: "Social & Reviews — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default function SocialPage() {
  return <SocialReviews />;
}
