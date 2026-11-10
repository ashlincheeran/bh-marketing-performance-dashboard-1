// Retired, with /api/pr/backfill: this streamed the "Re-read bodies" button's
// progress. See that route for why. The news bot now tries unreadable articles
// again and re-checks older stories itself, and the button is gone.
//
// It answers 410 so a page left open from before says what happened.
import { gone } from "@/lib/retired";

export const dynamic = "force-dynamic";

const MESSAGE =
  "Re-reading article bodies has been retired. The news bot now tries unreadable articles again on later mornings and re-checks older stories itself.";

export function GET() {
  return gone(MESSAGE);
}

export function POST() {
  return gone(MESSAGE);
}
