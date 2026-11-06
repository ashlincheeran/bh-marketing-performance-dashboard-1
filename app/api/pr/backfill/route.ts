// Retired. This re-read stored rejected rows through Apify and promoted the
// ones the AI then accepted. It could not tell a person's Reject from the
// bot's, so it undid people's Rejects; it moved rejected rival stories into
// that rival's count; and it re-read the same newest unreadable rows on every
// call. The news bot (docs/news-pipeline.md) now tries an unreadable article
// again on later mornings, and re-checks older stories itself, so there is
// nothing left to re-read by hand.
//
// It answers 410 so a bookmarked link or an old script says what happened.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function gone() {
  return NextResponse.json(
    {
      ok: false,
      error: "gone",
      message:
        "Re-reading article bodies has been retired. The news bot now tries unreadable articles again on later mornings and re-checks older stories itself.",
    },
    { status: 410 },
  );
}

export function GET() {
  return gone();
}

export function POST() {
  return gone();
}
