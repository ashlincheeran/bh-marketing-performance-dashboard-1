import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount, reset, router } from "@/components/testRender";
import type { RefreshStatus } from "@/lib/data";

// Refresh everything on Settings as an admin sees it: the real component,
// rendered by React DOM into a stand-in document, its call to /api/refresh
// answered by a stand-in fetch. Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/RefreshEverything.test.ts

const { default: RefreshEverything } = await load<typeof import("@/components/RefreshEverything")>("components/RefreshEverything.tsx");

const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString();
const STATUS: RefreshStatus = {
  news: { at: HOUR_AGO, ok: true, error: null },
  newsWorking: false,
  ads: HOUR_AGO,
  socials: { at: HOUR_AGO, ok: false, error: "Apify ran out of memory" },
  people: null,
};

/** A stand-in for the browser's fetch that answers `respond` and remembers what was asked. */
function answer(t: { after: (fn: () => void) => void }, respond: () => Promise<Response>) {
  const real = globalThis.fetch;
  const asked: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method ?? "GET" });
    return respond();
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = real));
  return asked;
}

async function screenFor(t: { after: (fn: () => void) => void }, status = STATUS) {
  reset();
  const screen = await mount(h(RefreshEverything, { status }));
  t.after(() => screen.unmount());
  return screen;
}

test("each bot is listed with when it last ran, a failure in its own words", async (t) => {
  const screen = await screenFor(t);
  const text = screen.text();
  for (const name of ["News bot", "Ads data", "People sentiment", "Socials benchmark"]) assert.ok(text.includes(name), name);
  assert.ok(text.includes("Last ran"));
  assert.ok(text.includes("Last synced"));
  assert.ok(text.includes("Failed") && text.includes("Apify ran out of memory"));
  assert.ok(text.includes("Not run yet"));
  assert.ok(text.includes("The weekly email is not sent."));
  assert.doesNotMatch(text, /—/);
});

test("nothing runs until the confirm, and Cancel runs nothing", async (t) => {
  const asked = answer(t, async () => Response.json({ news: { started: true, note: "Started." } }, { status: 202 }));
  const screen = await screenFor(t);
  screen.click("Refresh everything");
  await screen.until(() => screen.text().includes("Run all four now?"), "the confirm");
  assert.deepEqual(asked, []);
  screen.click("Cancel");
  await screen.until(() => screen.buttons().includes("Refresh everything"), "the button again");
  assert.deepEqual(asked, []);
});

test("Yes starts everything with one POST, says what started and looks again", async (t) => {
  const asked = answer(t, async () => Response.json({ news: { started: true, note: "Started." } }, { status: 202 }));
  const screen = await screenFor(t);
  screen.click("Refresh everything");
  await screen.until(() => screen.buttons().includes("Yes, run them"), "the confirm");
  screen.click("Yes, run them");
  await screen.until(() => screen.text().includes("The news bot has started."), "the started message");
  assert.deepEqual(asked, [{ url: "/api/refresh", method: "POST" }]);
  assert.ok(screen.text().includes("up to about 15 minutes"));
  assert.ok(router.refreshes >= 1);
  // Once started it can't be pressed again from this page.
  assert.equal(screen.enabled("Started"), false);
});

test("a news run already working is said, and a timed-out PIN says how to get back in", async (t) => {
  answer(t, async () => Response.json({ news: { started: false, note: "A news run is working now, so it was left to finish." } }, { status: 202 }));
  const screen = await screenFor(t);
  screen.click("Refresh everything");
  await screen.until(() => screen.buttons().includes("Yes, run them"), "the confirm");
  screen.click("Yes, run them");
  await screen.until(() => screen.text().includes("A news run is working now"), "the news note");

  const locked = answer(t, async () => Response.json({ error: "locked", scope: "settings" }, { status: 401 }));
  const again = await screenFor(t);
  again.click("Refresh everything");
  await again.until(() => again.buttons().includes("Yes, run them"), "the confirm");
  again.click("Yes, run them");
  await again.until(() => again.text().includes("The settings PIN has timed out"), "the PIN message");
  assert.equal(locked.length, 1);
  assert.equal(again.enabled("Refresh everything"), true);
});
