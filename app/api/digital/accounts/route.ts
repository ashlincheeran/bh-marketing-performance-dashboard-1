// The ad accounts the Digital tab's picker offers, from Supermetrics' account
// list (lib/paidCatalog.ts). Asked when the picker opens, never with the page.
import { errorMessage } from "@/lib/coerce";
import { getAccountCatalog } from "@/lib/paidCatalog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return Response.json(await getAccountCatalog(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
