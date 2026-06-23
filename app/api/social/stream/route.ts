// Streaming SSE endpoint for the People Sentiment "Run" button.
// Accepts the run variables (date window, max items, platforms, subjects) in the
// POST body and streams each stage back so the user can watch it work.
import { runSocialIngest, type SocialRunParams } from "@/lib/socialIngest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let params: SocialRunParams = {};
  try {
    params = (await req.json()) as SocialRunParams;
  } catch {
    /* no body → use stored config defaults */
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {
          /* client disconnected — let the run finish anyway */
        }
      };
      try {
        await runSocialIngest(params, send);
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
