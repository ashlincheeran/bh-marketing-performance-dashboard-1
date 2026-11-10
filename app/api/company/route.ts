// Company Performance data — refetched client-side when filters change.
import { errorMessage } from "@/lib/coerce";
import { getCompanyData } from "@/lib/company";

export const dynamic = "force-dynamic";
export const maxDuration = 90; // must exceed the 60s Metabase leads timeout

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const brand = searchParams.get("brand") || undefined;
  try {
    const data = await getCompanyData(from, to, brand);
    return Response.json(data);
  } catch (e) {
    console.error(`[api/company] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
