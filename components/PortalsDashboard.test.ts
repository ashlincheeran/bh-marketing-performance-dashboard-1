import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import type { AreaRow, PortalMetric, PortalsData } from "@/lib/portals";

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
};
/** Leasing's months, unlike Sale's (MONTHLY), so a test can tell which side a line reads. */
const LEASING: Record<PortalMetric, Record<string, number[]>> = {
  leads: per([5100, 6300], [4600, 4900], [2, 30]),
  viewings: per([300, 250], [280, 260], [1, 1]),
  reservations: per([60, 120], [55, 80], [0, 2]),
  reservedComm: per([550000, 1240000], [680000, 720000], [0, 4000]),
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** One portal's figures in an area: reservations, and the rest in proportion, so a test can read any tab. */
const fig = (reservations: number) => ({ reservations, reservedComm: reservations * 20000, leads: reservations * 20, viewings: reservations * 2, listings: reservations * 3 });
/** An area as the CRM gives it, its totals the sum of its portals'. */
function area(name: string, pf: number, bayut: number, dubizzle: number, listings = (pf + bayut + dubizzle) * 3): AreaRow {
  const byPortal = { "Property Finder": fig(pf), Bayut: fig(bayut), Dubizzle: fig(dubizzle) };
  const total = (k: keyof ReturnType<typeof fig>) => Object.values(byPortal).reduce((n, x) => n + x[k], 0);
  return { area: name, listings, reservations: total("reservations"), reservedComm: total("reservedComm"), leads: total("leads"), viewings: total("viewings"), byPortal };
}
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
    emirates: ["dubai", "abu-dhabi", "sharjah"],
    generatedAt: "2026-11-18T05:00:00.000Z",
    cachedAt: minutesAgo(0.2),
    rows: PORTALS.map((p) => ({
      portal: p,
      ...(Object.fromEntries(Object.entries(MONTHLY).map(([m, s]) => [m, sum(s[p])])) as Record<PortalMetric, number>),
    })),
    monthly: MONTHLY,
    // The chart's stand-in (components/testRender.ts) keeps each line's figures, so the tests read which side a line shows.
    bySide: { sale: MONTHLY, leasing: LEASING },
    leadsLeftOut: 25,
    areas: [{ area: "Dubai Marina", listings: 120, reservations: 40, reservedComm: 800000, leads: 0, viewings: 0, byPortal: {} }],
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
  // Portal, leads, viewings, viewings per 100 leads, reservations, reserved commission.
  assert.match(text, /Property Finder 15,665 790 5\.0 237 AED 3\.58M/);
  // Nothing about invoices: the CRM has kept invoice dates only since March 2026, so no figure could stay whole.
  assert.doesNotMatch(text, /nvoic/);

  assert.doesNotMatch(text, /Month by month|share of the two/);
  for (const gone of [/Spend \/ month/, /Spend in period/, /Cost \/ lead/, /Cost \/ deal/, /Return on spend/, /PPA/]) assert.doesNotMatch(text, gone);

  // The trend offers leads, viewings, reservations and reserved commission.
  const buttons = screen.buttons();
  for (const tab of ["Leads", "Viewings", "Reservations", "Reserved commission"]) assert.ok(buttons.includes(tab), `no "${tab}" tab`);
  assert.ok(!buttons.some((b) => /nvoic/.test(b)), "a button still offers invoiced figures");
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

test("the area chart switches figure with its tabs, and ranks by the one chosen", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  const areas: AreaRow[] = [
    { area: "Dubai Marina", listings: 120, reservations: 40, reservedComm: 800000, leads: 0, viewings: 0, byPortal: {} },
    { area: "Palm Jumeirah", listings: 300, reservations: 10, reservedComm: 900000, leads: 0, viewings: 0, byPortal: {} },
    { area: "Al Barsha", listings: 50, reservations: 0, reservedComm: 0, leads: 0, viewings: 0, byPortal: {} },
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

test("the trend is one chart with a tick box for Sales, Leasing and each portal, drawing what is ticked", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  const screen = await mount(h(PortalsDashboard, { initial: payload() }));
  t.after(() => screen.unmount());
  assert.match(screen.text(), /Over time Each portal, month by month, for the figure chosen\. Tick what to draw: Sales lines are solid, Leasing lines dashed\./);
  // Everything ticked to start: a line for each side and portal, in one chart.
  for (const box of ["Sales", "Leasing", "Property Finder", "Bayut", "Dubizzle"]) assert.equal(screen.ticked(box), true, `${box} not ticked`);
  const lines = () => screen.charts().filter((c) => c.type === "line");
  assert.equal(lines().length, 1);
  assert.deepEqual(lines()[0].series, [
    "Property Finder · Sales", "Bayut · Sales", "Dubizzle · Sales",
    "Property Finder · Leasing", "Bayut · Leasing", "Dubizzle · Leasing",
  ]);
  // Each line reads its own side's figures; Leasing's are dashed.
  assert.deepEqual(lines()[0].values, [...PORTALS.map((p) => MONTHLY.leads[p]), ...PORTALS.map((p) => LEASING.leads[p])]);
  assert.deepEqual(lines()[0].dashed, [false, false, false, true, true, true]);

  screen.tick("Leasing");
  await screen.until(() => lines()[0]?.series.length === 3, "the leasing lines to go");
  assert.deepEqual(lines()[0].series, ["Property Finder · Sales", "Bayut · Sales", "Dubizzle · Sales"]);
  screen.tick("Dubizzle");
  await screen.until(() => lines()[0]?.series.length === 2, "Dubizzle to go");
  assert.deepEqual(lines()[0].series, ["Property Finder · Sales", "Bayut · Sales"]);

  // The figure tabs keep what is ticked, and the lines take the new figure.
  screen.click("Reservations");
  await screen.until(() => JSON.stringify(lines()[0]?.values) === JSON.stringify([MONTHLY.reservations["Property Finder"], MONTHLY.reservations.Bayut]), "the reservations lines");
  assert.equal(screen.ticked("Leasing"), false);
  assert.deepEqual(lines()[0].series, ["Property Finder · Sales", "Bayut · Sales"]);

  // Nothing left to draw says so, rather than an empty chart.
  screen.tick("Sales");
  await screen.until(() => /Nothing to draw: tick a side and a portal to draw a line\./.test(screen.text()), "the empty note");
  assert.equal(lines().length, 0);
  screen.tick("Leasing");
  await screen.until(() => lines()[0]?.series.length === 2, "leasing back");
  assert.deepEqual(lines()[0].series, ["Property Finder · Leasing", "Bayut · Leasing"]);
  assert.deepEqual(lines()[0].values, [LEASING.reservations["Property Finder"], LEASING.reservations.Bayut]);
  assert.deepEqual(lines()[0].dashed, [true, true]);
});

test("under Sale or Leasing the side is the filter's: only the portals have tick boxes", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  for (const [side, label] of [["sale", "Sales"], ["leasing", "Leasing"]] as const) {
    const screen = await mount(h(PortalsDashboard, { initial: payload({ side }) }));
    t.after(() => screen.unmount());
    assert.match(screen.text(), new RegExp(`Over time Each portal, month by month, for the figure chosen\\. ${label} only, as the Side filter is set\\.`));
    assert.equal(screen.ticked("Sales"), null);
    assert.equal(screen.ticked("Leasing"), null);
    const lines = () => screen.charts().filter((c) => c.type === "line");
    assert.deepEqual(lines()[0].series, ["Property Finder", "Bayut", "Dubizzle"]);
    // The filter's own side, drawn solid: with one side there are no dashes to explain.
    assert.deepEqual(lines()[0].values, PORTALS.map((p) => (side === "sale" ? MONTHLY : LEASING).leads[p]));
    assert.deepEqual(lines()[0].dashed, [false, false, false]);
    screen.tick("Bayut");
    await screen.until(() => lines()[0]?.series.length === 2, "Bayut to go");
    screen.tick("Property Finder");
    screen.tick("Dubizzle");
    await screen.until(() => /Nothing to draw: tick a portal to draw a line\./.test(screen.text()), "the empty note");
  }
});

test("each area's bar is split by portal with each portal's share written on it, and leads and viewings have tabs", async (t) => {
  answer(t, () => assert.fail("no live ask"));
  const areas = [area("Dubai Marina", 30, 10, 0), area("Yas Island", 4, 4, 2)];
  const screen = await mount(h(PortalsDashboard, { initial: payload({ areas }) }));
  t.after(() => screen.unmount());
  const text = screen.text();
  // Reservations: 30 of 40 on Property Finder and 10 on Bayut, written beside the bar; Dubizzle has no part.
  // Every share is written, however short the bar.
  assert.match(text, /share of the area's reservations Dubai Marina 75%25% 40 Yas Island 40%40%20% 10/);
  for (const tab of ["Leads", "Viewings"]) assert.equal(screen.buttons().filter((b) => b === tab).length, 2, `the areas have no "${tab}" tab`);
  // The trend's Leads tab comes first; the area chart's is the second.
  screen.click("Leads", 1);
  await screen.until(() => /Dubai Marina leads with 800 leads · 2 areas/.test(screen.text()), "the leads ranking");
  assert.match(screen.text(), /share of the area's leads Dubai Marina 75%25% 800/);
  screen.click("Viewings", 1);
  await screen.until(() => /Dubai Marina leads with 80 viewings completed · 2 areas/.test(screen.text()), "the viewings ranking");
  // An average is not split: its bar has no shares on it.
  screen.click("Commission per reservation");
  await screen.until(() => /leads with AED 20,000 commission per reservation/.test(screen.text()), "the per-reservation ranking");
  assert.doesNotMatch(screen.text(), /share of the area's commission/);
});

test("the emirate tick boxes narrow every figure, and the last one ticked stays ticked", async (t) => {
  let answerWith: Partial<PortalsData> = { emirates: ["dubai", "abu-dhabi"] };
  const asked = answer(t, () => payload({ ...answerWith, cachedAt: new Date().toISOString() }));
  const screen = await mount(h(PortalsDashboard, { initial: payload() }));
  t.after(() => screen.unmount());
  for (const box of ["Dubai", "Abu Dhabi", "Sharjah"]) assert.equal(screen.ticked(box), true, `${box} not ticked`);
  assert.doesNotMatch(screen.text(), / only/);

  screen.tick("Sharjah");
  await screen.until(() => /Dubai and Abu Dhabi only/.test(screen.text()), "the narrowed figures");
  assert.match(asked[0], /^\/api\/portals\?from=2026-08-01&to=2026-09-30&side=all&emirates=dubai%2Cabu-dhabi$/);
  assert.equal(screen.ticked("Sharjah"), false);

  answerWith = { emirates: ["dubai"] };
  screen.tick("Abu Dhabi");
  await screen.until(() => /Dubai only/.test(screen.text()), "Dubai alone");
  assert.match(asked[1], /emirates=dubai$/);
  // The last one ticked can't be unticked: nothing would be left to show.
  assert.throws(() => screen.tick("Dubai"));
  assert.equal(screen.ticked("Dubai"), true);

  // Every emirate ticked again narrows nothing, and the address leaves them out.
  answerWith = { emirates: ["dubai", "sharjah"] };
  screen.tick("Sharjah");
  await screen.until(() => /Dubai and Sharjah only/.test(screen.text()), "Sharjah back");
  answerWith = { emirates: ["dubai", "abu-dhabi", "sharjah"] };
  screen.tick("Abu Dhabi");
  await screen.until(() => asked.length === 4 && !/ only/.test(screen.text()), "all three again");
  assert.match(asked[3], /^\/api\/portals\?from=2026-08-01&to=2026-09-30&side=all$/);
  assert.deepEqual(screen.caught, []);
});
