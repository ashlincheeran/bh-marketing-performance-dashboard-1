// Re-judge stored press mentions against their real article bodies.
//
// Batched on purpose: each row costs an Apify crawl plus a Gemini call, and the
// function ceiling is 300s. Call it repeatedly — the response carries
// `remaining`, and rows already re-read are skipped, so it is safe to re-run.
//
//   GET /api/pr/backfill?secret=$CRON_SECRET&from=2026-05-01&to=2026-09-30&limit=40
import { NextResponse } from "next/server";
import { runPrBackfill } from "@/lib/prBackfill";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const authorised =
    !!secret &&
    (req.headers.get("authorization") === `Bearer ${secret}` ||
      url.searchParams.get("secret") === secret);
  if (!authorised) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const from = url.searchParams.get("from") || "2026-05-01";
  const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));

  try {
    const result = await runPrBackfill(from, to, limit);
    return NextResponse.json({ ok: true, from, to, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
