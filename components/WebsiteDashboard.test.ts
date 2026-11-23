import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import { resolvePeriod, type PeriodQuery } from "@/lib/growthPeriod";
import { ENQUIRY_CHANNELS, VISIT_CHANNELS, zeroes } from "@/lib/website";
import type { PageLookup, VisitMonth, WebsiteCrmMonth, WebsiteCrmReport, WebsiteReport } from "@/lib/websiteGrowth";

// The Website tab as a viewer sees it: the real component, fed made-up months,
// its asks for figures answered by a stand-in fetch. Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/WebsiteDashboard.test.ts

const { default: WebsiteDashboard } = await load<typeof import("@/components/WebsiteDashboard")>("components/WebsiteDashboard.tsx");

const LATEST = "2026-10";
const fresh = () => new Date(Date.now() - 6_000).toISOString();

/** Every month alike, except that organic search doubles in the period, so its growth reads 100%. */
function report(q: PeriodQuery = {}): WebsiteReport {
  const period = resolvePeriod(q, LATEST);
  const month = (m: string): VisitMonth => {
    const channels = Object.fromEntries([...VISIT_CHANNELS.map((c) => c.key), "direct"].map((k) => [k, { site: 100, careers: 10 }])) as VisitMonth["channels"];
    channels.organic = { site: m >= period.from ? 2000 : 1000, careers: 50 };
    channels.direct = { site: 4000, careers: 20 };
    return { channels, directShort: 1000 };
  };
  return {
    cachedAt: fresh(),
    period,
    months: period.months,
    visits: period.months.map(month),
    detail: period.months.filter((m) => m >= period.from && m <= period.to).map((m) => ({
      month: m,
      countries: [{ country: "United States", visitors: 1000, automated: 940 }, { country: "United Arab Emirates", visitors: 800, automated: 8 }],
      devices: { Desktop: 600, Mobile: 400 },
      sections: { property: 3000, buy: 2000, "join-our-team": 500 },
      forms: [
        { form: "market-reports-blog-post", opened: 200, sent: 60 },
        { form: "property-valuation", opened: 60, sent: 15 },
        { form: "city-tower-register-your-interest", opened: 100, sent: 0 },
        { form: "contact_us", opened: 0, sent: 30 },
      ],
      actions: { clicked: 3000, opened: 300, searched: 900, gallery: 600, sent: 130 },
      senders: { organic: 40, email: 50, direct: 15 },
    })),
    sources: [{ name: "PostHog", state: "ok", detail: "answered" }],
    generatedAt: new Date().toISOString(),
  };
}

/** The CRM half: 100 untagged and 10 AI enquirers, 50 applicants, 20 listings and 5 reservations (2 completed) a month. */
function crm(q: PeriodQuery = {}): WebsiteCrmReport {
  const { months } = resolvePeriod(q, LATEST);
  const month = (m: string): WebsiteCrmMonth => ({
    month: m,
    enquiries: { ...zeroes(ENQUIRY_CHANNELS), untagged: 100, ai: 10 },
    enquirers: 110,
    jobs: 50,
    listed: { ...zeroes(ENQUIRY_CHANNELS), untagged: 20 },
    reserved: { ...zeroes(ENQUIRY_CHANNELS), untagged: 5 },
    completed: { ...zeroes(ENQUIRY_CHANNELS), untagged: 2 },
    awaiting: 3,
    commission: { completed: 100_000, awaiting: 50_000 },
  });
  return { cachedAt: fresh(), months, crm: months.map(month), connected: true, generatedAt: new Date().toISOString() };
}

const lookup: PageLookup = {
  cachedAt: fresh(), path: "/en/buy", days: 30, connected: true, generatedAt: new Date().toISOString(),
  overview: { views: 3918, visitors: 2964, seconds: 47, scroll: 71, clicks: 2030, clickers: 633, openers: 4, senders: 2 },
  entrances: { visits: 1500, bounce: 41.5, seconds: 60, pages: 2.1 },
  trend: [{ day: "2026-11-01", views: 120, visitors: 90 }, { day: "2026-11-02", views: 130, visitors: 95 }],
  sources: [{ channel: "organic", visitors: 1200 }, { channel: "direct", visitors: 900 }],
  clicks: [{ button: "Search", place: "hero", target: "/en/buy/apartment", clicks: 400, people: 300 }],
  next: [{ page: "(left the site)", views: 2554 }, { page: "/en/rent", views: 13 }],
  forms: [{ form: "property-lead-form", opened: 4, sent: 2 }],
  devices: [{ device: "Desktop", visitors: 2000 }, { device: "Mobile", visitors: 964 }],
};

/** A stand-in fetch: `route` answers each URL. Every URL asked is kept, in order. */
function serve(t: { after: (fn: () => void) => void }, route: (url: string) => unknown) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    return new Response(JSON.stringify(await route(url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test("the tab opens on the period in nine sections, every sentence worked out from the figures", async (t) => {
  const asked = serve(t, (url) => (url.startsWith("/api/website?part=crm") ? crm() : assert.fail(`no other ask: ${url}`)));
  const screen = await mount(h(WebsiteDashboard, { initial: report() }));
  t.after(() => screen.unmount());
  await screen.until(() => /Listed with us\s*60/.test(screen.text()), "the CRM figures");
  const text = screen.text();
  assert.deepEqual(screen.caught, []);
  // The CRM half is asked for the very months on screen.
  assert.deepEqual(asked, ["/api/website?part=crm&from=2026-08&to=2026-10"]);
  assert.match(text, /Aug–Oct 2026\s*vs May–Jul 2026/);
  assert.match(text, /The quarter in seven numbers/);

  // 01: commercial sessions leave out direct and careers: (2,000 organic + 7 × 100 others) × 3 months.
  assert.match(text, /Commercial sessions\s*8,100/);
  assert.match(text, /Website enquiries\s*330/);
  assert.match(text, /Job applications\s*150/);
  assert.match(text, /Deals completed\s*6\s*■ 0%\s*9 still reserved/);
  assert.match(text, /Commission\s*AED 450K/);
  // 03: the largest channel and the one that grew, from the figures.
  assert.match(text, /Organic search is the largest channel at 6K sessions in Aug–Oct 2026; organic search grew 100%/);
  // 04: a quarter of direct sessions were short, and the US visitors were mostly automated.
  assert.match(text, /Direct traffic held at about 4K sessions a month; in October, 25% of them lasted under 5 seconds\./);
  assert.match(text, /94% of visitors from United States were automated/);
  // 06: untagged share and AI enquiries.
  assert.match(text, /91% of website enquiries in Aug–Oct 2026 carried no tracking tag\. Enquiries from AI assistants held at 30\./);
  // 07: the forms compared, and the one with no send tracked named.
  assert.match(text, /Market reports blog post completes best \(30%/);
  assert.match(text, /property valuation completes least \(25%\)/);
  assert.match(text, /City tower register your interest: 300 people opened it, but no send is tracked/);
  // 08 and 09.
  assert.match(text, /60 properties listed with us and AED 450K in commission in Aug–Oct 2026; 100% of the listings came from untagged/);
  assert.match(text, /Property and buy pages get the most views; 40% of visitors are on mobile/);
  // The sections in order.
  const order = ["Website at a glance", "Page lookup", "Traffic by channel", "Traffic quality", "Careers vs commercial", "Enquiries by channel", "Forms", "Business outcomes", "Site experience"].map((x) => text.indexOf(x));
  assert.ok(order.every((i) => i >= 0), "every section is on the page");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // The channel chart stacks the seven channels and Other, month by month over a year.
  const channels = screen.charts().find((c) => c.series.includes("Organic search") && c.series.includes("Referral"));
  assert.equal(channels?.values[0].length, 12);
});

test("a page is looked up by the path typed, and a link that is not a page is refused without asking", async (t) => {
  const asked = serve(t, (url) => (url.includes("part=crm") ? crm() : url.startsWith("/api/website?path=") ? lookup : assert.fail(`no other ask: ${url}`)));
  const screen = await mount(h(WebsiteDashboard, { initial: report() }));
  t.after(() => screen.unmount());

  screen.type("Page link", "javascript:alert(1)");
  await new Promise((ok) => setTimeout(ok, 20));
  screen.click("Search");
  await screen.until(() => /Enter a bhomes\.com link or a path such as \/en\/buy\./.test(screen.text()), "the refusal");
  assert.ok(!asked.some((u) => u.includes("path=")));

  screen.type("Page link", "https://www.bhomes.com/en/buy/");
  await new Promise((ok) => setTimeout(ok, 20));
  screen.click("Search");
  await screen.until(() => /Showing \/en\/buy · last 30 days · 3,918 page views\./.test(screen.text()), "the page's figures");
  assert.ok(asked.includes("/api/website?path=%2Fen%2Fbuy&days=30"));
  const text = screen.text();
  assert.match(text, /Bounce rate\s*41\.5%/);
  assert.match(text, /Click-through\s*21%/);
  assert.match(text, /Where they went next/);
  assert.deepEqual(screen.caught, []);
});
