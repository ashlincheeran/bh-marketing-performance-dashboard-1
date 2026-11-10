// Portals data — refetched client-side when the range or brand changes.
import { errorMessage } from "@/lib/coerce";
import { getPortalsData } from "@/lib/portals";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // above the 50 s leads query

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const brand = searchParams.get("brand") || undefined;
  const side = searchParams.get("side") || undefined;
  try {
    const data = await getPortalsData(from, to, brand, side);
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[api/portals] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
