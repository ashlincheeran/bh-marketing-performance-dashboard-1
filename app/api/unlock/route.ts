// Verifies a PIN and issues the matching gate cookie. Both PINs are compared
// here, on the server, so neither reaches the browser bundle.
import { NextResponse } from "next/server";
import { COOKIES, PINS, expectedToken, isScope, safeEqual } from "@/lib/gate";
import { PRUNE_CHANCE, blockedMessage, clientIp, markRight, openAttempt, pruneAttempts } from "@/lib/gateLimit";

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
  if (attempt.status === "unavailable") {
    // Carry on without the limit: a database problem must never lock the team out.
    console.warn(`[unlock] wrong-PIN limit not applied, only the pause slows guessing: ${attempt.reason}`);
  }

  // A deliberate delay on every attempt. A four digit PIN is only 10,000
  // combinations, so without this a script could exhaust the space in seconds.
  // It does not make the PIN strong; it makes brute forcing it slow. Old
  // attempts are deleted during it now and then, so that costs no extra time.
  await Promise.all([
    new Promise((r) => setTimeout(r, 400)),
    Math.random() < PRUNE_CHANCE
      ? pruneAttempts().then((problem) => {
          if (problem) console.warn(`[unlock] old attempts not deleted: ${problem}`);
        })
      : null,
  ]);

  if (!safeEqual(pin.trim(), PINS[scope])) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (attempt.id != null) {
    const problem = await markRight(attempt.id);
    if (problem) console.warn(`[unlock] a right PIN is still counted as wrong: ${problem}`);
  }

  const res = NextResponse.json({ ok: true, scope });
  res.cookies.set({
    name: COOKIES[scope],
    value: await expectedToken(scope),
    httpOnly: true, // unreadable from JavaScript
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Settings expires sooner: it is an occasional administrative act, and a
    // long lived cookie on a shared machine is the likelier way it leaks.
    maxAge: scope === "settings" ? 60 * 60 : 60 * 60 * 12,
  });
  return res;
}
