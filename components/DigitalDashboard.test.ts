import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import type { PaidData } from "@/lib/paid";
import type { PipelineData } from "@/lib/digitalPipeline";

// The Digital tab, the Digital Pipeline Scorecard, as a viewer sees it: the real
// page, rendered by React DOM into a stand-in document, fed one Google and one
// Meta campaign by a stand-in fetch for the ad data and the CRM. Nothing
// reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/DigitalDashboard.test.ts

const { default: DigitalDashboard } = await load<typeof import("@/components/DigitalDashboard")>("components/DigitalDashboard.tsx");

const CONFIG = { accounts: { google: [{ id: "g1", name: "Betterhomes" }], meta: [{ id: "m1", name: "BH Meta" }], linkedin: [] } };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const day = (date: string, platform: "google" | "meta", campaign: string, campaignId: string | null, cost: number, impressions: number, clicks: number, leads: number) => ({
  date, platform, campaign, campaignId, cost, impressions, clicks, leads,
});
const row = (platform: "google" | "meta", campaign: string, campaignId: string | null) =>
  ({ platform, accountId: platform === "google" ? "g1" : "m1", accountName: "x", campaign, campaignId, currency: "AED", cost: 0, impressions: 0, clicks: 0 }) as unknown as PaidData["rows"][number];

const PAID: PaidData = {
  connected: true, label: "2026-01-01 → 2026-11-18", from: "2026-01-01", to: "2026-11-18", level: "ad",
  rows: [row("google", "GGL_Search_CT1", null), row("meta", "BH-Webinar", "1202")],
  byDateFine: [
    day("2026-02-03", "google", "GGL_Search_CT1", null, 1000, 50000, 900, 4),
    day("2026-05-10", "google", "GGL_Search_CT1", null, 3000, 100000, 2100, 10),
    day("2026-04-02", "meta", "BH-Webinar", "1202", 2000, 80000, 1200, 30),
    day("2026-08-15", "meta", "BH-Webinar", "1202", 4000, 70000, 800, 20),
  ],
  truncated: false, currencies: ["AED"], accountsUsed: [], emptyAccounts: [], failures: [], unconfigured: false,
  spendAsOf: "2026-11-18T04:20:00.000Z",
};

const cell = (campaign: string, month: string, f: Partial<PipelineData["cells"][number]>) => ({
  campaign, month, leads: 0, people: 0, viewed: 0, viewedDone: 0, listings: 0, deals: 0, directDeals: 0, commission: 0, directCommission: 0, reservedCommission: 0, dealValue: 0, ...f,
});
function crm(over: Partial<PipelineData> = {}): PipelineData {
  return {
    connected: true, from: "2026-01-01", to: "2026-11-18", cachedAt: minutesAgo(0.2), truncated: false,
    cells: [
      cell("ggl_search_ct1", "2026-02", { leads: 30, people: 25, viewed: 3, viewedDone: 1, listings: 2, deals: 1, directDeals: 1, commission: 20000, directCommission: 20000, dealValue: 1_000_000 }),
      cell("ggl_search_ct1", "2026-05", { leads: 20, people: 15, viewed: 1, viewedDone: 1 }),
      // A Meta campaign's leads carry its name or its id: both are its own.
      cell("bh-webinar", "2026-04", { leads: 40, people: 38 }),
      cell("1202", "2026-04", { leads: 12, people: 12, viewed: 1, deals: 1, commission: 30000, reservedCommission: 30000, dealValue: 2_000_000 }),
      cell("1202", "2026-08", { leads: 10, people: 10 }),
    ],
    sources: [{ campaign: "1202", month: "2026-04", source: "Bayut", deals: 1, commission: 30000 }],
    codes: [
      { campaign: "ggl_search_ct1", code: "ggl_search_ct1", leads: 50 },
      { campaign: "ggl_search_ct1", code: "bh-list-with-us", leads: 10 },
      { campaign: "bh-webinar", code: "webinar-2026", leads: 40 },
      { campaign: "1202", code: "webinar-2026", leads: 22 },
      { campaign: "1202", code: "bh-investors", leads: 5 },
    ],
    ...over,
  };
}

/** Stand-in fetch: the ad data on GET /api/digital, the CRM on POST /api/digital/pipeline. Put back after the test. */
function stand(t: { after: (fn: () => void) => void }, pipeline: () => { status?: number; body: unknown }) {
  const real = globalThis.fetch;
  const asked: { url: string; body?: { from: string; to: string; campaigns: string[] } }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/digital/pipeline")) {
      asked.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const a = pipeline();
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }
    asked.push({ url });
    return new Response(JSON.stringify(PAID), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

async function open(t: { after: (fn: () => void) => void }, pipeline: () => { status?: number; body: unknown } = () => ({ body: crm() })) {
  const asked = stand(t, pipeline);
  const screen = await mount(h(DigitalDashboard, { config: CONFIG }));
  t.after(() => screen.unmount());
  return { screen, asked };
}
const ready = (screen: { until: (c: () => boolean, w: string) => Promise<void>; text: () => string }) =>
  screen.until(() => /Paid leads in the CRM\?? 100 /.test(screen.text()), "the CRM figures");

test("the tab is the scorecard: its cards, grid, KPI table, paid impact, leads by quarter and campaigns, and none of the old tab", async (t) => {
  const { screen, asked } = await open(t);
  await ready(screen);
  const text = screen.text();
  assert.deepEqual(screen.caught, []);
  assert.match(text, /Digital Pipeline Scorecard/);
  for (const part of ["KPI scorecard", "Paid impact: direct and indirect", "Paid leads by quarter", "Campaigns", "Leads by month: each campaign"]) assert.ok(text.includes(part), `no "${part}"`);
  // Above the notes, which name what was left out: no old sections, no targets, roles, cohorts or reach.
  const page = text.slice(0, text.indexOf("Notes"));
  for (const gone of ["Lead funnel", "Campaign tree", "Explorer", "Feeder", "Harvest", "Tactical", "cohort", "2027", "Target", "target", "Reach", "Audience built"])
    assert.ok(!page.includes(gone), `still shows "${gone}"`);
  assert.match(text, /Notes .*Left out of the original scorecard/);
  // Asked the ad data first, then the CRM about every campaign name and Meta id in it.
  assert.equal(asked.length, 2);
  assert.match(asked[0].url, /^\/api\/digital\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d&level=ad$/);
  assert.equal(asked[1].url, "/api/digital/pipeline");
  assert.deepEqual(asked[1].body, { from: "2026-01-01", to: "2026-11-18", campaigns: ["1202", "bh-webinar", "ggl_search_ct1"] });
});

test("the nine cards add up the ad data and the CRM the scorecard's way", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  const text = screen.text();
  assert.match(text, /Impressions\?? 300K CPM AED 33\.33 cost per 1,000 impressions/);
  assert.match(text, /Clicks\?? 5\.0K AED 2\.00 per click 1\.7% click rate/);
  assert.match(text, /Platform-reported leads\?? 64 AED 156 per platform lead 1\.3% of clicks/);
  assert.match(text, /Paid leads in the CRM\?? 100 CPL AED 100 2\.0% of clicks became a lead/);
  assert.match(text, /Viewings\?? 5 AED 2\.0K per viewing 5\.0% lead to viewing rate, 2 marked completed, 2 listings won at AED 5\.0K each/);
  assert.match(text, /Deals\?? 2 CPA AED 5\.0K 2\.0% lead to deal rate/);
  assert.match(text, /Revenue: gross commission\?? AED 50K cost is 20\.0% of commission deal value AED 3\.00M/);
  assert.match(text, /Paid spend\?? AED 10K average AED 943 a month/);
  assert.match(text, /Marketing cost as % of commission\?? 20\.0% AED 10K spend on AED 50K commission commission is 5\.0x the spend/);
  // Paid impact: direct and indirect deals per campaign, then where the indirect ones came through.
  assert.match(text, /GGL_Search_CT1 1 \/ 0 · AED 20K · ROI 5\.0x/);
  assert.match(text, /BH-Webinar 0 \/ 1 · AED 30K · ROI 5\.0x/);
  assert.match(text, /All selected campaigns: 2 deals, AED 50K commission on AED 10K spend, ROI 5\.0x\./);
  assert.match(text, /Where indirect deals came through.* Bayut 1 · AED 30K/);
  // Paid leads by quarter, from the people's first paid lead.
  assert.match(text, /Q1 2026 25 leads Q2 2026 65 leads Q3 2026 10 leads Q4 2026 to date 0 leads/);
});

test("a card picks the grid's figure, which shows each campaign by month or what each costs", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  // Most spend first; a month with no spend and no result stays empty.
  assert.match(screen.text(), /BH-Webinar 50 10 GGL_Search_CT1 25 15 All selected campaigns 25 50 15 10/);
  screen.click("Cost per lead");
  await screen.until(() => /Cost per lead by month: each campaign/.test(screen.text()), "the cost grid");
  assert.match(screen.text(), /BH-Webinar 40\.00 400 GGL_Search_CT1 40\.00 200/);
  screen.click("Deals");
  await screen.until(() => /Deals by month: each campaign/.test(screen.text()), "the deals grid");
  // Meta ran in April (its one deal) and August; Google in February (its deal) and May.
  assert.match(screen.text(), /BH-Webinar 1 0 GGL_Search_CT1 1 0 All selected campaigns 1 1 0 0/);
});

test("Show trend opens the card's figure by quarter or month, per period or as a running total", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  screen.click("Show trend", 5); // Deals
  await screen.until(() => /Deals by quarter/.test(screen.text()), "the trend");
  assert.match(screen.text(), /Q1 2026 1 Q2 2026 1 Q3 2026 0 Q4 2026 to date 0/);
  screen.click("Cumulative");
  await screen.until(() => /Deals, running total/.test(screen.text()), "the running total");
  assert.match(screen.text(), /Q1 2026 1 Q2 2026 2 Q3 2026 2 Q4 2026 to date 2/);
  screen.click("Monthly");
  await screen.until(() => /Jan 0 Feb 1 Mar 1 Apr 2/.test(screen.text()), "the months");
  screen.click("Close");
  await screen.until(() => !/running total/.test(screen.text()), "the trend to close");
});

test("selecting a campaign in the table filters the whole page to it, and selecting it again shows every campaign", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  assert.match(screen.text(), /GGL_Search_CT1 Google Ads · ggl_search_ct1 · bh-list-with-us AED 4\.0K 150K 3\.0K 14 40 4 2 1 AED 20K AED 100 AED 4\.0K 20\.0%/);
  assert.match(screen.text(), /BH-Webinar Meta Ads · webinar-2026 · bh-investors AED 6\.0K 150K 2\.0K 50 60 1 0 1 AED 30K AED 100 AED 6\.0K 20\.0%/);
  screen.click("GGL_Search_CT1");
  await screen.until(() => /Paid leads in the CRM\?? 40 /.test(screen.text()), "the page filtered to the campaign");
  assert.match(screen.text(), /Leads by month: GGL_Search_CT1/);
  assert.doesNotMatch(screen.text(), /BH-Webinar Meta Ads/);
  screen.click("GGL_Search_CT1");
  await screen.until(() => /Paid leads in the CRM\?? 100 /.test(screen.text()), "every campaign again");
});

test("period, platform and Engage code each narrow the page, and Reset filters puts it back", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  screen.type("Period", "Q2 2026");
  await screen.until(() => /Paid leads in the CRM\?? 65 /.test(screen.text()), "the second quarter");
  assert.match(screen.text(), /Paid spend\?? AED 5\.0K/);
  screen.type("Period", "all");
  screen.type("Platform", "meta");
  await screen.until(() => /Paid leads in the CRM\?? 60 /.test(screen.text()), "Meta only");
  screen.type("Platform", "all");
  screen.type("Campaign code", "bh-list-with-us");
  await screen.until(() => /Paid leads in the CRM\?? 40 /.test(screen.text()), "the campaigns under one code");
  screen.click("Reset filters");
  await screen.until(() => /Paid leads in the CRM\?? 100 /.test(screen.text()), "the full view");
});

test("a CRM that fails leaves the ad figures standing and every CRM figure a dash, never a zero", async (t) => {
  const { screen } = await open(t, () => ({ status: 500, body: { error: "timed out after 60s" } }));
  await screen.until(() => /could not be read/.test(screen.text()), "the failure notice");
  const text = screen.text();
  assert.match(text, /The CRM half could not be read: timed out after 60s\./);
  assert.match(text, /Impressions\?? 300K/);
  assert.match(text, /Paid leads in the CRM\?? — /);
  assert.match(text, /Deals\?? — /);
  assert.doesNotMatch(text, /Paid leads in the CRM\?? 0 /);
});

test("a CRM answer over a minute old is shown, then the latest is asked for and swapped in", async (t) => {
  let n = 0;
  const { screen, asked } = await open(t, () =>
    ++n === 1 ? { body: crm({ cachedAt: minutesAgo(12) }) } : { body: crm({ cachedAt: new Date().toISOString(), cells: [cell("ggl_search_ct1", "2026-02", { leads: 130, people: 120 })], sources: [] }) },
  );
  await screen.until(() => /Paid leads in the CRM\?? 120 /.test(screen.text()), "the latest figures");
  assert.equal(asked.filter((a) => a.url.startsWith("/api/digital/pipeline")).length, 2);
  assert.equal(asked[asked.length - 1].url, "/api/digital/pipeline?live=1");
});
