// This morning's run, for the card on PR & Media settings to look at again
// while the news bot works (components/BotActivity.tsx RunSummary): the day in
// numbers, the queue, the progress bar and the log (lib/data.ts getRunPanel).
// Read-only. Behind both PINs, like the page (proxy.ts): a request whose
// settings PIN has run out gets the proxy's 401.
import { errorMessage } from "@/lib/coerce";
import { getRunPanel } from "@/lib/data";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET() {
  try {
    return Response.json(await getRunPanel(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(`[api/news/status] ${errorMessage(e)}`);
    return Response.json({ error: errorMessage(e) }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
