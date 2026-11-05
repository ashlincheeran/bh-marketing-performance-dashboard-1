// Retired. This ran the old news bot (lib/ingest.ts) and streamed its progress
// to the old "Run now" button. The new news bot (docs/news-pipeline.md) has
// its own Run now button on the PR & Media tab.
//
// It answers 410 so a page left open from before says where to go instead.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function gone() {
  return NextResponse.json(
    {
      ok: false,
      error: "gone",
      message: "The old news bot has been retired. Use the Run now button on the PR & Media tab, which runs the new news bot.",
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
