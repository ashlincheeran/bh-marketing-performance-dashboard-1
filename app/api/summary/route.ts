// Headline numbers for the Dashboard from the two tabs that have no API of
// their own: PR & Media and the social benchmark. Both read Supabase, so this is
// fast and worth bundling into one call — unlike the CRM, Supermetrics and
// PostHog sources, which the Dashboard fetches separately because they're slow.
//
// Summary only. Deliberately returns counts and totals, never rows: the owning
// tabs stay the place to see the detail.
import { getMentions, getPerfMetrics, getSov } from "@/lib/data";
import { dayLabel } from "@/lib/insights";
import { kpis } from "@/lib/pr";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export interface SummaryData {
  pr: {
    /**
     * Mentions in the last rolling 12 months, every brand counted, as the PR
     * tab counts them. 0 when `error` is set, which is not a real zero.
     */
    mentions: number;
    /** Estimated advertising value and reach over the same window, AED / people. */
    eav: number;
    reach: number;
    /**
     * Why the live press data could not be read, when it could not. The
     * figures above are then zeros, never the clipping file bundled with the
     * app, and the top-level `error` says the same.
     */
    error?: string;
    /** Our share of news volume, 0-1, from the year-to-date Share of Voice. */
    sov: number | null;
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
  social: {
    /** Our followers summed across platforms. */
    followers: number;
    /** Our average engagement rate as a fraction, averaged over platforms that have one. */
    engagement: number | null;
    /** Platforms we have live figures for. */
    platforms: number;
    /** Our follower share against the benchmarked competitors, 0-1. */
    share: number | null;
  };
  error?: string;
}

export async function GET() {
  try {
    const [{ mentions, source, error: readError }, sov, perf] = await Promise.all([getMentions(), getSov(), getPerfMetrics()]);
    // When the live read fails, getMentions hands back the clipping file
    // bundled with the app, which ends in April 2026. The PR tab says so in a
    // banner; here it would have been shown as this year's figures.
    const prError = source === "supabase" ? null : `Live press data could not be loaded: ${readError ?? "unknown error"}`;

    // Rolling 12 months. Mentions without a date are excluded rather than
    // assumed recent, as dating is patchy on older rows. Every brand counts, as
    // on the PR tab: leaving out CRC, PRIME and the other sub-brands read
    // about 10% below the tab this tile links to.
    const cutoff = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    const recent = prError ? [] : mentions.filter((m) => m.date && m.date >= cutoff);
    const press = kpis(recent);

    const usSov = sov.items.find((s) => s.isUs) ?? null;
    const bestRival = sov.items.filter((s) => !s.isUs).sort((a, b) => b.share - a.share)[0] ?? null;

    const us = perf.filter((p) => p.is_us);
    const rivals = perf.filter((p) => !p.is_us);
    const usFollowers = us.reduce((s, p) => s + (p.followers ?? 0), 0);
    const rivalFollowers = rivals.reduce((s, p) => s + (p.followers ?? 0), 0);
    // Average the per-platform rates — they're already normalised by followers,
    // so summing them would be meaningless.
    const rates = us.map((p) => p.engagement_rate).filter((r): r is number => r != null);

    const data: SummaryData = {
      pr: {
        mentions: press.count,
        eav: press.eav,
        reach: press.reach,
        ...(prError ? { error: prError } : {}),
        sov: usSov ? usSov.share / 100 : null,
        sovThrough: sov.through,
        sovThroughLabel: sov.through ? dayLabel(sov.through) : null,
        sovMonthsLeftOut: sov.monthsLeftOut,
        ahead: usSov && bestRival ? usSov.share >= bestRival.share : null,
      },
      social: {
        followers: usFollowers,
        // engagement_rate is stored as a percent; the UI formats fractions.
        engagement: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length / 100 : null,
        platforms: us.filter((p) => (p.followers ?? 0) > 0).length,
        share: usFollowers + rivalFollowers > 0 ? usFollowers / (usFollowers + rivalFollowers) : null,
      },
      // At the top level as well, because that is what the Dashboard reads
      // today: it then shows the press and social tiles blank and lists them
      // under "Couldn't load". `pr.error` lets it blank only the press tile.
      ...(prError ? { error: prError } : {}),
    };
    if (prError) console.error(`[api/summary] ${prError}`);
    // 503 so the Dashboard asks once more, as it does for any server error:
    // a failed page read is often fine a moment later.
    return Response.json(data, { status: prError ? 503 : 200, headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[api/summary] ${msg}`);
    return Response.json({ error: msg }, { status: 500 });
  }
}
