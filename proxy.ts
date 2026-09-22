// Two PIN gates, both running BEFORE any route renders.
//
// That ordering is the whole point of the app gate: every tab is a
// force-dynamic server component that fetches its data during render, so a
// client-side gate would still spend Supermetrics rows and Metabase time before
// the prompt appeared. Blocking here means an unauthenticated visitor costs
// nothing.
//
// Settings sits behind a SECOND PIN because what it edits changes everyone's
// numbers: portal spend feeds cost per deal, and the ad-account list decides how
// much API quota one page load consumes.
//
// Next 16 renamed the `middleware` file convention to `proxy`. A middleware.ts in
// this project would simply never run.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIES, expectedToken, safeEqual, type Scope } from "@/lib/gate";

async function unlocked(request: NextRequest, scope: Scope): Promise<boolean> {
  const token = request.cookies.get(COOKIES[scope])?.value;
  return !!token && safeEqual(token, await expectedToken(scope));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The unlock screen and its endpoint must stay reachable, or the gate locks
  // out the only way through it.
  if (pathname === "/unlock" || pathname === "/api/unlock") return NextResponse.next();

  // These carry their own CRON_SECRET check. Gating them would silently break
  // the daily runs, since Vercel's scheduler has no cookie jar — and the
  // backfill has to stay callable from a plain URL because it runs in batches.
  if (
    pathname === "/api/ingest" ||
    pathname === "/api/paid/sync" ||
    pathname === "/api/pr/backfill" ||
    pathname === "/api/social/sync" ||
    pathname === "/api/perf/sync"
  ) {
    return NextResponse.next();
  }

  // The console reaches external services on this deployment's credentials, so
  // it belongs to admin, not merely to anyone holding the app PIN.
  const isSettings =
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/api/console";

  // Settings needs BOTH: you are already inside the app before you can change
  // how it reads. Checked app-first so the prompts appear in that order.
  if (!(await unlocked(request, "app"))) return deny(request, pathname, "app");
  if (isSettings && !(await unlocked(request, "settings"))) return deny(request, pathname, "settings");

  return NextResponse.next();
}

function deny(request: NextRequest, pathname: string, scope: Scope) {
  // API calls get a 401 rather than a redirect: a fetch following a 302 to an
  // HTML page fails confusingly in the client.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "locked", scope }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  const params = new URLSearchParams();
  if (scope !== "app") params.set("scope", scope);
  if (pathname !== "/") params.set("next", pathname);
  url.search = params.toString();
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets and the favicon. Without a matcher this
  // would also gate CSS and JS, leaving the unlock page unstyled.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
