// The morning warm-up (app/api/warm, after the 08:00 news run and the 08:20
// ads sync) and Refresh everything: the views each tab opens on, worked out
// now and remembered (lib/cache.ts), so the first look of the day is as quick
// as the rest. Each view is the one its tab asks for by default, so the tab's
// own question finds it: Company and Portals for the year to date as the
// Dashboard and their tabs open them, the SEO tab's report and its CRM half,
// the Dashboard's search tiles, Website's figures and its leads card, and the
// Digital tab's CRM half (its pipeline scorecard), asked about the campaigns
// already stored from the ads sync, never Supermetrics.
import { errorMessage } from "@/lib/coerce";
import { getBusinessAreas } from "@/lib/areas";
import { getCompanyData } from "@/lib/company";
import { rangeFor, todayIn } from "@/lib/dateRanges";
import { getDigitalPipeline } from "@/lib/digitalPipeline";
import { paidRange, storedCampaignNames } from "@/lib/paid";
import { getPortalsData } from "@/lib/portals";
import { getGrowthCrmReport, getGrowthReport } from "@/lib/organicGrowth";
import { getSeoTile } from "@/lib/seoReport";
import { getWebsiteCrmReport, getWebsiteReport } from "@/lib/websiteGrowth";

export interface Warmed {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

async function warm(name: string, work: () => Promise<unknown>): Promise<Warmed> {
  const started = Date.now();
  try {
    await work();
    return { name, ok: true, ms: Date.now() - started };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, error: errorMessage(e) };
  }
}

/**
 * Works out every tab's opening view now and keeps it. Two at a time, in
 * pairs, so the CRM is never asked for everything at once. Never throws: each
 * view says how it went.
 */
export async function warmCache(): Promise<Warmed[]> {
  const fresh = { fresh: true };
  const year = rangeFor("this_year", todayIn("Asia/Dubai"));
  const digital = paidRange(year.from, year.to, 30);
  const pairs: [string, () => Promise<unknown>][][] = [
    [
      ["Company", () => getCompanyData(undefined, undefined, undefined, fresh)],
      ["Portals", () => getPortalsData(undefined, undefined, undefined, undefined, undefined, fresh)],
    ],
    [
      ["SEO", () => getGrowthReport({}, fresh)],
      ["SEO leads", () => getGrowthCrmReport({}, fresh)],
    ],
    // The Dashboard's search and AI tiles, and its best areas, open on the year to date.
    [
      ["Dashboard search", () => getSeoTile({}, fresh)],
      ["Dashboard areas", () => getBusinessAreas(undefined, undefined, fresh)],
    ],
    [
      ["Website", () => getWebsiteReport({}, fresh)],
      ["Website leads", () => getWebsiteCrmReport({}, fresh)],
    ],
    [["Digital scorecard", async () => getDigitalPipeline(digital.from, digital.to, await storedCampaignNames(digital.from, digital.to), fresh)]],
  ];
  const out: Warmed[] = [];
  for (const pair of pairs) out.push(...(await Promise.all(pair.map(([name, work]) => warm(name, work)))));
  return out;
}
