// Live web-metrics endpoint the SEO tab polls for auto-refresh.
import { getWebMetrics } from "@/lib/posthog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Number(searchParams.get("days") || 30);
  const data = await getWebMetrics(days);
  return Response.json(data);
}
