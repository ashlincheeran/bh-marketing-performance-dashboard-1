// Paid media (Digital Performance) — Google Ads, Meta and LinkedIn, all pulled
// through Supermetrics. Server-only.
//
// Uses the same Supermetrics Data Fetching API as lib/gsc.ts:
//   SUPERMETRICS_API_KEY           the Data Fetching API key (hub.supermetrics.com)
//   SUPERMETRICS_API_URL           override the endpoint if your plan differs
//   SUPERMETRICS_DS_USER_GOOGLE    ─┐ the login that authorised each source.
//   SUPERMETRICS_DS_USER_META       │ Per source, NOT per key: sending the wrong
//   SUPERMETRICS_DS_USER_LINKEDIN  ─┘ one returns 403 QUERY_AUTH_UNAVAILABLE.
//
// SUPERMETRICS_DS_USER is deliberately NOT read here. It holds the login that
// authorised Search Console, which is authorised for nothing else, so falling
// back to it made every ad platform fail with a 403 that read like a data
// problem.
//
// Every field ID below was verified against the live account, not taken from
// documentation — Supermetrics field IDs are per-source and inconsistent in case
// and naming (Google `Campaignname`, LinkedIn `campaignName`, Meta
// `adcampaign_name`), so guessing them yields a silent empty card.
import { getPaidConfig } from "@/lib/data";
import { getAppSettings } from "@/lib/appSettings";
import { contiguousBlocks, daysNeeding, readDaily, writeDaily, type PaidDailyRow } from "@/lib/paidStore";
import { clearNotification, notify } from "@/lib/notify";
import { VERIFIED_BLOCKED as VERIFIED_UNPRIORITISED } from "@/lib/paidAccounts";

const SM_ENDPOINT = process.env.SUPERMETRICS_API_URL || "https://api.supermetrics.com/enterprise/v2/query/data/json";

export type PaidPlatform = "google" | "meta" | "linkedin";

/**
 * What a campaign was actually trying to achieve. Campaigns are not comparable
 * on one number — a reach campaign has no leads and a lead campaign's link
 * clicks are beside the point — so each row carries its goal and the dashboard
 * reports the outcome that matches it.
 */
export type CampaignGoal = "leads" | "traffic" | "conversions" | "awareness" | "engagement" | "other";

/**
 * How deep a report goes. "adset" is Meta's word; it maps to Google ad groups.
 * Platforms that cannot express a level keep their rows at the deepest level
 * they CAN express, marked via `granularity`, rather than dropping out of the
 * view silently.
 */
export type PaidLevel = "campaign" | "adset" | "ad";

export interface CampaignRow {
  platform: PaidPlatform;
  accountId: string;
  accountName: string;
  campaign: string;
  /** Platform's campaign id, where exposed (Meta). Second join key to the CRM. */
  campaignId: string | null;
  /** Ad set (Meta) / ad group (Google) when the level asked for it. */
  adset: string | null;
  /** Ad name (Meta only — Google responsive ads have no single name). */
  ad: string | null;
  /** The depth this row actually has — may be shallower than the requested level. */
  granularity: PaidLevel;
  /** Raw platform objective, where the platform exposes one (Meta does). */
  objective: string | null;
  goal: CampaignGoal;
  currency: string;
  impressions: number;
  clicks: number;
  cost: number;
  /** The outcome that matches `goal` — what this campaign should be judged on. */
  result: number;
  /** Human label for `result`, e.g. "Leads", "Link clicks". */
  resultLabel: string;
  // Meta reports several outcomes at once and the ask was to see all of them.
  // Null on platforms that do not break them out this way.
  linkClicks: number | null;
  websiteConversions: number | null;
  websiteLeads: number | null;
  facebookLeads: number | null;
  conversions: number | null;
}

export interface PaidAccount {
  platform: PaidPlatform;
  id: string;
  name: string;
}

/** An account that was selected but could not be read, and why. */
export interface AccountFailure {
  platform: PaidPlatform;
  accountId: string;
  accountName: string;
  /** Plain-language cause, suitable for showing in a table cell. */
  reason: string;
  /** Supermetrics licenses a subset of ad accounts; this one is outside it. */
  notPrioritised: boolean;
  /** Wrong or missing ds_user for this source — a config fix, not a data one. */
  authProblem: boolean;
  /** The untouched response, for when the summary is not enough. */
  raw?: string;
}

export interface PaidData {
  connected: boolean;
  /**
   * True when an admin has switched Supermetrics off in Settings.
   *
   * Distinct from `connected` and `unconfigured`: those mean "no key" and "no
   * accounts chosen". This one means deliberately paused, and the tab says so
   * rather than showing an empty state that looks like breakage.
   */
  paused?: boolean;
  /** The admin's reason, if they left one. */
  pausedNote?: string;
  label: string;
  from: string;
  to: string;
  level: PaidLevel;
  rows: CampaignRow[];
  /** Some account hit the 10k-row cap, so totals may undercount. */
  truncated: boolean;
  /**
   * Daily series at (date × platform × campaign) granularity, so the trend
   * charts narrow with the dashboard's campaign filters instead of quietly
   * plotting every campaign whatever is selected. Carries campaignId as well,
   * since Meta leads can join on either.
   *
   * `leads` is platform-reported: Meta website + form leads; Google/LinkedIn
   * conversions (their lead proxy) — never link clicks, which are traffic.
   */
  byDateFine: { date: string; platform: PaidPlatform; campaign: string; campaignId: string | null; cost: number; leads: number }[];
  /** Distinct currencies present. More than one means spend must not be summed. */
  currencies: string[];
  accountsUsed: PaidAccount[];
  /**
   * Account-days actually fetched from Supermetrics on this request. 0 means the
   * whole range was served from cache and cost no API rows.
   */
  fetchedDays?: number;
  /**
   * Accounts that answered fine but had nothing in range. Tracked separately
   * from failures because otherwise they vanish: an account with no spend
   * appears in neither list and the reader cannot tell it was even asked.
   */
  emptyAccounts: PaidAccount[];
  failures: AccountFailure[];
  /** True when no account was selected yet — the UI prompts for config instead. */
  unconfigured: boolean;
  error?: string;
}

// ─── Platform registry ────────────────────────────────────────────────────────
// One place per platform: its Supermetrics ds_id and the field IDs to request.
// Adding a platform means adding an entry here plus its accounts to the config.
// Snapchat (ds_id SCM) is also authenticated on this subscription but is left
// out until its field IDs are verified the same way these were.
type FieldMap = {
  date: string;
  campaign: string;
  /** Campaign id, for joining CRM utm_campaign values that carry ids. */
  campaignId?: string;
  /** Ad set / ad group dimension, when the platform has one. */
  adset?: string;
  /** Ad-name dimension, when the platform has one. */
  ad?: string;
  currency: string;
  impressions: string;
  cost: string;
  /** Total clicks. Meta has no equivalent in this set, so it uses link clicks. */
  clicks?: string;
  objective?: string;
  conversions?: string;
  linkClicks?: string;
  websiteConversions?: string;
  websiteLeads?: string;
  facebookLeads?: string;
};

interface PlatformSpec {
  dsId: string;
  label: string;
  fields: FieldMap;
  /**
   * Env var naming the Supermetrics login that authorised THIS source.
   *
   * Authorisation is per source and per user, not per API key: each connection
   * is owned by whoever linked it. Sending the wrong login returns HTTP 403
   * QUERY_AUTH_UNAVAILABLE, which is what happened when this reused the GSC
   * client's user for the ad platforms.
   */
  dsUserEnv: string;
  /** Who Supermetrics reports as having connected this source, for the error. */
  dsUserHint: string;
}

export const PLATFORMS: Record<PaidPlatform, PlatformSpec> = {
  google: {
    dsId: "AW",
    label: "Google Ads",
    dsUserEnv: "SUPERMETRICS_DS_USER_GOOGLE",
    dsUserHint: "alina.osmanli@bhomes.com, marketing@bhomes.com or digital@bhomes.com",
    // Verified live: returned BH-Search-UAE-EN-Valuation, GGL_SEARCH_CT1_BRAND.
    fields: {
      date: "Date",
      campaign: "Campaignname",
      adset: "Adgroupname",
      currency: "Currencycode",
      impressions: "Impressions",
      clicks: "Clicks",
      cost: "Cost",
      conversions: "Conversions",
    },
  },
  meta: {
    dsId: "FA",
    label: "Meta Ads",
    dsUserEnv: "SUPERMETRICS_DS_USER_META",
    dsUserHint: "Ashlin Cheeran — try the Facebook user id 122111799831053725",
    fields: {
      date: "Date",
      campaign: "adcampaign_name",
      campaignId: "adcampaign_id",
      adset: "adset_name",
      ad: "ad_name",
      currency: "currency",
      objective: "campaignobjective",
      impressions: "impressions",
      cost: "cost",
      linkClicks: "action_link_click",
      websiteConversions: "offsite_conversions",
      websiteLeads: "offsite_conversions_fb_pixel_lead",
      facebookLeads: "onsite_conversion.lead_grouped",
    },
  },
  linkedin: {
    dsId: "LIA",
    label: "LinkedIn Ads",
    dsUserEnv: "SUPERMETRICS_DS_USER_LINKEDIN",
    dsUserHint: "Qaswa Kamran",
    // Verified live: returned Spotlight, InMail. `cost` canonicalises to
    // `spend`, so the canonical ID is used directly.
    fields: {
      date: "Date",
      campaign: "campaignName",
      currency: "accountCurrencyCode",
      impressions: "impressions",
      clicks: "clicks",
      cost: "spend",
      conversions: "conversions",
    },
  },
};

// ─── Goal mapping ─────────────────────────────────────────────────────────────
/**
 * Meta objective → goal. Objectives come in an older (`LINK_CLICKS`) and a newer
 * Outcome-Driven (`OUTCOME_TRAFFIC`) vocabulary and both still appear on live
 * accounts, so both are matched. Anything unrecognised falls through to
 * 'other' and is reported on its raw counts rather than being forced into a
 * bucket it may not belong in.
 */
function metaGoal(objective: string | null): CampaignGoal {
  const o = (objective || "").toUpperCase();
  if (!o) return "other";
  if (o.includes("LEAD")) return "leads";
  if (o.includes("SALES") || o.includes("CONVERSION") || o.includes("PURCHASE")) return "conversions";
  if (o.includes("TRAFFIC") || o.includes("LINK_CLICK")) return "traffic";
  if (o.includes("AWARENESS") || o.includes("REACH") || o.includes("BRAND") || o.includes("VIDEO_VIEW")) return "awareness";
  if (o.includes("ENGAGEMENT") || o.includes("MESSAGE") || o.includes("POST")) return "engagement";
  return "other";
}

export const GOAL_LABELS: Record<CampaignGoal, string> = {
  leads: "Leads",
  traffic: "Traffic",
  conversions: "Conversions",
  awareness: "Awareness",
  engagement: "Engagement",
  other: "Other",
};

// ─── Supermetrics client ──────────────────────────────────────────────────────
type SmResult = { rows: any[][] } | { error: string };

/**
 * One Supermetrics query. Returns the reason on failure rather than null,
 * because the two failures that actually happen here need different responses
 * from the reader: an unlicensed account is a subscription change, a timeout is
 * a shorter range.
 */
async function smQuery(
  dsId: string,
  account: string,
  fields: string[],
  from: string,
  to: string,
  dsUser: string | undefined,
  timeoutMs = 25000,
): Promise<SmResult> {
  const key = process.env.SUPERMETRICS_API_KEY;
  if (!key) return { error: "SUPERMETRICS_API_KEY is not set" };
  // Payload shape is kept identical to the working GSC client in lib/gsc.ts.
  //
  // Deliberately no `settings` key: the per-source settings (exclude_invalid_
  // accounts and friends) are documented on Supermetrics' hub and MCP surfaces,
  // and whether this Data Fetching endpoint accepts them here is unverified — an
  // endpoint that rejects unknown keys would fail every query for a setting that
  // is close to redundant anyway, since accounts are queried one at a time and a
  // bad one is already isolated and reported rather than poisoning the request.
  const payload: Record<string, unknown> = {
    ds_id: dsId,
    ds_accounts: [account],
    date_range_type: "custom",
    start_date: from,
    end_date: to,
    fields: fields.join(","),
    max_rows: 10000,
  };
  // Omitted when unconfigured rather than defaulted. There is no sensible
  // fallback: the GSC client's login is authorised for Search Console and
  // nothing else, so borrowing it guarantees a 403 on every ad platform.
  if (dsUser) payload.ds_user = dsUser;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(SM_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      return { error: `non-JSON response: ${text.slice(0, 160)}` };
    }
    if (j?.error) {
      const msg = typeof j.error === "string" ? j.error : j.error?.message || JSON.stringify(j.error);
      return { error: String(msg).slice(0, 300) };
    }
    let rows: any = j?.data;
    if (rows && !Array.isArray(rows) && Array.isArray(rows.data)) rows = rows.data;
    return { rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg.includes("abort") ? `timed out after ${Math.round(timeoutMs / 1000)}s` : msg };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Turn a Supermetrics failure into something a reader can act on.
 *
 * The raw body is a JSON envelope whose one useful token is buried among request
 * ids, so printing it into a table cell fills the column and communicates
 * nothing. The two failures that actually occur are told apart because they need
 * opposite responses: an unlicensed account is a subscription change, a bad
 * ds_user is a deployment variable.
 */
function explain(raw: string, platform: PaidPlatform, accountId: string): { reason: string; notPrioritised: boolean; authProblem: boolean; raw: string } {
  const spec = PLATFORMS[platform];
  const base = { notPrioritised: false, authProblem: false, raw };
  if (/prioritis|prioritiz/i.test(raw)) {
    return { ...base, notPrioritised: true, reason: "Not a prioritised account on this Supermetrics subscription, so its data cannot be pulled." };
  }
  // The Data Fetching API reports the unprioritised case as a bare QUERY_ERROR,
  // unlike the hub API which spells it out. Every account that has shown
  // QUERY_ERROR here was then probed through the hub API and confirmed
  // unprioritised, so the verified list turns this generic code into its actual
  // meaning; for accounts outside that list the wording stays hedged.
  if (/QUERY_ERROR/i.test(raw)) {
    const verified = VERIFIED_UNPRIORITISED[platform]?.includes(accountId);
    return {
      ...base,
      notPrioritised: true,
      reason: verified
        ? "Not a prioritised account on this Supermetrics subscription (verified) — its data cannot be pulled until it is added to the prioritised list."
        : "Supermetrics rejected the query (QUERY_ERROR). For every account checked so far this has meant it is not on the subscription's prioritised list.",
    };
  }
  if (/QUERY_AUTH_UNAVAILABLE|not authori[sz]ed|invalid[_ ]?grant/i.test(raw)) {
    return {
      ...base,
      authProblem: true,
      reason: `Supermetrics has no ${spec.label} authorisation for the login being used. Set ${spec.dsUserEnv} to the account that connected it (${spec.dsUserHint}).`,
    };
  }
  if (/timed out/i.test(raw)) return { ...base, reason: `${raw} — try a shorter date range.` };
  // Unrecognised: surface the message but keep it to a readable length.
  const m = /"description"\s*:\s*"([^"]{4,300})"/.exec(raw) || /"message"\s*:\s*"([^"]{4,300})"/.exec(raw);
  return { ...base, reason: m ? m[1] : raw.slice(0, 240) };
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.eE+-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Drop Supermetrics' leading header row of display names.
 *
 * The test is "first cell is not a date", which works because every query here
 * requests the date dimension first, so a data row always starts with one. The
 * obvious alternative — "all cells are strings and one contains letters" —
 * silently eats the first real row if the API stringifies its numbers, since a
 * campaign name contains letters too. This also disposes of the single-cell
 * "No data found" row, whose first cell is not a date either.
 */
function stripHeader(rows: any[][]): any[][] {
  if (!rows.length) return [];
  return isDate(String(rows[0]?.[0] ?? "")) ? rows : rows.slice(1);
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function paidRange(fromRaw?: string, toRaw?: string, days = 30): { from: string; to: string; label: string } {
  if (fromRaw && toRaw && isDate(fromRaw) && isDate(toRaw) && fromRaw <= toRaw) {
    return { from: fromRaw, to: toRaw, label: `${fromRaw} → ${toRaw}` };
  }
  const d = Math.max(1, Math.min(365, Math.round(days || 30)));
  const to = new Date();
  const from = new Date(Date.now() - (d - 1) * 864e5);
  return { from: ymd(from), to: ymd(to), label: `last ${d} days` };
}

// ─── Per-account fetch ────────────────────────────────────────────────────────
/**
 * Accounts are queried one at a time on purpose. Supermetrics fails the ENTIRE
 * request if any one account in it is outside the subscription's prioritised
 * list — verified against this account, where two of three Meta accounts tried
 * were unlicensed. Batching them would mean one unlicensed account blanking the
 * whole dashboard, so each is isolated and its failure reported individually.
 */
async function fetchAccount(platform: PaidPlatform, acct: PaidAccount, from: string, to: string, level: PaidLevel): Promise<{ rows: CampaignRow[]; failure?: AccountFailure }> {
  const spec = PLATFORMS[platform];
  const f = spec.fields;
  // Which breakdown dims this platform can actually serve at the asked level.
  // A platform without the dimension stays at the deepest level it has, and the
  // row says so via `granularity`, instead of vanishing from the deeper views.
  const wantAdset = (level === "adset" || level === "ad") && !!f.adset;
  const wantAd = level === "ad" && !!f.ad;
  const granularity: PaidLevel = wantAd ? "ad" : wantAdset ? "adset" : "campaign";
  // Order matters: the response columns come back in the order requested.
  const order: (keyof FieldMap)[] = ["date", "campaign"];
  if (f.campaignId) order.push("campaignId");
  if (wantAdset) order.push("adset");
  if (wantAd) order.push("ad");
  order.push("currency");
  if (f.objective) order.push("objective");
  order.push("impressions", "cost");
  for (const k of ["clicks", "conversions", "linkClicks", "websiteConversions", "websiteLeads", "facebookLeads"] as (keyof FieldMap)[]) {
    if (f[k]) order.push(k);
  }
  const fieldIds = order.map((k) => f[k] as string);

  const res = await smQuery(spec.dsId, acct.id, fieldIds, from, to, process.env[spec.dsUserEnv]);
  if ("error" in res) {
    return { rows: [], failure: { platform, accountId: acct.id, accountName: acct.name, ...explain(res.error, platform, acct.id) } };
  }

  const at = (row: any[], k: keyof FieldMap): unknown => {
    const i = order.indexOf(k);
    return i === -1 ? undefined : row[i];
  };
  const out: CampaignRow[] = [];
  for (const row of stripHeader(res.rows)) {
    const objective = f.objective ? String(at(row, "objective") ?? "") || null : null;
    const linkClicks = f.linkClicks ? num(at(row, "linkClicks")) : null;
    const websiteConversions = f.websiteConversions ? num(at(row, "websiteConversions")) : null;
    const websiteLeads = f.websiteLeads ? num(at(row, "websiteLeads")) : null;
    const facebookLeads = f.facebookLeads ? num(at(row, "facebookLeads")) : null;
    const conversions = f.conversions ? num(at(row, "conversions")) : null;
    const impressions = num(at(row, "impressions"));
    const clicks = f.clicks ? num(at(row, "clicks")) : (linkClicks ?? 0);

    // Meta declares its objective, so the goal is read from it. Google and
    // LinkedIn expose no objective in this field set; they are conversion-led by
    // configuration here, so they are reported on conversions and labelled as
    // such rather than having a goal invented for them.
    const goal: CampaignGoal = platform === "meta" ? metaGoal(objective) : "conversions";
    const leads = (websiteLeads ?? 0) + (facebookLeads ?? 0);
    let result = conversions ?? 0;
    let resultLabel = "Conversions";
    if (platform === "meta") {
      if (goal === "leads") { result = leads; resultLabel = "Leads"; }
      else if (goal === "traffic") { result = linkClicks ?? 0; resultLabel = "Link clicks"; }
      else if (goal === "conversions") { result = websiteConversions ?? 0; resultLabel = "Website conversions"; }
      else if (goal === "awareness") { result = impressions; resultLabel = "Impressions"; }
      else if (goal === "engagement") { result = linkClicks ?? 0; resultLabel = "Link clicks"; }
      else {
        // Unknown objective: report whichever outcome actually registered rather
        // than a zero that reads as failure.
        result = leads || websiteConversions || linkClicks || 0;
        resultLabel = leads ? "Leads" : websiteConversions ? "Website conversions" : "Link clicks";
      }
    }

    const dateVal = String(at(row, "date") ?? "");
    out.push({
      platform,
      accountId: acct.id,
      accountName: acct.name,
      campaign: String(at(row, "campaign") ?? "(unnamed)"),
      campaignId: f.campaignId ? String(at(row, "campaignId") ?? "") || null : null,
      adset: wantAdset ? String(at(row, "adset") ?? "") || null : null,
      ad: wantAd ? String(at(row, "ad") ?? "") || null : null,
      granularity,
      objective,
      goal,
      currency: String(at(row, "currency") ?? "") || "—",
      impressions,
      clicks,
      cost: num(at(row, "cost")),
      result,
      resultLabel,
      linkClicks,
      websiteConversions,
      websiteLeads,
      facebookLeads,
      conversions,
      // `date` is carried on the row only to build the trend; it is not part of
      // the campaign identity, so it lives in a non-enumerable slot.
      ...(isDate(dateVal) ? { _date: dateVal } : {}),
    } as CampaignRow & { _date?: string });
  }
  return { rows: out };
}

/**
 * Bring one account's cache up to date for a range, then report what happened.
 *
 * Only missing days and the restatement window are fetched; everything already
 * settled is left alone. Days are written as each block lands, so a request that
 * runs out of time still banks its progress and the next one resumes from the
 * gap rather than starting over.
 */
async function syncAccount(
  acct: PaidAccount,
  level: PaidLevel,
  from: string,
  to: string,
): Promise<{ fetchedDays: number; truncated: boolean; failure?: AccountFailure }> {
  const need = await daysNeeding(acct.platform, acct.id, level, from, to);
  if (!need.length) return { fetchedDays: 0, truncated: false };

  let fetchedDays = 0;
  let truncated = false;
  for (const block of contiguousBlocks(need)) {
    const res = await fetchAccount(acct.platform, acct, block.from, block.to, level);
    // Stop on failure rather than marking the block synced: a failed fetch must
    // leave the days missing so they are retried, not recorded as empty.
    if (res.failure) {
      const quota = /quota|429/i.test(res.failure.reason);
      void notify(
        quota ? "error" : "warning",
        "supermetrics",
        quota ? "Supermetrics row quota exhausted" : `Can't read ${acct.name}`,
        `${acct.platform} · ${acct.name}: ${res.failure.reason}`,
        // Quota is account-wide, so it collapses to one line however many
        // accounts hit it; anything else is per account.
        quota ? "supermetrics:quota" : `supermetrics:account:${acct.id}`,
      );
      return { fetchedDays, truncated, failure: res.failure };
    }
    void clearNotification(`supermetrics:account:${acct.id}`);
    if (res.rows.length >= 9999) truncated = true;

    const rows: PaidDailyRow[] = [];
    for (const r of res.rows) {
      const d = (r as CampaignRow & { _date?: string })._date;
      // A row with no date cannot be filed against a day. Dropping it would
      // undercount silently, so it is counted as a truncation signal instead.
      if (!d) { truncated = true; continue; }
      rows.push({ ...r, date: d });
    }

    const days = [];
    for (const d of need) if (d >= block.from && d <= block.to) days.push(d);
    const w = await writeDaily(acct.platform, acct.id, level, days, rows);
    if (!w.ok) {
      return {
        fetchedDays,
        truncated,
        failure: {
          platform: acct.platform,
          accountId: acct.id,
          accountName: acct.name,
          reason: `Fetched, but could not be cached: ${w.error}`,
          notPrioritised: false,
          authProblem: false,
        },
      };
    }
    fetchedDays += days.length;
  }
  return { fetchedDays, truncated };
}

// ─── Public entry point ───────────────────────────────────────────────────────
export async function getPaidData(fromRaw?: string, toRaw?: string, days = 30, level: PaidLevel = "campaign"): Promise<PaidData> {
  const { from, to, label } = paidRange(fromRaw, toRaw, days);
  const connected = !!process.env.SUPERMETRICS_API_KEY;
  const base: PaidData = {
    connected, label, from, to, level, rows: [], truncated: false, byDateFine: [], currencies: [],
    accountsUsed: [], emptyAccounts: [], failures: [], unconfigured: false, fetchedDays: 0,
  };
  if (!connected) return base;

  // The global switch is checked BEFORE anything else, so an admin turning
  // Supermetrics off costs exactly zero rows — no account queries are issued at
  // all. This does not change how rows are pulled when it is on.
  const settings = await getAppSettings();
  if (!settings.supermetricsEnabled) {
    return { ...base, paused: true, pausedNote: settings.note };
  }

  const cfg = await getPaidConfig();
  const selected: PaidAccount[] = [];
  for (const p of Object.keys(PLATFORMS) as PaidPlatform[]) {
    for (const a of cfg.accounts?.[p] ?? []) selected.push({ platform: p, id: a.id, name: a.name });
  }
  if (!selected.length) return { ...base, unconfigured: true };

  // Fetch only what the cache is missing, then read everything from the cache.
  // Accounts are independent, so they sync concurrently and a slow or unlicensed
  // one degrades its own row rather than the whole tab.
  const synced = await Promise.all(selected.map((a) => syncAccount(a, level, from, to)));
  for (let i = 0; i < synced.length; i++) {
    if (synced[i].failure) base.failures.push(synced[i].failure!);
    if (synced[i].truncated) base.truncated = true;
  }
  base.fetchedDays = synced.reduce((n, s) => n + s.fetchedDays, 0);

  // Everything the tab renders comes from the cache, including days fetched a
  // moment ago — one code path, so a cached read and a fresh one cannot diverge.
  const cached = await readDaily(level, from, to, selected);
  const rows: CampaignRow[] = cached.map((r) => ({ ...r, _date: r.date }) as CampaignRow);

  const seen = new Set(cached.map((r) => r.accountId));
  for (const a of selected) {
    if (base.failures.some((f) => f.accountId === a.id)) continue;
    (seen.has(a.id) ? base.accountsUsed : base.emptyAccounts).push(a);
  }

  // Roll the per-day rows up to one row per campaign, and build the trend from
  // the same data before collapsing it.
  const dayAcc = new Map<string, { date: string; platform: PaidPlatform; campaign: string; campaignId: string | null; cost: number; leads: number }>();
  const campAcc = new Map<string, CampaignRow>();
  for (const r of rows) {
    const d = (r as CampaignRow & { _date?: string })._date;
    if (d) {
      const k = `${d}|${r.platform}|${r.campaign}`;
      const cur = dayAcc.get(k) ?? { date: d, platform: r.platform, campaign: r.campaign, campaignId: r.campaignId, cost: 0, leads: 0 };
      cur.cost += r.cost;
      cur.leads += r.platform === "meta" ? (r.websiteLeads ?? 0) + (r.facebookLeads ?? 0) : (r.conversions ?? 0);
      dayAcc.set(k, cur);
    }
    const key = `${r.platform}|${r.accountId}|${r.campaign}|${r.adset ?? ""}|${r.ad ?? ""}`;
    const prev = campAcc.get(key);
    if (!prev) {
      campAcc.set(key, { ...r });
      continue;
    }
    prev.impressions += r.impressions;
    prev.clicks += r.clicks;
    prev.cost += r.cost;
    prev.result += r.result;
    const add = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    prev.linkClicks = add(prev.linkClicks, r.linkClicks);
    prev.websiteConversions = add(prev.websiteConversions, r.websiteConversions);
    prev.websiteLeads = add(prev.websiteLeads, r.websiteLeads);
    prev.facebookLeads = add(prev.facebookLeads, r.facebookLeads);
    prev.conversions = add(prev.conversions, r.conversions);
  }

  base.rows = [...campAcc.values()].sort((a, b) => b.cost - a.cost);
  base.byDateFine = [...dayAcc.values()].sort((a, b) => a.date.localeCompare(b.date));
  base.currencies = [...new Set(base.rows.map((r) => r.currency).filter((c) => c && c !== "—"))].sort();

  // An empty tab has three quite different causes and they need different
  // responses from the reader, so they are never collapsed into one blank state.
  if (!base.rows.length) {
    if (base.failures.length === selected.length) {
      base.error = `None of the ${selected.length} selected account(s) could be read — see the list below for why.`;
    } else if (base.failures.length) {
      base.error = `No spend in this range. ${base.failures.length} of ${selected.length} selected account(s) also could not be read — see below.`;
    } else {
      base.error = `The ${selected.length} selected account(s) were read successfully but had no activity between ${from} and ${to}. Try a longer range or a different account.`;
    }
  }
  return base;
}
