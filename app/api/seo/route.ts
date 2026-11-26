// The Dashboard's SEO card: organic clicks and AI visitors for a range, by the
// SEO tab's own rules (lib/seoReport.ts getSeoTile). The SEO tab reads
// /api/seo/growth.
import { getSeoTile } from "@/lib/seoReport";

export const dynamic = "force-dynamic";
// Room for PostHog's queue to drain; see app/seo/page.tsx.
export const maxDuration = 300;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (k: string) => searchParams.get(k);
  try {
    // fresh=1 (the tab's Live switch) works the report out now rather than showing the remembered one (lib/cache.ts).
    const fresh = q("fresh") === "1";
    return Response.json(await getSeoTile({ preset: q("preset"), from: q("from"), to: q("to"), month: q("month") }, { fresh }));
  } catch (e) {
    console.error(`[api/seo] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
