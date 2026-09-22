// Streaming SSE endpoint for the "Re-read article bodies" button.
// Mirrors /api/ingest/stream so the same reader in BotStatus drives both.
import { runPrBackfill } from "@/lib/prBackfill";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "2026-05-01";
  const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {
          // client disconnected — let the run finish anyway
        }
      };
      try {
        await runPrBackfill(from, to, limit, send);
      } catch (e) {
        send(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
