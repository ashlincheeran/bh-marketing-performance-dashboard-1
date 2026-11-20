import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_MS, isOld, liveUrl, wantsLive } from "@/lib/live";

// When a tab asks for live figures (lib/live.ts).

test("an answer older than a minute is old; a younger one, or one with no time, is not", () => {
  const now = Date.parse("2026-11-18T08:00:00.000Z");
  assert.equal(isOld(new Date(now - LIVE_MS).toISOString(), now), true);
  assert.equal(isOld(new Date(now - LIVE_MS + 1000).toISOString(), now), false);
  assert.equal(isOld(null, now), false);
  assert.equal(isOld(undefined, now), false);
  assert.equal(isOld("not a time", now), false);
});

test("a live request is the same request with live=1", () => {
  assert.equal(liveUrl("/api/portals"), "/api/portals?live=1");
  assert.equal(liveUrl("/api/portals?from=2026-01-01&to=2026-11-18"), "/api/portals?from=2026-01-01&to=2026-11-18&live=1");
  assert.equal(wantsLive(new URLSearchParams("from=2026-01-01&live=1")), true);
  assert.equal(wantsLive(new URLSearchParams("from=2026-01-01")), false);
});
