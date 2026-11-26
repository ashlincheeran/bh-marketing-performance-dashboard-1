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

/** An area's figures from its sales and leasing parts: [sales, leasing] each. */
function area(name: string, parts: Record<"leads" | "viewings" | "deals" | "commission" | "listings", [number, number]>) {
  const side = (i: 0 | 1) => Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v[i]]));
  return { area: name, ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v[0] + v[1]])), sides: { sales: side(0), leasing: side(1) } };
}

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
          area("Dubai Marina", { leads: [600, 300], viewings: [20, 30], deals: [5, 15], commission: [1_000_000 * k, 500_000 * k], listings: [300, 281] }),
          area("Business Bay", { leads: [100, 300], viewings: [40, 40], deals: [12, 0], commission: [2_000_000, 0], listings: [100, 64] }),
        ],
      };
    case "/api/digital":
      return { byDateFine: [{ cost: 5000, leads: 50 }], currencies: ["AED"] };
    case "/api/seo":
      // The SEO tab's figures and rules (lib/seoReport.ts getSeoTile): organic is search and AI together.
      return { range: { from, to }, gscRange: { from, to }, search: { clicks: 1234, impressions: 99999 }, visitors: { seo: 2889, ai: 321 } };
    case "/api/summary":
      return {
        pr: { stories: 12, year: 2026, sov: 0.2, sovThroughLabel: null },
        people: { posts: 3, net: 0.33 },
        social: { byPlatform: [{ platform: "linkedin", followers: 3000 }, { platform: "instagram", followers: 2000 }], engagement: 0.0123, platforms: 2, asOf: "2026-11-20" },
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
  // Each best area with its sales and leasing split.
  assert.match(text, /Best for leads\s*Dubai Marina\s*900 leads\s*67% sales · 33% leasing\s*Best for viewings\s*Business Bay\s*80 viewings\s*50% sales · 50% leasing/);
  assert.match(text, /Best for deals\s*Dubai Marina\s*20 deals\s*25% sales · 75% leasing\s*Best for commission\s*Business Bay\s*AED 2\.00M commission\s*100% sales · 0% leasing/);
  assert.match(text, /Best for listings\s*Dubai Marina\s*581 listings live\s*52% sales · 48% leasing/);
  assert.match(text, /Sales\s*Leasing\s*each side's share of the area/);
  assert.match(text, /Each bar is split into sales and leasing, with each side's share of the area; hover a bar for its share of all areas\. Of the period's 1,500 leads, 1,300 \(87%\) name a property; the rest have no area\./);
  // 3. Revenue for the year to date, month by month.
  const revenue = screen.charts().find((c) => c.series[0] === "Revenue");
  assert.deepEqual(revenue?.values, [[3500, 0]]);
  // 4. Two figures from each channel.
  // Press stories for the whole year, whatever the range.
  assert.match(text, /PR & people sentiment\s*Press stories in 2026\s*12\s*20% share of voice YTD\s*Net sentiment\s*\+33\s*from 3 posts checked/);
  // Followers on each platform, never added up.
  assert.match(text, /Social\s*Followers by channel\s*LinkedIn\s*3,000\s*Instagram\s*2,000\s*as of 20 Nov\s*Engagement rate\s*1\.23%/);
  assert.doesNotMatch(text, /5,000/);
  assert.match(text, /Digital\s*Paid spend\s*AED 5K\s*Cost per lead\s*AED 100\s*50 platform-reported leads/);
  assert.match(text, /SEO\s*Organic clicks\s*1,234\s*99,999 impressions · to 23 Nov\s*AI visitors\s*321\s*10\.0% of 3,210 organic/);
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
  // Commission first: Business Bay leads it, all of it sales; each bar gives its sales and leasing shares.
  assert.match(screen.text(), /Business Bay\s*100%\s*0%\s*AED 2\.00M\s*Dubai Marina\s*67%\s*33%\s*AED 1\.50M/);
  screen.click("Leads");
  await screen.until(() => /Dubai Marina\s*67%\s*33%\s*900\s*Business Bay\s*25%\s*75%\s*400/.test(screen.text()), "the ranking by leads");
  screen.click("Viewings");
  await screen.until(() => /Business Bay\s*50%\s*50%\s*80\s*Dubai Marina\s*40%\s*60%\s*50/.test(screen.text()), "the ranking by viewings");
  // Listings: the stock held today, by area.
  screen.click("Listings");
  await screen.until(() => /Dubai Marina\s*52%\s*48%\s*581\s*Business Bay\s*61%\s*39%\s*164/.test(screen.text()), "the ranking by listings");
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
