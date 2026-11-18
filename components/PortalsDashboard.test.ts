import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import type { PortalMetric, PortalsData } from "@/lib/portals";

// The Portals tab as a viewer sees it: the real component, rendered by React DOM
// into a stand-in document, fed August and September 2026 as the CRM gives them.
// Its live ask for the latest figures is answered by a stand-in fetch. Nothing
// reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/PortalsDashboard.test.ts

const { default: PortalsDashboard } = await load<typeof import("@/components/PortalsDashboard")>("components/PortalsDashboard.tsx");

const PORTALS = ["Property Finder", "Bayut", "Dubizzle"] as const;
const per = (pf: number[], bayut: number[], dubizzle: number[]) => ({ "Property Finder": pf, Bayut: bayut, Dubizzle: dubizzle });

const MONTHLY: Record<PortalMetric, Record<string, number[]>> = {
  leads: per([7083, 8582], [6631, 7101], [3, 38]),
  viewings: per([431, 359], [388, 340], [1, 2]),
  reservations: per([86, 151], [80, 106], [0, 2]),
  reservedComm: per([1397775, 2177794], [1277431, 1421716], [0, 31000]),
  invoiced: per([88, 127], [68, 102], [0, 2]),
  invoicedComm: per([1787017, 1815249], [1144783, 999227], [0, 31000]),
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function payload(over: Partial<PortalsData> = {}): PortalsData {
  return {
    connected: true,
    from: "2026-08-01",
    to: "2026-09-30",
    label: "2026-08-01 → 2026-09-30",
    months: ["2026-08", "2026-09"],
    portals: [...PORTALS],
    brands: [{ key: "", label: "All brands" }],
    brand: "",
    side: "all",
    generatedAt: "2026-11-18T05:00:00.000Z",
    cachedAt: minutesAgo(0.2),
    rows: PORTALS.map((p) => ({
      portal: p,
      ...(Object.fromEntries(Object.entries(MONTHLY).map(([m, s]) => [m, sum(s[p])])) as Record<PortalMetric, number>),
    })),
    monthly: MONTHLY,
    invoicedFrom: "2026-03",
    leadsLeftOut: 25,
    areas: [{ area: "Dubai Marina", listings: 120, reservations: 40, reservedComm: 800000 }],
    areaSource: "top-level locations.name",
    unmappedPortalIds: [],
    portalIdsAssumed: false,
    warnings: [],
    ...over,
  };
}

/** A stand-in fetch answering `body`, remembering each URL asked. Put back after the test. */
function answer(t: { after: (fn: () => void) => void }, body: () => unknown) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(JSON.stringify(body()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test("the tab shows each portal's figures and totals, with no month-by-month table and no spend", async (t) => {
  const asked = answer(t, () => assert.fail("a young answer needs no live ask"));
  const screen = await mount(h(PortalsDashboard, { initial: payload() }));
  t.after(() => screen.unmount());
  const text = screen.text();
  assert.deepEqual(screen.caught, []);
  assert.deepEqual(asked, []);

  // Each figure card: its label, its help mark, then the figure.
  assert.match(text, /Portal leads ?\? 29,438 /);
  assert.match(text, /Reserved commission ?\? AED 6\.31M/); // 1,397,775 + 2,177,794 + 1,277,431 + 1,421,716 + 31,000
  assert.match(text, /Invoiced commission ?\? AED 5\.78M/); // 1,787,017 + 1,815,249 + 1,144,783 + 999,227 + 31,000
  // Portal, leads, viewings, viewings per 100 leads, reservations, reserved commission, invoiced deals, invoiced commission.
  assert.match(text, /Property Finder 15,665 790 5\.0 237 AED 3\.58M 215 AED 3\.60M/);

  assert.doesNotMatch(text, /Month by month|share of the two/);
  for (const gone of [/Spend \/ month/, /Spend in period/, /Cost \/ lead/, /Cost \/ deal/, /Return on spend/, /PPA/]) assert.doesNotMatch(text, gone);

  // The trend offers leads, viewings, reservations and reserved commission; invoiced figures stay in the cards and table.
  const buttons = screen.buttons();
  for (const tab of ["Leads", "Viewings", "Reservations", "Reserved commission"]) assert.ok(buttons.includes(tab), `no "${tab}" tab`);
  assert.ok(!buttons.includes("Invoiced deals") && !buttons.includes("Invoiced commission"), "the trend still offers invoiced figures");
});

test("every figure follows the range: listings are those on a portal during it, and the left-out leads are counted, not typed in", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  const screen = await mount(h(PortalsDashboard, { initial: payload() }));
  t.after(() => screen.unmount());
  const text = screen.text();
  assert.doesNotMatch(text, /Listings live|snapshot of now/);
  // The areas are one chart with a tab per figure, not a table repeating the reservations.
  for (const tab of ["Commission per reservation", "Listings on portals"]) assert.ok(screen.buttons().includes(tab), `no "${tab}" tab`);
  assert.match(text, /Top areas\?? Dubai Marina leads with 40 reservations · 1 area/);
  assert.doesNotMatch(text, /Share of reservations|Comm \/ reservation/);
  assert.match(text, /Leads leave out test forms, staff and internal cards, as on every tab: 25 portal leads in this range\./);
});

test("an answer over a minute old is shown at once, then the latest is asked for and swapped in", async (t) => {
  const latest = payload({
    cachedAt: new Date().toISOString(),
    rows: payload().rows.map((r) => (r.portal === "Property Finder" ? { ...r, leads: 15700 } : r)),
  });
  const asked = answer(t, () => latest);
  const screen = await mount(h(PortalsDashboard, { initial: payload({ cachedAt: minutesAgo(12) }) }));
  t.after(() => screen.unmount());

  // The remembered figures are on screen straight away, and the tab says it is getting the latest.
  assert.match(screen.text(), /Property Finder 15,665 /);
  await screen.until(() => /Property Finder 15,700 /.test(screen.text()), "the latest figures to replace the remembered ones");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\/api\/portals\?from=2026-08-01&to=2026-09-30&side=all&live=1$/);
  assert.match(screen.text(), /updated just now/);
  assert.doesNotMatch(screen.text(), /getting the latest/);
  assert.deepEqual(screen.caught, []);
});

test("a live ask that fails keeps the figures shown, with no error box", async (t) => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  const screen = await mount(h(PortalsDashboard, { initial: payload({ cachedAt: minutesAgo(12) }) }));
  t.after(() => screen.unmount());
  await screen.until(() => !/getting the latest/.test(screen.text()), "the live ask to finish");
  const text = screen.text();
  assert.match(text, /Property Finder 15,665 /);
  assert.doesNotMatch(text, /Couldn't load that selection/);
});

test("a figure whose query failed reads as a dash in its total, never a zero", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  const blank = Object.fromEntries(PORTALS.map((p) => [p, [null, null]])) as Record<string, null[]>;
  const screen = await mount(
    h(PortalsDashboard, {
      initial: payload({
        monthly: { ...MONTHLY, viewings: blank },
        rows: payload().rows.map((r) => ({ ...r, viewings: null })),
        warnings: ["Viewings unavailable (timed out after 45s) — the other figures are still live."],
      }),
    }),
  );
  t.after(() => screen.unmount());
  const text = screen.text();
  assert.match(text, /Viewings completed ?\? — /);
  assert.match(text, /Property Finder 15,665 — — 237 /);
  assert.match(text, /Viewings unavailable \(timed out after 45s\)/);
});

test("months before the CRM recorded invoice dates are named, and a range after they began says nothing", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  const early = await mount(h(PortalsDashboard, { initial: payload({ from: "2026-01-01", invoicedFrom: "2026-03" }) }));
  t.after(() => early.unmount());
  assert.match(early.text(), /The CRM has recorded invoice dates since Mar 2026/);
  const later = await mount(h(PortalsDashboard, { initial: payload() }));
  t.after(() => later.unmount());
  assert.doesNotMatch(later.text(), /recorded invoice dates since/);
});

test("the area chart switches figure with its tabs, and ranks by the one chosen", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  const areas = [
    { area: "Dubai Marina", listings: 120, reservations: 40, reservedComm: 800000 },
    { area: "Palm Jumeirah", listings: 300, reservations: 10, reservedComm: 900000 },
    { area: "Al Barsha", listings: 50, reservations: 0, reservedComm: 0 },
  ];
  const screen = await mount(h(PortalsDashboard, { initial: payload({ areas }) }));
  t.after(() => screen.unmount());
  assert.match(screen.text(), /Dubai Marina leads with 40 reservations · 2 areas/);
  // The trend has a "Reserved commission" tab too; the area chart's is the second.
  screen.click("Reserved commission", 1);
  await screen.until(() => /Palm Jumeirah leads with AED 900K reserved commission · 2 areas/.test(screen.text()), "the commission ranking");
  assert.match(screen.text(), /Over time Each portal/, "the trend kept its own figure");
  // Commission per reservation leaves out an area with no reservations.
  screen.click("Commission per reservation");
  await screen.until(() => /Palm Jumeirah leads with AED 90,000 commission per reservation · 2 areas/.test(screen.text()), "the per-reservation ranking");
  screen.click("Listings on portals");
  await screen.until(() => /Palm Jumeirah leads with 300 listings on portals · 3 areas/.test(screen.text()), "the listings ranking");
});
