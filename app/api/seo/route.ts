// SEO & AI Channel report endpoint (PostHog + GSC + the stored manual figures).
// The CRM half lives at /api/seo/leads for the reason given there.
import { getSeoReport } from "@/lib/seoReport";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || undefined;
  try {
    return Response.json(await getSeoReport(month));
  } catch (e) {
    console.error(`[api/seo] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
