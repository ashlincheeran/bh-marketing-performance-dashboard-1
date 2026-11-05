// Global admin switches. Server-only.
//
// Read on the server before any upstream call, which is what makes the
// Supermetrics switch actually save quota: the pages fetch during render, so a
// client-side flag would arrive too late to prevent the request.
import { readClient } from "@/lib/supabase";
import type { NewsSettings } from "@/lib/news/types";

/**
 * Where the SEO tab's Search Console figures come from.
 *
 *   supermetrics — through the Supermetrics Data Fetching API. No Google Cloud
 *                  setup, but it spends the shared monthly row quota, and the
 *                  keyword query alone can return 5,000 rows per call.
 *   direct       — Google's own Search Console API via a service account. Free,
 *                  and spends no Supermetrics rows at all. Needs GSC_CLIENT_EMAIL
 *                  and GSC_PRIVATE_KEY, and the account added to the property.
 *
 * Same underlying data either way — Supermetrics reads the same property.
 */
export type SeoSource = "supermetrics" | "direct";

export interface AppSettings {
  /** When false, no Supermetrics HTTP call is made anywhere in the app. */
  supermetricsEnabled: boolean;
  seoSource: SeoSource;
  /** Optional reason, shown to viewers while it is off. */
  note: string;
  /** When the switch was last changed, ISO. */
  updatedAt: string | null;
  /** The news bot: which Claude model checks articles, and whether Apify may read blocked pages. */
  news: NewsSettings;
}

export const NEWS_MODELS: NewsSettings["model"][] = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

export const DEFAULT_NEWS_SETTINGS: NewsSettings = {
  // Haiku: the program has already struck out the look-alike names, so what is
  // left is a short sorting job, and Haiku costs about a fortieth of Opus.
  model: "claude-haiku-5-5",
  // Off: Apify's monthly allowance ran out in October 2026, and a free page
  // read covers most sites.
  apifyBackup: false,
  apifyMonthlyCap: 30,
  // Two days, so a morning the run fails is still covered by the next one.
  searchWindow: "2d",
  // On: a fresh install counts what the bot finds. Test mode is chosen in Settings.
  countOnPrTab: true,
};

/** Whatever is stored, as valid news settings: anything unknown falls back to the default. */
export function cleanNewsSettings(raw: unknown): NewsSettings {
  const p = (raw ?? {}) as Partial<Record<keyof NewsSettings, unknown>>;
  const cap = Number(p.apifyMonthlyCap);
  return {
    model: NEWS_MODELS.includes(p.model as NewsSettings["model"]) ? (p.model as NewsSettings["model"]) : DEFAULT_NEWS_SETTINGS.model,
    apifyBackup: p.apifyBackup === true,
    apifyMonthlyCap: Number.isInteger(cap) && cap >= 0 && cap <= 500 ? cap : DEFAULT_NEWS_SETTINGS.apifyMonthlyCap,
    searchWindow: (["", "1d", "2d", "7d"] as const).includes(p.searchWindow as NewsSettings["searchWindow"])
      ? (p.searchWindow as NewsSettings["searchWindow"])
      : DEFAULT_NEWS_SETTINGS.searchWindow,
    // Only an explicit false turns counting off, so a missing value never hides the bot's finds.
    countOnPrTab: p.countOnPrTab !== false,
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  // Defaults to ON so a missing table or a failed read behaves exactly as the
  // app did before the switch existed. Failing closed would silently blank
  // every paid figure the first time Supabase hiccupped.
  supermetricsEnabled: true,
  // Supermetrics, because that is what the tab used before this setting
  // existed. Deploying this must not change where the numbers come from; that
  // is a decision for Settings, made on purpose.
  seoSource: "supermetrics",
  note: "",
  updatedAt: null,
  news: DEFAULT_NEWS_SETTINGS,
};

export async function getAppSettings(): Promise<AppSettings> {
  const db = readClient();
  if (!db) return DEFAULT_APP_SETTINGS;
  try {
    const { data } = await db.from("app_settings").select("payload, updated_at").eq("id", 1).maybeSingle();
    const p = (data?.payload ?? {}) as Partial<AppSettings>;
    return {
      // Only an explicit `false` turns it off, so a malformed or partial payload
      // cannot accidentally disable the whole paid channel.
      supermetricsEnabled: p.supermetricsEnabled !== false,
      // Only an exact "direct" switches it, for the same reason as above: a
      // malformed payload must land on the behaviour the app already had.
      seoSource: p.seoSource === "direct" ? "direct" : "supermetrics",
      note: typeof p.note === "string" ? p.note : "",
      updatedAt: (data?.updated_at as string | undefined) ?? null,
      news: cleanNewsSettings((p as { news?: unknown }).news),
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

/** True when Supermetrics may be called. Also false with no API key at all. */
export async function supermetricsAllowed(): Promise<boolean> {
  if (!process.env.SUPERMETRICS_API_KEY) return false;
  return (await getAppSettings()).supermetricsEnabled;
}
