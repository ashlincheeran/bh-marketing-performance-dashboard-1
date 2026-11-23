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

/**
 * Each feed's answer for a range. `k` scales what differs between ranges (the
 * year to date is 1), so a test can tell which range a figure came from.
 */
function answerFor(path: string, q: URLSearchParams, k: number): unknown {
  const from = q.get("from") ?? FROM, to = q.get("to") ?? TO;
  switch (path) {
    case "/api/company":
      return {
        connected: true, from, to, months: ["2026-10", "2026-11"], channels: ["Property Finder", "Bayut", "Client Referral"],
        leads: { Sales: { "Property Finder": [1000, 0], Bayut: [500, 0] }, Leasing: {} },
        deals: { Offplan: { "Property Finder": [k, 0], Bayut: [2 * k, 0] }, Secondary: { "Client Referral": [1, 0] }, Leasing: {} },
        comm: { Offplan: { "Property Finder": [1000 * k, 0], Bayut: [2000 * k, 0] }, Secondary: { "Client Referral": [500, 0] }, Leasing: {} },
      };
    case "/api/portals":
      return {
        connected: true, from, to,
        rows: [
          { portal: "Property Finder", leads: 600, viewings: 5, reservations: 7, reservedComm: 70000 },
          { portal: "Bayut", leads: 400, viewings: 3, reservations: 3, reservedComm: 30000 },
        ],
        cost: { months: ["2026-10"], leads: [10000], viewings: [800], reservations: [150], reservedComm: [2_000_000] },
      };
    case "/api/areas":
      return {
        connected: true, from, to, failed: [],
        areas: [
          { area: "Dubai Marina", leads: 900, viewings: 50, deals: 20, commission: 1_500_000 * k, listings: 581 },
          { area: "Business Bay", leads: 400, viewings: 80, deals: 12, commission: 2_000_000, listings: 164 },
        ],
      };
    case "/api/digital":
      return { byDateFine: [{ cost: 5000, leads: 50 }], currencies: ["AED"] };
    case "/api/seo":
      return { gsc: { totals: { clicks: 1234, impressions: 99999 } }, gscRange: { from, to }, ai: { visitors: 321, organicVisitors: 3210, missing: [] } };
    case "/api/summary":
      return {
        pr: { mentions: 12, sov: 0.2, sovThroughLabel: null },
        people: { posts: 3, net: 0.33 },
        social: { followers: 5000, share: 0.34, engagement: 0.0123, platforms: 3, asOf: "2026-11-20" },
      };
  }
  throw new Error(`unexpected ask ${path}`);
}

/** A stand-in fetch: every feed answers for the range it was asked for. `hold` keeps back one URL's answer until released. */
function feeds(t: { after: (fn: () => void) => void }, k: (q: URLSearchParams) => number, hold?: string) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((ok) => (release = ok));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const u = new URL(url, "http://dashboard.test");
    if (url === hold) await held;
    return new Response(JSON.stringify(answerFor(u.pathname, u.searchParams, k(u.searchParams))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return { asked, release };
}

const settled = (text: string) => /Engagement rate\s*1\.23%/.test(text) && /Best for leads\s*Dubai Marina/.test(text) && /Revenue, year to date/.test(text) && /Return on spend/.test(text);

test("the Dashboard opens on the year to date, in the four parts the business asked for", async (t) => {
  const { asked } = feeds(t, () => 1);
  const screen = await mount(h(CeoDashboard, { initialFrom: FROM, initialTo: TO }));
  t.after(() => screen.unmount());
  await screen.until(() => settled(screen.text()), "every part to land");
  // The year to date's Company figures are asked for once, for parts 1 and 3 together.
  assert.deepEqual([...asked].sort(), [
    `/api/areas?from=${FROM}&to=${TO}`,
    "/api/company",
    `/api/digital?from=${FROM}&to=${TO}`,
    `/api/portals?from=${FROM}&to=${TO}`,
    "/api/seo?preset=this_year",
    `/api/summary?from=${FROM}&to=${TO}`,
  ]);
  const text = screen.text();
  assert.deepEqual(screen.caught, []);

  // 1. Gross commission, then each source's part of it, biggest first, beside the portals.
  assert.match(text, /Gross commission\s*\??\s*AED 4K\s*from 4 deals/);
  assert.match(text, /Bayut\s*57%\s*AED 2K\s*Property Finder\s*29%\s*AED 1K\s*Client Referral\s*14%\s*AED 500/);
  assert.match(text, /Portal performance[\s\S]*Property Finder\s*600\s*7\s*AED 70K[\s\S]*Total\s*1,000\s*10\s*AED 100K/);
  assert.match(text, /Portal spend\s*AED 7\.52M\s*Cost per lead\s*AED 752\s*Return on spend\s*0\.3×/);
  // 2. The best area for each figure, the whole business.
  assert.match(text, /Best for leads\s*Dubai Marina\s*900 leads\s*Best for viewings\s*Business Bay\s*80 viewings\s*Best for deals\s*Dubai Marina\s*20 deals\s*Best for commission\s*Business Bay\s*AED 2\.00M commission\s*Best for listings\s*Dubai Marina\s*581 listings live/);
  assert.match(text, /Shares are of the total across areas\. Of the period's 1,500 leads, 1,300 \(87%\) name a property; the rest have no area\./);
  // 3. Revenue for the year to date, month by month.
  const revenue = screen.charts().find((c) => c.series[0] === "Revenue");
  assert.deepEqual(revenue?.values, [[3500, 0]]);
  // 4. Two figures from each channel.
  assert.match(text, /PR & people sentiment\s*Press stories\s*12\s*20% share of voice YTD\s*Net sentiment\s*\+33\s*from 3 posts checked/);
  assert.match(text, /Social\s*Followers\s*5,000\s*34\.0% of benchmarked set · as of 20 Nov\s*Engagement rate\s*1\.23%/);
  assert.match(text, /Digital\s*Paid spend\s*AED 5K\s*Cost per lead\s*AED 100\s*50 platform-reported leads/);
  assert.match(text, /SEO\s*Organic clicks\s*1,234\s*99,999 impressions · to 23 Nov\s*AI visitors\s*321/);
  // In that order.
  const order = ["Gross commission", "Portal performance", "Best areas", "Revenue, year to date", "PR & people sentiment", "Social", "Digital", "SEO"].map((s) => text.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(text, /· 90d|· 12m|Couldn't load/);
});

test("a picked range refetches what follows it, the year to date stays, and a late answer for the range before is dropped", async (t) => {
  const last = rangeFor("last_month");
  // The year to date counts 1, last month 5; the year to date's areas come late.
  const { asked, release } = feeds(t, (q) => (q.get("from") === last.from ? 5 : 1), `/api/areas?from=${FROM}&to=${TO}`);
  const screen = await mount(h(CeoDashboard, { initialFrom: FROM, initialTo: TO }));
  t.after(() => screen.unmount());
  await screen.until(() => /Engagement rate\s*1\.23%/.test(screen.text()) && /Revenue, year to date/.test(screen.text()), "the first figures");

  screen.type("Date range", "last_month");
  await screen.until(() => /from 16 deals/.test(screen.text()) && /Best for commission\s*Dubai Marina\s*AED 7\.50M/.test(screen.text()), "last month's figures");
  for (const path of ["/api/company", "/api/portals", "/api/areas", "/api/digital", "/api/summary"]) {
    assert.ok(asked.includes(`${path}?from=${last.from}&to=${last.to}`), `${path} not asked for last month`);
  }
  assert.ok(asked.includes("/api/seo?preset=last_month"));
  // The year to date is asked for once only, and its revenue stays.
  assert.equal(asked.filter((u) => u === "/api/company").length, 1);
  assert.deepEqual(screen.charts().find((c) => c.series[0] === "Revenue")?.values, [[3500, 0]]);

  // The year to date's late areas answer lands now, and is dropped.
  release();
  await new Promise((ok) => setTimeout(ok, 50));
  assert.match(screen.text(), /Best for commission\s*Dubai Marina\s*AED 7\.50M/);
  assert.deepEqual(screen.caught, []);
});

test("the best-area ranking follows the figure chosen by its tab, and the best-for cards are not buttons", async (t) => {
  feeds(t, () => 1);
  const screen = await mount(h(CeoDashboard, { initialFrom: FROM, initialTo: TO }));
  t.after(() => screen.unmount());
  await screen.until(() => settled(screen.text()), "every part to land");
  // The cards only say which area is best; the tabs pick the ranking.
  assert.ok(!screen.buttons().some((b) => b.startsWith("Best for")), `buttons: ${screen.buttons().join(" | ")}`);
  // Commission first: Business Bay leads it.
  assert.match(screen.text(), /Business Bay\s*57%\s*AED 2\.00M\s*Dubai Marina\s*43%\s*AED 1\.50M/);
  screen.click("Leads");
  await screen.until(() => /Dubai Marina\s*69%\s*900\s*Business Bay\s*31%\s*400/.test(screen.text()), "the ranking by leads");
  screen.click("Viewings");
  await screen.until(() => /Business Bay\s*62%\s*80\s*Dubai Marina\s*38%\s*50/.test(screen.text()), "the ranking by viewings");
  // Listings: the stock held today, by area.
  screen.click("Listings");
  await screen.until(() => /Dubai Marina\s*78%\s*581\s*Business Bay\s*22%\s*164/.test(screen.text()), "the ranking by listings");
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
  assert.ok(asked.includes("/api/areas?from=2026-03-01&to=2026-03-31"));
  await screen.until(() => /1 Mar 2026 – 31 Mar 2026/.test(screen.text()), "the range line");
});
