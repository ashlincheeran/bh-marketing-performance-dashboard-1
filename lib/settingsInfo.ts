// What Settings knows about the app's configuration. Server-only.
//
// Reports STATE, never secrets: whether a key is present, never its value. A
// settings screen that prints credentials is worse than no settings screen.
import { getPaidConfig, getPerfConfig, getSeoConfig, getTrackedKeywords, getIngestRuns } from "@/lib/data";
import { PORTAL_SPEND, SPEND_SOURCE_LABEL, avgMonthlySpend, avgMonthlySpendTotal } from "@/lib/portalSpend";
import { cacheStatus, RESTATE_DAYS } from "@/lib/paidStore";

export interface Connection {
  name: string;
  /** Which tabs stop working without it. */
  powers: string;
  configured: boolean;
  /** The env vars checked, so a missing one can be found without reading source. */
  vars: string[];
}

export interface SettingsInfo {
  connections: Connection[];
  counts: {
    seoKeywords: number;
    prKeywords: number;
    competitorKeywords: number;
    benchmarkBrands: number;
    paidAccounts: number;
  };
  portalSpend: { portal: string; monthly: number }[];
  portalSpendTotal: number;
  portalSpendSource: string;
  lastIngest: { ranAt: string; trigger: string; ok: boolean; inserted: number } | null;
  pinsFromEnv: { app: boolean; settings: boolean };
  /** The Supermetrics cache: what it covers and when it last ran. */
  paidCache: {
    days: number;
    rows: number;
    oldest: string | null;
    newest: string | null;
    lastSyncedAt: string | null;
    restateDays: number;
  };
}

const has = (...names: string[]) => names.every((n) => !!process.env[n]);
const hasAny = (...names: string[]) => names.some((n) => !!process.env[n]);

export async function getSettingsInfo(): Promise<SettingsInfo> {
  const [paid, perf, seo, kw, runs, cache] = await Promise.all([
    getPaidConfig(),
    getPerfConfig(),
    getSeoConfig(),
    getTrackedKeywords(),
    getIngestRuns(1),
    cacheStatus(),
  ]);

  const paidAccounts =
    (paid.accounts?.google?.length ?? 0) + (paid.accounts?.meta?.length ?? 0) + (paid.accounts?.linkedin?.length ?? 0);

  const last = runs[0];

  return {
    connections: [
      {
        name: "Metabase (Engage CRM)",
        powers: "Company Performance, Portals, SEO leads",
        configured: !!process.env.METABASE_URL && hasAny("METABASE_API_KEY", "METABASE_PASSWORD"),
        vars: ["METABASE_URL", "METABASE_API_KEY or METABASE_USERNAME/PASSWORD"],
      },
      {
        name: "Supermetrics",
        powers: "Digital Performance, and Search Console figures on SEO",
        configured: has("SUPERMETRICS_API_KEY"),
        vars: ["SUPERMETRICS_API_KEY"],
      },
      {
        name: "PostHog",
        powers: "Website, SEO traffic",
        configured: hasAny("POSTHOG_API_KEY"),
        vars: ["POSTHOG_API_KEY", "POSTHOG_HOST"],
      },
      {
        name: "Search Console (direct)",
        powers: "Fallback for SEO when Supermetrics is unavailable",
        configured: has("GSC_CLIENT_EMAIL", "GSC_PRIVATE_KEY"),
        vars: ["GSC_CLIENT_EMAIL", "GSC_PRIVATE_KEY"],
      },
      {
        name: "Apify",
        powers: "Social benchmark scraping, news article bodies",
        configured: has("APIFY_TOKEN"),
        vars: ["APIFY_TOKEN"],
      },
      {
        name: "Gemini",
        powers: "News relevance and sentiment, AI insight panels",
        configured: hasAny("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        vars: ["GEMINI_API_KEY"],
      },
      {
        name: "Supabase",
        powers: "All stored config, news, social and benchmark data",
        configured: has("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"),
        vars: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
      },
      {
        name: "News cron",
        powers: "The daily 08:00 Dubai news run",
        configured: has("CRON_SECRET"),
        vars: ["CRON_SECRET"],
      },
    ],
    counts: {
      seoKeywords: seo.keywords.length,
      prKeywords: kw.pr.length,
      competitorKeywords: kw.competitor.length,
      benchmarkBrands: perf.brands.length,
      paidAccounts,
    },
    portalSpend: Object.keys(PORTAL_SPEND).map((p) => ({ portal: p, monthly: avgMonthlySpend(p) })),
    portalSpendTotal: avgMonthlySpendTotal(),
    portalSpendSource: SPEND_SOURCE_LABEL,
    lastIngest: last
      ? { ranAt: last.ran_at, trigger: last.trigger, ok: last.ok, inserted: last.inserted }
      : null,
    pinsFromEnv: { app: !!process.env.DASHBOARD_PIN, settings: !!process.env.SETTINGS_PIN },
    paidCache: { ...cache, restateDays: RESTATE_DAYS },
  };
}
