import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import { rangeFor } from "@/lib/dateRanges";

// The Dashboard as a viewer sees it: the real component, its asks for figures
// answered by a stand-in fetch that says which range each answer is for.
// Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/CeoDashboard.test.ts

const { default: CeoDashboard } = await load<typeof import("@/components/CeoDashboard")>("components/CeoDashboard.tsx");

const FROM = "2026-01-01", TO = "2026-11-23";

/** Each feed's answer for a range, its deals counted as `deals` so a test can tell the ranges apart. */
function answerFor(path: string, q: URLSearchParams, deals: number): unknown {
  const from = q.get("from") ?? FROM, to = q.get("to") ?? TO;
  switch (path) {
    case "/api/company":
      return {
        connected: true, from, to, months: [from.slice(0, 7)], channels: ["Property Finder"],
        leads: { Sales: { "Property Finder": [deals * 10] }, Leasing: {} },
        deals: { Offplan: { "Property Finder": [deals] }, Secondary: {}, Leasing: {} },
        comm: { Offplan: { "Property Finder": [deals * 1000] }, Secondary: {}, Leasing: {} },
      };
    case "/api/portals":
      return { connected: true, rows: [{ portal: "Property Finder", leads: 100, viewings: 5, reservations: 7, reservedComm: 70000 }] };
    case "/api/digital":
      return { byDateFine: [{ cost: 5000, leads: 50 }], currencies: ["AED"] };
    case "/api/seo":
      return { gsc: { totals: { clicks: 1234, impressions: 99999 } }, gscRange: { from, to }, ai: { visitors: 321, organicVisitors: 3210, missing: [] } };
    case "/api/summary":
      return { pr: { mentions: 12, sov: 0.2, sovThroughLabel: null }, social: { followers: 5000, share: null, engagement: null, asOf: "2026-11-20" } };
  }
  throw new Error(`unexpected ask ${path}`);
}

/**
 * A stand-in fetch: every feed answers for the range it was asked for, with
 * `deals` deals. `hold` keeps back one URL's answer until released.
 */
function feeds(t: { after: (fn: () => void) => void }, deals: (q: URLSearchParams) => number, hold?: string) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((ok) => (release = ok));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const u = new URL(url, "http://dashboard.test");
    if (url === hold) await held;
    return new Response(JSON.stringify(answerFor(u.pathname, u.searchParams, deals(u.searchParams))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return { asked, release };
}

test("every figure asks for the year to date first, and the tiles name no period of their own", async (t) => {
  const { asked } = feeds(t, () => 2);
  const screen = await mount(h(CeoDashboard, { initialFrom: FROM, initialTo: TO }));
  t.after(() => screen.unmount());
  await screen.until(() => /Deals\s*2\b/.test(screen.text()) && /Press found by the bot\s*12\b/.test(screen.text()), "every tile to land");
  assert.deepEqual([...asked].sort(), [
    `/api/company?from=${FROM}&to=${TO}`,
    `/api/digital?from=${FROM}&to=${TO}`,
    `/api/portals?from=${FROM}&to=${TO}`,
    // A named range goes by its name, so the server resolves it on Dubai's calendar.
    "/api/seo?preset=this_year",
    `/api/summary?from=${FROM}&to=${TO}`,
  ]);
  const text = screen.text();
  assert.match(text, /Period/);
  assert.match(text, /1 Jan 2026 – 23 Nov 2026/);
  assert.match(text, /Paid spend\s*AED 5K/);
  assert.match(text, /Organic clicks\s*1,234/);
  assert.doesNotMatch(text, /· 90d|· 12m|this year/);
  assert.deepEqual(screen.caught, []);
});

test("picking a range asks every feed again for it, and an answer for the range before never lands", async (t) => {
  const last = rangeFor("last_month");
  // The year to date has 2 deals and last month 5; the year to date's company answer comes late.
  const { asked, release } = feeds(t, (q) => (q.get("from") === last.from ? 5 : 2), `/api/company?from=${FROM}&to=${TO}`);
  const screen = await mount(h(CeoDashboard, { initialFrom: FROM, initialTo: TO }));
  t.after(() => screen.unmount());
  await screen.until(() => /Organic clicks\s*1,234/.test(screen.text()), "the first figures");

  screen.type("Date range", "last_month");
  await screen.until(() => /Deals\s*5\b/.test(screen.text()), "last month's deals");
  for (const path of ["/api/company", "/api/portals", "/api/digital", "/api/summary"]) {
    assert.ok(asked.includes(`${path}?from=${last.from}&to=${last.to}`), `${path} not asked for last month`);
  }
  assert.ok(asked.includes("/api/seo?preset=last_month"));

  // The year to date's late answer lands now, and is dropped.
  release();
  await new Promise((ok) => setTimeout(ok, 50));
  assert.match(screen.text(), /Deals\s*5\b/);
  assert.doesNotMatch(screen.text(), /Deals\s*2\b/);
  assert.deepEqual(screen.caught, []);
});

test("a typed range goes to every feed, the SEO feed included, by its dates", async (t) => {
  const { asked } = feeds(t, () => 3);
  const screen = await mount(h(CeoDashboard, { initialFrom: FROM, initialTo: TO }));
  t.after(() => screen.unmount());
  screen.type("Date range", "custom");
  await screen.until(() => screen.buttons().includes("Apply"), "the boxes for typed dates");
  screen.type("From", "2026-03-01");
  screen.type("To", "2026-03-31");
  // As between a person's typing and their click: the boxes show what was typed before Apply reads them.
  await new Promise((ok) => setTimeout(ok, 20));
  screen.click("Apply");
  await screen.until(() => asked.includes("/api/seo?from=2026-03-01&to=2026-03-31"), "the typed range");
  assert.ok(asked.includes("/api/company?from=2026-03-01&to=2026-03-31"));
  await screen.until(() => /1 Mar 2026 – 31 Mar 2026/.test(screen.text()), "the range line");
});
