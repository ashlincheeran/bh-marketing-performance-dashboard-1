// Live web-metrics endpoint the SEO tab polls for auto-refresh.
import { getWebMetrics } from "@/lib/posthog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Number(searchParams.get("days") || 30);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const humansOnly = searchParams.get("humans") !== "0";
  const data = await getWebMetrics(days, from, to, humansOnly);
  return Response.json(data);
}
