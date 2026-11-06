"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import PausedNotice from "@/components/PausedNotice";
import DateRangePicker, { rangeFor } from "@/components/DateRangePicker";
import { savePaidConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
import { PLATFORMS, GOAL_LABELS, type PaidData, type PaidPlatform, type CampaignGoal, type PaidLevel, type CampaignRow } from "@/lib/paid";
import { ACCOUNT_CATALOG, VERIFIED_BLOCKED, SUPERMETRICS_SUBSCRIPTION_URL, type CatalogAccount } from "@/lib/paidAccounts";
import type { CampaignLeadsData } from "@/lib/metabase";
import type { PaidConfig } from "@/lib/data";

const fmt = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n)));
const fmtK = (n: number | null | undefined) => {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
};
const money = (n: number | null | undefined, cur: string) =>
  n == null ? "—" : `${cur === "—" ? "" : cur + " "}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n))}`;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const pct1 = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(2)}%`);
const pct0 = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(n * 100 >= 10 ? 0 : 1)}%`);
/** A sync time in the business's zone, e.g. "20 Oct, 07:30" — Dubai, whatever the viewer's clock says. */
const fmtSynced = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

const PLATFORM_ORDER: PaidPlatform[] = ["google", "meta", "linkedin"];
// Google reads green and Meta blue everywhere on this tab, by request.
const PLATFORM_COLOR: Record<PaidPlatform, string> = { google: C.green, meta: C.blue, linkedin: "#7c5cbf" };
const GOAL_COLOR: Record<CampaignGoal, string> = {
  leads: C.green, conversions: C.blue, traffic: C.sand, awareness: "#7c5cbf", engagement: C.coral, other: C.mid,
};

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Platform-reported leads — Meta website + form leads, Google/LinkedIn
 * conversions — the same rule byDateFine uses in lib/paid.ts. Never `result`,
 * which is impressions for a reach campaign and link clicks for traffic.
 */
const platformLeads = (r: CampaignRow) =>
  r.platform === "meta" ? (r.websiteLeads ?? 0) + (r.facebookLeads ?? 0) : (r.conversions ?? 0);

/**
 * Which bucket a lead falls in, from its stage and state together.
 *
 * 'notq' is the disqualified bucket as defined by the business: a lead that sat
 * at New, Qualified or Viewing and was then CLOSED. Those are not qualified
 * leads — counting them as qualified would flatter every stage — but they are
 * not nothing either, so they get their own bucket rather than being discarded.
 *
 * 'lost' is a lead closed further down (Valuation, Listed, Offer, Reserved,
 * Deal). It is out of the forward funnel but deliberately NOT folded into
 * 'notq', which is defined only over the three early stages.
 *
 * Completed counts as in play — a completed Deal is a won deal, not a lost one.
 *
 * Valuation and Listed are the SELLER/LANDLORD path and are as much a
 * conversion as a Deal is on the buyer side. They were previously missing from
 * this function, so they fell through to 'other': counted in the lead total but
 * shown in no stage row, which made the Google listing and valuation campaigns
 * look like they produced leads and nothing else.
 */
export type StageBucket = "new" | "qualified" | "viewing" | "valuation" | "listed" | "offerRes" | "deal" | "notq" | "lost" | "other";
export function bucketOf(stage: string, state: string): StageBucket {
  const st = norm(stage);
  // The disqualified rule is defined over these three stages only.
  const early = st === "new" || st === "qualified" || st === "viewing";
  if (norm(state) === "closed") return early ? "notq" : "lost";
  if (st === "new") return "new";
  if (st === "qualified") return "qualified";
  if (st === "viewing") return "viewing";
  if (st === "valuation") return "valuation";
  if (st === "listed") return "listed";
  if (st === "offer" || st === "reserved") return "offerRes";
  if (st === "deal") return "deal";
  return "other";
}
/** In the forward funnel — i.e. still live, neither disqualified nor lost. */
const isOpen = (b: StageBucket) => b !== "notq" && b !== "lost";

/** The pickable lead-stage filter values. */
type StageFilter = "all" | StageBucket;
const STAGE_FILTERS: { key: StageFilter; label: string }[] = [
  { key: "all", label: "All stages" },
  { key: "new", label: "New" },
  { key: "qualified", label: "Qualified" },
  { key: "viewing", label: "Viewing" },
  { key: "valuation", label: "Valuation" },
  { key: "listed", label: "Listed" },
  { key: "offerRes", label: "Offer / Reserved" },
  { key: "deal", label: "Deal" },
  { key: "notq", label: "Not qualified" },
];

const LEVEL_LABEL: Record<PaidLevel, string> = { campaign: "Campaigns", adset: "Ad sets", ad: "Ads" };
const DEPTH: Record<PaidLevel, number> = { campaign: 0, adset: 1, ad: 2 };

type CrmJoin = { leads: number; qualified: number; deals: number };
type StageAgg = {
  /** Every row counted, whatever its bucket — the total after filtering. */
  matched: number;
  /** Still in the forward funnel (not disqualified, not lost). */
  leads: number;
  newLeads: number;
  qualified: number;
  viewing: number;
  valuation: number;
  listed: number;
  offerRes: number;
  deals: number;
  notq: number;
  lost: number;
  /** In play but at a stage this dashboard doesn't name — surfaced, never hidden. */
  other: number;
};

const emptyStages = (): StageAgg => ({ matched: 0, leads: 0, newLeads: 0, qualified: 0, viewing: 0, valuation: 0, listed: 0, offerRes: 0, deals: 0, notq: 0, lost: 0, other: 0 });
function addStage(a: StageAgg, stage: string, state: string, n: number) {
  const b = bucketOf(stage, state);
  a.matched += n;
  if (isOpen(b)) a.leads += n;
  if (b === "new") a.newLeads += n;
  else if (b === "qualified") a.qualified += n;
  else if (b === "viewing") a.viewing += n;
  else if (b === "valuation") a.valuation += n;
  else if (b === "listed") a.listed += n;
  else if (b === "offerRes") a.offerRes += n;
  else if (b === "deal") a.deals += n;
  else if (b === "notq") a.notq += n;
  else if (b === "lost") a.lost += n;
  else a.other += n;
}

// ─── Trend bucketing ─────────────────────────────────────────────────────────
// A 7-month range plotted daily is 200 unreadable ticks; a 7-day range plotted
// monthly is one. Granularity follows the range length, and the axis is labelled
// in the unit it actually shows.
type Bucket = "day" | "week" | "month";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 864e5;
const parseYmd = (s: string) => new Date(`${s}T00:00:00Z`);
const toYmd = (d: Date) => d.toISOString().slice(0, 10);
/** Monday of the week containing d (UTC, so bucketing can't drift on DST). */
function mondayOf(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dow * DAY_MS);
}
export function pickBucket(from: string, to: string): Bucket {
  const days = Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / DAY_MS) + 1;
  if (days <= 31) return "day";   // a month or less: every day fits
  if (days <= 120) return "week"; // a quarter: ~17 ticks
  return "month";                 // longer: month names, as asked
}
function bucketKey(ymd: string, b: Bucket): string {
  if (b === "day") return ymd;
  if (b === "week") return toYmd(mondayOf(parseYmd(ymd)));
  return ymd.slice(0, 7);
}
function bucketLabel(key: string, b: Bucket, multiYear: boolean): string {
  if (b === "month") {
    const [y, m] = key.split("-");
    return multiYear ? `${MONTHS[+m - 1]} ${y.slice(2)}` : MONTHS[+m - 1];
  }
  const d = parseYmd(key);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return b === "week" ? `w/c ${day}` : day;
}
/**
 * Every bucket in the range, including empty ones. Zero-filling matters: the
 * series only contains days that had spend, so a fortnight of nothing used to be
 * drawn as a straight line between the two dates either side of it — implying
 * spend that never happened.
 */
function enumerateBuckets(from: string, to: string, b: Bucket): string[] {
  const out: string[] = [];
  if (b === "month") {
    let y = +from.slice(0, 4), m = +from.slice(5, 7);
    const endY = +to.slice(0, 4), endM = +to.slice(5, 7);
    while (y < endY || (y === endY && m <= endM)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }
  const step = b === "week" ? 7 : 1;
  let cur = b === "week" ? mondayOf(parseYmd(from)) : parseYmd(from);
  const end = parseYmd(to);
  while (cur.getTime() <= end.getTime()) {
    out.push(toYmd(cur));
    cur = new Date(cur.getTime() + step * DAY_MS);
  }
  return out;
}

const BUCKET_LABEL: Record<Bucket, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

// Default range = this month, resolved once at module load (never during render).
const INIT_RANGE = rangeFor("this_month");

/**
 * A renderable payload for a failed media fetch. Without this a failure left
 * `data` null forever, which the skeleton reads as "still loading" — the page
 * would spin indefinitely instead of saying what went wrong.
 */
const failedPaid = (from: string, to: string, error: string): PaidData => ({
  connected: true, label: `${from} → ${to}`, from, to, level: "ad",
  rows: [], truncated: false, byDateFine: [], currencies: [],
  accountsUsed: [], emptyAccounts: [], failures: [], unconfigured: false, error,
});

// ─── Searchable filter dropdown ───────────────────────────────────────────────
function FilterSelect({
  label,
  selected,
  options,
  onToggle,
  onClear,
}: {
  label: string;
  /** Empty means "all" — no narrowing on this dimension. */
  selected: string[];
  options: [string, number][];
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [search, setSearch] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const PANEL_H = 330;

  /**
   * Open upward when there isn't room below. #main is the scrolling container,
   * so a panel opening downward near the bottom of the viewport is cut off at
   * its edge — measured on open rather than guessed, because the control's
   * position depends on how far the page is scrolled.
   */
  const place = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    setDropUp(below < PANEL_H && r.top > below);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const needle = norm(search);
  // A chosen value the other filters have since ruled out is still applied, so
  // it stays listed (at 0) where it can be seen and unticked. Leaving it off the
  // list is how a filter came to narrow the page under a summary reading "all".
  const listed: [string, number][] = [
    ...selected.filter((v) => !options.some(([o]) => o === v)).map((v): [string, number] => [v, 0]),
    ...options,
  ];
  const shown = needle ? listed.filter(([v]) => v.includes(needle)) : listed;
  const chosen = new Set(selected);
  const summary =
    selected.length === 0 ? `${label}: all`
      : selected.length === 1 ? `${label}: ${selected[0].length > 22 ? selected[0].slice(0, 22) + "…" : selected[0]}`
        : `${label}: ${selected.length} selected`;

  return (
    <div ref={boxRef} style={{ position: "relative", minWidth: 0 }}>
      <button
        className={`search-box${selected.length ? " active" : ""}`}
        style={{ width: "100%", minWidth: 0, textAlign: "left", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: selected.length ? 600 : 400 }}
        onClick={() => { if (!open) place(); setOpen((v) => !v); setSearch(""); }}
        title={selected.length ? `${label}: ${selected.join(", ")}` : `${label}: all`}
      >
        {summary} <span className="muted">▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            ...(dropUp ? { bottom: "100%", marginBottom: 4 } : { top: "100%", marginTop: 4 }),
            left: 0,
            zIndex: 60,
            width: 320,
            maxWidth: "90vw",
            maxHeight: PANEL_H - 20,
            overflowY: "auto",
            background: "#fff",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 18px rgba(0,0,0,.12)",
            padding: 6,
          }}
        >
          <input
            autoFocus
            className="search-box"
            style={{ width: "100%", marginBottom: 6 }}
            placeholder={`Search ${label}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 8px 6px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
            <span className="muted" style={{ fontSize: 11, flex: 1 }}>
              {selected.length ? `${selected.length} selected` : "none selected — showing all"}
            </span>
            {/* Stays open on clear so several can be picked in one visit. */}
            <button className="filter-btn" style={{ fontSize: 10, padding: "1px 7px" }} onMouseDown={onClear} disabled={!selected.length}>
              Clear
            </button>
          </div>
          {shown.slice(0, 300).map(([v, n]) => (
            <label
              key={v}
              title={v}
              style={{ padding: "4px 8px", fontSize: 12, cursor: "pointer", borderRadius: 5, display: "flex", gap: 8, alignItems: "center", fontWeight: chosen.has(v) ? 700 : 400 }}
            >
              <input type="checkbox" checked={chosen.has(v)} onChange={() => onToggle(v)} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</span>
              <span className="muted">{n}</span>
            </label>
          ))}
          {!shown.length && <div className="muted" style={{ padding: "4px 8px", fontSize: 12 }}>No matches.</div>}
        </div>
      )}
    </div>
  );
}

export default function DigitalDashboard({ initial, config }: { initial: PaidData | null; config: PaidConfig }) {
  // Media is fetched ONCE per range at ad level — the deepest each platform can
  // serve — and every coarser view (campaigns, ad sets, the tree) is a client-
  // side regroup of the same rows. Switching levels is instant and free.
  const [data, setData] = useState<PaidData | null>(initial);
  const [crm, setCrm] = useState<CampaignLeadsData | null>(null);
  const [viewLevel, setViewLevel] = useState<PaidLevel>("campaign");
  const [from, setFrom] = useState(initial?.from ?? INIT_RANGE.from);
  const [to, setTo] = useState(initial?.to ?? INIT_RANGE.to);
  /**
   * One flag for the whole page. Media (Supermetrics) and leads (Engage) are
   * fetched concurrently but committed together, so the page never fills in
   * piecemeal — it shows the skeleton until every source has answered, then
   * swaps to a complete view. The cost of that is the page is as slow as its
   * slowest source; the benefit is no half-populated numbers to misread.
   */
  const [busy, setBusy] = useState(true);

  // ── Account picker (⚙) ─────────────────────────────────────────────────────
  const initialSel = useMemo<Record<PaidPlatform, string[]>>(
    () => ({
      google: config.accounts.google.map((a) => a.id),
      meta: config.accounts.meta.map((a) => a.id),
      linkedin: config.accounts.linkedin.map((a) => a.id),
    }),
    [config],
  );
  const nothingSelected = PLATFORM_ORDER.every((p) => (config.accounts[p] ?? []).length === 0);
  const [cfgOpen, setCfgOpen] = useState(initial ? initial.unconfigured : nothingSelected);
  const [sel, setSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [savedSel, setSavedSel] = useState<Record<PaidPlatform, string[]>>(initialSel);
  const [showHidden, setShowHidden] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const selKey = (s: Record<PaidPlatform, string[]>) => PLATFORM_ORDER.map((p) => [...s[p]].sort().join(",")).join("|");
  const dirty = selKey(sel) !== selKey(savedSel);

  // ── Dashboard-level filters ─────────────────────────────────────────────────
  const [platformFilter, setPlatformFilter] = useState<"all" | PaidPlatform>("all");
  // Each facet holds a SET of chosen values; empty means "all". Multi-select
  // throughout, so several codes (or sources, mediums…) can be compared at once.
  const [codes, setCodes] = useState<string[]>([]);
  const [utmCamps, setUtmCamps] = useState<string[]>([]);
  const [utmSrcs, setUtmSrcs] = useState<string[]>([]);
  const [utmMeds, setUtmMeds] = useState<string[]>([]);
  const [utmContents, setUtmContents] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const toggleIn = (setter: (f: (prev: string[]) => string[]) => void) => (v: string) =>
    setter((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  const [q, setQ] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerQ, setExplorerQ] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Pure fetchers: they return payloads and write no state, so the caller decides
  // when anything appears on screen. Neither ever rejects — a failure comes back
  // as a payload carrying its reason.
  const fetchMedia = useCallback(async (f: string, t: string): Promise<PaidData> => {
    try {
      const res = await fetch(`/api/digital?from=${f}&to=${t}&level=ad`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.rows)) return json as PaidData;
      return failedPaid(f, t, json?.error || `Media request failed (HTTP ${res.status}).`);
    } catch (e) {
      return failedPaid(f, t, String(e));
    }
  }, []);

  const fetchCrm = useCallback(async (f: string, t: string): Promise<CampaignLeadsData> => {
    const empty = (error: string): CampaignLeadsData => ({ connected: true, label: `${f} → ${t}`, rows: [], codeRows: [], truncated: false, error });
    try {
      const res = await fetch(`/api/digital/crm?from=${f}&to=${t}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.rows)) return json as CampaignLeadsData;
      return empty(json?.error || `HTTP ${res.status}`);
    } catch (e) {
      return empty(String(e));
    }
  }, []);

  /**
   * Load everything for a range and commit it in one go.
   *
   * The sequence guard matters: changing the range twice quickly leaves two
   * loads in flight, and without it the slower (older) one can land last and
   * overwrite the newer data with stale numbers.
   */
  const seq = useRef(0);
  const loadAll = useCallback(
    async (f: string, t: string) => {
      const mine = ++seq.current;
      setBusy(true);
      const [media, crmData] = await Promise.all([fetchMedia(f, t), fetchCrm(f, t)]);
      if (mine !== seq.current) return; // superseded by a newer load
      setData(media);
      setCrm(crmData);
      setBusy(false);
    },
    [fetchMedia, fetchCrm],
  );

  // Loads on mount ON PURPOSE — the server renders the shell without waiting on
  // Supermetrics. Flipping the busy flag during the mount effect is intended
  // behaviour here, not a cascading render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyRange(f: string, t: string) {
    setFrom(f);
    setTo(t);
    loadAll(f, t);
  }

  // ── Account picker actions ──────────────────────────────────────────────────
  function toggleAccount(p: PaidPlatform, id: string) {
    setCfgMsg(null);
    setSel((s) => ({ ...s, [p]: s[p].includes(id) ? s[p].filter((x) => x !== id) : [...s[p], id] }));
  }
  function setPlatformAll(p: PaidPlatform, on: boolean, visible: CatalogAccount[]) {
    setCfgMsg(null);
    setSel((s) => ({ ...s, [p]: on ? [...new Set([...s[p], ...visible.map((a) => a.id)])] : s[p].filter((id) => !visible.some((a) => a.id === id)) }));
  }
  function closeConfig(revert: boolean) {
    if (revert) setSel(savedSel);
    setCfgMsg(null);
    setCfgOpen(false);
  }
  function saveAndClose() {
    setCfgMsg(null);
    startSave(async () => {
      const payload: Record<string, { id: string; name: string }[]> = {};
      for (const p of PLATFORM_ORDER) {
        payload[p] = sel[p].map((id) => ({ id, name: ACCOUNT_CATALOG[p].find((a) => a.id === id)?.name || id }));
      }
      const r = await savePaidConfigAction(payload);
      if (!r.ok) {
        setCfgMsg(r.error || "Could not save.");
        return;
      }
      setSavedSel(sel);
      setCfgMsg(null);
      setCfgOpen(false);
      await loadAll(from, to);
    });
  }

  /** utm_campaigns living under ANY selected campaign_code (from Engage). */
  /**
   * campaign name (and Meta campaign id) → the platform it actually ran on,
   * taken from the ad-platform data itself.
   *
   * This replaces matching leads by utm_source spelling, which was wrong in a
   * way that mattered: a lead that arrived from a Google ad and then converted
   * on a website pop-up carries utm_source=google, so a pop-up campaign appeared
   * under the Google Ads filter. A campaign's platform is a property of the
   * campaign, not of a lead's last touch — so it comes from the platform that
   * actually reports the campaign.
   */
  const campaignPlatform = useMemo(() => {
    const m = new Map<string, PaidPlatform>();
    for (const r of data?.rows ?? []) {
      m.set(norm(r.campaign), r.platform);
      if (r.campaignId) m.set(norm(r.campaignId), r.platform);
    }
    return m;
  }, [data?.rows]);

  const campaignsUnderCode = useMemo(() => {
    if (!codes.length) return null;
    const chosen = new Set(codes);
    const set = new Set<string>();
    for (const r of crm?.codeRows ?? []) if (chosen.has(norm(r.code))) set.add(norm(r.campaign));
    return set;
  }, [crm?.codeRows, codes]);

  /**
   * Which campaigns the media side is narrowed to — null means no narrowing.
   *
   * Only the campaign-IDENTIFYING facets move spend: a campaign_code names a set
   * of campaigns, and utm_campaign names them directly. utm_source, utm_medium,
   * utm_content and the lead stage describe LEADS, not which campaign ran, so
   * they deliberately leave spend alone. That is what makes cost-per-stage
   * meaningful — campaign spend ÷ leads at that stage — instead of a numerator
   * that shrinks alongside its own denominator.
   *
   * Before this, spend ignored the filters entirely: selecting one campaign_code
   * left Spend at the full account total while Leads narrowed, so Cost / lead was
   * total spend divided by one code's leads.
   */
  const mediaCampaignFilter = useMemo(() => {
    let set: Set<string> | null = campaignsUnderCode ? new Set(campaignsUnderCode) : null;
    if (utmCamps.length) {
      set = set ? new Set(utmCamps.filter((c) => set!.has(c))) : new Set(utmCamps);
    }
    return set;
  }, [campaignsUnderCode, utmCamps]);

  /**
   * Campaigns the search box selects, by name and Meta id — null when empty.
   *
   * Matched at campaign level on both sides: a hit on an ad set, ad or account
   * name selects its whole campaign, because the CRM records only the campaign
   * tag. Spend used to narrow to the matching ad or account while leads
   * narrowed by utm_campaign text, so searching an account name divided that
   * account's spend by whichever leads' tags happened to contain the word.
   */
  const searchCampaigns = useMemo(() => {
    const needle = norm(q);
    if (!needle) return null;
    const set = new Set<string>();
    for (const r of data?.rows ?? []) {
      if (![r.campaign, r.adset ?? "", r.ad ?? "", r.accountName].some((v) => norm(v).includes(needle))) continue;
      set.add(norm(r.campaign));
      if (r.campaignId) set.add(norm(r.campaignId));
    }
    return set;
  }, [data?.rows, q]);

  /** Does a media row belong to the selected and searched campaigns? Name or Meta id. */
  const inCampaignFilter = useCallback(
    (r: { campaign: string; campaignId: string | null }) => {
      const hit = (s: Set<string>) => s.has(norm(r.campaign)) || (!!r.campaignId && s.has(norm(r.campaignId)));
      return (!mediaCampaignFilter || hit(mediaCampaignFilter)) && (!searchCampaigns || hit(searchCampaigns));
    },
    [mediaCampaignFilter, searchCampaigns],
  );


  // ── Media regrouping (ad-level rows → any view level) ──────────────────────
  const regroup = useCallback((rows: CampaignRow[], level: PaidLevel): CampaignRow[] => {
    const acc = new Map<string, CampaignRow>();
    const add = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    for (const r of rows) {
      const wantAdset = DEPTH[level] >= 1 && r.adset != null;
      const wantAd = DEPTH[level] >= 2 && r.ad != null;
      const key = `${r.platform}|${r.accountId}|${r.campaign}|${wantAdset ? r.adset : ""}|${wantAd ? r.ad : ""}`;
      const prev = acc.get(key);
      if (!prev) {
        acc.set(key, {
          ...r,
          adset: wantAdset ? r.adset : null,
          ad: wantAd ? r.ad : null,
          granularity: wantAd ? "ad" : wantAdset ? "adset" : "campaign",
        });
        continue;
      }
      prev.impressions += r.impressions;
      prev.clicks += r.clicks;
      prev.cost += r.cost;
      prev.result += r.result;
      prev.linkClicks = add(prev.linkClicks, r.linkClicks);
      prev.websiteConversions = add(prev.websiteConversions, r.websiteConversions);
      prev.websiteLeads = add(prev.websiteLeads, r.websiteLeads);
      prev.facebookLeads = add(prev.facebookLeads, r.facebookLeads);
      prev.conversions = add(prev.conversions, r.conversions);
    }
    return [...acc.values()].sort((a, b) => b.cost - a.cost);
  }, []);

  // The search reaches spend through inCampaignFilter, as whole campaigns.
  const mediaFiltered = useMemo(
    () => (data?.rows ?? []).filter((r) => (platformFilter === "all" || r.platform === platformFilter) && inCampaignFilter(r)),
    [data?.rows, platformFilter, inCampaignFilter],
  );

  const mediaRows = useMemo(() => regroup(mediaFiltered, viewLevel), [mediaFiltered, viewLevel, regroup]);

  const totals = useMemo(() => {
    const byCur = new Map<string, number>();
    let impressions = 0, clicks = 0;
    // Totals from campaign-level regroup so nothing depends on the view level.
    for (const r of regroup(mediaFiltered, "campaign")) {
      byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + r.cost);
      impressions += r.impressions;
      clicks += r.clicks;
    }
    const curs = [...byCur.entries()].sort((a, b) => b[1] - a[1]);
    return {
      spendByCurrency: curs,
      singleCurrency: curs.length === 1 ? curs[0][0] : null,
      spend: curs.reduce((s, [, v]) => s + v, 0),
      impressions, clicks,
    };
  }, [mediaFiltered, regroup]);

  // ── CRM facets: five interlinked, searchable filters ───────────────────────
  const crmBase = useCallback(
    (skip: "campaign" | "source" | "medium" | "content" | "code" | null, unmatched = false) => {
      const rows = crm?.rows ?? [];
      const needle = norm(q);
      return rows.filter((r) => {
        const camp = norm(r.campaign);
        return (
          // Only campaigns the ad data reports — the platform's own when one is
          // picked, any platform's on All. All used to count every tagged lead,
          // so Cost / lead there divided spend by WhatsApp-button and pop-up
          // leads (186 of 495, 1–20 Oct 2026) that every platform view dropped.
          // `unmatched` selects exactly those, so they are counted beside Leads
          // rather than vanishing.
          (unmatched
            ? !campaignPlatform.has(camp)
            : platformFilter === "all" ? campaignPlatform.has(camp) : campaignPlatform.get(camp) === platformFilter) &&
          (skip === "code" || !campaignsUnderCode || campaignsUnderCode.has(camp)) &&
          // The stage filter narrows every facet: picking Deal must leave only
          // the utm values that actually appear on Deal-stage leads.
          (stageFilter === "all" || bucketOf(r.stage, r.state) === stageFilter) &&
          (skip === "campaign" || !utmCamps.length || utmCamps.includes(camp)) &&
          (skip === "source" || !utmSrcs.length || utmSrcs.includes(norm(r.source))) &&
          (skip === "medium" || !utmMeds.length || utmMeds.includes(norm(r.medium))) &&
          (skip === "content" || !utmContents.length || utmContents.includes(norm(r.content))) &&
          // The campaigns the search selected for spend. A lead with no ad data
          // has no such campaign, so it can only be found by its own tag.
          (unmatched ? !needle || camp.includes(needle) : !searchCampaigns || searchCampaigns.has(camp))
        );
      });
    },
    [crm?.rows, platformFilter, campaignPlatform, campaignsUnderCode, utmCamps, utmSrcs, utmMeds, utmContents, q, searchCampaigns, stageFilter],
  );

  const facetOf = (rows: { campaign: string; source: string; medium: string; content: string; n: number }[], key: "campaign" | "source" | "medium" | "content") => {
    const acc = new Map<string, number>();
    for (const r of rows) {
      const v = norm(r[key]);
      if (v === "(none)") continue;
      acc.set(v, (acc.get(v) ?? 0) + r.n);
    }
    return [...acc].sort((a, b) => b[1] - a[1]);
  };
  const campOptions = useMemo(() => facetOf(crmBase("campaign"), "campaign"), [crmBase]);
  const srcOptions = useMemo(() => facetOf(crmBase("source"), "source"), [crmBase]);
  const medOptions = useMemo(() => facetOf(crmBase("medium"), "medium"), [crmBase]);
  const contentOptions = useMemo(() => facetOf(crmBase("content"), "content"), [crmBase]);

  /**
   * Nothing but the code selection is narrowing anything — "did the user pick
   * something" is the question, same as campaignsUnderCode and the media
   * allowlist.
   */
  const utmFiltersIdle =
    !utmCamps.length && !utmSrcs.length && !utmMeds.length && !utmContents.length && platformFilter === "all" && !q.trim();

  /** utm_campaign → the campaign_codes it belongs to, from Engage membership. */
  const campaignToCodes = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of crm?.codeRows ?? []) {
      const code = norm(r.code);
      if (code === "(unlinked)") continue;
      const k = norm(r.campaign);
      const set = m.get(k) ?? new Set<string>();
      set.add(code);
      m.set(k, set);
    }
    return m;
  }, [crm?.codeRows]);

  /**
   * Code facet counts, sourced the SAME way the funnel is so the two agree.
   *
   * The funnel reads membership rows when nothing but codes is selected and
   * per-lead utm rows otherwise — both limited to campaigns with ad data. The
   * facet used to always read membership rows while the funnel had switched to
   * utm rows, so a code could offer "7" and then show 27 once picked. Mirroring
   * the switch makes the number on the chip a promise.
   */
  const codeOptions = useMemo(() => {
    const acc = new Map<string, number>();
    if (utmFiltersIdle) {
      for (const r of crm?.codeRows ?? []) {
        if (stageFilter !== "all" && bucketOf(r.stage, r.state) !== stageFilter) continue;
        if (!campaignPlatform.has(norm(r.campaign))) continue;
        const v = norm(r.code);
        if (v === "(unlinked)") continue;
        acc.set(v, (acc.get(v) ?? 0) + r.n);
      }
    } else {
      // Every other filter already applied; "code" is skipped so the facet does
      // not narrow itself.
      for (const r of crmBase("code")) {
        for (const c of campaignToCodes.get(norm(r.campaign)) ?? []) acc.set(c, (acc.get(c) ?? 0) + r.n);
      }
    }
    return [...acc].sort((a, b) => b[1] - a[1]);
  }, [crm?.codeRows, crmBase, campaignToCodes, campaignPlatform, stageFilter, utmFiltersIdle]);

  // What is applied is what is shown. A value the other filters had ruled out
  // used to be pruned from the dropdowns only, while the counts, the spend
  // allowlist and Clear kept applying it: pick a campaign, switch to a month it
  // didn't run in, and the page read Leads 0 under "utm_campaign: all" with
  // nothing to clear. It now stays selected and listed at 0, so the zero
  // explains itself and can be unticked.
  const codesKey = codes.join("|");
  const campsKey = utmCamps.join("|");

  const crmFiltered = useMemo(() => crmBase(null), [crmBase]);

  /**
   * The rows the funnel and its hover breakdown are both built from — so the
   * tooltip can never disagree with the bar it belongs to.
   *
   * With only codes selected these are the membership rows (a lead counted once
   * per code); otherwise they are the per-lead utm rows. Both are limited to
   * campaigns with ad data — a code's untagged WhatsApp/email leads are counted
   * with the other unmatched leads instead.
   */
  const funnelRows = useMemo(() => {
    if (codes.length && utmFiltersIdle) {
      const chosen = new Set(codes);
      return (crm?.codeRows ?? [])
        .filter((r) => chosen.has(norm(r.code)) && campaignPlatform.has(norm(r.campaign)) && (stageFilter === "all" || bucketOf(r.stage, r.state) === stageFilter))
        .map((r) => ({ campaign: r.campaign, stage: r.stage, state: r.state, n: r.n }));
    }
    return crmFiltered.map((r) => ({ campaign: r.campaign, stage: r.stage, state: r.state, n: r.n }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crm?.codeRows, codesKey, utmFiltersIdle, crmFiltered, campaignPlatform, stageFilter]);

  /**
   * Leads in view whose campaign matches nothing in the ad data, with their
   * utm_source — WhatsApp buttons, website pop-ups, e-mail: 186 of the 495
   * tagged leads in 1–20 Oct 2026. Leads and Cost / lead leave them out, as the
   * platform views always did, so they are counted here instead of vanishing.
   * Membership rows carry no utm_source, so the codes-only path gives a count.
   */
  const unmatched = useMemo(() => {
    let n = 0;
    const bySource = new Map<string, number>();
    if (codes.length && utmFiltersIdle) {
      const chosen = new Set(codes);
      for (const r of crm?.codeRows ?? []) {
        if (!chosen.has(norm(r.code)) || campaignPlatform.has(norm(r.campaign))) continue;
        if (stageFilter === "all" || bucketOf(r.stage, r.state) === stageFilter) n += r.n;
      }
    } else {
      for (const r of crmBase(null, true)) {
        n += r.n;
        bySource.set(norm(r.source), (bySource.get(norm(r.source)) ?? 0) + r.n);
      }
    }
    return { n, bySource: [...bySource].sort((a, b) => b[1] - a[1]) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crm?.codeRows, codesKey, utmFiltersIdle, crmBase, campaignPlatform, stageFilter]);

  const crmAgg = useMemo(() => {
    const agg = emptyStages();
    for (const r of funnelRows) addStage(agg, r.stage, r.state, r.n);
    return agg;
  }, [funnelRows]);

  /**
   * Top campaigns per funnel bucket, for the hover breakdown. Built from the
   * same rows as the bar heights, so a bar of 14 always breaks down to 14.
   */
  const funnelTop = useMemo(() => {
    const acc = new Map<StageBucket | "leads" | "live", Map<string, number>>();
    const bump = (k: StageBucket | "leads" | "live", camp: string, n: number) => {
      const m = acc.get(k) ?? new Map<string, number>();
      m.set(camp, (m.get(camp) ?? 0) + n);
      acc.set(k, m);
    };
    for (const r of funnelRows) {
      const b = bucketOf(r.stage, r.state);
      const camp = r.campaign || "(none)";
      bump(b, camp, r.n);
      bump("leads", camp, r.n);            // the whole pool
      if (isOpen(b)) bump("live", camp, r.n); // still in play
    }
    const out = {} as Record<string, { campaign: string; n: number }[]>;
    for (const [k, m] of acc) {
      out[k] = [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([campaign, n]) => ({ campaign, n }));
    }
    return out;
  }, [funnelRows]);

  /**
   * Do the selected codes share leads?
   *
   * Engage links a lead to several campaign entities at once — typically its own
   * utm_campaign entity AND an umbrella project code — so summing membership
   * rows across codes double-counts any lead they have in common. There is no
   * lead id in the grouped rows to dedupe by, so rather than quietly overstate
   * the funnel this detects the collision (the same campaign+stage+state
   * appearing under more than one selected code) and the card says so.
   */
  const codesOverlap = useMemo(() => {
    if (codes.length < 2 || !utmFiltersIdle) return false;
    const chosen = new Set(codes);
    const seen = new Set<string>();
    for (const r of crm?.codeRows ?? []) {
      // Only the rows the funnel counts can be counted twice.
      if (!chosen.has(norm(r.code)) || !campaignPlatform.has(norm(r.campaign))) continue;
      const k = `${norm(r.campaign)}|${r.stage}|${r.state}`;
      if (seen.has(k)) return true;
      seen.add(k);
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crm?.codeRows, codesKey, utmFiltersIdle, campaignPlatform]);

  const crmByCampaign = useMemo(() => {
    const m = new Map<string, CrmJoin>();
    for (const r of crmFiltered) {
      const b = bucketOf(r.stage, r.state);
      const k = norm(r.campaign);
      const cur = m.get(k) ?? { leads: 0, qualified: 0, deals: 0 };
      // Closed leads count, as in the headline's Cost / lead — they were paid
      // for too. Counting open leads only put a campaign's Cost / lead at up to
      // 1.9× the headline's (1–20 Oct 2026: 117 of 495 tagged leads closed,
      // 31 of 64 on one campaign).
      cur.leads += r.n;
      if (b === "qualified") cur.qualified += r.n;
      if (b === "deal") cur.deals += r.n;
      m.set(k, cur);
    }
    return m;
  }, [crmFiltered]);

  const joinFor = useCallback(
    (r: CampaignRow): CrmJoin | null => {
      const byName = crmByCampaign.get(norm(r.campaign));
      const byId = r.campaignId ? crmByCampaign.get(norm(r.campaignId)) : undefined;
      if (!byName || !byId) return byName ?? byId ?? null;
      // Tagged by name on some ads and by Meta id on others: the headline counts
      // both, so the row does too — taking the name alone left its leads short.
      return { leads: byName.leads + byId.leads, qualified: byName.qualified + byId.qualified, deals: byName.deals + byId.deals };
    },
    [crmByCampaign],
  );

  // ── Funnel ──────────────────────────────────────────────────────────────────
  /**
   * Two paths out of one lead pool, because Engage runs two.
   *
   * A Buyer or Tenant progresses Viewing → Offer/Reserved → Deal. A Seller or
   * Landlord progresses Valuation → Listed, and a listing IS that lead's
   * conversion — it will never reach a Deal stage. Showing only the buyer path
   * made the listing and valuation campaigns read as producing leads and
   * nothing else.
   */
  const funnel = useMemo(
    () => [
      // The top of the funnel is the whole pool. It used to be the LIVE count,
      // which made "Leads 384" sit above "Not qualified 422" and read as a
      // contradiction — you cannot disqualify more leads than you received. The
      // pool is the honest denominator, and every stage below is a share of it.
      { key: "leads" as const, label: "Leads", n: crmAgg.matched, note: "every campaign-tagged lead", group: "top" as const },
      { key: "live" as const, label: "Still live", n: crmAgg.leads, note: "not disqualified or lost", group: "top" as const },
      { key: "qualified" as const, label: "Qualified", n: crmAgg.qualified, note: "at Qualified now", group: "top" as const },
      { key: "viewing" as const, label: "Viewing", n: crmAgg.viewing, note: "buyer / tenant path", group: "buy" as const },
      { key: "offerRes" as const, label: "Offer / Reserved", n: crmAgg.offerRes, note: "in negotiation", group: "buy" as const },
      { key: "deal" as const, label: "Deal", n: crmAgg.deals, note: "reached Deal stage", group: "buy" as const },
      { key: "valuation" as const, label: "Valuation", n: crmAgg.valuation, note: "seller / landlord path", group: "sell" as const },
      { key: "listed" as const, label: "Listed", n: crmAgg.listed, note: "property listed — the seller-side conversion", group: "sell" as const },
      { key: "notq" as const, label: "Not qualified", n: crmAgg.notq, note: "closed at New / Qualified / Viewing", group: "lost" as const },
    ],
    [crmAgg],
  );
  // Scale on the live funnel only: a big disqualified count would otherwise
  // flatten every bar above it.
  const funnelMax = Math.max(...funnel.filter((s) => s.group !== "lost").map((s) => s.n), 1);
  const [hoverStage, setHoverStage] = useState<string | null>(null);

  // With a stage filter on, "Leads" would read 0 for a disqualified-only view,
  // so the card names what it is actually counting.
  const stageLabel = STAGE_FILTERS.find((f) => f.key === stageFilter)?.label ?? "All stages";
  const leadLabel = stageFilter === "all" ? "Leads" : `${stageLabel} leads`;
  const leadCount = crmAgg.matched;
  /**
   * The CRM half failed or is not connected, so every CRM figure reads "—".
   * Only Leads used to check: a failed query left Qualified, Viewing, Deal and
   * the rest of the strip reading a real-looking 0.
   */
  const crmDown = !crm || !crm.connected || (!!crm.error && !crm.rows.length);
  const crmFig = (n: number) => (crmDown ? "—" : fmt(n));

  const cur = totals.singleCurrency ?? "—";
  // Cost per lead divides by every lead the spend could have bought — leads
  // whose campaign is in the ad data — including the ones later disqualified,
  // since they were paid for too. The Explorer and the tree count the same way.
  const cpl = crmAgg.matched > 0 && totals.singleCurrency ? totals.spend / crmAgg.matched : null;
  const cpql = crmAgg.qualified > 0 && totals.singleCurrency ? totals.spend / crmAgg.qualified : null;
  const selectedCount = PLATFORM_ORDER.reduce((n, p) => n + sel[p].length, 0);

  // ── Trends (platform + goal aware) ──────────────────────────────────────────
  // Granularity and labels follow the selected range: days for a month or less,
  // weeks up to a quarter, month names beyond that.
  const bucket = useMemo(() => pickBucket(from, to), [from, to]);
  const bucketKeys = useMemo(() => enumerateBuckets(from, to, bucket), [from, to, bucket]);
  const bucketLabels = useMemo(() => {
    const multiYear = from.slice(0, 4) !== to.slice(0, 4);
    return bucketKeys.map((k) => bucketLabel(k, bucket, multiYear));
  }, [bucketKeys, bucket, from, to]);

  const trend = useMemo(() => {
    const acc = new Map(bucketKeys.map((k) => [k, { cost: 0, leads: 0 }]));
    for (const d of data?.byDateFine ?? []) {
      if (platformFilter !== "all" && d.platform !== platformFilter) continue;
      if (!inCampaignFilter(d)) continue;
      const cur = acc.get(bucketKey(d.date, bucket));
      if (!cur) continue; // outside the requested range
      cur.cost += d.cost;
      cur.leads += d.leads;
    }
    return bucketKeys.map((k) => acc.get(k)!);
  }, [data?.byDateFine, platformFilter, bucketKeys, bucket, inCampaignFilter]);

  // byDateFine carries no currency, so the spend line is drawn only when what it
  // sums bills in one — the same test the Spend card applies. Leads still plot.
  const trendSpendShown = totals.spendByCurrency.length <= 1;

  const platformTrend = useMemo(() => {
    const series = PLATFORM_ORDER.map((p) => {
      const acc = new Map(bucketKeys.map((k) => [k, 0]));
      let any = false;
      // A platform whose accounts bill in more than one currency is left off
      // rather than summed; the chart says so.
      const curs = new Set((data?.rows ?? []).filter((r) => r.platform === p && inCampaignFilter(r)).map((r) => r.currency));
      if (curs.size > 1) return { platform: p, points: [], any: false, mixed: true };
      for (const d of data?.byDateFine ?? []) {
        if (d.platform !== p) continue;
        if (!inCampaignFilter(d)) continue;
        const k = bucketKey(d.date, bucket);
        if (!acc.has(k)) continue;
        acc.set(k, acc.get(k)! + d.cost);
        if (d.cost > 0) any = true;
      }
      return { platform: p, points: bucketKeys.map((k) => acc.get(k)!), any, mixed: false };
    });
    return { shown: series.filter((s) => s.any), mixed: series.filter((s) => s.mixed).map((s) => s.platform) };
  }, [data?.rows, data?.byDateFine, bucketKeys, bucket, inCampaignFilter]);

  // Spend is summed by goal only within one currency; across several the bars
  // show impressions instead, as the platform doughnut does.
  const goalBySpend = totals.spendByCurrency.length <= 1;
  const byGoal = useMemo(() => {
    const acc = new Map<CampaignGoal, number>();
    for (const r of mediaFiltered) acc.set(r.goal, (acc.get(r.goal) ?? 0) + (goalBySpend ? r.cost : r.impressions));
    return [...acc].map(([goal, value]) => ({ goal, value })).sort((a, b) => b.value - a.value);
  }, [mediaFiltered, goalBySpend]);

  // ── Platform comparison ─────────────────────────────────────────────────────
  const platformTable = useMemo(() => {
    const present = new Set<PaidPlatform>();
    for (const a of data?.accountsUsed ?? []) present.add(a.platform);
    for (const a of data?.emptyAccounts ?? []) present.add(a.platform);
    for (const f of data?.failures ?? []) present.add(f.platform);
    // The search reaches this table through inCampaignFilter, as whole campaigns.
    const rows = regroup((data?.rows ?? []).filter((r) => inCampaignFilter(r)), "campaign");
    // Leads, not `result`: result is goal-dependent — impressions for a reach
    // campaign, link clicks for traffic — so its sum mixed units into one cell.
    const acc = new Map<PaidPlatform, { cost: number; impressions: number; clicks: number; leads: number; n: number; currencies: Set<string> }>();
    for (const p of PLATFORM_ORDER) if (present.has(p)) acc.set(p, { cost: 0, impressions: 0, clicks: 0, leads: 0, n: 0, currencies: new Set() });
    for (const r of rows) {
      const cur = acc.get(r.platform);
      if (!cur) continue;
      cur.cost += r.cost; cur.impressions += r.impressions; cur.clicks += r.clicks; cur.leads += platformLeads(r); cur.n += 1;
      cur.currencies.add(r.currency);
    }
    const list = PLATFORM_ORDER.filter((p) => acc.has(p)).map((p) => ({ platform: p, ...acc.get(p)! }));
    const allCurs = new Set(list.flatMap((l) => [...l.currencies]));
    const total = {
      n: list.reduce((s, l) => s + l.n, 0),
      cost: list.reduce((s, l) => s + l.cost, 0),
      impressions: list.reduce((s, l) => s + l.impressions, 0),
      clicks: list.reduce((s, l) => s + l.clicks, 0),
      leads: list.reduce((s, l) => s + l.leads, 0),
      currency: allCurs.size === 1 ? [...allCurs][0] : "—",
      mixed: allCurs.size > 1,
    };
    return { list, total };
  }, [data?.rows, data?.accountsUsed, data?.emptyAccounts, data?.failures, regroup, inCampaignFilter]);

  // ── Campaign tree: code → utm_campaign → ad set → ad ───────────────────────
  const mediaIndex = useMemo(() => {
    // Nested media index keyed by normalised campaign name AND Meta campaign id,
    // so a tree campaign node can find its ads either way.
    const byCampaign = new Map<string, { row: CampaignRow; adsets: Map<string, { row: CampaignRow; ads: CampaignRow[] }> }>();
    const campaignRows = regroup(data?.rows ?? [], "campaign");
    const adsetRows = regroup(data?.rows ?? [], "adset");
    const adRows = regroup(data?.rows ?? [], "ad");
    const entryFor = (key: string, row: CampaignRow) => {
      const e = byCampaign.get(key);
      if (e) return e;
      const fresh = { row, adsets: new Map<string, { row: CampaignRow; ads: CampaignRow[] }>() };
      byCampaign.set(key, fresh);
      return fresh;
    };
    for (const r of campaignRows) {
      const e = entryFor(norm(r.campaign), r);
      if (r.campaignId) byCampaign.set(norm(r.campaignId), e);
    }
    for (const r of adsetRows) {
      if (!r.adset) continue;
      const e = byCampaign.get(norm(r.campaign));
      if (e) e.adsets.set(r.adset, { row: r, ads: [] });
    }
    for (const r of adRows) {
      if (!r.adset || !r.ad) continue;
      byCampaign.get(norm(r.campaign))?.adsets.get(r.adset)?.ads.push(r);
    }
    return byCampaign;
  }, [data?.rows, regroup]);

  const tree = useMemo(() => {
    // Code level from Engage membership rows; campaign level carries CRM stages
    // plus its matched media; deeper levels are media-only (the CRM records
    // nothing finer than the campaign tag).
    const byCode = new Map<string, { agg: StageAgg; campaigns: Map<string, StageAgg> }>();
    for (const r of crm?.codeRows ?? []) {
      const c = norm(r.code);
      if (codes.length && !codes.includes(c)) continue;
      if (utmCamps.length && !utmCamps.includes(norm(r.campaign))) continue;
      if (stageFilter !== "all" && bucketOf(r.stage, r.state) !== stageFilter) continue;
      const needle = norm(q);
      if (needle && !c.includes(needle) && !norm(r.campaign).includes(needle)) continue;
      const entry = byCode.get(c) ?? { agg: emptyStages(), campaigns: new Map<string, StageAgg>() };
      addStage(entry.agg, r.stage, r.state, r.n);
      const ck = norm(r.campaign);
      const camp = entry.campaigns.get(ck) ?? emptyStages();
      addStage(camp, r.stage, r.state, r.n);
      entry.campaigns.set(ck, camp);
      byCode.set(c, entry);
    }
    return [...byCode.entries()]
      .map(([c, v]) => ({
        code: c,
        agg: v.agg,
        campaigns: [...v.campaigns.entries()].map(([name, agg]) => ({ name, agg, media: mediaIndex.get(name) ?? null })).sort((a, b) => b.agg.matched - a.agg.matched),
      }))
      .sort((a, b) => b.agg.matched - a.agg.matched)
      .slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crm?.codeRows, codesKey, campsKey, q, mediaIndex, stageFilter]);

  const toggleNode = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rowName = (r: CampaignRow) => (viewLevel === "ad" ? r.ad ?? r.adset ?? r.campaign : viewLevel === "adset" ? r.adset ?? r.campaign : r.campaign);
  const rowContext = (r: CampaignRow) =>
    viewLevel === "ad" ? [r.campaign, r.adset].filter(Boolean).join(" › ") : viewLevel === "adset" ? r.campaign : null;

  const filtersActive =
    platformFilter !== "all" || stageFilter !== "all" || codes.length > 0 || utmCamps.length > 0 ||
    utmSrcs.length > 0 || utmMeds.length > 0 || utmContents.length > 0 || q.trim() !== "";
  function clearAll() {
    setPlatformFilter("all");
    setStageFilter("all");
    setCodes([]); setUtmCamps([]); setUtmSrcs([]); setUtmMeds([]); setUtmContents([]);
    setQ("");
  }

  const explorerRows = useMemo(() => {
    const needle = norm(explorerQ);
    if (!needle) return mediaRows;
    return mediaRows.filter(
      (r) => norm(r.campaign).includes(needle) || norm(r.adset ?? "").includes(needle) || norm(r.ad ?? "").includes(needle) || norm(r.accountName).includes(needle),
    );
  }, [mediaRows, explorerQ]);

  // Leads here is every lead, closed included — the headline's count, so a
  // campaign's Spend ÷ Leads in the tree matches its Explorer Cost / lead.
  const stageCells = (a: StageAgg) => (
    <>
      <td style={{ textAlign: "right", fontWeight: 600, color: C.green }}>{fmt(a.matched)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.qualified)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.viewing)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.offerRes)}</td>
      <td style={{ textAlign: "right" }}>{fmt(a.deals)}</td>
      <td style={{ textAlign: "right", color: a.valuation ? C.blue : undefined }}>{fmt(a.valuation)}</td>
      <td style={{ textAlign: "right", color: a.listed ? C.blue : undefined }}>{fmt(a.listed)}</td>
      <td style={{ textAlign: "right", color: a.notq ? C.coral : undefined }}>{fmt(a.notq)}</td>
    </>
  );
  const emptyStageCells = (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <td key={i} style={{ textAlign: "right" }} className="muted">—</td>
      ))}
    </>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Digital Performance</h1>
          <p className="page-sub">
            Paid media via Supermetrics · lead funnel via Engage (Metabase) · {busy ? "loading…" : data?.label}
          </p>
        </div>
        <div className="filter-row" style={{ flexWrap: "wrap" }}>
          <DateRangePicker initialFrom={from} initialTo={to} onApply={applyRange} />
          <button
            className={`filter-btn${cfgOpen ? " active" : ""}`}
            onClick={() => (cfgOpen ? closeConfig(true) : setCfgOpen(true))}
            title={`Choose which ad accounts appear — ${selectedCount} selected`}
            aria-label="Account settings"
          >
            ⚙ <span className="muted">{selectedCount}</span>
          </button>
        </div>
      </div>

      {cfgOpen && (
        <div className="chart-card" style={{ marginBottom: 16 }}>
          <div className="chart-title">
            Accounts to showcase <HelpTip text="Only the accounts you tick are queried. The connected platforms expose far more than are actually advertised on — 41 Meta ad accounts alone, most of them closed, disabled, or messaging integrations." />
          </div>
          <div className="chart-sub">Pick the accounts that represent live activity. Closed, disabled and messaging-integration accounts are hidden by default.</div>
          <div style={{ display: "flex", gap: 6, margin: "10px 0", alignItems: "center", flexWrap: "wrap" }}>
            <button className="filter-btn" onClick={saveAndClose} disabled={saving}>{saving ? "Saving…" : "Save & close"}</button>
            <button className="filter-btn" onClick={() => closeConfig(true)} disabled={saving}>{dirty ? "Discard changes" : "Close"}</button>
            <button className="filter-btn" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "Hide closed & integration accounts" : "Show all accounts"}
            </button>
            {dirty && !cfgMsg && <span className="muted" style={{ fontSize: 11 }}>Unsaved changes</span>}
            {cfgMsg && <span className="ps-save-msg" style={{ color: C.coral }}>{cfgMsg}</span>}
          </div>
          <div className="charts-grid-2">
            {PLATFORM_ORDER.map((p) => {
              const all = ACCOUNT_CATALOG[p];
              const visible = showHidden ? all : all.filter((a) => !a.disabled && !a.readOnly);
              const allOn = visible.length > 0 && visible.every((a) => sel[p].includes(a.id));
              return (
                <div key={p}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 12, color: PLATFORM_COLOR[p] }}>{PLATFORMS[p].label}</span>
                    <span className="muted" style={{ fontSize: 11 }}>{sel[p].length}/{all.length} selected</span>
                    <button className="filter-btn" style={{ fontSize: 10, padding: "1px 7px", marginLeft: "auto" }} onClick={() => setPlatformAll(p, !allOn, visible)}>
                      {allOn ? "None" : "All shown"}
                    </button>
                  </div>
                  <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                    {visible.map((a) => (
                      <AccountRow key={a.id} acct={a} platform={p} checked={sel[p].includes(a.id)} onToggle={() => toggleAccount(p, a.id)} />
                    ))}
                    {!visible.length && <div className="muted" style={{ fontSize: 12 }}>None.</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {busy || !data ? (
        <DigitalSkeleton />
      ) : !data.connected ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>Supermetrics not connected</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.8 }}>
              Add to the deployment environment, then refresh:
              <br />
              {["SUPERMETRICS_API_KEY", "SUPERMETRICS_DS_USER_GOOGLE", "SUPERMETRICS_DS_USER_META", "SUPERMETRICS_DS_USER_LINKEDIN"].map((l) => (
                <code key={l} style={{ display: "inline-block", margin: "2px 4px", background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>{l}</code>
              ))}
            </div>
          </div>
        </div>
      ) : data.paused ? (
        // An admin switched Supermetrics off. Say so, rather than showing an
        // empty tab that reads as a fault.
        <PausedNotice note={data.pausedNote} what="Paid media figures are paused." />
      ) : data.unconfigured ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>No accounts selected yet</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.7, maxWidth: 520, margin: "0 auto" }}>
              Open <strong>⚙</strong> above and tick the ad accounts you want on this dashboard.
            </div>
          </div>
        </div>
      ) : (
        <>
          {data.error && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="empty-state" style={{ height: "auto", padding: "18px 16px", display: "block" }}>⚠ {data.error}</div>
            </div>
          )}

          {/* ── Filters — everything on the page answers to these ────────────── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <button className={`filter-btn${platformFilter === "all" ? " active" : ""}`} onClick={() => setPlatformFilter("all")}>All platforms</button>
              {PLATFORM_ORDER.filter((p) => data.rows.some((r) => r.platform === p)).map((p) => (
                <button key={p} className={`filter-btn${platformFilter === p ? " active" : ""}`} onClick={() => setPlatformFilter(p)} style={platformFilter === p ? { background: PLATFORM_COLOR[p], borderColor: PLATFORM_COLOR[p] } : undefined}>
                  {PLATFORMS[p].label}
                </button>
              ))}
              {filtersActive && (
                <button className="filter-btn" style={{ marginLeft: "auto" }} onClick={clearAll}>Clear all filters</button>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 11 }}>
                Lead stage <HelpTip text="Narrows every CRM figure to leads sitting in one stage. 'Not qualified' is a lead that was at New, Qualified or Viewing and then closed — disqualified rather than progressed. Leads closed further down (Offer, Reserved, Deal) are counted as lost, not as not-qualified." />
              </span>
              {STAGE_FILTERS.map((sf) => (
                <button
                  key={sf.key}
                  className={`filter-btn${stageFilter === sf.key ? " active" : ""}`}
                  onClick={() => setStageFilter(sf.key)}
                  style={stageFilter === sf.key && sf.key === "notq" ? { background: C.coral, borderColor: C.coral } : undefined}
                >
                  {sf.label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                Engage <HelpTip text="Straight from Engage: campaign_code is the campaign entity's reference (a code groups several utm_campaigns); the four utm_* fields are what each lead's record carries. All five are multi-select, searchable and faceted: each dropdown offers only the values that still exist under every other active filter, including the lead stage — so picking Deal leaves only the utm values that appear on Deal-stage leads, with counts to match." />
              </span>
            </div>
            {/* A wrapping grid, not a flex row: `.search-box` carries a 240px
                floor, so six controls on one line overflowed the card and left
                the search box a sliver. */}
            <div className="filter-grid" style={{ marginTop: 6 }}>
              <FilterSelect label="campaign_code" selected={codes} options={codeOptions} onToggle={toggleIn(setCodes)} onClear={() => setCodes([])} />
              <FilterSelect label="utm_campaign" selected={utmCamps} options={campOptions} onToggle={toggleIn(setUtmCamps)} onClear={() => setUtmCamps([])} />
              <FilterSelect label="utm_source" selected={utmSrcs} options={srcOptions} onToggle={toggleIn(setUtmSrcs)} onClear={() => setUtmSrcs([])} />
              <FilterSelect label="utm_medium" selected={utmMeds} options={medOptions} onToggle={toggleIn(setUtmMeds)} onClear={() => setUtmMeds([])} />
              <FilterSelect label="utm_content" selected={utmContents} options={contentOptions} onToggle={toggleIn(setUtmContents)} onClear={() => setUtmContents([])} />
              <input className="search-box" placeholder="Search everything…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="chart-sub" style={{ marginTop: 8 }}>
              Every figure on the page is faceted. <strong>Spend and the ad metrics</strong> follow platform, campaign_code and
              utm_campaign — the filters that identify a campaign. <strong>utm_source, utm_medium, utm_content and lead stage</strong>{" "}
              describe leads rather than campaigns, so they narrow the lead figures and leave spend whole: that is what makes
              cost per stage read as campaign spend ÷ leads at that stage. The search box picks whole campaigns — by campaign, ad
              set, ad or account name — for both spend and leads.
              {mediaCampaignFilter && mediaRows.length === 0 && (
                <span style={{ color: C.coral }}> No ad spend is recorded against the selected campaign(s) in this range.</span>
              )}
            </div>
          </div>

          {/* ── KPIs ─────────────────────────────────────────────────────────── */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(5,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">Spend <HelpTip text={totals.singleCurrency ? `Media spend for the current filters, in ${totals.singleCurrency}.` : totals.spendByCurrency.length ? "The filtered accounts bill in more than one currency; the split is shown below and nothing is summed across currencies." : "No ad spend for the current filters in this range."} /></div>
              {/* No rows means no currency at all — "—", not "Mixed currency". */}
              <div className="kpi-value">{totals.singleCurrency ? money(totals.spend, cur) : totals.spendByCurrency.length ? <span style={{ fontSize: 15 }}>Mixed currency</span> : "—"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                {leadLabel} <HelpTip text="Campaign-tagged CRM leads created in this range whose utm_campaign (or Meta campaign id) matches a campaign in the selected ad accounts, including ones since disqualified or lost — the pool the spend bought, and the Cost / lead denominator everywhere on this tab. Tagged leads with no matching campaign (WhatsApp buttons, website pop-ups, e-mail) are counted beneath, not in this number. Source: Engage via Metabase." />
              </div>
              <div className="kpi-value" style={{ color: C.green }}>{crmFig(leadCount)}</div>
              {!crmDown && stageFilter === "all" && crmAgg.matched > 0 && (
                <div className="kpi-change">{fmt(crmAgg.leads)} still live · {fmt(crmAgg.notq + crmAgg.lost)} closed</div>
              )}
              {!crmDown && unmatched.n > 0 && (
                <div className="kpi-change">+{fmt(unmatched.n)} with no paid campaign, not counted</div>
              )}
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Qualified <HelpTip text="Leads sitting at the Qualified stage right now, still open." /></div>
              <div className="kpi-value">{crmFig(crmAgg.qualified)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Viewing <HelpTip text="Leads at the Viewing stage right now, still open." /></div>
              <div className="kpi-value">{crmFig(crmAgg.viewing)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Offer / Reserved <HelpTip text="Leads in negotiation — at the Offer or Reserved stage, still open. Buyer / tenant path." /></div>
              <div className="kpi-value">{crmFig(crmAgg.offerRes)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Valuation <HelpTip text="Leads at the Valuation stage — the seller / landlord path. A valuation campaign's leads progress here, not to Viewing." /></div>
              <div className="kpi-value" style={{ color: C.blue }}>{crmFig(crmAgg.valuation)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Listed <HelpTip text="Leads whose property is now Listed — the seller-side conversion, the equivalent of a Deal on the buyer side. Listing and valuation campaigns convert here and will never reach a Deal stage." /></div>
              <div className="kpi-value" style={{ color: C.blue }}>{crmFig(crmAgg.listed)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Deal stage <HelpTip text="Leads currently at the Deal stage of the pipeline. A stage snapshot — not the same as a signed transaction in the deals table." /></div>
              <div className="kpi-value">{crmFig(crmAgg.deals)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">
                Not qualified <HelpTip text="Leads that sat at New, Qualified or Viewing and were then closed — disqualified rather than progressed. Leads closed further down the pipeline count as lost instead, and are shown in the funnel note." />
              </div>
              <div className="kpi-value" style={{ color: C.coral }}>{crmFig(crmAgg.notq)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Cost / lead <HelpTip text={totals.singleCurrency ? "Filtered spend divided by Leads (closed ones included), and by currently-qualified leads. Spend is read from the cache as of the time shown; leads are counted live, so a range ending today can pair part-day spend with a full day's leads." : "Hidden while the filtered accounts span multiple currencies."} /></div>
              <div className="kpi-value" style={{ fontSize: 16 }}>
                {crmDown || cpl == null ? "—" : money(cpl, cur)}
                {!crmDown && cpql != null && <span className="muted" style={{ fontSize: 12 }}> · {money(cpql, cur)} / qualified</span>}
              </div>
              {data.spendAsOf && <div className="kpi-change">spend as of {fmtSynced(data.spendAsOf)} · leads live</div>}
            </div>
          </div>

          {totals.spendByCurrency.length > 1 && (
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <div className="chart-title">Spend by currency</div>
              <div className="chart-sub">These are not added together — no conversion rate is applied anywhere on this tab.</div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 8 }}>
                {totals.spendByCurrency.map(([c, v]) => (
                  <div key={c}>
                    <div className="kpi-label">{c}</div>
                    <div style={{ fontFamily: "Georgia, serif", fontSize: 18, fontWeight: 700 }}>{money(v, c)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Funnel ───────────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div className="chart-title">
              Lead funnel <HelpTip text="Leads from campaigns in the ad data — the Cost / lead pool — by the pipeline stage they sit at today. Each stage shows its share of leads." />
            </div>
            <div className="chart-sub">
              {crmDown ? `CRM unavailable: ${crm?.error ?? "Metabase is not connected"}` : `${fmt(crmAgg.leads)} open leads${codes.length === 1 ? ` · code ${codes[0]}` : codes.length > 1 ? ` · ${codes.length} codes` : ""} · ${crm?.label ?? ""}${crmAgg.lost ? ` · ${fmt(crmAgg.lost)} closed later in the pipeline (lost)` : ""}${crmAgg.other ? ` · ${fmt(crmAgg.other)} at a stage not shown above` : ""}${crm?.truncated ? " · largest groups only (row cap hit)" : ""}${crm?.error ? ` · ${crm.error}` : ""}`}
            </div>
            {!crmDown && unmatched.n > 0 && (
              <div className="chart-sub" style={{ marginTop: 8 }}>
                {fmt(unmatched.n)} lead{unmatched.n === 1 ? "" : "s"} with no paid campaign
                {unmatched.bySource.length > 0 && ` (by utm_source: ${unmatched.bySource.slice(0, 4).map(([s, n]) => `${s} ${fmt(n)}`).join(" · ")}${unmatched.bySource.length > 4 ? " · …" : ""})`}
                : their utm_campaign matches no campaign in the selected ad accounts in this range, so they are not in Leads or Cost / lead.
                If one should match, check the naming — the Explorer&apos;s dashes show the same gap from the ads side.
              </div>
            )}
            {codesOverlap && (
              <div className="chart-sub" style={{ marginTop: 8, color: C.coral }}>
                ⚠ Two or more of the selected codes share leads — Engage links a lead to its own campaign entity <em>and</em> to any
                umbrella project code above it. Those leads are counted once per code here, so the totals below are higher than the
                number of distinct leads. Select the codes one at a time for exact figures.
              </div>
            )}
            {/* No bars while the CRM is down: a row of zeros would read as a result. */}
            {!crmDown && (
            <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
              {funnel.map((st, i) => {
                const colour = st.group === "lost" ? C.coral : st.group === "sell" ? C.blue : C.green;
                const top = funnelTop[st.key] ?? [];
                // A rule and a caption wherever the path changes, so the two
                // flows can't be misread as one sequence.
                const newGroup = i > 0 && funnel[i - 1].group !== st.group;
                const caption =
                  st.group === "buy" ? "Buyer / tenant path"
                    : st.group === "sell" ? "Seller / landlord path — a listing is this lead's conversion"
                      : st.group === "lost" ? "Disqualified" : null;
                return (
                  <div key={st.key}>
                    {newGroup && caption && (
                      <div style={{ borderTop: "1px dashed var(--border)", marginTop: 8, paddingTop: 8, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: colour }}>
                        {caption}
                      </div>
                    )}
                  <div
                    style={{ display: "grid", gridTemplateColumns: "minmax(120px,150px) 1fr minmax(130px,170px)", alignItems: "center", gap: 10, position: "relative" }}
                    onMouseEnter={() => setHoverStage(st.key)}
                    onMouseLeave={() => setHoverStage(null)}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: colour }}>
                      {st.label}
                      <div className="muted" style={{ fontSize: 10, fontWeight: 400 }}>{st.note}</div>
                    </div>
                    {/* The popover lives in this cell, not the row, so it lines
                        up with the bar whatever width the label column takes. */}
                    <div style={{ position: "relative", minWidth: 0 }}>
                      <div style={{ background: "var(--warm-white)", borderRadius: 5, height: 26, position: "relative", overflow: "hidden", cursor: top.length ? "help" : "default" }}>
                        <div style={{ width: `${Math.max((st.n / funnelMax) * 100, st.n > 0 ? 1.5 : 0)}%`, background: colour, opacity: i === 0 ? 0.9 : 0.7, height: "100%", borderRadius: 5, transition: "width .3s" }} />
                      </div>
                      {hoverStage === st.key && top.length > 0 && (
                        <div
                          style={{
                            position: "absolute",
                            // The lower rows open upward: below them is the card
                            // edge and then the next card.
                            ...(i >= funnel.length - 2 ? { bottom: "100%", marginBottom: 6 } : { top: "100%", marginTop: 6 }),
                            left: 0,
                            zIndex: 60,
                            minWidth: 260,
                            maxWidth: "min(460px, 90vw)",
                            background: "#fff",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            boxShadow: "0 8px 22px rgba(0,0,0,.12)",
                            padding: "8px 10px",
                            pointerEvents: "none",
                          }}
                        >
                          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, color: colour }}>
                            Top campaigns · {st.label}
                          </div>
                          {top.map((t) => (
                            <div key={t.campaign} style={{ display: "flex", gap: 10, fontSize: 11, padding: "2px 0" }}>
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.campaign}>{t.campaign}</span>
                              <strong>{fmt(t.n)}</strong>
                            </div>
                          ))}
                          {st.n > top.reduce((a, t) => a + t.n, 0) && (
                            <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                              + {fmt(st.n - top.reduce((a, t) => a + t.n, 0))} across other campaigns
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: 12, textAlign: "right" }}>
                      <strong>{fmt(st.n)}</strong>
                      {st.group !== "lost" && i > 0 && funnel[0].n > 0 && <span className="muted"> · {pct0(st.n / funnel[0].n)} of leads</span>}
                      {st.group === "lost" && funnel[0].n > 0 && <span className="muted"> · {pct0(st.n / funnel[0].n)} of leads</span>}
                    </div>
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </div>

          {/* ── Campaign tree ────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 16 }}>
            <div className="chart-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                Campaign tree <HelpTip text="Engage's own hierarchy: a campaign_code groups several utm_campaigns; under each campaign sit its ad sets and ads from the ad platforms. Lead stages exist down to the campaign level — the CRM records nothing finer — so ad sets and ads show media numbers only. Expand rows with the arrows." />
              </span>
              <button className="filter-btn" onClick={() => setTreeOpen((v) => !v)}>{treeOpen ? "Hide" : "Show"}</button>
            </div>
            <div className="chart-sub">campaign_code → utm_campaign → ad set → ad · {tree.length} code{tree.length === 1 ? "" : "s"}</div>
            {treeOpen && (
              <div className="table-scroll">
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 320 }}>Node</th>
                      <th style={{ textAlign: "right" }}>Spend</th>
                      <th style={{ textAlign: "right" }}>Impr.</th>
                      <th style={{ textAlign: "right" }}>Clicks</th>
                      <th style={{ textAlign: "right" }}>Leads</th>
                      <th style={{ textAlign: "right" }}>Qualified</th>
                      <th style={{ textAlign: "right" }}>Viewing</th>
                      <th style={{ textAlign: "right" }}>Offer/Res.</th>
                      <th style={{ textAlign: "right" }}>Deal</th>
                      <th style={{ textAlign: "right" }}>Valuation</th>
                      <th style={{ textAlign: "right" }}>Listed</th>
                      <th style={{ textAlign: "right" }}>Not qual.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tree.map((node) => {
                      const codeKey = `c|${node.code}`;
                      const codeOpen = expanded.has(codeKey);
                      return (
                        <FragmentRows key={codeKey}>
                          <tr style={{ background: "var(--warm-white)" }}>
                            <td style={{ fontWeight: 700 }}>
                              <button className="filter-btn" style={{ padding: "0 7px", marginRight: 6, fontSize: 11 }} onClick={() => toggleNode(codeKey)}>
                                {codeOpen ? "▾" : "▸"}
                              </button>
                              {node.code} <span className="muted" style={{ fontWeight: 400, fontSize: 10 }}>code · {node.campaigns.length} campaign{node.campaigns.length === 1 ? "" : "s"}</span>
                            </td>
                            <td style={{ textAlign: "right" }} className="muted">—</td>
                            <td style={{ textAlign: "right" }} className="muted">—</td>
                            <td style={{ textAlign: "right" }} className="muted">—</td>
                            {stageCells(node.agg)}
                          </tr>
                          {codeOpen &&
                            node.campaigns.map((camp) => {
                              const campKey = `${codeKey}|p|${camp.name}`;
                              const campOpen = expanded.has(campKey);
                              const m = camp.media;
                              const adsets = m ? [...m.adsets.values()].sort((a, b) => b.row.cost - a.row.cost) : [];
                              return (
                                <FragmentRows key={campKey}>
                                  <tr>
                                    <td style={{ paddingLeft: 34 }}>
                                      {adsets.length > 0 ? (
                                        <button className="filter-btn" style={{ padding: "0 7px", marginRight: 6, fontSize: 11 }} onClick={() => toggleNode(campKey)}>
                                          {campOpen ? "▾" : "▸"}
                                        </button>
                                      ) : (
                                        <span style={{ display: "inline-block", width: 30 }} />
                                      )}
                                      {camp.name}
                                      {m && <span style={{ color: PLATFORM_COLOR[m.row.platform], fontSize: 10 }}> ● {PLATFORMS[m.row.platform].label}</span>}
                                      {!m && camp.name !== "(none)" && <span className="muted" style={{ fontSize: 10 }}> · no matching ads in range</span>}
                                      {camp.name === "(none)" && <span className="muted" style={{ fontSize: 10 }}> · leads with no utm_campaign</span>}
                                    </td>
                                    <td style={{ textAlign: "right" }}>{m ? money(m.row.cost, m.row.currency) : "—"}</td>
                                    <td style={{ textAlign: "right" }}>{m ? fmtK(m.row.impressions) : "—"}</td>
                                    <td style={{ textAlign: "right" }}>{m ? fmtK(m.row.clicks) : "—"}</td>
                                    {stageCells(camp.agg)}
                                  </tr>
                                  {campOpen &&
                                    adsets.map((as) => {
                                      const asKey = `${campKey}|s|${as.row.adset}`;
                                      const asOpen = expanded.has(asKey);
                                      const ads = [...as.ads].sort((a, b) => b.cost - a.cost);
                                      return (
                                        <FragmentRows key={asKey}>
                                          <tr>
                                            <td style={{ paddingLeft: 64 }}>
                                              {ads.length > 0 ? (
                                                <button className="filter-btn" style={{ padding: "0 7px", marginRight: 6, fontSize: 11 }} onClick={() => toggleNode(asKey)}>
                                                  {asOpen ? "▾" : "▸"}
                                                </button>
                                              ) : (
                                                <span style={{ display: "inline-block", width: 30 }} />
                                              )}
                                              <span style={{ fontSize: 12 }}>{as.row.adset}</span> <span className="muted" style={{ fontSize: 10 }}>ad set</span>
                                            </td>
                                            <td style={{ textAlign: "right" }}>{money(as.row.cost, as.row.currency)}</td>
                                            <td style={{ textAlign: "right" }}>{fmtK(as.row.impressions)}</td>
                                            <td style={{ textAlign: "right" }}>{fmtK(as.row.clicks)}</td>
                                            {emptyStageCells}
                                          </tr>
                                          {asOpen &&
                                            ads.map((ad) => (
                                              <tr key={`${asKey}|a|${ad.ad}`}>
                                                <td style={{ paddingLeft: 100, fontSize: 12 }}>
                                                  {ad.ad} <span className="muted" style={{ fontSize: 10 }}>ad · {ad.resultLabel.toLowerCase()}: {fmt(ad.result)}</span>
                                                </td>
                                                <td style={{ textAlign: "right" }}>{money(ad.cost, ad.currency)}</td>
                                                <td style={{ textAlign: "right" }}>{fmtK(ad.impressions)}</td>
                                                <td style={{ textAlign: "right" }}>{fmtK(ad.clicks)}</td>
                                                {emptyStageCells}
                                              </tr>
                                            ))}
                                        </FragmentRows>
                                      );
                                    })}
                                </FragmentRows>
                              );
                            })}
                        </FragmentRows>
                      );
                    })}
                    {!tree.length && (
                      <tr><td colSpan={12} className="muted">{crmDown ? "CRM unavailable — see the funnel note." : "No campaign codes match the filters."}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Trends ───────────────────────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">
                Spend &amp; leads over time <HelpTip text="Leads here are platform-reported (Meta website + form leads; Google/LinkedIn conversions) so they exist per day. Platform and goal filters apply; Engage filters can't reach this chart because the ad platforms don't report by UTM." />
              </div>
              <div className="chart-sub">
                {BUCKET_LABEL[bucket]} · {data.label}
                {!trendSpendShown && " · spend not drawn: it spans more than one currency (see Spend by currency)"}
              </div>
              <div className="chart-canvas-wrap">
                {trend.some((d) => d.cost > 0 || d.leads > 0) ? (
                  <ChartBox
                    type="line"
                    data={{
                      labels: bucketLabels,
                      datasets: [
                        ...(trendSpendShown
                          ? [{ label: `Spend${cur !== "—" ? ` (${cur})` : ""}`, data: trend.map((d) => d.cost), borderColor: C.dark, backgroundColor: "rgba(31,52,63,.08)", fill: true, tension: 0.3, yAxisID: "y" }]
                          : []),
                        { label: "Leads", data: trend.map((d) => d.leads), borderColor: C.green, backgroundColor: "transparent", tension: 0.3, yAxisID: trendSpendShown ? "y1" : "y" },
                      ],
                    }}
                    options={{
                      interaction: { mode: "index", intersect: false },
                      scales: {
                        y: { beginAtZero: true, position: "left", title: { display: true, text: trendSpendShown ? "Spend" : "Leads" } },
                        y1: { display: trendSpendShown, beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Leads" }, ticks: { precision: 0 } },
                      },
                    }}
                  />
                ) : (
                  <div className="empty-state">No daily data for the current filters.</div>
                )}
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">Spend by platform over time</div>
              <div className="chart-sub">
                {BUCKET_LABEL[bucket]} · Google in green, Meta in blue
                {platformTrend.mixed.length > 0 && ` · ${platformTrend.mixed.map((p) => PLATFORMS[p].label).join(", ")} left off: its accounts bill in more than one currency`}
              </div>
              <div className="chart-canvas-wrap">
                {platformTrend.shown.length ? (
                  <ChartBox
                    type="line"
                    data={{
                      labels: bucketLabels,
                      datasets: platformTrend.shown.map((s) => ({
                        label: PLATFORMS[s.platform].label,
                        data: s.points,
                        borderColor: PLATFORM_COLOR[s.platform],
                        backgroundColor: "transparent",
                        tension: 0.3,
                      })),
                    }}
                    options={{ interaction: { mode: "index", intersect: false }, scales: { y: { beginAtZero: true } } }}
                  />
                ) : (
                  <div className="empty-state">No daily data for the current filters.</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Mix + platform comparison ────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Where the money goes</div>
              {/* The doughnut plots every platform whatever the platform filter, so
                  it decides spend vs impressions from its own rows; it used the
                  filtered Spend card's currency, which could add AED to USD. */}
              <div className="chart-sub">
                {platformTable.total.mixed
                  ? "Impression share by platform — spend spans more than one currency"
                  : `Spend share by platform${platformTable.total.currency !== "—" ? ` (${platformTable.total.currency})` : ""}`}
                {" "}· {goalBySpend ? "spend" : "impressions"} by campaign goal
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
                <div className="chart-canvas-wrap">
                  {platformTable.list.some((p) => p.cost > 0 || p.impressions > 0) ? (
                    <ChartBox
                      type="doughnut"
                      data={{
                        labels: platformTable.list.map((p) => PLATFORMS[p.platform].label),
                        datasets: [{
                          data: platformTable.list.map((p) => (platformTable.total.mixed ? p.impressions : p.cost)),
                          backgroundColor: platformTable.list.map((p) => PLATFORM_COLOR[p.platform]),
                          borderWidth: 1,
                        }],
                      }}
                      options={{ plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } } }, cutout: "55%" }}
                    />
                  ) : (
                    <div className="empty-state">Nothing in range.</div>
                  )}
                </div>
                <div className="chart-canvas-wrap">
                  {byGoal.length ? (
                    <ChartBox
                      type="bar"
                      data={{
                        labels: byGoal.map((g) => GOAL_LABELS[g.goal]),
                        datasets: [{ label: goalBySpend ? "Spend" : "Impressions", data: byGoal.map((g) => g.value), backgroundColor: byGoal.map((g) => GOAL_COLOR[g.goal]), borderRadius: 5 }],
                      }}
                      options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }}
                    />
                  ) : (
                    <div className="empty-state">Nothing in range.</div>
                  )}
                </div>
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">
                Platform comparison <HelpTip text="Every selected platform, including quiet ones, plus a total. Goal and search filters apply; the platform filter deliberately does not — a comparison with the others hidden compares nothing. Rates are derived from raw totals. Leads are platform-reported (Meta website + form leads; Google/LinkedIn conversions), not the CRM count." />
              </div>
              <div className="chart-sub">Totals per platform · {data.label}</div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead>
                    <tr>
                      <th>Platform</th><th style={{ textAlign: "right" }}>Campaigns</th><th style={{ textAlign: "right" }}>Spend</th>
                      <th style={{ textAlign: "right" }}>Impr.</th><th style={{ textAlign: "right" }}>Clicks</th>
                      <th style={{ textAlign: "right" }}>CTR</th><th style={{ textAlign: "right" }}>Leads (platform)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {platformTable.list.map((p) => {
                      const pc = p.currencies.size === 1 ? [...p.currencies][0] : "—";
                      return (
                        <tr key={p.platform}>
                          <td><span style={{ color: PLATFORM_COLOR[p.platform], fontWeight: 600 }}>{PLATFORMS[p.platform].label}</span></td>
                          <td style={{ textAlign: "right" }}>{p.n}</td>
                          <td style={{ textAlign: "right" }} title={p.currencies.size > 1 ? "This platform's accounts bill in more than one currency; spend is not summed" : undefined}>
                            {p.currencies.size > 1 ? "mixed" : money(p.cost, pc)}
                          </td>
                          <td style={{ textAlign: "right" }}>{fmtK(p.impressions)}</td>
                          <td style={{ textAlign: "right" }}>{fmtK(p.clicks)}</td>
                          <td style={{ textAlign: "right" }}>{pct1(ratio(p.clicks, p.impressions))}</td>
                          <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p.leads)}</td>
                        </tr>
                      );
                    })}
                    {platformTable.list.length > 0 && (
                      <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>
                        <td>Total</td>
                        <td style={{ textAlign: "right" }}>{platformTable.total.n}</td>
                        <td style={{ textAlign: "right" }} title={platformTable.total.mixed ? "Spend spans multiple currencies and is not summed" : undefined}>
                          {platformTable.total.mixed ? "mixed" : money(platformTable.total.cost, platformTable.total.currency)}
                        </td>
                        <td style={{ textAlign: "right" }}>{fmtK(platformTable.total.impressions)}</td>
                        <td style={{ textAlign: "right" }}>{fmtK(platformTable.total.clicks)}</td>
                        <td style={{ textAlign: "right" }}>{pct1(ratio(platformTable.total.clicks, platformTable.total.impressions))}</td>
                        <td style={{ textAlign: "right" }}>{fmt(platformTable.total.leads)}</td>
                      </tr>
                    )}
                    {!platformTable.list.length && <tr><td colSpan={7} className="muted">No platforms selected.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Explorer ─────────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginTop: 4 }}>
            <div className="chart-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                Explorer <HelpTip text="Every row with spend in range, biggest first. Result is goal-aware — leads for lead campaigns, link clicks for traffic, website conversions for sales. CRM columns join by utm_campaign (name or Meta campaign id) at campaign level; ad sets and ads inherit no CRM figures because the CRM records only the campaign tag. Leads include closed ones, as the headline does, so Cost / lead means the same here as in the KPI strip." />
              </span>
              <button className="filter-btn" onClick={() => setExplorerOpen((v) => !v)}>{explorerOpen ? "Hide" : "Show"}</button>
            </div>
            <div className="chart-sub">
              {explorerRows.length} row{explorerRows.length === 1 ? "" : "s"} · {LEVEL_LABEL[viewLevel].toLowerCase()}
              {data.truncated ? " · some accounts hit the row cap — totals may undercount" : ""}
            </div>
            {explorerOpen && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0", alignItems: "center" }}>
                  {(Object.keys(LEVEL_LABEL) as PaidLevel[]).map((l) => (
                    <button key={l} className={`filter-btn${viewLevel === l ? " active" : ""}`} onClick={() => setViewLevel(l)}>{LEVEL_LABEL[l]}</button>
                  ))}
                  <input className="search-box" style={{ flex: 1, minWidth: 160 }} placeholder="Filter these rows…" value={explorerQ} onChange={(e) => setExplorerQ(e.target.value)} />
                </div>
                <div className="table-scroll">
                  <table className="perf-table">
                    <thead>
                      <tr>
                        <th>{LEVEL_LABEL[viewLevel].replace(/s$/, "")}</th><th>Account</th><th>Goal</th>
                        <th style={{ textAlign: "right" }}>Spend</th>
                        <th style={{ textAlign: "right" }}>Impr.</th>
                        <th style={{ textAlign: "right" }}>Clicks</th>
                        <th style={{ textAlign: "right" }}>CTR</th>
                        <th style={{ textAlign: "right" }}>Result</th>
                        <th>Measured as</th>
                        {viewLevel === "campaign" && (
                          <>
                            <th style={{ textAlign: "right" }}>Leads</th>
                            <th style={{ textAlign: "right" }}>Qualified</th>
                            <th style={{ textAlign: "right" }}>Deals</th>
                            <th style={{ textAlign: "right" }}>Cost / lead</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {explorerRows.slice(0, 80).map((r) => {
                        const j = viewLevel === "campaign" ? joinFor(r) : null;
                        const ctx = rowContext(r);
                        const shallow = DEPTH[r.granularity] < DEPTH[viewLevel];
                        return (
                          <tr key={`${r.platform}|${r.accountId}|${r.campaign}|${r.adset ?? ""}|${r.ad ?? ""}`}>
                            <td title={r.objective || undefined}>
                              {rowName(r)}
                              {ctx && <div className="muted" style={{ fontSize: 10 }}>{ctx}</div>}
                              {shallow && (
                                <div className="muted" style={{ fontSize: 10 }} title={r.platform === "google" ? "Google responsive search ads have no single ad name; shown at ad-group level." : "LinkedIn creative naming is unreliable; shown at campaign level."}>
                                  ({r.granularity === "adset" ? "ad-group level" : "campaign level"})
                                </div>
                              )}
                            </td>
                            <td className="muted" style={{ fontSize: 11 }}><span style={{ color: PLATFORM_COLOR[r.platform] }}>●</span> {r.accountName}</td>
                            <td><span style={{ color: GOAL_COLOR[r.goal], fontWeight: 600, fontSize: 11 }}>{GOAL_LABELS[r.goal]}</span></td>
                            <td style={{ textAlign: "right" }}>{money(r.cost, r.currency)}</td>
                            <td style={{ textAlign: "right" }}>{fmtK(r.impressions)}</td>
                            <td style={{ textAlign: "right" }}>{fmtK(r.clicks)}</td>
                            <td style={{ textAlign: "right" }}>{pct1(ratio(r.clicks, r.impressions))}</td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(r.result)}</td>
                            <td className="muted" style={{ fontSize: 11 }}>{r.resultLabel}</td>
                            {viewLevel === "campaign" && (
                              <>
                                <td style={{ textAlign: "right", fontWeight: 600, color: j ? C.green : undefined }}>{j ? fmt(j.leads) : "—"}</td>
                                <td style={{ textAlign: "right" }}>{j ? fmt(j.qualified) : "—"}</td>
                                <td style={{ textAlign: "right" }}>{j ? fmt(j.deals) : "—"}</td>
                                <td style={{ textAlign: "right" }}>{j && j.leads > 0 ? money(r.cost / j.leads, r.currency) : "—"}</td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                      {!explorerRows.length && <tr><td colSpan={viewLevel === "campaign" ? 13 : 9} className="muted">No rows match the filters.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {explorerRows.length > 80 && <div className="chart-sub" style={{ marginTop: 8 }}>Showing the 80 highest-spending of {explorerRows.length} rows — narrow with the filters or search.</div>}
              </>
            )}
          </div>

          {/* ── Accounts that could not be read ─────────────────────────────── */}
          {data.failures.length > 0 && (
            <div className="chart-card" style={{ marginTop: 4 }}>
              <div className="chart-title">
                Accounts that could not be read ({data.failures.length}) <HelpTip text="Selected accounts that returned no data and why. Listed rather than silently omitted, because a missing account looks identical to a quiet one on the numbers above. Hover a reason for the raw response." />
              </div>
              {/* Says what the figures do: a failed refresh leaves the account's
                  already-cached days in every total, so "excluded" was untrue. */}
              <div className="chart-sub">
                Each still counts in every figure above with the days already cached, up to the date shown; later days are missing.
              </div>
              <div className="table-scroll">
                <table className="perf-table">
                  <thead><tr><th>Account</th><th>Platform</th><th>Shown to</th><th>Reason</th></tr></thead>
                  <tbody>
                    {data.failures.map((f) => (
                      <tr key={`${f.platform}|${f.accountId}`}>
                        <td>{f.accountName}</td>
                        <td className="muted">{PLATFORMS[f.platform].label}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{f.cachedTo ? bucketLabel(f.cachedTo, "day", false) : "nothing cached"}</td>
                        <td style={{ fontSize: 11, maxWidth: 520, whiteSpace: "normal" }} title={f.raw}>{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.failures.some((f) => f.notPrioritised) && (
                <div className="chart-sub" style={{ marginTop: 10 }}>
                  Supermetrics licenses a subset of ad accounts for querying — plans cap how many can be prioritised, so adding one
                  may mean swapping another out. Manage the list here and these accounts start loading on the next refresh:{" "}
                  {[...new Set(data.failures.filter((f) => f.notPrioritised).map((f) => f.platform))].map((p, i) => (
                    <span key={p}>
                      {i > 0 && " · "}
                      <a href={`${SUPERMETRICS_SUBSCRIPTION_URL}#datasource-${PLATFORMS[p].dsId}`} target="_blank" rel="noopener noreferrer">
                        {PLATFORMS[p].label} prioritised accounts
                      </a>
                    </span>
                  ))}
                </div>
              )}
              {data.failures.some((f) => f.authProblem) && (
                <div className="chart-sub" style={{ marginTop: 10 }}>
                  <strong>Configuration, not missing data:</strong> each platform needs the Supermetrics login that authorised it —
                  {[...new Set(data.failures.filter((f) => f.authProblem).map((f) => f.platform))].map((p) => (
                    <div key={p} style={{ marginTop: 4 }}>
                      <code style={{ background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>{PLATFORMS[p].dsUserEnv}</code> → {PLATFORMS[p].dsUserHint}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="chart-sub" style={{ marginTop: 14 }}>
            Sources: {data.accountsUsed.length} ad account{data.accountsUsed.length === 1 ? "" : "s"} with data via Supermetrics
            {data.emptyAccounts.length ? ` · ${data.emptyAccounts.length} read but quiet in range (${data.emptyAccounts.map((a) => a.name).join(", ")})` : ""}
            {data.failures.length ? ` · ${data.failures.length} unavailable` : ""}
            {" "}· lead funnel and campaign codes from Engage (Metabase), joined on utm_campaign, closed leads excluded · rates derived from raw totals.
          </div>
        </>
      )}
    </div>
  );
}

/** Keyed fragment so sibling groups of <tr>s can nest without extra DOM. */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * Placeholder mirroring the real layout — KPI strip, funnel, charts, table — so
 * the page keeps its shape while Supermetrics answers (up to ~25s per account).
 */
function DigitalSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading paid media data…">
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="kpi-card">
            <div className="skeleton sk-line short" />
            <div className="skeleton sk-big" />
          </div>
        ))}
      </div>
      <div className="chart-card" style={{ marginBottom: 16 }}>
        <div className="skeleton sk-line" style={{ width: "30%" }} />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr 170px", alignItems: "center", gap: 10, margin: "10px 0" }}>
            <div className="skeleton sk-line" style={{ margin: 0 }} />
            <div className="skeleton" style={{ height: 26, width: `${90 - i * 18}%` }} />
            <div className="skeleton sk-line short" style={{ margin: 0, justifySelf: "end" }} />
          </div>
        ))}
      </div>
      <div className="charts-grid-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="chart-card">
            <div className="skeleton sk-line" style={{ width: "40%" }} />
            <div className="skeleton sk-block" />
          </div>
        ))}
      </div>
      <div className="chart-card" style={{ marginTop: 4 }}>
        <div className="skeleton sk-line" style={{ width: "25%" }} />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton sk-line" style={{ width: `${95 - i * 6}%` }} />
        ))}
      </div>
    </div>
  );
}

function AccountRow({ acct, platform, checked, onToggle }: { acct: CatalogAccount; platform: PaidPlatform; checked: boolean; onToggle: () => void }) {
  const blocked = VERIFIED_BLOCKED[platform].includes(acct.id);
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span style={{ flex: 1 }}>
        {acct.name}
        {acct.disabled && <span className="muted" style={{ fontSize: 10 }}> · closed</span>}
        {acct.readOnly && <span className="muted" style={{ fontSize: 10 }}> · integration</span>}
        {blocked && (
          <span style={{ fontSize: 10, color: C.coral }} title="Verified: Supermetrics rejects this account as not prioritised on the subscription">
            {" "}· not licensed
          </span>
        )}
      </span>
    </label>
  );
}
