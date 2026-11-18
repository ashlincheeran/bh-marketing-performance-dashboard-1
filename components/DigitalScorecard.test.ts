import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import type { PipelineData } from "@/lib/digitalPipeline";
import type { ScorecardCampaign } from "@/components/DigitalScorecard";

// The Digital tab's pipeline scorecard as a viewer sees it: the real component,
// rendered by React DOM into a stand-in document. Its ask to the CRM is
// answered by a stand-in fetch. Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/DigitalScorecard.test.ts

const { default: DigitalScorecard } = await load<typeof import("@/components/DigitalScorecard")>("components/DigitalScorecard.tsx");

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const CAMPAIGNS: ScorecardCampaign[] = [
  { name: "ggl_search_ct1", platform: "Google Ads", keys: ["ggl_search_ct1"], spend: 10_000, impressions: 200_000, clicks: 4_000, codes: ["ggl-ct1"] },
  // A Meta campaign's leads carry its name or its id: both are its own.
  { name: "bh-webinar-x", platform: "Meta Ads", keys: ["bh-webinar-x", "1202"], spend: 20_000, impressions: 300_000, clicks: 3_000, codes: ["umbrella", "webinar"] },
];
const PROPS = {
  from: "2026-01-01",
  to: "2026-02-28",
  allKeys: ["1202", "bh-webinar-x", "ggl_search_ct1", "not-in-filter"],
  campaigns: CAMPAIGNS,
  spendByMonth: { "2026-01": 12_000, "2026-02": 18_000 },
  currency: "AED",
};

const cell = (campaign: string, month: string, f: Partial<PipelineData["cells"][number]>) => ({
  campaign, month, leads: 0, people: 0, viewed: 0, listings: 0, deals: 0, directDeals: 0, commission: 0, directCommission: 0, reservedCommission: 0, dealValue: 0, ...f,
});

function answer(over: Partial<PipelineData> = {}): PipelineData {
  return {
    connected: true,
    from: "2026-01-01",
    to: "2026-02-28",
    cachedAt: minutesAgo(0.2),
    truncated: false,
    cells: [
      cell("ggl_search_ct1", "2026-01", { leads: 50, people: 45, viewed: 3, listings: 1, deals: 2, directDeals: 1, commission: 30_000, directCommission: 10_000, reservedCommission: 5_000 }),
      cell("bh-webinar-x", "2026-02", { leads: 30, people: 28, viewed: 1, deals: 1, commission: 15_000 }),
      cell("1202", "2026-02", { leads: 20, people: 20 }),
      // A campaign the tab's filters leave out: never added up.
      cell("not-in-filter", "2026-01", { leads: 999, people: 900, deals: 50, commission: 9_000_000 }),
    ],
    sources: [
      { campaign: "ggl_search_ct1", source: "Bayut", deals: 1, commission: 20_000 },
      { campaign: "bh-webinar-x", source: "(not recorded)", deals: 1, commission: 15_000 },
      { campaign: "not-in-filter", source: "Website", deals: 50, commission: 9_000_000 },
    ],
    ...over,
  };
}

/** A stand-in fetch answering `body` with `status`, remembering each ask. Put back after the test. */
function stand(t: { after: (fn: () => void) => void }, body: () => unknown, status = 200) {
  const real = globalThis.fetch;
  const asked: { url: string; body: { from: string; to: string; campaigns: string[] } }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body()), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test("the scorecard adds up the filtered campaigns only, sets them against their spend, and asks the CRM about every campaign", async (t) => {
  const asked = stand(t, () => answer());
  const screen = await mount(h(DigitalScorecard, PROPS));
  t.after(() => screen.unmount());
  await screen.until(() => /Leads ?\? 100 /.test(screen.text()), "the CRM figures");
  const text = screen.text();
  assert.deepEqual(screen.caught, []);

  // One ask, about every campaign in the range whatever the filters, for the range.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, "/api/digital/pipeline");
  assert.deepEqual(asked[0].body, { from: "2026-01-01", to: "2026-02-28", campaigns: PROPS.allKeys });

  // Spend, impressions and clicks from the ad platforms; the rest from the CRM.
  assert.match(text, /Spend ?\? AED 30K 2 campaigns/);
  assert.match(text, /Impressions ?\? 500K AED 60 per 1,000/);
  assert.match(text, /Leads ?\? 100 AED 300 a lead/);
  assert.match(text, /People ?\? 93 /);
  assert.match(text, /Had a viewing ?\? 4 4\.3% of people/);
  assert.match(text, /Deals ?\? 3 1 on the paid lead, 2 on a later one · AED 10K a deal/);
  assert.match(text, /Commission ?\? AED 45K AED 5,000 still at Reserved/);
  assert.match(text, /Return on spend ?\? 1\.50× spend is 67% of commission/);
  assert.doesNotMatch(text, /999|9\.0M|Website/, "a campaign outside the filters is not added in");
});

test("months set each month's spend against its leads, and quarters add them up", async (t) => {
  stand(t, () => answer());
  const screen = await mount(h(DigitalScorecard, PROPS));
  t.after(() => screen.unmount());
  await screen.until(() => /Jan 2026 AED 12K 50 AED 240/.test(screen.text()), "the month rows");
  assert.match(screen.text(), /Feb 2026 AED 18K 50 AED 360 48 1 0 1 AED 15K 0\.83×/);
  assert.match(screen.text(), /Total AED 30K 100 AED 300 93 4 1 3 AED 45K 1\.50×/);
  screen.click("Quarters");
  await screen.until(() => /Q1 2026 AED 30K 100 AED 300/.test(screen.text()), "the quarter row");
});

test("each campaign is one row with its own Engage codes, and its Meta id's leads count as its own", async (t) => {
  stand(t, () => answer());
  const screen = await mount(h(DigitalScorecard, PROPS));
  t.after(() => screen.unmount());
  await screen.until(() => /bh-webinar-x Meta Ads · umbrella · webinar AED 20K 50 /.test(screen.text()), "the campaign rows");
  const text = screen.text();
  // Most spend first; codes listed one by one, never merged.
  assert.match(text, /bh-webinar-x Meta Ads · umbrella · webinar AED 20K 50 AED 400 48 1 0 1 AED 15K/);
  assert.match(text, /ggl_search_ct1 Google Ads · ggl-ct1 AED 10K 50 AED 200 45 3 1 2 AED 30K/);
  // Where the deals came through: on the paid lead, then each later lead's enquiry source.
  assert.match(text, /On the paid lead 1 AED 10K Later lead · Bayut 1 AED 20K Later lead · \(not recorded\) 1 AED 15K/);
});

test("a failed CRM read says so and shows a dash, never a zero, while spend stays", async (t) => {
  stand(t, () => ({ error: "timed out after 60s" }), 500);
  const screen = await mount(h(DigitalScorecard, PROPS));
  t.after(() => screen.unmount());
  await screen.until(() => /could not be read/.test(screen.text()), "the failure notice");
  const text = screen.text();
  assert.match(text, /The CRM half of the scorecard could not be read: timed out after 60s\./);
  assert.match(text, /Spend ?\? AED 30K/);
  assert.match(text, /Leads ?\? — /);
  assert.match(text, /Deals ?\? — /);
  assert.doesNotMatch(text, /Leads ?\? 0 /);
});

test("an answer over a minute old is shown, then the latest is asked for and swapped in", async (t) => {
  let n = 0;
  const asked = stand(t, () =>
    ++n === 1
      ? answer({ cachedAt: minutesAgo(12) })
      : answer({ cachedAt: new Date().toISOString(), cells: [cell("ggl_search_ct1", "2026-01", { leads: 70, people: 60 })], sources: [] }),
  );
  const screen = await mount(h(DigitalScorecard, PROPS));
  t.after(() => screen.unmount());
  await screen.until(() => /Leads ?\? 70 /.test(screen.text()), "the latest figures");
  assert.equal(asked.length, 2);
  assert.equal(asked[1].url, "/api/digital/pipeline?live=1");
  assert.match(screen.text(), /updated just now/);
});
