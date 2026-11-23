"use client";

// Company Performance — a live rebuild of the "Leads & deals by channel" report,
// reading the Engage CRM through Metabase instead of a static export.
//
// Only the BRAND filter refetches: it changes the SQL. Period, division, group-by
// and channel all slice the payload client-side, so they're instant.
//
// Portal economics (spend, cost per deal, revenue after portal expense, return on
// spend) are intentionally absent — the CRM holds no spend data.
import UpdatedAgo from "@/components/UpdatedAgo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { C, channelColor as colorOf } from "@/lib/theme";
import { errorMessage } from "@/lib/coerce";
import { daysInMonth } from "@/lib/dateRanges";
import { dayLabel, fmtAEDShort, fmtInt, fmtPct, MONTHS } from "@/lib/format";
import { liveUrl } from "@/lib/live";
import { useLiveRefresh } from "@/components/useLiveRefresh";
import { PageHeader } from "@/components/ui";
import type { Brand, CompanyDaily, CompanyData, DealDivision, LeadDivision } from "@/lib/company";

/* ── formatting (mirrors the report's fmt* helpers) ───────────────────────── */
const fmtCompact = (n: number) => {
  const a = Math.abs(n || 0);
  if (a >= 1e6) {
    const v = (n || 0) / 1e6;
    return `${v % 1 ? v.toFixed(1) : v.toFixed(0)}M`;
  }
  if (a >= 1e3) {
    const v = (n || 0) / 1e3;
    return `${v % 1 && a < 1e4 ? v.toFixed(1) : Math.round(v)}K`;
  }
  return `${Math.round(n || 0)}`;
};

/** "A, B and C". */
const listWords = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

/**
 * What each brand holds, from the CRM's divisions as this answer read them:
 * "Betterhomes combines the CRM divisions Betterhomes, Local, BH Elite and BH
 * Exclusive. Prime is reported separately." Empty when the divisions did not load.
 */
function brandsSentence(brands: Brand[]): string {
  const groups = brands.filter((b) => b.entities.length > 1).map((b) => `${b.label} combines the CRM divisions ${listWords(b.entities)}.`);
  const alone = brands.filter((b) => b.entities.length === 1).map((b) => b.label);
  return [...groups, alone.length ? `${listWords(alone)} ${alone.length === 1 ? "is" : "are"} reported separately.` : ""].filter(Boolean).join(" ");
}

// Each channel's colour comes from lib/theme.ts, shared with the Dashboard.

/**
 * Day figures with every source the month view doesn't show as a channel folded
 * into Other, so a day always adds up to its month: the day view names every
 * source, and only the month view knows which are big enough to stand alone.
 */
function foldDays(block: Record<string, Record<string, number[]>>, channels: string[]): Record<string, Record<string, number[]>> {
  const keep = new Set(channels);
  const out: Record<string, Record<string, number[]>> = {};
  for (const [dv, series] of Object.entries(block)) {
    const folded: Record<string, number[]> = {};
    for (const [ch, values] of Object.entries(series)) {
      const to = keep.has(ch) ? ch : "Other";
      folded[to] = folded[to] ? folded[to].map((v, i) => v + (values[i] ?? 0)) : [...values];
    }
    out[dv] = folded;
  }
  return out;
}

type DivKey = "All" | "Sales" | "Offplan" | "Secondary" | "Leasing";
const DIV_LABEL: Record<DivKey, string> = {
  All: "All",
  Sales: "Sales",
  Offplan: "Off-plan",
  Secondary: "Secondary",
  Leasing: "Leasing",
};

/**
 * Which stored divisions a filter selects. Leads are stored Sales/Leasing while
 * deals are stored Offplan/Secondary/Leasing, so an off-plan or secondary view
 * can only ever show ALL sales enquiries — nothing finer exists, because
 * enquiries carry no off-plan flag. Conversion is withheld for those two.
 */
function divsFor(d: DivKey): { leadDivs: LeadDivision[]; dealDivs: DealDivision[]; convValid: boolean } {
  switch (d) {
    case "Sales":
      return { leadDivs: ["Sales"], dealDivs: ["Offplan", "Secondary"], convValid: true };
    // Off-plan and secondary still show ALL sales enquiries — there's no finer
    // split available — but conversion is withheld, because dividing one slice
    // of sales deals by every sales lead would read as a real rate and isn't.
    case "Offplan":
      return { leadDivs: ["Sales"], dealDivs: ["Offplan"], convValid: false };
    case "Secondary":
      return { leadDivs: ["Sales"], dealDivs: ["Secondary"], convValid: false };
    case "Leasing":
      return { leadDivs: ["Leasing"], dealDivs: ["Leasing"], convValid: true };
    default:
      return { leadDivs: ["Sales", "Leasing"], dealDivs: ["Offplan", "Secondary", "Leasing"], convValid: true };
  }
}

const DIV_PHRASE: Record<DivKey, string> = {
  All: "sales & leasing",
  Sales: "sales",
  Offplan: "off-plan sales",
  Secondary: "secondary sales",
  Leasing: "leasing",
};

const GRAIN_NOUN: Record<GroupBy, string> = { month: "month", quarter: "quarter", year: "year" };

type GroupBy = "month" | "quarter" | "year";
const bucketOf = (month: string, g: GroupBy) => {
  const [y, m] = month.split("-");
  if (g === "year") return y;
  if (g === "quarter") return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
  return month;
};
/** "Jun ’25" / "Q2 ’25" / "2025" — the report's own bucket labels. */
const bucketLabel = (b: string, g: GroupBy) => {
  if (g === "year") return b;
  if (g === "quarter") {
    const [y, q] = b.split("-");
    return `${q} ’${y.slice(2)}`;
  }
  const [y, mo] = b.split("-");
  return `${MONTHS[Number(mo) - 1]} ’${y.slice(2)}`;
};

/** Months in each grain — how far back the matching month of the bucket before lies. */
const GRAIN_MONTHS: Record<GroupBy, number> = { month: 1, quarter: 3, year: 12 };
/** "YYYY-MM" moved by n months. */
const shiftMonth = (m: string, n: number) => {
  const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

/** Stands in for a chart whose figures failed to load, so a gap never draws as zeros. */
function Unavailable({ what }: { what: string }) {
  return (
    <div className="empty-state" style={{ fontSize: 12, color: C.mid, textAlign: "center", padding: 30 }}>
      {what} unavailable — see the note above.
    </div>
  );
}

/**
 * Shown while the brand filter refetches. Mirrors the real layout so the page
 * doesn't jump, and leaves the controls bar in place so the selection you just
 * made stays visible.
 */
function DataSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading figures…">
      <div className="kpi-strip cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="kpi-card">
            <div className="skeleton sk-line short" />
            <div className="skeleton sk-big" />
            <div className="skeleton sk-line" />
          </div>
        ))}
      </div>
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="skeleton sk-line" style={{ width: "34%" }} />
        <div className="skeleton sk-block" style={{ height: 300 }} />
      </div>
      <div className="charts-grid-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="chart-card">
            <div className="skeleton sk-line" style={{ width: "40%" }} />
            <div className="skeleton sk-block" style={{ height: 250 }} />
          </div>
        ))}
      </div>
      <div className="chart-card">
        <div className="skeleton sk-line" style={{ width: "26%" }} />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton sk-line" style={{ width: "100%", height: 14 }} />
        ))}
      </div>
    </div>
  );
}

export default function CompanyPerformance({ initial }: { initial: CompanyData }) {
  const [data, setData] = useState<CompanyData>(initial);
  const [loading, setLoading] = useState(false);
  const [brand, setBrand] = useState<string>("");

  const [period, setPeriod] = useState<string>("all"); // all | 2025 | 2026
  /** The division pills: everything, sales or leasing; under sales, which kinds of sale are ticked (one at least). */
  const [divPick, setDivPick] = useState<"All" | "Sales" | "Leasing">("All");
  const [saleKinds, setSaleKinds] = useState({ offplan: true, secondary: true });
  /** The pills and ticks as one of the divisions the figures are summed over. */
  const division: DivKey =
    divPick !== "Sales" ? divPick : saleKinds.offplan && saleKinds.secondary ? "Sales" : saleKinds.offplan ? "Offplan" : "Secondary";
  const [groupBy, setGroupBy] = useState<GroupBy>("month");
  const [channel, setChannel] = useState<string>("all");
  /** Which single bucket the KPI cards describe; "__all__" = the whole range. */
  /**
   * "" means "not chosen yet" and resolves to the latest bucket below — the
   * current month. Opening on the whole 19-month range answered a question
   * nobody had just asked; the month you are in is the one being managed.
   */
  const [bucket, setBucket] = useState<string>("");
  /**
   * Day-grain figures for the selected month. A failed fetch is stored too, as
   * the same month with no days — that resolves "loading" without pretending
   * there is daily data, so the charts fall back to bucket grain instead of
   * spinning forever.
   */
  const [daily, setDaily] = useState<CompanyDaily | null>(null);
  /** A "this month has no usable daily data" marker, so loading resolves. */
  const dailyMiss = (month: string, brand: string, error = "the daily figures did not load"): CompanyDaily => ({
    month,
    brand,
    days: [],
    channels: [],
    leads: { Sales: {}, Leasing: {} },
    deals: { Offplan: {}, Secondary: {}, Leasing: {} },
    comm: { Offplan: {}, Secondary: {}, Leasing: {} },
    error,
  });
  const [revShare, setRevShare] = useState(false);
  const [contribMetric, setContribMetric] = useState<"leads" | "deals" | "revenue">("revenue");
  /** A brand refetch that failed: which brand was asked for, and why it didn't come. */
  const [refreshError, setRefreshError] = useState<{ brand: string; message: string } | null>(null);

  /* ── brand filter is the only server round trip ─────────────────────────── */
  /** The newest request: a slower, older answer must not land over a newer pick. */
  const latest = useRef(0);
  /**
   * Fetch a brand's figures. A live ask (`live`) wants figures at most a minute
   * old and is quiet: no "updating", and a failure keeps what is shown without
   * a word, for the next turn to try again. It asks without dates, so after
   * midnight the range moves on to the new day by itself.
   */
  const load = useCallback(async (b: string, shown: string, live = false) => {
    const id = ++latest.current;
    if (!live) {
      setLoading(true);
      setRefreshError(null);
    }
    try {
      const qs = b ? `?brand=${encodeURIComponent(b)}` : "";
      const url = `/api/company${qs}`;
      const res = await fetch(live ? liveUrl(url) : url, { cache: "no-store" });
      // A function killed at its time limit answers with HTML, not JSON.
      const json = await res.json().catch(() => null);
      if (id !== latest.current) return;
      if (res.ok && json && Array.isArray(json.months)) {
        setData(json as CompanyData);
        return;
      }
      throw new Error(json?.error ?? `HTTP ${res.status}`);
    } catch (e) {
      if (id !== latest.current || live) return;
      // The dropdown moved before the fetch. Left there, it would put the new
      // brand's name on the previous brand's figures.
      console.error("[company] refresh failed", e);
      setBrand(shown);
      setRefreshError({ brand: b, message: errorMessage(e) });
    } finally {
      if (id === latest.current && !live) setLoading(false);
    }
  }, []);

  /** Changing brand fetches straight from the handler — no effect round trip. */
  const pickBrand = (next: string) => {
    setBrand(next);
    load(next, data.brand);
  };

  /** The latest figures for the brand on screen while the tab is open, as on Portals and Digital; held back while a pick is loading. */
  const updating = useLiveRefresh(data.cachedAt, () => load(data.brand, data.brand, true), !loading);

  const { months, channels } = data;
  const { leadDivs, dealDivs, convValid } = divsFor(division);
  /** The brand the figures on screen belong to. The dropdown moves first, so it can't say. */
  const shownBrand = data.brand;
  const brandLabel = (k: string) => (k ? (data.brands.find((b) => b.key === k)?.label ?? k.replace(/^entity:/, "")) : "All brands");
  // A failed aggregate is unknown, not zero: what it feeds reads "—".
  const noLeads = !!data.leadsError;
  const noDeals = !!data.dealsError;

  /** Years the payload covers, for the period buttons — a new year appears on its own. */
  const years = useMemo(() => [...new Set(months.map((m) => m.slice(0, 4)))], [months]);
  /** The year still running, labelled "to date"; none once the range ends on 31 Dec. */
  const ytdYear = data.to && !data.to.endsWith("-12-31") ? data.to.slice(0, 4) : "";

  /* ── month indices for the selected period ──────────────────────────────── */
  const idxs = useMemo(
    () => (period === "all" ? months.map((_, i) => i) : months.map((m, i) => (m.startsWith(period) ? i : -1)).filter((i) => i >= 0)),
    [months, period],
  );

  const activeChannels = channel === "all" ? channels : channels.filter((c) => c === channel);

  const byChannel = useCallback(
    (block: Record<string, Record<string, number[]>>, divs: string[], indices: number[]) => {
      const out: Record<string, number> = {};
      for (const c of channels) {
        let t = 0;
        for (const dv of divs) for (const i of indices) t += block[dv]?.[c]?.[i] ?? 0;
        out[c] = t;
      }
      return out;
    },
    [channels],
  );

  /* ── per-bucket series for the stacked charts ───────────────────────────── */
  const buckets = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, number[]>();
    for (const i of idxs) {
      const b = bucketOf(months[i], groupBy);
      if (!map.has(b)) {
        map.set(b, []);
        order.push(b);
      }
      map.get(b)!.push(i);
    }
    return { order, map };
  }, [idxs, months, groupBy]);

  /** A bucket selection stops being valid when the period or grain changes. */
  // "" resolves to the newest bucket, so the page opens on the current month.
  const latestBucket = buckets.order[buckets.order.length - 1] ?? "__all__";
  const effBucket = bucket === "" ? latestBucket : bucket === "__all__" || buckets.order.includes(bucket) ? bucket : "__all__";

  /**
   * Charts go day-by-day when a single MONTH is selected. Quarters and years
   * stay on their own grain — 90 or 365 bars is not a readable chart, and the
   * query would be the expensive one this deliberately avoids.
   */
  const dayMode = groupBy === "month" && effBucket !== "__all__";
  /**
   * The months the date filter picks: the month, quarter or year chosen under
   * "Showing", or the whole period. Every card, chart and table on the tab
   * follows them.
   */
  const windowIdxs = useMemo(() => (effBucket === "__all__" ? idxs : (buckets.map.get(effBucket) ?? idxs)), [effBucket, idxs, buckets]);
  /**
   * The bars the charts draw: across the whole period, one per month, quarter
   * or year; inside a chosen quarter or year, one per month. A chosen month is
   * drawn day by day, or as its one bar while its days are missing.
   */
  const bars = useMemo(
    () =>
      effBucket === "__all__"
        ? { order: buckets.order, map: buckets.map, grain: groupBy }
        : { order: windowIdxs.map((i) => months[i]), map: new Map(windowIdxs.map((i) => [months[i], [i]])), grain: "month" as GroupBy },
    [effBucket, buckets, windowIdxs, months, groupBy],
  );
  // Derived, not stored: a setState inside the effect would be a cascading
  // render, and "have I got this month yet" is already answerable from state.
  // Keyed on brand as well as month: keyed on month alone, picking a brand
  // left the charts on the previous brand's days.
  const dailyNow = dayMode && daily?.month === effBucket && daily?.brand === shownBrand ? daily : null;
  // Days that came back with an error are not drawn — the month's own bar is.
  const dailyReady = !!dailyNow && dailyNow.days.length > 0 && !dailyNow.error;
  const dailyLoading = dayMode && !dailyNow;
  const dailyError = dailyNow?.error ?? null;

  /** Per-bucket totals, honouring the division and channel filters. */
  const bSums = useMemo(() => {
    const sum = (block: Record<string, Record<string, number[]>>, divs: string[]) =>
      buckets.order.map((b) => {
        let t = 0;
        for (const dv of divs) for (const c of activeChannels) for (const i of buckets.map.get(b)!) t += block[dv]?.[c]?.[i] ?? 0;
        return t;
      });
    return {
      leads: sum(data.leads, leadDivs),
      deals: sum(data.deals, dealDivs),
      comm: sum(data.comm, dealDivs),
      salesDeals: sum(data.deals, ["Offplan", "Secondary"]),
    };
  }, [buckets, data, leadDivs, dealDivs, activeChannels]);

  /** One block summed over the given months, honouring the division and channel filters. */
  const sumIdx = useCallback(
    (block: Record<string, Record<string, number[]>>, divs: string[], indices: number[]) => {
      let t = 0;
      for (const dv of divs) for (const c of activeChannels) for (const i of indices) t += block[dv]?.[c]?.[i] ?? 0;
      return t;
    },
    [activeChannels],
  );

  /** "Jan 2025 – Jul 2026" · "full year 2025" · "Jan – Jul 2026" */
  const rangeText = useMemo(() => {
    if (!idxs.length) return "";
    const f = months[idxs[0]];
    const l = months[idxs[idxs.length - 1]];
    const nice = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
    if (f === l) return nice(f);
    if (f.slice(0, 4) === l.slice(0, 4)) {
      if (f.endsWith("-01") && l.endsWith("-12")) return `full year ${f.slice(0, 4)}`;
      return `${MONTHS[Number(f.slice(5, 7)) - 1]} – ${nice(l)}`;
    }
    return `${nice(f)} – ${nice(l)}`;
  }, [idxs, months]);

  /** The window as words: "Oct 2026", "Q3 2026", or the whole period's range. */
  const windowLabel = effBucket === "__all__" ? rangeText : bucketLabel(effBucket, groupBy);

  const lastMonthIdx = months.length - 1;
  const toPretty = data.to ? `${Number(data.to.slice(8, 10))} ${MONTHS[Number(data.to.slice(5, 7)) - 1]}` : "";

  type Kpi = { label: string; value: string; cur: number | null; prev: number | null; note: string };

  /**
   * The cards describe ONE bucket (or the whole range) with the change against
   * the bucket before it — the same shape as the report they replace.
   */
  const { cap, items, vs, noCmp } = useMemo(() => {
    const gname = GRAIN_NOUN[groupBy];
    const totL = bSums.leads.reduce((a, b) => a + b, 0);
    const totD = bSums.deals.reduce((a, b) => a + b, 0);
    const totC = bSums.comm.reduce((a, b) => a + b, 0);
    const totDS = bSums.salesDeals.reduce((a, b) => a + b, 0);

    let out: Kpi[];
    let caption: string;
    /** The bucket before, as the cards weigh this one against it. */
    let prev: { leads: number; deals: number; comm: number; salesDeals: number } | null = null;
    /** What the change is measured against: "previous month", "1–20 Sep", … */
    let against = "";
    /** Said instead of a change when there is nothing fair to compare with. */
    let noCompare = "";

    if (effBucket === "__all__") {
      caption = `Entire period — ${rangeText}`;
      out = [
        { label: "Leads received", value: fmtInt(totL), cur: null, prev: null, note: `sum of every ${gname} in range` },
        { label: "Deals reserved", value: fmtInt(totD), cur: null, prev: null, note: `sum of every ${gname} in range` },
        { label: "Conversion", value: fmtPct(totL ? totD / totL : null, 2), cur: null, prev: null, note: "deals ÷ leads over the range" },
        { label: "Gross commission", value: fmtAEDShort(totC), cur: null, prev: null, note: "final gross commission, whole range" },
      ];
    } else {
      const bi = buckets.order.indexOf(effBucket);
      const pi = bi - 1;
      const inProgress = buckets.map.get(effBucket)?.includes(lastMonthIdx) ?? false;
      if (pi < 0) noCompare = `no previous ${gname} in range`;
      else if (!inProgress) {
        prev = { leads: bSums.leads[pi], deals: bSums.deals[pi], comm: bSums.comm[pi], salesDeals: bSums.salesDeals[pi] };
        against = `previous ${gname}`;
      } else {
        // In progress: the bucket before is cut to the same point — its whole
        // months up to the matching one, then that month's 1st to data.mtdDay.
        // On 20 Oct 2026, against the whole of September, October read deals
        // ▼53% and commission ▼27% when like-for-like they were ▼22% and ▲10%.
        // When the bucket before doesn't hold every month up to that point, no
        // change is shown at all.
        const aligned = shiftMonth(months[lastMonthIdx], -GRAIN_MONTHS[groupBy]);
        const k = months.indexOf(aligned);
        const prevIdx = buckets.map.get(buckets.order[pi]) ?? [];
        const before = prevIdx.filter((i) => i < k);
        const whole = prevIdx.includes(k) && before.length === (Number(aligned.slice(5, 7)) - 1) % GRAIN_MONTHS[groupBy];
        if (whole && data.leadsMtd) {
          const like = (block: Record<string, Record<string, number[]>>, mtd: Record<string, Record<string, number[]>>, divs: string[]) =>
            sumIdx(block, divs, before) + sumIdx(mtd, divs, [k]);
          prev = {
            leads: like(data.leads, data.leadsMtd, leadDivs),
            deals: like(data.deals, data.dealsMtd, dealDivs),
            comm: like(data.comm, data.commMtd, dealDivs),
            salesDeals: like(data.deals, data.dealsMtd, ["Offplan", "Secondary"]),
          };
          const upTo = `${Math.min(data.mtdDay, daysInMonth(aligned))} ${MONTHS[Number(aligned.slice(5, 7)) - 1]}`;
          against = groupBy === "month" ? `1–${upTo}` : `${bucketLabel(buckets.order[pi], groupBy)} to ${upTo}`;
        } else noCompare = "in progress — no like-for-like comparison";
      }
      const convCur = bSums.leads[bi] ? bSums.deals[bi] / bSums.leads[bi] : null;
      const convPrev = prev && prev.leads ? prev.deals / prev.leads : null;
      caption =
        `${gname[0].toUpperCase()}${gname.slice(1)} — ${bucketLabel(effBucket, groupBy)}` +
        (inProgress ? ` (in progress: to ${toPretty})` : "") +
        (against ? ` · change vs ${inProgress ? against : bucketLabel(buckets.order[pi], groupBy)}` : "");
      out = [
        { label: "Leads received", value: fmtInt(bSums.leads[bi]), cur: bSums.leads[bi], prev: prev?.leads ?? null, note: `Total ${rangeText}: ${fmtInt(totL)}` },
        { label: "Deals reserved", value: fmtInt(bSums.deals[bi]), cur: bSums.deals[bi], prev: prev?.deals ?? null, note: `Total ${rangeText}: ${fmtInt(totD)}` },
        { label: "Conversion", value: fmtPct(convCur, 2), cur: convCur, prev: convPrev, note: `Range average: ${fmtPct(totL ? totD / totL : null, 2)}` },
        { label: "Gross commission", value: fmtAEDShort(bSums.comm[bi]), cur: bSums.comm[bi], prev: prev?.comm ?? null, note: `Total ${rangeText}: ${fmtAEDShort(totC)}` },
      ];
    }
    if (channel !== "all") caption += ` · ${channel}`;

    // "No Source" collects deals that never had a lead, so a rate is nonsense.
    if (channel === "No Source" && convValid) {
      out[2] = { label: "Conversion", value: "—", cur: null, prev: null, note: "not meaningful — deals without a linked lead sit here" };
    }

    // Off-plan / secondary have no lead split, so show share + average instead.
    if (!convValid) {
      const dvName = division === "Offplan" ? "off-plan" : "secondary";
      if (effBucket === "__all__") {
        out[0] = { label: "Share of sales deals", value: fmtPct(totDS ? totD / totDS : null, 1), cur: null, prev: null, note: `${dvName} deals ÷ all sales deals, whole range` };
        out[2] = { label: "Avg commission / deal", value: totD ? fmtAEDShort(totC / totD) : "—", cur: null, prev: null, note: `gross commission ÷ ${dvName} deals` };
      } else {
        const bi = buckets.order.indexOf(effBucket);
        const shareCur = bSums.salesDeals[bi] ? bSums.deals[bi] / bSums.salesDeals[bi] : null;
        const sharePrev = prev && prev.salesDeals ? prev.deals / prev.salesDeals : null;
        const avgCur = bSums.deals[bi] ? bSums.comm[bi] / bSums.deals[bi] : null;
        const avgPrev = prev && prev.deals ? prev.comm / prev.deals : null;
        out[0] = { label: "Share of sales deals", value: fmtPct(shareCur, 1), cur: shareCur, prev: sharePrev, note: `Range: ${fmtPct(totDS ? totD / totDS : null, 1)} of sales deals` };
        out[2] = { label: "Avg commission / deal", value: avgCur != null ? fmtAEDShort(avgCur) : "—", cur: avgCur, prev: avgPrev, note: `Range average: ${totD ? fmtAEDShort(totC / totD) : "—"}` };
      }
    }

    // A failed aggregate is unknown, not zero: its cards read "—", with no change.
    const blank = (k: Kpi): Kpi => ({ ...k, value: "—", cur: null, prev: null, note: "unavailable — see the note above" });
    if (noDeals) out = out.map((k, i) => (i === 0 && convValid ? k : blank(k)));
    if (noLeads && convValid) out = [blank(out[0]), out[1], blank(out[2]), out[3]];

    return { cap: caption, items: out, vs: against, noCmp: noCompare };
  }, [bSums, buckets, effBucket, groupBy, rangeText, channel, convValid, division, lastMonthIdx, toPretty, months, data, sumIdx, leadDivs, dealDivs, noLeads, noDeals]);

  /**
   * Fetch day grain for the selected month. Straight from a handler would be
   * neater, but the selection also moves when groupBy or the period changes, so
   * it has to react to the resolved bucket rather than to one control.
   */
  /** The figures the shown days were fetched beside: when those are refreshed, the days are asked for their latest too. */
  const dailyFor = useRef("");
  useEffect(() => {
    if (!dayMode) return;
    const same = daily?.month === effBucket && daily?.brand === shownBrand;
    if (same && dailyFor.current === data.generatedAt) return;
    let current = true;
    const month = effBucket;
    // The brand of the figures on screen, not the dropdown's: a failed brand
    // refetch puts the dropdown back, and the days must match the cards.
    const forBrand = shownBrand;
    const generated = data.generatedAt;
    const qs = new URLSearchParams({ month });
    if (forBrand) qs.set("brand", forBrand);
    const url = `/api/company/daily?${qs}`;
    // The same month again means the figures above were refreshed: ask for the latest days as well.
    fetch(same ? liveUrl(url) : url, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!current) return;
        dailyFor.current = generated;
        // Record the month either way. Without the failure case the charts would
        // report "loading daily…" for as long as the page stayed open. A refresh
        // that fails keeps the days shown.
        if (Array.isArray(j?.days)) setDaily({ ...(j as CompanyDaily), brand: forBrand });
        else if (!same) setDaily(dailyMiss(month, forBrand, j?.error));
      })
      .catch(() => {
        if (!current) return;
        dailyFor.current = generated;
        if (!same) setDaily(dailyMiss(month, forBrand));
      });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayMode, effBucket, shownBrand, data.generatedAt]);

  /** The day figures, folded to the month view's channels. */
  const days = useMemo(
    () => (daily ? { leads: foldDays(daily.leads, channels), deals: foldDays(daily.deals, channels), comm: foldDays(daily.comm, channels) } : null),
    [daily, channels],
  );

  const stack = useCallback(
    (block: Record<string, Record<string, number[]>>, divs: string[], dayBlock?: Record<string, Record<string, number[]>>) =>
      activeChannels.map((c) => ({
        label: c,
        // One point per day of the selected month, else one per bucket.
        data: dailyReady && dayBlock
          ? (daily?.days ?? []).map((_, i) => {
              let t = 0;
              for (const dv of divs) t += dayBlock[dv]?.[c]?.[i] ?? 0;
              return t;
            })
          : bars.order.map((b) => {
              let t = 0;
              for (const dv of divs) for (const i of bars.map.get(b)!) t += block[dv]?.[c]?.[i] ?? 0;
              return t;
            }),
        backgroundColor: colorOf(c, channels),
        borderWidth: 0,
      })),
    [activeChannels, bars, dailyReady, daily, channels],
  );

  /** X labels: days of the month when in day mode, otherwise the bars. */
  const chartLabels = dailyReady
    ? (daily?.days ?? []).map((d) => String(Number(d.slice(8, 10))))
    : bars.order.map((b) => bucketLabel(b, bars.grain));

  /** Appended to each chart's subtitle so the grain on screen is never a guess. */
  const grainNote = dailyReady
    ? `daily · ${bucketLabel(effBucket, groupBy)}`
    : dayMode && dailyLoading
      ? "loading daily…"
      : effBucket === "__all__"
        ? `by ${groupBy}`
        : `by month · ${windowLabel}`;

  /**
   * A stacked chart's options. `title` heads each bar's tooltip: its date and
   * its commission, so every bar says what it earned whatever it counts. A
   * channel with nothing on that bar is left out of the list under it.
   */
  const stackedOpts = (money = false, pct = false, title?: (i: number) => string) => ({
    responsive: true,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: { position: "bottom" as const, labels: { boxWidth: 10, font: { size: 10 }, padding: 10 } },
      tooltip: {
        filter: (item: any) => Number(item.raw) !== 0,
        callbacks: {
          ...(title ? { title: (items: any[]) => title(items[0]?.dataIndex ?? 0) } : {}),
          label: (ctx: any) =>
            `${ctx.dataset.label}: ${pct ? `${Number(ctx.raw).toFixed(1)}%` : money ? fmtAEDShort(Number(ctx.raw)) : fmtInt(Number(ctx.raw))}`,
        },
      },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
      y: {
        stacked: true,
        beginAtZero: true,
        max: pct ? 100 : undefined,
        grid: { color: C.border },
        ticks: { font: { size: 10 }, callback: (v: any) => (pct ? `${v}%` : money ? fmtCompact(Number(v)) : fmtCompact(Number(v))) },
      },
    },
  });

  const toPercent = (datasets: any[]) => {
    const n = datasets[0]?.data.length ?? 0;
    const tot = new Array(n).fill(0);
    for (const ds of datasets) ds.data.forEach((v: number, i: number) => (tot[i] += v));
    return datasets.map((ds) => ({ ...ds, data: ds.data.map((v: number, i: number) => (tot[i] ? (v / tot[i]) * 100 : 0)) }));
  };

  /** Commission by channel, in dirhams whatever the revenue chart shows: every tooltip's total comes from here. */
  const commDatasets = useMemo(() => stack(data.comm, dealDivs, days?.comm), [stack, data.comm, dealDivs, days]);
  const revDatasets = useMemo(() => (revShare ? toPercent(commDatasets) : commDatasets), [commDatasets, revShare]);

  const leadDatasets = useMemo(() => stack(data.leads, leadDivs, days?.leads), [stack, data.leads, leadDivs, days]);
  const dealDatasets = useMemo(() => stack(data.deals, dealDivs, days?.deals), [stack, data.deals, dealDivs, days]);

  /** A bar's figure added up across its channels. */
  const barTotal = (sets: { data: number[] }[], i: number) => sets.reduce((t, d) => t + (d.data[i] ?? 0), 0);
  /** A bar as words: "18 Nov" for a day, "Oct ’26" for a month, "Q3 ’26" for a quarter. */
  const barName = (i: number) => {
    if (dailyReady) {
      const d = daily?.days[i] ?? "";
      return d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : "";
    }
    return bucketLabel(bars.order[i] ?? "", bars.grain);
  };
  const commOn = (i: number) => (noDeals ? "commission unavailable" : `${fmtAEDShort(barTotal(commDatasets, i))} commission`);
  const revTitle = (i: number) => `${barName(i)} · ${commOn(i)}`;
  const leadTitle = (i: number) => `${barName(i)} · ${fmtInt(barTotal(leadDatasets, i))} leads · ${commOn(i)}`;
  const dealTitle = (i: number) => `${barName(i)} · ${fmtInt(barTotal(dealDatasets, i))} deals · ${commOn(i)}`;

  /* ── channel summary ───────────────────────────────────────────────────── */
  const summary = useMemo(() => {
    const L = byChannel(data.leads, leadDivs, windowIdxs);
    const D = byChannel(data.deals, dealDivs, windowIdxs);
    const R = byChannel(data.comm, dealDivs, windowIdxs);
    const tL = Object.values(L).reduce((a, b) => a + b, 0);
    const tD = Object.values(D).reduce((a, b) => a + b, 0);
    const tR = Object.values(R).reduce((a, b) => a + b, 0);
    return channels
      .map((c) => {
        // "No Source" deals include those with no linked lead at all, so a
        // conversion rate for that row isn't meaningful.
        const conv = convValid && c !== "No Source" && L[c] > 0 ? D[c] / L[c] : null;
        return {
          channel: c,
          leads: L[c],
          deals: D[c],
          conv,
          revenue: R[c],
          revPct: tR ? R[c] / tR : 0,
          avgComm: D[c] ? R[c] / D[c] : 0,
          leadPct: tL ? L[c] / tL : 0,
          dealPct: tD ? D[c] / tD : 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }, [data, channels, leadDivs, dealDivs, windowIdxs, byChannel, convValid]);

  const convRows = useMemo(
    () => summary.filter((r) => r.conv != null).sort((a, b) => (b.conv ?? 0) - (a.conv ?? 0)),
    [summary],
  );

  const contribDatasets = useMemo(() => {
    const block = contribMetric === "leads" ? data.leads : contribMetric === "deals" ? data.deals : data.comm;
    const dayBlock = contribMetric === "leads" ? days?.leads : contribMetric === "deals" ? days?.deals : days?.comm;
    const divs = contribMetric === "leads" ? leadDivs : dealDivs;
    return toPercent(stack(block, divs, dayBlock));
  }, [contribMetric, data, leadDivs, dealDivs, stack, days]);

  /* ── full data table + CSV: the window's months, every division and channel ─── */
  const fullRows = useMemo(() => {
    const rows: { month: string; channel: string; division: string; leads: number | ""; deals: number; revenue: number }[] = [];
    for (const i of windowIdxs) {
      for (const c of channels) {
        for (const dv of ["Offplan", "Secondary", "Leasing"] as DealDivision[]) {
          const deals = data.deals[dv]?.[c]?.[i] ?? 0;
          const revenue = data.comm[dv]?.[c]?.[i] ?? 0;
          // leads only exist as Sales / Leasing
          const leadDv: LeadDivision | null = dv === "Leasing" ? "Leasing" : null;
          const leads = leadDv ? (data.leads[leadDv]?.[c]?.[i] ?? 0) : "";
          if (!deals && !revenue && leads === "") continue;
          rows.push({ month: months[i], channel: c, division: DIV_LABEL[dv], leads, deals, revenue });
        }
      }
      // sales-side leads have no off-plan/secondary split, so they get their own row
      for (const c of channels) {
        const leads = data.leads.Sales?.[c]?.[i] ?? 0;
        if (leads) rows.push({ month: months[i], channel: c, division: "Sales (leads only)", leads, deals: 0, revenue: 0 });
      }
    }
    return rows;
  }, [windowIdxs, months, channels, data]);

  const downloadCsv = () => {
    const head = ["Month", "Channel", "Division", "Leads", "Deals", "Gross commission (AED)"];
    // A failed aggregate exports as empty cells, never as zeros.
    const body = fullRows.map((r) => [
      r.month,
      r.channel,
      r.division,
      r.leads === "" || noLeads ? "" : r.leads,
      noDeals ? "" : r.deals,
      noDeals ? "" : Math.round(r.revenue),
    ]);
    const csv = [head, ...body].map((r) => r.map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v)).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    // The file is brand-filtered like the table, so its name says which brand.
    const brandSlug = brandLabel(shownBrand).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    a.download = `company-performance-${brandSlug}-${months[windowIdxs[0]] ?? data.from}-to-${months[windowIdxs[windowIdxs.length - 1]] ?? data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const notConnected = !data.connected;

  return (
    <>
      <PageHeader
        title="Company Performance"
        sub={
          <>
            Leads, deals and revenue by channel · {windowLabel} · from the Engage CRM
            {loading || updating ? " · updating…" : <UpdatedAgo at={data.cachedAt} />}
          </>
        }
      />

      {notConnected ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: "auto", padding: "26px 20px", display: "block", textAlign: "center" }}>
            <div style={{ fontWeight: 600, color: C.dark, marginBottom: 8 }}>Metabase not connected</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.8 }}>
              Add to the deployment environment, then refresh:
              <br />
              {["METABASE_URL", "METABASE_USERNAME", "METABASE_PASSWORD"].map((l) => (
                <code key={l} style={{ display: "inline-block", margin: "2px 4px", background: "var(--warm-white)", padding: "1px 6px", borderRadius: 4 }}>
                  {l}
                </code>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Whatever didn't load is said here, so a gap never reads as a zero. */}
          {refreshError || data.error || dailyError ? (
            <div className="chart-card" style={{ marginBottom: 18, borderColor: C.amber }}>
              {refreshError ? (
                <>
                  <div style={{ fontSize: 12, color: C.amber, fontWeight: 600 }}>Brand not changed</div>
                  <div style={{ fontSize: 12, color: C.mid, marginTop: 4 }}>
                    Couldn&apos;t load {brandLabel(refreshError.brand)} ({refreshError.message}) — still showing {brandLabel(shownBrand)}.
                  </div>
                </>
              ) : null}
              {data.error || dailyError ? (
                <div style={{ fontSize: 12, color: C.amber, fontWeight: 600, marginTop: refreshError ? 10 : 0 }}>Partial data</div>
              ) : null}
              {data.error ? <div style={{ fontSize: 12, color: C.mid, marginTop: 4 }}>{data.error}</div> : null}
              {dailyError ? (
                <div style={{ fontSize: 12, color: C.mid, marginTop: 4 }}>
                  Daily figures for {bucketLabel(effBucket, groupBy)} unavailable ({dailyError}) — the charts show the month as one bar.
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── controls ──────────────────────────────────────────────────── */}
          <div className="controls-bar">
            <div className="field">
              <label>
                Period{" "}
                <HelpTip text={`From ${dayLabel(data.from)}. The cards compare the chosen month, quarter or year with the one before it. One still in progress is compared with the one before cut at the same point — for a month the same days (1–20 Oct with 1–20 Sep), for a quarter or year the same months and days — never with the whole of it.`} />
              </label>
              <div className="ps-platforms">
                {[["all", "All"], ...years.map((y) => [y, y === ytdYear ? `${y} YTD` : y])].map(([v, l]) => (
                  <button key={v} className={`filter-btn${period === v ? " active" : ""}`} onClick={() => setPeriod(v)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Division <HelpTip text="Sales covers off-plan and secondary: pick Sales, then tick either or both. Deals split Sale vs Rent as recorded in the CRM, and a sale is off-plan when its linked property is flagged “Off Plan”. Enquiries carry no off-plan flag, so with one kind of sale ticked the lead counts are every sales enquiry and conversion is not shown." /></label>
              <div className="ps-platforms">
                {(["All", "Sales", "Leasing"] as const).map((d) => (
                  <button key={d} className={`filter-btn${divPick === d ? " active" : ""}`} onClick={() => setDivPick(d)}>
                    {DIV_LABEL[d]}
                  </button>
                ))}
                {divPick === "Sales"
                  ? (["offplan", "secondary"] as const).map((k) => {
                      const on = saleKinds[k];
                      const last = on && !saleKinds[k === "offplan" ? "secondary" : "offplan"];
                      const name = k === "offplan" ? DIV_LABEL.Offplan : DIV_LABEL.Secondary;
                      return (
                        <label key={k} className={`filter-btn tick-pick${on ? " active" : ""}`} title={last ? "One kind of sale stays ticked" : undefined}>
                          <input type="checkbox" aria-label={name} checked={on} disabled={last} onChange={() => setSaleKinds((o) => ({ ...o, [k]: !o[k] }))} />
                          {name}
                        </label>
                      );
                    })
                  : null}
              </div>
            </div>

            <div className="field">
              <label>Group by</label>
              <div className="ps-platforms">
                {(["month", "quarter", "year"] as GroupBy[]).map((g) => (
                  <button key={g} className={`filter-btn${groupBy === g ? " active" : ""}`} onClick={() => setGroupBy(g)}>
                    {g[0].toUpperCase() + g.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>
                Brand{" "}
                <HelpTip text={`${brandsSentence(data.brands)} Changing this refetches from the CRM.`.trim()} />
              </label>
              <select className="ps-select" value={brand} onChange={(e) => pickBrand(e.target.value)} disabled={loading}>
                <option value="">All brands</option>
                {data.brands.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Channel</label>
              <select className="ps-select" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="all">All channels</option>
                {channels.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>
                Showing{" "}
                <HelpTip text="The dates the whole tab shows: the cards, the charts and the tables. Pick a month, quarter or year to see it against the one before it; “Entire period” shows the whole range instead." />
              </label>
              <select className="ps-select" aria-label="Showing" value={effBucket} onChange={(e) => setBucket(e.target.value)}>
                <option value="__all__">Entire period ({rangeText})</option>
                {buckets.order
                  .slice()
                  .reverse()
                  .map((b) => (
                    <option key={b} value={b}>
                      {bucketLabel(b, groupBy)}
                      {buckets.map.get(b)?.includes(lastMonthIdx) ? " (in progress)" : ""}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {/* what the page is currently showing */}
          <div style={{ fontSize: 11.5, color: C.mid, marginTop: -8, marginBottom: 10 }}>
            Showing: {period === "all" ? "All" : period === ytdYear ? `${period} to date` : period} · {DIV_PHRASE[division]} · by{" "}
            {groupBy} · {effBucket === "__all__" ? "entire period" : bucketLabel(effBucket, groupBy)} ·{" "}
            {channel === "all" ? "all channels" : channel}
            {data.generatedAt ? (
              // formatted in the viewer's locale, so server and client text differ by design
              <span suppressHydrationWarning> — updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: C.sage,
              marginBottom: 10,
            }}
          >
            {cap}
          </div>

          {loading ? (
            <DataSkeleton />
          ) : (
          <>
          {/* ── KPIs — one bucket, change vs the previous one ─────────────── */}
          <div className="kpi-strip cols-4">
            {items.map((it) => {
              const hasPrev = it.cur !== null && it.prev !== null && it.prev !== 0 && Number.isFinite(it.prev);
              const ch = hasPrev ? (it.cur! - it.prev!) / it.prev! : 0;
              const up = hasPrev && ch >= 0.0005;
              const down = hasPrev && ch <= -0.0005;
              return (
                <div className="kpi-card" key={it.label}>
                  <div className="kpi-label">{it.label}</div>
                  <div className="kpi-value" style={it.label === "Gross commission" ? { color: C.green } : undefined}>
                    {it.value}
                  </div>
                  {it.cur !== null ? (
                    <div className="kpi-change" style={{ color: up ? C.green : down ? C.red : C.mid }}>
                      {hasPrev
                        ? `${up ? "\u25b2" : down ? "\u25bc" : "\u00b7"} ${Math.abs(ch * 100).toFixed(1)}% vs ${vs}`
                        : it.prev === 0
                          ? `${vs[0].toUpperCase()}${vs.slice(1)} was 0`
                          : noCmp || `no rate for ${vs}`}
                    </div>
                  ) : null}
                  <div style={{ fontSize: 11, color: C.mid, marginTop: 4 }}>{it.note}</div>
                </div>
              );
            })}
          </div>

          {/* ── revenue contribution ──────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div className="chart-title">Revenue contribution by channel</div>
                <div className="chart-sub">Gross commission, AED · {grainNote}</div>
              </div>
              <div className="ps-platforms">
                <button className={`filter-btn${!revShare ? " active" : ""}`} onClick={() => setRevShare(false)}>AED</button>
                <button className={`filter-btn${revShare ? " active" : ""}`} onClick={() => setRevShare(true)}>% share</button>
              </div>
            </div>
            <div className="chart-canvas-wrap" style={{ height: 320 }}>
              {noDeals ? (
                <Unavailable what="Revenue" />
              ) : (
                <ChartBox
                  type="bar"
                  data={{ labels: chartLabels, datasets: revDatasets }}
                  options={stackedOpts(!revShare, revShare, revTitle)}
                />
              )}
            </div>
          </div>

          {/* ── leads + deals ─────────────────────────────────────────────── */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Leads by channel</div>
              <div className="chart-sub">
                {convValid
                  ? `Enquiries received, ${grainNote} · ${DIV_PHRASE[division]}`
                  : `All sales enquiries, ${grainNote} — enquiries are not classified by sales type`}
              </div>
              <div className="chart-canvas-wrap" style={{ height: 280 }}>
                {noLeads ? (
                  <Unavailable what="Lead figures" />
                ) : (
                  <ChartBox
                    type="bar"
                    data={{ labels: chartLabels, datasets: leadDatasets }}
                    options={stackedOpts(false, false, leadTitle)}
                  />
                )}
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-title">Deals by channel</div>
              <div className="chart-sub">Reservations + completions · {dealDivs.map((d) => DIV_LABEL[d]).join(" + ")}</div>
              <div className="chart-canvas-wrap" style={{ height: 280 }}>
                {noDeals ? (
                  <Unavailable what="Deal figures" />
                ) : (
                  <ChartBox
                    type="bar"
                    data={{ labels: chartLabels, datasets: dealDatasets }}
                    options={stackedOpts(false, false, dealTitle)}
                  />
                )}
              </div>
            </div>
          </div>

          {/* ── conversion by channel ─────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-title">Conversion rate by channel</div>
            <div className="chart-sub">Deals ÷ leads · {windowLabel}</div>
            <div className="chart-canvas-wrap" style={{ height: Math.max(180, convRows.length * 34) }}>
              {noLeads || noDeals ? (
                <Unavailable what="Conversion" />
              ) : convRows.length ? (
                <ChartBox
                  type="bar"
                  data={{
                    labels: convRows.map((r) => r.channel),
                    datasets: [
                      {
                        label: "Conversion",
                        data: convRows.map((r) => (r.conv ?? 0) * 100),
                        backgroundColor: convRows.map((r) => colorOf(r.channel, channels)),
                        borderWidth: 0,
                      },
                    ],
                  }}
                  options={{
                    indexAxis: "y" as const,
                    responsive: true,
                    plugins: {
                      legend: { display: false },
                      tooltip: {
                        callbacks: {
                          title: (items: any[]) => {
                            const r = convRows[items[0]?.dataIndex ?? 0];
                            return r ? `${r.channel} · ${fmtAEDShort(r.revenue)} commission` : "";
                          },
                          label: (ctx: any) => {
                            const r = convRows[ctx.dataIndex];
                            return `${Number(ctx.raw).toFixed(2)}%${r ? ` · ${fmtInt(r.deals)} deals from ${fmtInt(r.leads)} leads` : ""}`;
                          },
                        },
                      },
                    },
                    scales: {
                      x: { beginAtZero: true, grid: { color: C.border }, ticks: { font: { size: 10 }, callback: (v: any) => `${v}%` } },
                      y: { grid: { display: false }, ticks: { font: { size: 10 }, autoSkip: false } },
                    },
                  }}
                />
              ) : (
                <div className="empty-state" style={{ fontSize: 12, color: C.mid, textAlign: "center", padding: 30 }}>
                  Conversion isn&apos;t available for this division.
                </div>
              )}
            </div>
          </div>

          {/* ── channel summary ──────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-title">Channel summary</div>
            <div className="chart-sub">{windowLabel} · sorted by revenue</div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th style={{ textAlign: "right" }}>Leads</th>
                    <th style={{ textAlign: "right" }}>Deals</th>
                    <th style={{ textAlign: "right" }}>Conversion</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
                    <th style={{ textAlign: "right" }}>Revenue %</th>
                    <th style={{ textAlign: "right" }}>Avg comm/deal</th>
                    <th style={{ textAlign: "right" }}>Lead %</th>
                    <th style={{ textAlign: "right" }}>Deal %</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((r) => (
                    <tr key={r.channel}>
                      <td>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: colorOf(r.channel, channels),
                            marginRight: 8,
                          }}
                        />
                        {r.channel}
                      </td>
                      <td style={{ textAlign: "right" }}>{leadDivs.length && !noLeads ? fmtInt(r.leads) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{noDeals ? "—" : fmtInt(r.deals)}</td>
                      <td style={{ textAlign: "right" }}>{noLeads || noDeals ? "—" : fmtPct(r.conv, 2)}</td>
                      <td style={{ textAlign: "right" }}>{noDeals ? "—" : fmtAEDShort(r.revenue)}</td>
                      <td style={{ textAlign: "right" }}>{noDeals ? "—" : fmtPct(r.revPct)}</td>
                      <td style={{ textAlign: "right" }}>{noDeals ? "—" : fmtAEDShort(r.avgComm)}</td>
                      <td style={{ textAlign: "right" }}>{leadDivs.length && !noLeads ? fmtPct(r.leadPct) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{noDeals ? "—" : fmtPct(r.dealPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── contribution % ───────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div className="chart-title">Channel contribution</div>
                <div className="chart-sub">Share of total, {grainNote}</div>
              </div>
              <div className="ps-platforms">
                {(["leads", "deals", "revenue"] as const).map((m) => (
                  <button
                    key={m}
                    className={`filter-btn${contribMetric === m ? " active" : ""}`}
                    onClick={() => setContribMetric(m)}
                    disabled={m === "leads" && !leadDivs.length}
                  >
                    {m[0].toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="chart-canvas-wrap" style={{ height: 300 }}>
              {(contribMetric === "leads" ? noLeads : noDeals) ? (
                <Unavailable what={contribMetric === "leads" ? "Lead figures" : contribMetric === "deals" ? "Deal figures" : "Revenue"} />
              ) : (
                <ChartBox
                  type="bar"
                  data={{ labels: chartLabels, datasets: contribDatasets }}
                  options={stackedOpts(false, true, revTitle)}
                />
              )}
            </div>
          </div>

          {/* ── full data ────────────────────────────────────────────────── */}
          <div className="chart-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div className="chart-title">Full data</div>
                <div className="chart-sub">
                  Every month, division and channel for {brandLabel(shownBrand)} in {windowLabel} — the division and channel filters
                  above don&apos;t apply
                </div>
              </div>
              <button className="filter-btn" onClick={downloadCsv}>Download CSV</button>
            </div>
            <div className="table-scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Channel</th>
                    <th>Division</th>
                    <th style={{ textAlign: "right" }}>Leads</th>
                    <th style={{ textAlign: "right" }}>Deals</th>
                    <th style={{ textAlign: "right" }}>Gross commission</th>
                  </tr>
                </thead>
                <tbody>
                  {fullRows.map((r, i) => (
                    <tr key={`${r.month}-${r.channel}-${r.division}-${i}`}>
                      <td>{r.month}</td>
                      <td>{r.channel}</td>
                      <td>{r.division}</td>
                      <td style={{ textAlign: "right" }}>{r.leads === "" || noLeads ? "—" : fmtInt(r.leads)}</td>
                      <td style={{ textAlign: "right" }}>{r.deals && !noDeals ? fmtInt(r.deals) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{r.revenue && !noDeals ? fmtAEDShort(r.revenue) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── method ───────────────────────────────────────────────────── */}
          <div className="chart-card" style={{ marginTop: 20 }}>
            <div className="chart-title">Method &amp; data notes</div>
            <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.85, marginTop: 8 }}>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Method.</strong> Deals are reservations and completions (withdrawn deals excluded), dated by
                reservation date. Revenue is final gross commission in AED. A deal&apos;s channel is the enquiry source of
                its originating lead; deals with no linked lead or no source appear as &ldquo;No Source&rdquo;.
                Each named channel collects the CRM&apos;s spellings of that source (Google takes &ldquo;google&rdquo;,
                &ldquo;adwords&rdquo; and Google Business Profile). Any other source holding at least 1% of the
                period&apos;s leads or deals gets a channel of its own, up to four; the rest are grouped as &ldquo;Other&rdquo;.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Division split.</strong> Deals are Sale vs Rent as recorded in the CRM; a sale is off-plan when
                its linked property is flagged &ldquo;Off Plan&rdquo;, and sales with no linked property count as
                secondary. Leads are Buyer and Seller enquiries (sales) vs Tenant and Landlord enquiries (leasing).
                Enquiries carry no off-plan flag, so lead counts and conversion aren&apos;t available for that split.
                &ldquo;No Source&rdquo; deals include deals with no linked lead, so their conversion rate isn&apos;t
                meaningful and shows as &ldquo;—&rdquo;.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Lead counts</strong> leave out GoYzer rows, bulk imports and internal and test cards.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Brands.</strong> {brandsSentence(data.brands)} Any trading entity added to the CRM in
                future appears as its own brand rather than being folded into a total.
              </p>
              <p style={{ margin: 0 }}>
                <strong>Not shown.</strong> Portal spend, cost per deal, revenue after portal expense and return on spend
                are omitted — the CRM holds no spend data. Figures cover {dayLabel(data.from)} onwards and update automatically
                as the CRM changes. Source: Engage CRM via Metabase.
              </p>
            </div>
          </div>
          </>
          )}
        </>
      )}
    </>
  );
}
