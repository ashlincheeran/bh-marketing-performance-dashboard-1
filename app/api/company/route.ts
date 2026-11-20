// Company Performance data — refetched client-side when filters change.
import { errorMessage } from "@/lib/coerce";
import { getCompanyData } from "@/lib/company";
import { LIVE_MS, wantsLive } from "@/lib/live";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // must exceed the 60s Metabase leads timeout

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const brand = searchParams.get("brand") || undefined;
  try {
    // live=1: an answer at most a minute old (lib/live.ts), asked of the CRM again when older.
    const data = await getCompanyData(from, to, brand, wantsLive(searchParams) ? { maxAgeMs: LIVE_MS } : {});
    return Response.json(data);
  } catch (e) {
    console.error(`[api/company] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
