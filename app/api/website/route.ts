// Live web-metrics endpoint the Website tab polls for auto-refresh.
import { getWebMetrics } from "@/lib/posthog";

export const dynamic = "force-dynamic";
// Headroom for PostHog's queue; see app/website/page.tsx.
export const maxDuration = 90;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Number(searchParams.get("days") || 30);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const humansOnly = searchParams.get("humans") !== "0";
  const flowPages = (searchParams.get("flowPages") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const flowMatch = searchParams.get("flowMatch") || undefined;
  const data = await getWebMetrics(days, from, to, humansOnly, flowPages, flowMatch);
  return Response.json(data);
}
