// Streaming SSE endpoint for the "Run now" button.
// Runs the full ingest pipeline and streams progress lines back to the browser
// so the user can watch each stage in real time.
import { runIngest } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {
          // client disconnected — ignore, let the run finish anyway
        }
      };
      try {
        await runIngest("manual", send);
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
