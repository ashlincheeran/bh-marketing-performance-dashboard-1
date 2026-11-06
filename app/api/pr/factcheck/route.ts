// Retired. This re-ran the old fact check on stored bot-found mentions, a
// batch per call. The news bot (docs/news-pipeline.md) now checks every story
// itself, and re-checks older stories itself when they move into its article
// store, so there is nothing to re-run by hand.
//
// It answers 410 so an old script or bookmark says what happened.
import { gone } from "@/lib/retired";

export const dynamic = "force-dynamic";

const MESSAGE =
  "Re-running the fact check has been retired. The news bot now tries unreadable articles again on later mornings and re-checks older stories itself.";

export function GET() {
  return gone(MESSAGE);
}

export function POST() {
  return gone(MESSAGE);
}
