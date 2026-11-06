// How many wrong PINs the unlock screen will judge before it asks people to wait.
//
// Both PINs are four digits, so there are 10,000 of each to try. The pause in
// app/api/unlock slows one guess but limits nothing, because requests run side
// by side: 200 in flight covered every PIN in about 20 seconds. The count lives
// in the database (gate_attempts, migration 0021), because serverless
// instances share no memory and a count kept in one would not stop the others.
//
// The decision is a pure function, so it is tested without a database. When
// the database can't count an attempt (the table is missing, it fails, or it
// is too slow), the unlock route turns the attempt away without comparing the
// PIN. Carrying on instead would switch the limit off whenever the database
// struggles, and a flood of guesses is itself what makes it struggle: each
// unlock makes three or four calls. People already unlocked keep working
// through an outage, because their cookies are checked without the database.
// Only a machine with no database set up at all, outside production, compares
// PINs without the limit: that is local development.
//
// Server-only: it writes through the service role.
import { adminClient } from "@/lib/supabase";
import { errorMessage } from "@/lib/coerce";
import type { Scope } from "@/lib/gate";

export interface GateLimits {
  /** How far back the counts look, in milliseconds. The window slides. */
  windowMs: number;
  /** Wrong PINs judged from one address inside the window. At least 1. */
  perIp: number;
  /** Wrong PINs judged from every address together inside the window. At least 1. */
  overall: number;
}

/**
 * At most 8 wrong PINs from one address, and 60 from all addresses together,
 * in any 15 minutes. The second limit is what stops a guesser who keeps
 * changing address: at 60 every 15 minutes, trying every PIN takes about 42
 * hours instead of 20 seconds.
 */
export const GATE_LIMITS: GateLimits = { windowMs: 15 * 60_000, perIp: 8, overall: 60 };

export type Blocked = { allowed: false; retryAfterSeconds: number; reason: "ip" | "everyone" };
export type GateDecision = { allowed: true } | Blocked;

/**
 * Whether one more attempt may have its PIN compared, and if not, how long to wait.
 *
 * `recent.ip` and `recent.all` are the times, in milliseconds, of the OTHER
 * wrong attempts: from this address, and from every address. Times older than
 * the window are ignored, so the caller may pass a few too many.
 */
export function decideAttempt(
  recent: { ip: number[]; all: number[] },
  now: number,
  limits: GateLimits = GATE_LIMITS,
): GateDecision {
  const waitFor = (times: number[], max: number): number => {
    const counted = times.filter((t) => t > now - limits.windowMs).sort((a, b) => b - a);
    if (counted.length < max) return 0;
    // There is room for one more once the max-th newest leaves the window:
    // only max - 1 newer ones are left then.
    return counted[max - 1] + limits.windowMs - now;
  };
  const ipWait = waitFor(recent.ip, limits.perIp);
  const allWait = waitFor(recent.all, limits.overall);
  if (ipWait <= 0 && allWait <= 0) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(Math.max(ipWait, allWait) / 1000)),
    reason: ipWait > allWait ? "ip" : "everyone",
  };
}

/** A wait in whole minutes, rounded up: "1 minute", "12 minutes". */
export function waitLabel(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** What the unlock screen says when an attempt is turned away. */
export function blockedMessage(d: Blocked): string {
  const wait = waitLabel(d.retryAfterSeconds);
  return d.reason === "ip"
    ? `Too many wrong PINs from this connection. Try again in ${wait}.`
    : `Too many wrong PINs have been tried on this dashboard. Try again in ${wait}.`;
}

/**
 * The caller's address: the first entry of x-forwarded-for, else x-real-ip.
 * Capped in length, because a header holds whatever the request puts in it.
 */
export function clientIp(headers: Headers): string {
  const forwarded = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ip = forwarded || (headers.get("x-real-ip") ?? "").trim();
  return (ip || "unknown").slice(0, 100);
}

/**
 * The longest the limit may hold up one unlock. Past it the attempt is turned
 * away uncounted, so a slow database delays new unlocks, never the people
 * already in.
 */
const DB_TIMEOUT_MS = 3000;

/** About one attempt in twenty also deletes the rows older than a day. */
export const PRUNE_CHANCE = 0.05;
const KEEP_MS = 24 * 3600_000;

export type AttemptCheck =
  | { status: "allowed"; id: number }
  | { status: "blocked"; decision: Blocked }
  /** The attempt could not be counted: the table is missing, or the database failed or was too slow. */
  | { status: "unavailable"; reason: string }
  /** No database is set up on this server, so there is nowhere to count. */
  | { status: "off"; reason: string };

/** An attempt the limit could not count. */
export type Uncounted = Extract<AttemptCheck, { status: "unavailable" | "off" }>;

/** How long, in seconds, the unlock screen asks people to wait when their attempt could not be counted. */
export const UNCOUNTED_RETRY_SECONDS = 60;

/** What the unlock screen says then. */
export const UNCOUNTED_MESSAGE = "The PIN check is unavailable right now. Try again in a minute.";

/**
 * Whether an attempt the limit could not count may have its PIN compared anyway.
 *
 * Only where no database is set up and this is not production, which is local
 * development. Anywhere else the attempt is turned away unjudged (see the top
 * of this file): a database that fails or answers slowly is exactly what a
 * flood of guesses produces, and so is a deployment that lost its service-role
 * key.
 */
export function compareUncounted(check: Uncounted, nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return check.status === "off" && nodeEnv !== "production";
}

type Db = ReturnType<typeof adminClient>;

const NO_DATABASE = "no database is set up (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set)";

/**
 * Record this attempt and decide whether its PIN may be compared.
 *
 * The row is written as a wrong attempt BEFORE the decision, and markRight
 * clears it once the PIN proves right. Written after, attempts sent at the
 * same moment would all count the same empty window and all be judged, so a
 * burst of 200 would get 200 guesses. Written first, each one counts the rows
 * of those ahead of it, so no more than the limit get through.
 *
 * When the row was written but the counts failed, the row stays: it counts as
 * a wrong attempt for the window, which only errs towards the limit.
 * `db` is the service-role client; tests pass a stand-in.
 */
export async function openAttempt(ip: string, gate: Scope, db: Db = adminClient()): Promise<AttemptCheck> {
  if (!db) return { status: "off", reason: NO_DATABASE };
  const signal = AbortSignal.timeout(DB_TIMEOUT_MS);
  try {
    const ins = await db.from("gate_attempts").insert({ ip, gate, ok: false }).select("id,at").abortSignal(signal).single();
    if (ins.error || !ins.data) {
      return { status: "unavailable", reason: ins.error?.message ?? "the attempt was not recorded" };
    }
    const rowId = Number(ins.data.id);
    // The database's clock rather than this server's, so the window and the rows agree.
    const now = Date.parse(String(ins.data.at));
    const since = new Date(now - GATE_LIMITS.windowMs).toISOString();
    const wrong = (max: number, fromIp: string | null) => {
      let q = db.from("gate_attempts").select("at").eq("ok", false).gt("at", since).neq("id", rowId);
      if (fromIp != null) q = q.eq("ip", fromIp);
      return q.order("at", { ascending: false }).limit(max).abortSignal(signal);
    };
    const [mine, everyone] = await Promise.all([wrong(GATE_LIMITS.perIp, ip), wrong(GATE_LIMITS.overall, null)]);
    const err = mine.error ?? everyone.error;
    if (err) return { status: "unavailable", reason: err.message };
    const times = (rows: { at: unknown }[] | null) =>
      (rows ?? []).map((r) => Date.parse(String(r.at))).filter((t) => Number.isFinite(t));
    const decision = decideAttempt({ ip: times(mine.data), all: times(everyone.data) }, now);
    if (decision.allowed) return { status: "allowed", id: rowId };

    // A turned-away attempt compared no PIN, so its row goes: trying again
    // during the wait does not make the wait longer. If the delete fails the
    // wait is only a little longer, so the attempt is still turned away.
    try {
      await db.from("gate_attempts").delete().eq("id", rowId).abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    } catch {
      /* see above */
    }
    return { status: "blocked", decision };
  } catch (e) {
    return { status: "unavailable", reason: errorMessage(e) };
  }
}

/** The PIN was right, so the attempt stops counting as a wrong one. Returns what went wrong, if anything. */
export async function markRight(id: number, db: Db = adminClient()): Promise<string | null> {
  if (!db) return NO_DATABASE;
  try {
    const { error } = await db
      .from("gate_attempts")
      .update({ ok: true })
      .eq("id", id)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    return error?.message ?? null;
  } catch (e) {
    return errorMessage(e);
  }
}

/** Delete attempts older than a day: the limit only ever looks back 15 minutes. Returns what went wrong, if anything. */
export async function pruneAttempts(now = Date.now(), db: Db = adminClient()): Promise<string | null> {
  if (!db) return NO_DATABASE;
  try {
    const { error } = await db
      .from("gate_attempts")
      .delete()
      .lt("at", new Date(now - KEEP_MS).toISOString())
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    return error?.message ?? null;
  } catch (e) {
    return errorMessage(e);
  }
}
