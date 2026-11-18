import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import type { PortalMetric, PortalsData } from "@/lib/portals";

// The Portals tab as a viewer sees it: the real component, rendered by React DOM
// into a stand-in document, fed August and September 2026 as the CRM gives them.
// Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/PortalsDashboard.test.ts

const { default: PortalsDashboard } = await load<typeof import("@/components/PortalsDashboard")>("components/PortalsDashboard.tsx");

const PORTALS = ["Property Finder", "Bayut", "Dubizzle"] as const;
const per = (pf: number[], bayut: number[], dubizzle: number[]) => ({ "Property Finder": pf, Bayut: bayut, Dubizzle: dubizzle });

// Aug and Sep 2026 per portal: Bayut and Dubizzle add up to the business's
// portal table (6,635 and 7,153 leads; 80 and 108 reservations, and so on).
const MONTHLY: Record<PortalMetric, Record<string, number[]>> = {
  leads: per([7088, 8602], [6632, 7115], [3, 38]),
  viewings: per([431, 360], [390, 341], [1, 2]),
  reservations: per([86, 151], [80, 106], [0, 2]),
  reservedComm: per([1397775, 2177794], [1277431, 1421716], [0, 31000]),
  invoiced: per([88, 127], [68, 102], [0, 2]),
  invoicedComm: per([1787017, 1815249], [1144783, 999227], [0, 31000]),
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function payload(over: Partial<PortalsData> = {}): PortalsData {
  return {
    connected: true,
    from: "2026-08-01",
    to: "2026-09-17",
    label: "2026-08-01 → 2026-09-17",
    months: ["2026-08", "2026-09"],
    portals: [...PORTALS],
    brands: [{ key: "", label: "All brands" }],
    brand: "",
    side: "all",
    generatedAt: "2026-11-18T05:00:00.000Z",
    rows: PORTALS.map((p) => ({
      portal: p,
      ...(Object.fromEntries(Object.entries(MONTHLY).map(([m, s]) => [m, sum(s[p])])) as Record<PortalMetric, number>),
      listings: null,
    })),
    monthly: MONTHLY,
    areas: [{ area: "Dubai Marina", listings: 120, reservations: 40, reservedComm: 800000 }],
    areaSource: "top-level locations.name",
    unmappedPortalIds: [],
    portalIdsAssumed: false,
    warnings: [],
    ...over,
  };
}

test("the month-by-month table sets Property Finder against Bayut + Dubizzle, as the business's portal table does", async (t) => {
  const screen = await mount(h(PortalsDashboard, { initial: payload() }));
  t.after(() => screen.unmount());
  const text = screen.text();
  assert.deepEqual(screen.caught, []);

  // Month, leads, viewings completed, viewings per 100 leads, reservations, reserved comm, invoiced deals, invoiced comm.
  assert.match(text, /Property Finder Aug 26 7,088 431 6\.1 86 AED 1\.40M 88 AED 1\.79M/);
  assert.match(text, /Bayut \+ Dubizzle Aug 26 6,635 391 5\.9 80 AED 1\.28M 68 AED 1\.14M/);
  assert.match(text, /Sep 26 \(to 17th\) 7,153 343 4\.8 108 AED 1\.45M 104 AED 1\.03M/);

  // Property Finder's share of the two, in the business table's August figures: 52% of leads, 61% of invoiced commission.
  assert.match(text, /Property Finder's share of the two Aug 26 52% 52% 52% 52% 56% 61%/);
});

test("the tab shows no portal spend, cost per lead or return on spend", async (t) => {
  const screen = await mount(h(PortalsDashboard, { initial: payload() }));
  t.after(() => screen.unmount());
  const text = screen.text();
  for (const gone of [/Spend \/ month/, /Spend in period/, /Cost \/ lead/, /Cost \/ deal/, /Return on spend/, /RoS/, /PPA/]) {
    assert.doesNotMatch(text, gone);
  }
  // Each KPI's label, its help mark, then the figure.
  assert.match(text, /Reserved commission \? AED 6\.31M/); // 1,397,775 + 2,177,794 + 1,277,431 + 1,421,716 + 31,000
  assert.match(text, /Invoiced commission \? AED 5\.78M/); // 1,787,017 + 1,815,249 + 1,144,783 + 999,227 + 31,000
});

test("a figure whose query failed reads as a dash in the month table and its total, never a zero", async (t) => {
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
  assert.match(text, /Bayut \+ Dubizzle Aug 26 6,635 — — 80 AED 1\.28M 68 AED 1\.14M/);
  assert.match(text, /Viewings completed \? — /);
  assert.match(text, /Viewings unavailable \(timed out after 45s\)/);
});
