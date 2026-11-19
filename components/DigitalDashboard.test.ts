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
  campaign, month, leads: 0, viewed: 0, viewedDone: 0, listings: 0, deals: 0, commission: 0, reservedCommission: 0, dealValue: 0, ...f,
});
function crm(over: Partial<PipelineData> = {}): PipelineData {
  return {
    connected: true, from: "2026-01-01", to: "2026-11-18", cachedAt: minutesAgo(0.2), truncated: false,
    cells: [
      cell("ggl_search_ct1", "2026-02", { leads: 30, viewed: 3, viewedDone: 1, listings: 2, deals: 1, commission: 20000, dealValue: 1_000_000 }),
      cell("ggl_search_ct1", "2026-05", { leads: 20, viewed: 1, viewedDone: 1 }),
      // A Meta campaign's leads carry its name or its id: both are its own.
      cell("bh-webinar", "2026-04", { leads: 40 }),
      cell("1202", "2026-04", { leads: 12, viewed: 1, deals: 1, commission: 30000, reservedCommission: 30000, dealValue: 2_000_000 }),
      cell("1202", "2026-08", { leads: 10 }),
    ],
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

type CrmReply = { status?: number; body: unknown };

/** Stand-in fetch: the ad data on GET /api/digital, the CRM on POST /api/digital/pipeline. Put back after the test. */
function stand(t: { after: (fn: () => void) => void }, pipeline: () => CrmReply | Promise<CrmReply>, paid: PaidData = PAID) {
  const real = globalThis.fetch;
  const asked: { url: string; body?: { from: string; to: string; campaigns: string[] } }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/digital/pipeline")) {
      asked.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const a = await pipeline();
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }
    asked.push({ url });
    return new Response(JSON.stringify(paid), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

async function open(t: { after: (fn: () => void) => void }, pipeline: () => CrmReply | Promise<CrmReply> = () => ({ body: crm() }), paid: PaidData = PAID) {
  const asked = stand(t, pipeline, paid);
  const screen = await mount(h(DigitalDashboard, { config: CONFIG }));
  t.after(() => screen.unmount());
  return { screen, asked };
}
const ready = (screen: { until: (c: () => boolean, w: string) => Promise<void>; text: () => string }) =>
  screen.until(() => /Paid leads in the CRM\?? 112 /.test(screen.text()), "the CRM figures");

/** Open a searchable picker by the words on its button, search it, and take the first match with Enter. */
async function pick(screen: Awaited<ReturnType<typeof mount>>, button: string, label: string, query: string) {
  screen.click(button);
  await screen.until(() => {
    try {
      screen.type(`Search ${label}`, query);
      return true;
    } catch {
      return false;
    }
  }, `the ${label} search box`);
  // Typing hides the list's own "All…" line: once it has gone, the list is narrowed.
  await screen.until(() => screen.buttons().filter((b) => b === button).length <= 1, `the ${label} list to narrow`);
  screen.press(`Search ${label}`, "Enter");
}

/** The quarter the test's range ends in: "to date" while that is today, "(part)" after. */
const Q4 = "Q4 2026 (?:to date|\\(part\\))";

test("the tab is the scorecard: its cards, grid, KPI table, paid impact, leads by quarter and campaigns, and none of the old tab", async (t) => {
  const { screen, asked } = await open(t);
  await ready(screen);
  const text = screen.text();
  assert.deepEqual(screen.caught, []);
  assert.match(text, /Digital Pipeline Scorecard/);
  for (const part of ["KPI scorecard", "Paid leads by quarter", "Campaigns", "Leads by month: each campaign"]) assert.ok(text.includes(part), `no "${part}"`);
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
  assert.match(text, /Paid leads in the CRM\?? 112 CPL AED 89 2\.2% of clicks became a lead/);
  assert.match(text, /Viewings\?? 5 AED 2\.0K per viewing 4\.5% lead to viewing rate, 2 marked completed, 2 listings at AED 5\.0K each/);
  assert.match(text, /Deals\?? 2 CPA AED 5\.0K 1\.8% lead to deal rate/);
  assert.match(text, /Revenue: gross commission\?? AED 50K cost is 20\.0% of commission deal value AED 3\.00M/);
  assert.match(text, /Paid spend\?? AED 10K average AED 943 a month/);
  assert.match(text, /Marketing cost as % of commission\?? 20\.0% AED 10K spend on AED 50K commission commission is 5\.0x the spend/);
  // No direct or indirect credit: the CRM does not record it.
  assert.doesNotMatch(text, /Paid impact|indirect deals|ROI \d/);
  // Paid leads by quarter, by when the leads came in.
  assert.match(text, new RegExp(`Q1 2026 30 leads Q2 2026 72 leads Q3 2026 10 leads ${Q4} 0 leads`));
});

test("a card picks the grid's figure, which shows each campaign by month or what each costs", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  // Most spend first; a month with no spend and no result stays empty.
  assert.match(screen.text(), /BH-Webinar 52 10 GGL_Search_CT1 30 20 All selected campaigns 30 52 20 10/);
  screen.click("Cost per lead");
  await screen.until(() => /Cost per lead by month: each campaign/.test(screen.text()), "the cost grid");
  assert.match(screen.text(), /BH-Webinar 38\.46 400 GGL_Search_CT1 33\.33 150/);
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
  assert.match(screen.text(), new RegExp(`Q1 2026 1 Q2 2026 1 Q3 2026 0 ${Q4} 0`));
  screen.click("Cumulative");
  await screen.until(() => /Deals, running total/.test(screen.text()), "the running total");
  assert.match(screen.text(), new RegExp(`Q1 2026 1 Q2 2026 2 Q3 2026 2 ${Q4} 2`));
  screen.click("Monthly");
  await screen.until(() => /Jan 0 Feb 1 Mar 1 Apr 2/.test(screen.text()), "the months");
  screen.click("Close");
  await screen.until(() => !/running total/.test(screen.text()), "the trend to close");
});

test("selecting a campaign in the table filters the whole page to it, and selecting it again shows every campaign", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  assert.match(screen.text(), /GGL_Search_CT1 Google Ads · ggl_search_ct1 · bh-list-with-us AED 4\.0K 150K 3\.0K 14 50 4 2 1 AED 20K AED 80 AED 4\.0K 20\.0%/);
  assert.match(screen.text(), /BH-Webinar Meta Ads · webinar-2026 · bh-investors AED 6\.0K 150K 2\.0K 50 62 1 0 1 AED 30K AED 97 AED 6\.0K 20\.0%/);
  screen.click("GGL_Search_CT1");
  await screen.until(() => /Paid leads in the CRM\?? 50 /.test(screen.text()), "the page filtered to the campaign");
  assert.match(screen.text(), /Leads by month: GGL_Search_CT1/);
  assert.doesNotMatch(screen.text(), /BH-Webinar Meta Ads/);
  screen.click("Show every campaign again");
  await screen.until(() => /Paid leads in the CRM\?? 112 /.test(screen.text()), "every campaign again");
});

test("period, platform and Engage code each narrow the page, and Reset filters puts it back", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  screen.type("Period", "Q2 2026");
  await screen.until(() => /Paid leads in the CRM\?? 72 /.test(screen.text()), "the second quarter");
  assert.match(screen.text(), /Paid spend\?? AED 5\.0K/);
  screen.type("Period", "all");
  screen.type("Platform", "meta");
  await screen.until(() => /Paid leads in the CRM\?? 62 /.test(screen.text()), "Meta only");
  screen.type("Platform", "all");
  await pick(screen, "All codes", "campaign code", "bh-list-with-us");
  await screen.until(() => /Paid leads in the CRM\?? 50 /.test(screen.text()), "the campaigns under one code");
  screen.click("Reset filters");
  await screen.until(() => /Paid leads in the CRM\?? 112 /.test(screen.text()), "the full view");
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
    ++n === 1 ? { body: crm({ cachedAt: minutesAgo(12) }) } : { body: crm({ cachedAt: new Date().toISOString(), cells: [cell("ggl_search_ct1", "2026-02", { leads: 130 })] }) },
  );
  await screen.until(() => /Paid leads in the CRM\?? 130 /.test(screen.text()), "the latest figures");
  assert.equal(asked.filter((a) => a.url.startsWith("/api/digital/pipeline")).length, 2);
  assert.equal(asked[asked.length - 1].url, "/api/digital/pipeline?live=1");
});

test("changing platform drops a code the platform's campaigns do not carry, so the page never empties under 'All codes'", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  await pick(screen, "All codes", "campaign code", "bh-list-with-us"); // Google only
  await screen.until(() => /Paid leads in the CRM\?? 50 /.test(screen.text()), "the code's campaigns");
  screen.type("Platform", "meta");
  await screen.until(() => /Paid leads in the CRM\?? 62 /.test(screen.text()), "Meta, with the code dropped");
  assert.doesNotMatch(screen.text(), /No campaigns match/);
});

test("a picked code waits for the CRM on a new range, with the ad figures shown, and goes when the new answer lacks it", async (t) => {
  let release: (r: CrmReply) => void = () => {};
  let n = 0;
  const { screen } = await open(t, () =>
    ++n === 1
      ? { body: crm() }
      : new Promise<CrmReply>((r) => {
          release = r;
        }),
  );
  await ready(screen);
  await pick(screen, "All codes", "campaign code", "bh-list-with-us");
  await screen.until(() => /Paid leads in the CRM\?? 50 /.test(screen.text()), "the code's campaigns");
  screen.type("Date range", "last_90_days");
  await screen.until(() => /waiting for the CRM/.test(screen.text()), "the code to wait");
  // Meanwhile the ad half shows for every campaign, not 'No campaigns match'.
  assert.match(screen.text(), /Impressions\?? 300K/);
  assert.doesNotMatch(screen.text(), /No campaigns match/);
  release({ body: crm({ codes: [{ campaign: "1202", code: "webinar-2026", leads: 22 }] }) });
  await screen.until(() => /Paid leads in the CRM\?? 112 /.test(screen.text()), "every campaign, the code gone");
  assert.doesNotMatch(screen.text(), /bh-list-with-us \(/);
});

test("the grid has its own campaign picker, which filters the page as the filter bar does", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  await pick(screen, "Each campaign", "grid campaign", "ct1");
  await screen.until(() => /Leads by month: GGL_Search_CT1/.test(screen.text()), "the grid on one campaign");
  assert.match(screen.text(), /Paid leads in the CRM\?? 50 /);
});

test("a CRM that is not connected says so, and its figures read as dashes, never zeros", async (t) => {
  const { screen } = await open(t, () => ({ body: { connected: false, from: "2026-01-01", to: "2026-11-18", cells: [], codes: [], truncated: false, error: "the CRM (Metabase) is not connected on this deployment" } }));
  await screen.until(() => /not connected on this deployment/.test(screen.text()), "the notice");
  assert.match(screen.text(), /Paid leads in the CRM\?? — /);
  assert.doesNotMatch(screen.text(), /Paid leads in the CRM\?? 0 /);
});

test("a range with no ad activity says so, rather than blaming the filters", async (t) => {
  const empty = { ...PAID, rows: [], byDateFine: [], error: "The 2 selected account(s) were read successfully but had no activity." };
  const { screen } = await open(t, () => ({ body: crm({ cells: [], codes: [] }) }), empty);
  await screen.until(() => /No ad activity in this range/.test(screen.text()), "the empty state");
  assert.doesNotMatch(screen.text(), /No campaigns match/);
});

test("with spend in more than one currency, nothing adds spend across them", async (t) => {
  const mixed = { ...PAID, currencies: ["AED", "USD"] };
  const { screen } = await open(t, () => ({ body: crm() }), mixed);
  await ready(screen);
  assert.match(screen.text(), /bill in more than one currency/);
  assert.match(screen.text(), /Paid spend\?? — /);
  assert.match(screen.text(), /Marketing cost as % of commission\?? — — spend on AED 50K commission/);
  screen.click("Paid spend");
  await screen.until(() => /Spend by month: each campaign/.test(screen.text()), "the spend grid");
  // No figure in any month, the all-campaigns row included.
  assert.match(screen.text(), /Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov BH-Webinar GGL_Search_CT1 All selected campaigns KPI scorecard/);
});

test("the campaign picker searches its long list: typing narrows it, Enter takes the first match", async (t) => {
  const { screen } = await open(t);
  await ready(screen);
  screen.click("All campaigns");
  await screen.until(() => {
    try {
      screen.type("Search campaign", "zzz");
      return true;
    } catch {
      return false;
    }
  }, "the search box");
  await screen.until(() => /Nothing matches “zzz”\./.test(screen.text()), "no match said");
  screen.type("Search campaign", "webinar");
  await screen.until(() => !/Nothing matches/.test(screen.text()), "the narrowed list");
  // Each name shows its platform; the search keeps the matching campaign only.
  assert.ok(screen.buttons().includes("BH-Webinar Meta Ads"), "the matching campaign is offered");
  assert.ok(!screen.buttons().includes("GGL_Search_CT1 Google Ads"), "a campaign that does not match is still offered");
  screen.press("Search campaign", "Enter");
  await screen.until(() => /Paid leads in the CRM\?? 62 /.test(screen.text()), "the page filtered to the match");
  assert.ok(screen.buttons().includes("BH-Webinar"), "the picker shows what it filters by");
});
