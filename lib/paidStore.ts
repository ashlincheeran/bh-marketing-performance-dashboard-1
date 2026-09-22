// The Supermetrics cache: daily paid-media rows in Supabase, plus the ledger of
// which days have actually been fetched. Server-only.
//
// THE POINT. Supermetrics bills a monthly row quota, and the app was re-fetching
// the whole window per account on every page load. The API already returns one
// row per DATE — date is the first requested dimension — so the daily grain was
// always in the response and simply aggregated away. Storing it means a given
// day costs rows once, not once per viewer.
//
// THE TRAP, and why this is not a plain "fetch since last update". Ad platforms
// RESTATE recent history: Meta and Google attribute conversions back to the day
// of the click days later, and spend is adjusted for invalid traffic. A day
// fetched this morning is not final. So the sync always re-fetches a trailing
// window and upserts over it; only days older than that window are treated as
// settled. Fetching strictly forward from the last synced date would freeze
// whatever partial numbers happened to be there — quietly, and permanently.
import { adminClient, readClient } from "@/lib/supabase";
import { notify, notifyIfStored } from "@/lib/notify";
import type { CampaignRow, PaidLevel, PaidPlatform } from "@/lib/paid";

/** A stored row: one Supermetrics record, with the date it belongs to. */
export interface PaidDailyRow extends CampaignRow {
  date: string; // YYYY-MM-DD
}

/**
 * How many trailing days are always re-fetched, however recently they were
 * synced.
 *
 * 14 covers Meta's 7-day click window with room for late-landing conversions
 * and spend adjustments. Shorter risks freezing numbers before the platform has
 * finished restating them; longer just costs rows. Tune with PAID_RESTATE_DAYS.
 */
export const RESTATE_DAYS = Math.max(1, Number(process.env.PAID_RESTATE_DAYS || 14));

/**
 * How stale a day inside the restatement window may be before it is re-fetched.
 *
 * Without this the window would be re-fetched on EVERY page load — ten viewers
 * would mean ten fourteen-day fetches, which defeats the point of caching at
 * all. Twelve hours means a restated day is picked up twice daily at most,
 * while a settled day is never re-fetched.
 */
export const RESTATE_TTL_MS = Math.max(
  60_000,
  Number(process.env.PAID_RESTATE_TTL_MS || 12 * 60 * 60 * 1000),
);

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Every date from `from` to `to` inclusive, as YYYY-MM-DD. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (const d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(ymd(d));
  }
  return out;
}

/**
 * The days that must be fetched for one account: any day in the range with no
 * ledger entry, plus every day inside the restatement window regardless.
 *
 * Returned sorted and de-duplicated, so a caller can fetch contiguous blocks.
 */
export async function daysNeeding(
  platform: PaidPlatform,
  accountId: string,
  level: PaidLevel,
  from: string,
  to: string,
): Promise<string[]> {
  const all = dateRange(from, to);
  const db = readClient();
  if (!db) return all; // no database → nothing is cached, so everything is needed

  const { data, error } = await db
    .from("paid_sync_days")
    .select("date, synced_at")
    .eq("platform", platform)
    .eq("account_id", accountId)
    .eq("level", level)
    .gte("date", from)
    .lte("date", to);

  // On a read error, re-fetch rather than assume cached. Assuming the cache is
  // complete when the check failed is how days go permanently missing.
  if (error) return all;

  // Keep synced_at, not just the date: a day inside the restatement window is
  // only worth re-fetching if it has not already been refreshed recently.
  const syncedAt = new Map<string, number>();
  for (const r of data ?? []) {
    syncedAt.set(String(r.date).slice(0, 10), Date.parse(String(r.synced_at)) || 0);
  }
  const restateFrom = ymd(new Date(Date.now() - (RESTATE_DAYS - 1) * 864e5));
  const stale = Date.now() - RESTATE_TTL_MS;
  return all.filter((d) => {
    const at = syncedAt.get(d);
    if (at === undefined) return true;          // never fetched — a real gap
    if (d < restateFrom) return false;          // settled; platforms no longer restate it
    return at < stale;                          // recent, but not refreshed lately
  });
}

/**
 * Group sorted days into contiguous blocks, so a sparse set of gaps becomes a
 * few range requests rather than one per day — or one huge range spanning
 * months because a single old day was missing.
 */
export function contiguousBlocks(days: string[]): { from: string; to: string }[] {
  if (!days.length) return [];
  const sorted = [...new Set(days)].sort();
  const out: { from: string; to: string }[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const d of sorted.slice(1)) {
    const next = new Date(`${prev}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    if (d === ymd(next)) { prev = d; continue; }
    out.push({ from: start, to: prev });
    start = d;
    prev = d;
  }
  out.push({ from: start, to: prev });
  return out;
}

/** Cached rows for a range, across the given accounts. */
export async function readDaily(
  level: PaidLevel,
  from: string,
  to: string,
  accounts: { platform: PaidPlatform; id: string }[],
): Promise<PaidDailyRow[]> {
  const db = readClient();
  if (!db || !accounts.length) return [];
  const ids = accounts.map((a) => a.id);

  // Paged: Supabase caps a single select, and a wide range across several
  // accounts at ad level can exceed it. Silently returning the first page would
  // undercount spend, which is worse than being slow.
  const PAGE = 1000;
  const out: PaidDailyRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("paid_daily")
      .select("*")
      .eq("level", level)
      .gte("date", from)
      .lte("date", to)
      .in("account_id", ids)
      .order("date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error || !data?.length) break;
    for (const r of data) out.push(fromDb(r));
    if (data.length < PAGE) break;
  }
  return out;
}

function fromDb(r: Record<string, unknown>): PaidDailyRow {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    date: String(r.date).slice(0, 10),
    platform: r.platform as PaidPlatform,
    accountId: String(r.account_id),
    accountName: String(r.account_name ?? r.account_id),
    campaign: String(r.campaign ?? "(unnamed)"),
    campaignId: (r.campaign_id as string) ?? null,
    adset: (r.adset as string) ?? null,
    ad: (r.ad as string) ?? null,
    granularity: (r.granularity as PaidLevel) ?? "campaign",
    objective: (r.objective as string) ?? null,
    goal: r.goal as CampaignRow["goal"],
    currency: String(r.currency ?? "—"),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    cost: Number(r.cost ?? 0),
    result: Number(r.result ?? 0),
    resultLabel: String(r.result_label ?? ""),
    linkClicks: n(r.link_clicks),
    websiteConversions: n(r.website_conversions),
    websiteLeads: n(r.website_leads),
    facebookLeads: n(r.facebook_leads),
    conversions: n(r.conversions),
  };
}

/**
 * Store a fetched block and mark its days synced, in that order.
 *
 * Order matters: marking a day synced before its rows are safely stored would
 * make a failed write look like a day with no spend, and it would never be
 * re-fetched.
 */
export async function writeDaily(
  platform: PaidPlatform,
  accountId: string,
  level: PaidLevel,
  days: string[],
  rows: PaidDailyRow[],
): Promise<{ ok: boolean; error?: string }> {
  const db = adminClient();
  if (!db) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not set" };

  if (rows.length) {
    const payload = rows.map((r) => ({
      date: r.date,
      platform: r.platform,
      account_id: r.accountId,
      level,
      campaign: r.campaign,
      adset: r.adset,
      ad: r.ad,
      account_name: r.accountName,
      campaign_id: r.campaignId,
      granularity: r.granularity,
      objective: r.objective,
      goal: r.goal,
      currency: r.currency,
      impressions: r.impressions,
      clicks: r.clicks,
      cost: r.cost,
      result: r.result,
      result_label: r.resultLabel,
      link_clicks: r.linkClicks,
      website_conversions: r.websiteConversions,
      website_leads: r.websiteLeads,
      facebook_leads: r.facebookLeads,
      conversions: r.conversions,
      synced_at: new Date().toISOString(),
    }));
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await db
        .from("paid_daily")
        .upsert(payload.slice(i, i + 500), { onConflict: "date,platform,account_id,level,campaign,adset_k,ad_k" });
      if (error) return { ok: false, error: error.message };
    }
  }

  const perDay = new Map<string, number>();
  for (const d of days) perDay.set(d, 0);
  for (const r of rows) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);

  const { error } = await db.from("paid_sync_days").upsert(
    days.map((d) => ({
      platform,
      account_id: accountId,
      level,
      date: d,
      rows: perDay.get(d) ?? 0,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "platform,account_id,level,date" },
  );
  if (error) {
    await notify(
      "error",
      "supabase",
      "Paid data fetched but not saved",
      `${platform} ${accountId}: ${error.message}`,
      `paid-write:${platform}:${accountId}:${level}`,
    );
    return { ok: false, error: error.message };
  }

  // Announced from what Supabase reports back, not from what was just sent. A
  // write that silently stored nothing must not produce an "updated" message.
  await notifyIfStored(
    "supermetrics",
    (n) => `Paid metrics updated — ${n.rows.toLocaleString()} rows`,
    (n) => `${platform} · ${accountId} · ${level} · ${days[0]} to ${days[days.length - 1]} · confirmed ${n.at}`,
    `paid-sync:${platform}:${accountId}:${level}`,
    async () => {
      const { data } = await db
        .from("paid_sync_days")
        .select("rows, synced_at")
        .eq("platform", platform)
        .eq("account_id", accountId)
        .eq("level", level)
        .in("date", days);
      if (!data?.length) return null;
      return {
        rows: data.reduce((t, r) => t + Number(r.rows ?? 0), 0),
        at: data.map((r) => String(r.synced_at)).sort().pop() ?? null,
      };
    },
  );
  return { ok: true };
}

/** What the cache holds, for the Settings panel. */
export async function cacheStatus(): Promise<{
  days: number;
  rows: number;
  oldest: string | null;
  newest: string | null;
  lastSyncedAt: string | null;
}> {
  const db = readClient();
  const empty = { days: 0, rows: 0, oldest: null, newest: null, lastSyncedAt: null };
  if (!db) return empty;
  try {
    const { count } = await db.from("paid_daily").select("*", { count: "exact", head: true });
    const { data: lo } = await db.from("paid_sync_days").select("date").order("date", { ascending: true }).limit(1);
    const { data: hi } = await db.from("paid_sync_days").select("date").order("date", { ascending: false }).limit(1);
    const { data: last } = await db.from("paid_sync_days").select("synced_at").order("synced_at", { ascending: false }).limit(1);
    const { count: dayCount } = await db.from("paid_sync_days").select("*", { count: "exact", head: true });
    return {
      days: dayCount ?? 0,
      rows: count ?? 0,
      oldest: lo?.[0]?.date ? String(lo[0].date).slice(0, 10) : null,
      newest: hi?.[0]?.date ? String(hi[0].date).slice(0, 10) : null,
      lastSyncedAt: (last?.[0]?.synced_at as string) ?? null,
    };
  } catch {
    return empty;
  }
}
