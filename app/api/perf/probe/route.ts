// Actor-finder for the LinkedIn benchmark. It tries each candidate actor/input
// against a real company page, reporting which one returns posts: the "run it
// until it gives data" step, done where Apify is actually reachable.
//
//   POST /api/perf/probe                    → uses the stored betterhomes handle
//   POST /api/perf/probe?handle=<url|slug>  → probe a specific page
//
// POST only. One call starts up to ten billed Apify runs on a page the caller
// chooses, and browsers send the app cookie (SameSite=Lax) on a link followed
// from another site, so a plain GET from an email or a web page must never
// start them. Accepted with "Authorization: Bearer $CRON_SECRET" from a
// script, or with both PIN cookies from a browser, for example with
// fetch("/api/perf/probe?handle=...", { method: "POST" }) on an unlocked
// Settings page: spending money is a settings-level act. Both are checked here
// (lib/gate.ts cronOrBothPins), because proxy.ts only knows the cookies.
//
// Read-only: it never writes to the database and never changes the config. Wire
// the winner in deliberately after reading the result.
import { NextResponse, type NextRequest } from "next/server";
import { cronOrBothPins } from "@/lib/gate";
import { probeLinkedIn } from "@/lib/linkedinProbe";
import { getPerfConfig } from "@/lib/data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Accept either a full LinkedIn URL or a bare slug, and derive the other form. */
function bothForms(handle: string): { url: string; slug: string } {
  const h = handle.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const m = h.match(/^https?:\/\/(?:[a-z]{2}\.|www\.)?linkedin\.com\/(?:company|school)\/(.+)$/i);
  const slug = m ? m[1] : h.replace(/^@/, "");
  return { url: `https://www.linkedin.com/company/${slug}`, slug };
}

export async function GET() {
  return NextResponse.json(
    { error: "method not allowed", message: "This starts paid Apify runs, so it only answers POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(req: NextRequest) {
  if (!(await cronOrBothPins(req))) {
    return NextResponse.json({ error: "locked", scope: "settings" }, { status: 401 });
  }
  if (!process.env.APIFY_TOKEN) {
    return Response.json({ error: "APIFY_TOKEN not set" }, { status: 500 });
  }

  const asked = new URL(req.url).searchParams.get("handle");
  let handle = asked ?? "";
  if (!handle) {
    // Default to our own page: if any page should scrape, it's this one.
    const cfg = await getPerfConfig();
    handle = cfg.brands.find((b) => b.isUs)?.handles.linkedin ?? cfg.brands[0]?.handles.linkedin ?? "";
  }
  if (!handle) {
    return Response.json({ error: "No LinkedIn handle to probe: pass ?handle=" }, { status: 400 });
  }

  const { url, slug } = bothForms(handle);
  const { attempts, winner } = await probeLinkedIn(url, slug);

  return Response.json(
    {
      probed: { handle, url, slug },
      winner: winner
        ? { label: winner.label, actor: winner.actor, input: winner.input, rows: winner.rows, postish: winner.postish, followers: winner.followers }
        : null,
      // Every attempt, including failures: an input-validation error names the
      // fields the actor wanted, which is the point of running this.
      attempts,
      next: winner
        ? `Set actors.linkedin to "${winner.actor}" and use this input shape.`
        : "Nothing returned posts. The errors below name what each actor expected, so send them over.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
