import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import type { CompanyDaily, CompanyData } from "@/lib/company";

// The Company tab as a viewer sees it: the real component, fed made-up months,
// its asks for day figures answered by a stand-in fetch. Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/CompanyPerformance.test.ts

const { default: CompanyPerformance } = await load<typeof import("@/components/CompanyPerformance")>("components/CompanyPerformance.tsx");

const PF = "Property Finder", BAYUT = "Bayut";
/** Three months, September to November; each figure easy to add up by hand. */
const blocks = {
  leads: { Sales: { [PF]: [100, 200, 50], [BAYUT]: [50, 100, 20] }, Leasing: { [PF]: [30, 60, 10], [BAYUT]: [20, 40, 5] } },
  deals: {
    Offplan: { [PF]: [2, 4, 1], [BAYUT]: [1, 2, 0] },
    Secondary: { [PF]: [3, 6, 1], [BAYUT]: [1, 3, 1] },
    Leasing: { [PF]: [5, 10, 2], [BAYUT]: [2, 4, 1] },
  },
  comm: {
    Offplan: { [PF]: [20_000, 40_000, 10_000], [BAYUT]: [10_000, 20_000, 0] },
    Secondary: { [PF]: [30_000, 60_000, 10_000], [BAYUT]: [10_000, 30_000, 10_000] },
    Leasing: { [PF]: [5_000, 10_000, 2_000], [BAYUT]: [2_000, 4_000, 1_000] },
  },
};
const data: CompanyData = {
  cachedAt: new Date(Date.now() - 5_000).toISOString(),
  connected: true,
  from: "2026-09-01",
  to: "2026-11-23",
  label: "1 Sep 2026 – 23 Nov 2026",
  months: ["2026-09", "2026-10", "2026-11"],
  channels: [PF, BAYUT],
  brands: [],
  brand: "",
  generatedAt: new Date().toISOString(),
  ...blocks,
  mtdDay: 23,
  leadsMtd: blocks.leads,
  dealsMtd: blocks.deals,
  commMtd: blocks.comm,
};
/** A month's days: two of them, carrying the month's figures between them. */
const daily = (month: string): CompanyDaily => ({
  month,
  brand: "",
  days: [`${month}-01`, `${month}-02`],
  channels: [PF, BAYUT],
  leads: { Sales: { [PF]: [1, 2], [BAYUT]: [1, 1] }, Leasing: { [PF]: [1, 0], [BAYUT]: [0, 1] } },
  deals: { Offplan: { [PF]: [1, 0], [BAYUT]: [0, 0] }, Secondary: { [PF]: [0, 1], [BAYUT]: [0, 0] }, Leasing: { [PF]: [1, 1], [BAYUT]: [0, 1] } },
  comm: { Offplan: { [PF]: [1000, 0], [BAYUT]: [0, 0] }, Secondary: { [PF]: [0, 2000], [BAYUT]: [0, 0] }, Leasing: { [PF]: [300, 300], [BAYUT]: [0, 200] } },
});

/** A stand-in fetch for the day figures; any other ask fails the test. */
function serve(t: { after: (fn: () => void) => void }) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const u = new URL(url, "http://dashboard.test");
    if (u.pathname !== "/api/company/daily") throw new Error(`unexpected ask ${url}`);
    return new Response(JSON.stringify(daily(u.searchParams.get("month") ?? "")), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test("the division is all, sales or leasing, and under sales a tick box each for off-plan and secondary", async (t) => {
  serve(t);
  const screen = await mount(h(CompanyPerformance, { initial: data }));
  t.after(() => screen.unmount());
  await screen.until(() => /Channel summary/.test(screen.text()), "the tab");
  // No separate off-plan or secondary pills: they are kinds of sale.
  assert.ok(!screen.buttons().includes("Off-plan") && !screen.buttons().includes("Secondary"), screen.buttons().join(" | "));
  assert.equal(screen.ticked("Off-plan"), null);

  screen.click("Sales");
  await screen.until(() => screen.ticked("Off-plan") === true && screen.ticked("Secondary") === true, "both kinds of sale ticked");
  assert.match(screen.text(), /Showing: sales · by month/);

  // Secondary unticked: off-plan sales alone, so conversion is withheld (enquiries carry no off-plan flag).
  screen.tick("Secondary");
  await screen.until(() => /Showing: off-plan sales · by month/.test(screen.text()), "off-plan sales alone");
  assert.match(screen.text(), /Conversion isn.t available for this division\./);
  // The last kind ticked stays ticked.
  assert.throws(() => screen.tick("Off-plan"), /disabled/);

  screen.click("Leasing");
  await screen.until(() => /Showing: leasing · by month/.test(screen.text()), "leasing");
  assert.equal(screen.ticked("Off-plan"), null);
  assert.deepEqual(screen.caught, []);
});

test("the month picked under Showing moves the conversion chart, the channel summary and the full data with it", async (t) => {
  const asked = serve(t);
  const screen = await mount(h(CompanyPerformance, { initial: data }));
  t.after(() => screen.unmount());
  // It opens on the month still running.
  await screen.until(() => /Deals ÷ leads · Nov ’26/.test(screen.text()), "November");

  screen.type("Showing", "2026-10");
  await screen.until(() => /Deals ÷ leads · Oct ’26/.test(screen.text()), "October");
  const text = screen.text();
  assert.match(text, /Oct ’26 · sorted by revenue/);
  // October's Property Finder: 200 + 60 leads, 4 + 6 + 10 deals.
  assert.match(text, /Property Finder\s*260\s*20\s/);
  assert.match(text, /for All brands in Oct ’26/);
  // The charts go day by day through October: its days are asked for.
  await screen.until(() => asked.includes("/api/company/daily?month=2026-10"), "October's days");

  // The whole range again: September to November, every month in the table.
  screen.type("Showing", "__all__");
  await screen.until(() => /Deals ÷ leads · Sep – Nov 2026/.test(screen.text()), "the entire period");
  // 2 + 4 + 1 off-plan, 3 + 6 + 1 secondary and 5 + 10 + 2 leasing deals.
  assert.match(screen.text(), /Property Finder\s*450\s*34\s/);
  assert.deepEqual(screen.caught, []);
});

test("channels are tick boxes: tick one or several and every figure counts only those; no period pills", async (t) => {
  serve(t);
  const screen = await mount(h(CompanyPerformance, { initial: data }));
  t.after(() => screen.unmount());
  await screen.until(() => /Channel summary/.test(screen.text()), "the tab");
  // The tab covers the year to date, so there is no "All / 2026 YTD" choice to make.
  assert.ok(!screen.buttons().some((b) => /YTD/.test(b)), screen.buttons().join(" | "));
  // November, every channel: 50 + 10 Property Finder leads and 20 + 5 Bayut.
  assert.match(screen.text(), /Leads received 85/);

  screen.click("All channels");
  await screen.until(() => screen.ticked("Property Finder") === false, "the channel list");
  assert.equal(screen.ticked("All channels"), true);

  screen.tick("Property Finder");
  await screen.until(() => /Showing: .* · Property Finder/.test(screen.text()), "Property Finder alone");
  assert.match(screen.text(), /Leads received 60/);
  assert.equal(screen.ticked("All channels"), false);

  // Unticking the last channel ticked goes back to every channel.
  screen.tick("Property Finder");
  await screen.until(() => /· all channels/.test(screen.text()) && screen.ticked("All channels") === true, "all channels again");
  assert.match(screen.text(), /Leads received 85/);
  assert.deepEqual(screen.caught, []);
});
