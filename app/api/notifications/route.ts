// The notification feed for the bell. Read-only.
import { recentNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET() {
  try {
    return Response.json(
      { items: await recentNotifications(40), at: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    console.error(`[api/notifications] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ items: [], error: String(e) }, { status: 500 });
  }
}
