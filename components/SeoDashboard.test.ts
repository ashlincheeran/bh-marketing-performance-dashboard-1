import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";
import { resolvePeriod, type PeriodQuery } from "@/lib/growthPeriod";
import type { GrowthCrmMonth } from "@/lib/metabase";
import type { GrowthCrmReport, GrowthReport } from "@/lib/organicGrowth";

// The SEO tab as a viewer sees it: the real component, fed made-up months,
// its asks for figures answered by a stand-in fetch. Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/SeoDashboard.test.ts

const { default: SeoDashboard } = await load<typeof import("@/components/SeoDashboard")>("components/SeoDashboard.tsx");

const LATEST = "2026-10";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** The visitors half for a period: every month alike, so a test reads the period's length off its totals. */
function report(q: PeriodQuery, cachedAt = minutesAgo(0.1)): GrowthReport {
  const period = resolvePeriod(q, LATEST);
  return {
    cachedAt,
    period,
    months: period.months,
    traffic: period.months.map((month) => ({
      month, seo: 1000, ai: 100, offPlan: 10, propertyManagement: 5,
      byAssistant: { chatgpt: 90, gemini: 10 }, aiLanding: { home: 60, blog: 40 }, news: {}, newsPeople: 0,
    })),
    assistantNames: { chatgpt: ["chatgpt.com"], gemini: ["gemini.google.com"] },
    search: period.months.map((month) => ({ month, clicks: 15000, impressions: 3_000_000, position: 14, brandClicks: 3000, brandImpressions: 9000 })),
    searchSource: "direct",
    searchFrom: "2025-08",
    keywords: [],
    newsSites: 10,
    sources: [{ name: "PostHog", state: "ok", detail: "answered" }],
    generatedAt: new Date().toISOString(),
  };
}

const lines = (n: number) => ({ sale: n, rent: n, offplan: 0, pm: 0, other: 0, total: 2 * n });
/** The CRM half for a period, `listed` sale and `listed` rent listings a month. */
function crm(q: PeriodQuery, listed: number, cachedAt = minutesAgo(0.1)): GrowthCrmReport {
  const { months } = resolvePeriod(q, LATEST);
  const month = (m: string): GrowthCrmMonth => ({
    month: m, leads: lines(20), aiLeads: lines(1),
    listed: { sale: listed, rent: listed }, reserved: { sale: 1, rent: 1 }, completed: { sale: 0, rent: 1 },
    commission: { completedSale: 0, completedRent: 5000, awaiting: 10000 },
  });
  return { cachedAt, months, crm: months.map(month), connected: true, generatedAt: new Date().toISOString() };
}

/** A stand-in fetch: `route` answers each URL, now or later. Every URL asked is kept, in order. */
function serve(t: { after: (fn: () => void) => void }, route: (url: string) => unknown) {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const body = await route(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return asked;
}

test("the tab shows the period's figures against the months before, with the period picker in the header", async (t) => {
  serve(t, (url) => (url.includes("part=crm") ? crm({}, 3) : assert.fail(`no other ask: ${url}`)));
  const screen = await mount(h(SeoDashboard, { initial: report({}) }));
  t.after(() => screen.unmount());
  await screen.until(() => /Listed with us 18 /.test(screen.text()), "the CRM figures");
  const text = screen.text();
  assert.deepEqual(screen.caught, []);
  // Aug–Oct against May–Jul: 3 months of 1,000 SEO and 100 AI visitors, and 3 sale and 3 rent listings a month.
  assert.match(text, /Aug–Oct 2026\s*vs May–Jul 2026/);
  assert.match(text, /The quarter in seven numbers/);
  assert.match(text, /Organic visitors 3,300 ■ 0%/);
  assert.match(text, /Listed with us 18 ■ 0%\s*9 sale · 9 rent/);
});

test("a late answer for the period left behind never takes the new period's place", async (t) => {
  // The CRM half arrives a few minutes old, so the tab asks for the latest at once; that ask is held back.
  let release: (v: unknown) => void = () => {};
  const held = new Promise((r) => (release = r));
  const asked = serve(t, (url) => {
    if (url.includes("part=crm") && url.includes("live=1")) return held.then(() => crm({ from: "2026-08", to: "2026-10" }, 3));
    if (url.includes("part=crm")) return url.includes("from=2026-08") ? crm({}, 3, minutesAgo(5)) : crm({ preset: "ytd" }, 7);
    if (url.includes("preset=ytd")) return report({ preset: "ytd" });
    return assert.fail(`no other ask: ${url}`);
  });
  const screen = await mount(h(SeoDashboard, { initial: report({}) }));
  t.after(() => screen.unmount());
  await screen.until(() => asked.some((u) => u.includes("live=1")), "the ask for the latest CRM figures");

  // Year to date while that ask is out: its own figures land first.
  screen.type("Period", "ytd");
  await screen.until(() => /Listed with us 140 /.test(screen.text()), "the year's CRM figures");

  // Then the held answer, for Aug–Oct, lands. It must not replace the year's figures.
  release(null);
  await new Promise((r) => setTimeout(r, 50));
  const text = screen.text();
  assert.match(text, /Listed with us 140 /);
  assert.doesNotMatch(text, /Loading the CRM/);
  assert.match(text, /Jan–Oct 2026\s*vs Mar–Dec 2025/);
  assert.deepEqual(screen.caught, []);
});
