import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_LIMITS, blockedMessage, clientIp, decideAttempt, waitLabel } from "@/lib/gateLimit";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const MIN = 60_000;
/** `n` wrong attempts, one a minute, the newest `newestAgo` minutes before NOW. */
const fails = (n: number, newestAgo = 1) => Array.from({ length: n }, (_, i) => NOW - (newestAgo + i) * MIN);

test("the limits are the ones the unlock screen promises", () => {
  assert.equal(GATE_LIMITS.windowMs, 15 * MIN);
  assert.equal(GATE_LIMITS.perIp, 8);
  assert.equal(GATE_LIMITS.overall, 60);
});

test("a first attempt, and one after seven wrong PINs, are judged", () => {
  assert.deepEqual(decideAttempt({ ip: [], all: [] }, NOW), { allowed: true });
  assert.deepEqual(decideAttempt({ ip: fails(7), all: fails(7) }, NOW), { allowed: true });
});

test("after eight wrong PINs from one address the next waits for the oldest to leave the window", () => {
  // Wrong at 1..8 minutes ago. The 8th newest is 8 minutes old, so there is room again in 7 minutes.
  const d = decideAttempt({ ip: fails(8), all: fails(8) }, NOW);
  assert.deepEqual(d, { allowed: false, retryAfterSeconds: 7 * 60, reason: "ip" });
});

test("only the eight newest count when more slipped in at once", () => {
  // Ten wrong, 1..10 minutes ago: room again when the 8th newest (8 minutes old) leaves.
  const d = decideAttempt({ ip: fails(10), all: fails(10) }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.retryAfterSeconds, 7 * 60);
});

test("wrong attempts older than 15 minutes are forgotten", () => {
  const old = Array.from({ length: 20 }, (_, i) => NOW - (15 * MIN + 1 + i * 1000));
  assert.deepEqual(decideAttempt({ ip: old, all: old }, NOW), { allowed: true });
  // Exactly 15 minutes old is outside the window too.
  const edge = Array.from({ length: 8 }, () => NOW - 15 * MIN);
  assert.deepEqual(decideAttempt({ ip: edge, all: edge }, NOW), { allowed: true });
});

test("the order the times come in does not matter", () => {
  const shuffled = [...fails(8)].reverse();
  const d = decideAttempt({ ip: shuffled, all: shuffled }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.retryAfterSeconds, 7 * 60);
});

test("sixty wrong PINs from many addresses stop everyone, even an address with none", () => {
  // 60 wrong in the last 15 minutes, none from this address.
  const all = Array.from({ length: 60 }, (_, i) => NOW - 10_000 - i * 10_000);
  const d = decideAttempt({ ip: [], all }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.equal(d.reason, "everyone");
    // The 60th newest is 600 s old: room again in 300 s.
    assert.equal(d.retryAfterSeconds, 300);
  }
  assert.deepEqual(decideAttempt({ ip: [], all: all.slice(0, 59) }, NOW), { allowed: true });
});

test("when both limits are reached the longer wait is given", () => {
  const ip = fails(8, 10); // the 8th newest is 17 minutes old: outside, so wait 0
  assert.deepEqual(decideAttempt({ ip, all: [] }, NOW), { allowed: true });
  const mine = fails(8, 6); // 6..13 minutes ago: room in 2 minutes
  const all = Array.from({ length: 60 }, (_, i) => NOW - 1000 - i * 1000); // 1..60 s ago: room in 14 minutes
  const d = decideAttempt({ ip: mine, all }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) {
    assert.equal(d.reason, "everyone");
    assert.equal(d.retryAfterSeconds, 15 * 60 - 60);
  }
});

test("the wait is never less than a second, and is rounded up", () => {
  // The 8th newest leaves the window 1 ms from now.
  const ip = [...fails(7), NOW - 15 * MIN + 1];
  const d = decideAttempt({ ip, all: ip }, NOW);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.equal(d.retryAfterSeconds, 1);
});

test("custom limits are honoured", () => {
  const limits = { windowMs: 60_000, perIp: 2, overall: 3 };
  assert.deepEqual(decideAttempt({ ip: [NOW - 1000], all: [NOW - 1000] }, NOW, limits), { allowed: true });
  const d = decideAttempt({ ip: [NOW - 1000, NOW - 2000], all: [NOW - 1000, NOW - 2000] }, NOW, limits);
  assert.deepEqual(d, { allowed: false, retryAfterSeconds: 58, reason: "ip" });
});

test("waits read in whole minutes, rounded up", () => {
  assert.equal(waitLabel(1), "1 minute");
  assert.equal(waitLabel(60), "1 minute");
  assert.equal(waitLabel(61), "2 minutes");
  assert.equal(waitLabel(7 * 60), "7 minutes");
});

test("the message says whose attempts caused the wait, in plain words", () => {
  assert.equal(
    blockedMessage({ allowed: false, retryAfterSeconds: 420, reason: "ip" }),
    "Too many wrong PINs from this connection. Try again in 7 minutes.",
  );
  assert.equal(
    blockedMessage({ allowed: false, retryAfterSeconds: 30, reason: "everyone" }),
    "Too many wrong PINs have been tried on this dashboard. Try again in 1 minute.",
  );
  for (const reason of ["ip", "everyone"] as const) {
    assert.doesNotMatch(blockedMessage({ allowed: false, retryAfterSeconds: 99, reason }), /[–—]/);
  }
});

test("the address is the first forwarded one, then x-real-ip, then unknown", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": " 2001:db8::1 " })), "2001:db8::1");
  assert.equal(clientIp(new Headers({ "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "", "x-real-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(new Headers()), "unknown");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "x".repeat(500) })).length, 100);
});
