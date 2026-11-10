// Retired. This ran the old news bot (lib/ingest.ts) and streamed its progress
// to the old "Run now" button. The new news bot (docs/news-pipeline.md) has
// its own Run now button on the PR & Media tab.
//
// It answers 410 so a page left open from before says where to go instead.
import { gone } from "@/lib/retired";

export const dynamic = "force-dynamic";

const MESSAGE = "The old news bot has been retired. Use the Run now button on the PR & Media tab, which runs the new news bot.";

export function GET() {
  return gone(MESSAGE);
}

export function POST() {
  return gone(MESSAGE);
}
