// The Digital Pipeline Scorecard's figures (the Digital tab), worked out in the
// browser from the two halves the tab loads:
//   - the ad platforms' spend, impressions, clicks and platform-reported leads,
//     per campaign and day (Supermetrics, lib/paid.ts byDateFine);
//   - each campaign's paid leads in the CRM, per month they were created, and
//     the viewings, listings and deals on them (the CRM, lib/digitalPipeline.ts).
// Each ad campaign is its own row: a Meta campaign's CRM leads can carry its
// name or its campaign id, and both are its own. Nothing is grouped or merged.
// Pure: no fetching, no state, so the page and the tests share one sum.
import type { PaidData, PaidPlatform } from "@/lib/paid";
import type { PipelineData } from "@/lib/digitalPipeline";

/** One campaign's figures for one month, or any sum of them. */
export interface Figures {
  spend: number;
  impr: number;
  clicks: number;
  /** Leads the ad platform reports: Meta form and website leads, Google conversions. */
  pleads: number;
  /** CRM leads tagged with the campaign, by the month they came in; what follows happened on those leads. */
  leads: number;
  viewed: number;
  viewedDone: number;
  listings: number;
  deals: number;
  comm: number;
  resComm: number;
  dealValue: number;
}

export const ZERO: Figures = {
  spend: 0, impr: 0, clicks: 0, pleads: 0, leads: 0, viewed: 0, viewedDone: 0, listings: 0, deals: 0, comm: 0, resComm: 0, dealValue: 0,
};
const FIELDS = Object.keys(ZERO) as (keyof Figures)[];

export function add(a: Figures, b: Figures): Figures {
  const out = { ...a };
  for (const k of FIELDS) out[k] += b[k];
  return out;
}

/** a ÷ b, or null when b is nothing. */
export const ratio = (a: number, b: number): number | null => (b ? a / b : null);

// ── Numbers, written the scorecard's way ────────────────────────────────────
/**
 * 1,234 → 1.2K, 15,400 → 15K, 2,345,678 → 2.35M. Each unit starts where the
 * figure would round up into it, so 999,999 reads 1.00M, never 1000K.
 */
export function n(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 9_995_000) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 999_500) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 9_950) return `${Math.round(v / 1e3)}K`;
  if (a >= 999.5) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}
export const money = (v: number | null | undefined, cur = "AED") => (v == null || !Number.isFinite(v) ? "—" : `${cur} ${n(v)}`);
export const money2 = (v: number | null | undefined, cur = "AED") => (v == null || !Number.isFinite(v) ? "—" : `${cur} ${v.toFixed(2)}`);
export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
/** 1 → "1st", 2 → "2nd", 18 → "18th". */
export const ordinal = (d: number) => `${d}${d % 100 >= 11 && d % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][d % 10] ?? "th"}`;

export interface ScCampaign {
  /** platform|name in lower case. */
  id: string;
  /** As the ad platform names it. */
  name: string;
  platform: PaidPlatform;
  /** What its CRM leads carry as utm_campaign, lower case: its name and, on Meta, its id. */
  keys: string[];
  /** Its Engage campaign codes, each as it is, the one with the most of its leads first. */
  codes: { code: string; leads: number }[];
}

export interface ScModel {
  /** Every month of the range, YYYY-MM. */
  months: string[];
  campaigns: ScCampaign[];
  /** Campaign id → its figures per month, in the order of `months`. */
  grid: Map<string, Figures[]>;
}

const norm = (s: string) => s.toLowerCase().trim();

/** Every month from `from` to `to`, as YYYY-MM. */
export function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let i = 0; i < 600 && Number.isFinite(y) && Number.isFinite(m); i++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    if (k > last) break;
    out.push(k);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** The ad data and the CRM answer, joined per campaign and month. The CRM half may still be on its way (null). */
export function buildModel(
  paid: Pick<PaidData, "rows" | "byDateFine">,
  pipe: Pick<PipelineData, "cells" | "codes"> | null,
  from: string,
  to: string,
): ScModel {
  const months = monthsIn(from, to);
  const at = new Map(months.map((m, i) => [m, i]));
  const campaigns = new Map<string, ScCampaign>();
  const owner = new Map<string, string>(); // CRM key → campaign id
  const grid = new Map<string, Figures[]>();
  const row = (id: string) => {
    let r = grid.get(id);
    if (!r) grid.set(id, (r = months.map(() => ({ ...ZERO }))));
    return r;
  };
  const campaign = (platform: PaidPlatform, name: string, campaignId: string | null) => {
    const id = `${platform}|${norm(name)}`;
    let c = campaigns.get(id);
    if (!c) campaigns.set(id, (c = { id, name, platform, keys: [], codes: [] }));
    for (const k of [name, campaignId ?? ""].map(norm).filter(Boolean)) {
      if (!c.keys.includes(k)) c.keys.push(k);
      if (!owner.has(k)) owner.set(k, id);
    }
    return c;
  };

  for (const r of paid.rows) campaign(r.platform, r.campaign, r.campaignId);
  for (const d of paid.byDateFine) {
    const c = campaign(d.platform, d.campaign, d.campaignId);
    const i = at.get(d.date.slice(0, 7));
    if (i == null) continue;
    const f = row(c.id)[i];
    f.spend += d.cost;
    f.impr += d.impressions ?? 0;
    f.clicks += d.clicks ?? 0;
    f.pleads += d.leads;
  }

  for (const c of pipe?.cells ?? []) {
    const id = owner.get(c.campaign);
    const i = at.get(c.month);
    if (!id || i == null) continue;
    const f = row(id)[i];
    f.leads += c.leads;
    f.viewed += c.viewed;
    f.viewedDone += c.viewedDone ?? 0;
    f.listings += c.listings;
    f.deals += c.deals;
    f.comm += c.commission;
    f.resComm += c.reservedCommission;
    f.dealValue += c.dealValue;
  }

  const codes = new Map<string, Map<string, number>>();
  for (const k of pipe?.codes ?? []) {
    const id = owner.get(k.campaign);
    if (!id) continue;
    const per = codes.get(id) ?? new Map<string, number>();
    per.set(k.code, (per.get(k.code) ?? 0) + k.leads);
    codes.set(id, per);
  }
  for (const [id, per] of codes) {
    campaigns.get(id)!.codes = [...per].map(([code, leads]) => ({ code, leads })).sort((a, b) => b.leads - a.leads || a.code.localeCompare(b.code));
  }

  return { months, campaigns: [...campaigns.values()], grid };
}

/** The sum over some campaigns and some months (indexes into `months`). */
export function total(model: ScModel, ids: Iterable<string>, monthIdx: number[]): Figures {
  let s = { ...ZERO };
  for (const id of ids) {
    const r = model.grid.get(id);
    if (!r) continue;
    for (const i of monthIdx) if (r[i]) s = add(s, r[i]);
  }
  return s;
}

/** Each month's sum over some campaigns. */
export function perMonth(model: ScModel, ids: Iterable<string>): Figures[] {
  const out = model.months.map(() => ({ ...ZERO }));
  for (const id of ids) {
    const r = model.grid.get(id);
    if (!r) continue;
    r.forEach((f, i) => (out[i] = add(out[i], f)));
  }
  return out;
}

export interface Quarter {
  /** "Q3 2026"; "Q4 2026 to date" while the range runs to today inside it; "Q1 2026 (part)" when the range covers only part of it. */
  label: string;
  /** Indexes into the months. */
  idx: number[];
}

const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

/** The range's months in calendar quarters. `today` (YYYY-MM-DD) tells a quarter still running from one the range cuts short. */
export function quarters(months: string[], from: string, to: string, today: string): Quarter[] {
  const out: Quarter[] = [];
  months.forEach((m, i) => {
    const key = `Q${Math.ceil(Number(m.slice(5, 7)) / 3)} ${m.slice(0, 4)}`;
    const q = out.find((x) => x.label === key);
    if (q) q.idx.push(i);
    else out.push({ label: key, idx: [i] });
  });
  for (const q of out) {
    const first = months[q.idx[0]];
    const last = months[q.idx[q.idx.length - 1]];
    const endsInside = Number(last.slice(5, 7)) % 3 !== 0 || (last === to.slice(0, 7) && Number(to.slice(8, 10)) < lastDay(last));
    const startsInside = (Number(first.slice(5, 7)) - 1) % 3 !== 0 || (first === from.slice(0, 7) && Number(from.slice(8, 10)) > 1);
    if (endsInside && to >= today && !startsInside) q.label += " to date";
    else if (endsInside || startsInside) q.label += " (part)";
  }
  return out;
}
