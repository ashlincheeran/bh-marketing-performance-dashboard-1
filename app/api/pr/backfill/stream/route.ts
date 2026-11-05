// Retired, with /api/pr/backfill: this streamed the "Re-read bodies" button's
// progress. See that route for why. The news bot now tries unreadable articles
// again and re-checks older stories itself, and the button is gone.
//
// It answers 410 so a page left open from before says what happened.
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
