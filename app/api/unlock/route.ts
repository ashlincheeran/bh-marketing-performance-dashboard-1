// Verifies a PIN and issues the matching gate cookie. Both PINs are compared
// here, on the server, so neither reaches the browser bundle.
import { NextResponse } from "next/server";
import { COOKIES, MAX_AGE, PINS, canSignCookies, isScope, issueToken, safeEqual } from "@/lib/gate";
import {
  PRUNE_CHANCE,
  UNCOUNTED_MESSAGE,
  UNCOUNTED_RETRY_SECONDS,
  blockedMessage,
  clientIp,
  compareUncounted,
  markRight,
  openAttempt,
  pruneAttempts,
} from "@/lib/gateLimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let pin = "";
  let scope: "app" | "settings" = "app";
  try {
    const body = (await req.json()) as { pin?: unknown; scope?: unknown };
    pin = String(body?.pin ?? "");
    if (isScope(body?.scope)) scope = body.scope;
  } catch {
    /* empty body → treated as a wrong PIN */
  }

  // Without a key there is no cookie to give, so nothing is counted or compared.
  if (!canSignCookies()) {
    console.error("[unlock] no key to sign the PIN cookies with: set SESSION_SECRET");
    return NextResponse.json(
      { ok: false, error: "no_session_key", message: "Unlocking is not set up on this server yet. An admin needs to set SESSION_SECRET." },
      { status: 503 },
    );
  }

  // Counted before the PIN is compared, in the database, because the pause
  // below limits nothing on its own: requests run side by side, so 200 in
  // flight tried every four digit PIN in about 20 seconds. See lib/gateLimit.ts.
  const attempt = await openAttempt(clientIp(req.headers), scope);
  if (attempt.status === "blocked") {
    const { retryAfterSeconds } = attempt.decision;
    return NextResponse.json(
      { ok: false, error: "too_many_attempts", message: blockedMessage(attempt.decision), retryAfter: retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }
  if (attempt.status === "unavailable" || attempt.status === "off") {
    // Not counted, so not compared: a database that fails or is slow is what a
    // flood of guesses produces, and judging the PIN anyway would switch the
    // limit off for exactly that attack. People already in keep their cookies.
    if (!compareUncounted(attempt)) {
      console.warn(`[unlock] PIN not checked, the wrong-PIN limit could not count the attempt: ${attempt.reason}`);
      return NextResponse.json(
        { ok: false, error: "limit_unavailable", message: UNCOUNTED_MESSAGE, retryAfter: UNCOUNTED_RETRY_SECONDS },
        { status: 503, headers: { "Retry-After": String(UNCOUNTED_RETRY_SECONDS) } },
      );
    }
    console.warn(`[unlock] local development without a database, so the wrong-PIN limit is off: ${attempt.reason}`);
  }

  // A deliberate delay on every attempt. A four digit PIN is only 10,000
  // combinations, so without this a script could exhaust the space in seconds.
  // It does not make the PIN strong; it makes brute forcing it slow. Old
  // attempts are deleted during it now and then, so that costs no extra time.
  await Promise.all([
    new Promise((r) => setTimeout(r, 400)),
    attempt.status === "allowed" && Math.random() < PRUNE_CHANCE
      ? pruneAttempts().then((problem) => {
          if (problem) console.warn(`[unlock] old attempts not deleted: ${problem}`);
        })
      : null,
  ]);

  if (!safeEqual(pin.trim(), PINS[scope])) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (attempt.status === "allowed") {
    const problem = await markRight(attempt.id);
    if (problem) console.warn(`[unlock] a right PIN is still counted as wrong: ${problem}`);
  }

  const res = NextResponse.json({ ok: true, scope });
  res.cookies.set({
    name: COOKIES[scope],
    // Signed with the time it was issued, so the server stops accepting it
    // after MAX_AGE whatever the browser does with its copy.
    value: await issueToken(scope),
    httpOnly: true, // unreadable from JavaScript
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Settings expires sooner: it is an occasional administrative act, and a
    // long lived cookie on a shared machine is the likelier way it leaks.
    maxAge: MAX_AGE[scope],
  });
  return res;
}
