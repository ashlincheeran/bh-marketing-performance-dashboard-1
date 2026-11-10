// Day-grain figures for a single month, fetched when one month is selected so
// the charts can show its shape rather than a single bar.
import { errorMessage } from "@/lib/coerce";
import { getCompanyDaily } from "@/lib/company";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // must exceed the 45s query ceilings

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || "";
  const brand = searchParams.get("brand") || undefined;
  try {
    return Response.json(await getCompanyDaily(month, brand), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[api/company/daily] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
