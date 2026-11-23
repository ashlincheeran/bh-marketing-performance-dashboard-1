// Headline numbers for the Dashboard from the two tabs that have no API of
// their own: PR & Media and the social benchmark. Both read Supabase, so this is
// fast and worth bundling into one call — unlike the CRM, Supermetrics and
// PostHog sources, which the Dashboard fetches separately because they're slow.
//
// Summary only. Deliberately returns counts and totals, never rows: the owning
// tabs stay the place to see the detail.
import { errorMessage } from "@/lib/coerce";
import { dateOrNull, todayIn } from "@/lib/dateRanges";
import { getMentions, getPerfMetrics, getSocialConfig, getSocialMentions, getSov } from "@/lib/data";
import { dayLabel } from "@/lib/insights";
import { brandHandle, sentimentSummary } from "@/lib/peopleSentiment";
import { kpis } from "@/lib/pr";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export interface SummaryData {
  pr: {
    /**
     * Every press story dated this calendar year, to today (Dubai's calendar),
     * counted as the PR tab counts them: one per placement, every brand, the
     * clipping archive and the news bot's finds together. Whatever the range
     * asked for. 0 when `error` is set, which is not a real zero.
     */
    stories: number;
    /** The year those stories are counted for. */
    year: number;
    /**
     * Why the live press data could not be read, when it could not. The
     * figures above are then zeros, never the clipping file bundled with the
     * app. The social figures are still real: the Dashboard blanks only the
     * press tile.
     */
    error?: string;
    /** Our share of news volume, 0-1, from the year-to-date Share of Voice. */
    sov: number | null;
    /** Why that share could not be worked out, when it could not. `sov` is then null, which is not "no share". */
    sovError?: string;
    /**
     * Last day that share counts ("YYYY-MM-DD") when stored competitor coverage
     * ends before today, else null. It ended on 22 Jun 2026: counted to today,
     * the share read 42% against 17% like for like.
     */
    sovThrough: string | null;
    /** sovThrough as the tile shows it, e.g. "22 Jun 2026". */
    sovThroughLabel: string | null;
    /** Months ("YYYY-MM") left out of the share because no competitor story is stored for them. */
    sovMonthsLeftOut: string[];
    /** Best-ranked competitor we trail, or null when we lead. */
    ahead: boolean | null;
  };
  /**
   * People sentiment, counted as its tab counts it (lib/peopleSentiment.ts):
   * the distinct posts the AI has checked, dated in the range asked for (every
   * post without one), and their net sentiment, -1 to +1, null with none scored.
   */
  people: { posts: number; net: number | null };
  social: {
    /**
     * Our followers on each platform, most first. Never added up: the same
     * people follow on several platforms, so a sum overstates the audience.
     */
    byPlatform: { platform: string; followers: number }[];
    /** Our average engagement rate as a fraction, averaged over platforms that have one. */
    engagement: number | null;
    /** Platforms we have live figures for. */
    platforms: number;
    /** When the oldest of our figures was captured (YYYY-MM-DD): a run that failed leaves the last one in place. */
    asOf: string | null;
  };
  /**
   * Set only when the summary failed as a whole, and then nothing else is
   * sent. A press read that failed on its own is `pr.error`, beside real
   * social figures.
   */
  error?: string;
}

export async function GET(req: Request) {
  // The Dashboard's date range: the stories counted are those dated inside it.
  const { searchParams } = new URL(req.url);
  const asked = [dateOrNull(searchParams.get("from") ?? undefined), dateOrNull(searchParams.get("to") ?? undefined)];
  try {
    const [{ mentions, source, error: readError }, sov, perf, socialMentions, socialConfig] = await Promise.all([
      getMentions(),
      getSov(),
      getPerfMetrics(),
      getSocialMentions(),
      getSocialConfig(),
    ]);
    // When the live read fails, getMentions hands back no clips and the reason:
    // the tile shows "—", never a count.
    const prError = source === "supabase" ? null : `Live press data could not be loaded: ${readError ?? "unknown error"}`;

    // Every story this year to today, the clipping archive (to May 2026) and the
    // news bot's finds together, one per placement as the PR tab counts them.
    // Undated stories are left out rather than assumed to be this year's.
    const t = todayIn("Asia/Dubai");
    const year = t.getFullYear();
    const today = `${year}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    const thisYear = prError ? [] : mentions.filter((m) => m.date && m.date >= `${year}-01-01` && m.date.slice(0, 10) <= today);
    const press = kpis(thisYear);

    // A Share of Voice that could not be worked out is said, never shown as no share.
    const sovError = sov.error ? `Share of Voice could not be worked out: ${sov.error}` : null;
    const usSov = sov.items.find((s) => s.isUs) ?? null;
    const bestRival = sov.items.filter((s) => !s.isUs).sort((a, b) => b.share - a.share)[0] ?? null;

    const us = perf.filter((p) => p.is_us);
    // Average the per-platform rates — they're already normalised by followers,
    // so summing them would be meaningless.
    const rates = us.map((p) => p.engagement_rate).filter((r): r is number => r != null);

    const people = sentimentSummary(socialMentions, brandHandle(socialConfig), ...(asked[0] && asked[1] ? ([asked[0], asked[1]].sort() as [string, string]) : []));

    const data: SummaryData = {
      people,
      pr: {
        stories: press.count,
        year,
        ...(prError ? { error: prError } : {}),
        sov: usSov ? usSov.share / 100 : null,
        ...(sovError ? { sovError } : {}),
        sovThrough: sov.through,
        sovThroughLabel: sov.through ? dayLabel(sov.through) : null,
        sovMonthsLeftOut: sov.monthsLeftOut,
        ahead: usSov && bestRival ? usSov.share >= bestRival.share : null,
      },
      social: {
        byPlatform: us
          .filter((p) => (p.followers ?? 0) > 0)
          .map((p) => ({ platform: p.platform, followers: p.followers ?? 0 }))
          .sort((a, b) => b.followers - a.followers),
        // engagement_rate is stored as a percent; the UI formats fractions.
        engagement: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length / 100 : null,
        platforms: us.filter((p) => (p.followers ?? 0) > 0).length,
        asOf: us.reduce<string | null>((min, p) => (p.captured_at && (!min || p.captured_at < min) ? p.captured_at : min), null)?.slice(0, 10) ?? null,
      },
    };
    if (prError) console.error(`[api/summary] ${prError}`);
    if (sovError) console.error(`[api/summary] ${sovError}`);
    // 503 so the Dashboard asks once more, as it does for any server error:
    // a failed page read is often fine a moment later.
    return Response.json(data, { status: prError ? 503 : 200, headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = errorMessage(e);
    console.error(`[api/summary] ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}
