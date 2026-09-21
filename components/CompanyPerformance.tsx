"use client";

// Company Performance — a live rebuild of the "Leads & deals by channel" report,
// reading the Engage CRM through Metabase instead of a static export.
//
// Only the BRAND filter refetches: it changes the SQL. Period, division, group-by
// and channel all slice the payload client-side, so they're instant.
//
// Portal economics (spend, cost per deal, revenue after portal expense, return on
// spend) are intentionally absent — the CRM holds no spend data.
import { useCallback, useEffect, useMemo, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { C } from "@/lib/theme";
import type { CompanyDaily, CompanyData, DealDivision, LeadDivision } from "@/lib/company";

/* ── formatting (mirrors the report's fmt* helpers) ───────────────────────── */
const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
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
const fmtAED = (n: number) => {
  const a = Math.abs(n || 0);
  if (a >= 1e6) return `AED ${((n || 0) / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `AED ${Math.round((n || 0) / 1e3)}K`;
  return `AED ${Math.round(n || 0)}`;
};
const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);

const START_LABEL = "January 2025";

// Portal brands wear their own colours: Property Finder orange, Bayut green,
// Dubizzle red. Agent External gives up amber so it doesn't read as a second
// Property Finder, and takes the navy Property Finder vacated.
const CH_COLOR: Record<string, string> = {
  "Property Finder": C.amber,
  Bayut: C.green,
  "Client Referral": C.sage,
  "Previous Tenant/Buyer": C.blue,
  "Meta/Facebook": "#7c5cbf",
  "Agent External": C.dark,
  Dubizzle: C.red,
  "No Source": C.sand,
  Other: C.mid,
};

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
const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Jun ’25" / "Q2 ’25" / "2025" — the report's own bucket labels. */
const bucketLabel = (b: string, g: GroupBy) => {
  if (g === "year") return b;
  if (g === "quarter") {
    const [y, q] = b.split("-");
    return `${q} ’${y.slice(2)}`;
  }
  const [y, mo] = b.split("-");
  return `${MONTH_LABEL[Number(mo) - 1]} ’${y.slice(2)}`;
};
const prettyMonth = (m: string) => bucketLabel(m, "month");
const prettyBucket = (b: string, g: GroupBy) => bucketLabel(b, g);

/**
 * Shown while the brand filter refetches. Mirrors the real layout so the page
 * doesn't jump, and leaves the controls bar in place so the selection you just
 * made stays visible.
 */
function DataSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading figures…">
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
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
  const [division, setDivision] = useState<DivKey>("All");
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
  const dailyMiss = (month: string): CompanyDaily => ({
    month,
    days: [],
    channels: [],
    leads: { Sales: {}, Leasing: {} },
    deals: { Offplan: {}, Secondary: {}, Leasing: {} },
    comm: { Offplan: {}, Secondary: {}, Leasing: {} },
  });
  const [revShare, setRevShare] = useState(false);
  const [contribMetric, setContribMetric] = useState<"leads" | "deals" | "revenue">("revenue");

  /* ── brand filter is the only server round trip ─────────────────────────── */
  const load = useCallback(async (b: string) => {
    setLoading(true);
    try {
      const qs = b ? `?brand=${encodeURIComponent(b)}` : "";
      const res = await fetch(`/api/company${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok && json && Array.isArray(json.months)) setData(json as CompanyData);
      else console.error("[company] refresh returned an error", json?.error ?? res.status);
    } catch (e) {
      console.error("[company] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Changing brand fetches straight from the handler — no effect round trip. */
  const pickBrand = (next: string) => {
    setBrand(next);
    load(next);
  };

  const { months, channels } = data;
  const { leadDivs, dealDivs, convValid } = divsFor(division);

  /* ── month indices for the selected period ──────────────────────────────── */
  const { idxs, periodLabel } = useMemo(() => {
    let sel = months.map((_, i) => i);
    if (period === "2025") sel = months.map((m, i) => (m.startsWith("2025") ? i : -1)).filter((i) => i >= 0);
    else if (period === "2026") sel = months.map((m, i) => (m.startsWith("2026") ? i : -1)).filter((i) => i >= 0);
    const lbl =
      period === "all"
        ? `${prettyMonth(months[0] ?? "")} – ${prettyMonth(months[months.length - 1] ?? "")}`
        : period === "2025"
          ? "2025"
          : "2026 to date";
    return { idxs: sel, periodLabel: lbl };
  }, [months, period]);

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
  // Derived, not stored: a setState inside the effect would be a cascading
  // render, and "have I got this month yet" is already answerable from state.
  const dailyReady = dayMode && daily?.month === effBucket && (daily?.days.length ?? 0) > 0;
  const dailyLoading = dayMode && daily?.month !== effBucket;

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

  /** "Jan 2025 – Jul 2026" · "full year 2025" · "Jan – Jul 2026" */
  const rangeText = useMemo(() => {
    if (!idxs.length) return "";
    const f = months[idxs[0]];
    const l = months[idxs[idxs.length - 1]];
    const nice = (m: string) => `${MONTH_LABEL[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
    if (f === l) return nice(f);
    if (f.slice(0, 4) === l.slice(0, 4)) {
      if (f.endsWith("-01") && l.endsWith("-12")) return `full year ${f.slice(0, 4)}`;
      return `${MONTH_LABEL[Number(f.slice(5, 7)) - 1]} – ${nice(l)}`;
    }
    return `${nice(f)} – ${nice(l)}`;
  }, [idxs, months]);

  const lastMonthIdx = months.length - 1;
  const toPretty = data.to ? `${Number(data.to.slice(8, 10))} ${MONTH_LABEL[Number(data.to.slice(5, 7)) - 1]}` : "";

  type Kpi = { label: string; value: string; cur: number | null; prev: number | null; note: string };

  /**
   * The cards describe ONE bucket (or the whole range) with the change against
   * the bucket before it — the same shape as the report they replace.
   */
  const { cap, items } = useMemo(() => {
    const gname = GRAIN_NOUN[groupBy];
    const totL = bSums.leads.reduce((a, b) => a + b, 0);
    const totD = bSums.deals.reduce((a, b) => a + b, 0);
    const totC = bSums.comm.reduce((a, b) => a + b, 0);
    const totDS = bSums.salesDeals.reduce((a, b) => a + b, 0);

    let out: Kpi[];
    let caption: string;

    if (effBucket === "__all__") {
      caption = `Entire period — ${rangeText}`;
      out = [
        { label: "Leads received", value: fmtInt(totL), cur: null, prev: null, note: `sum of every ${gname} in range` },
        { label: "Deals reserved", value: fmtInt(totD), cur: null, prev: null, note: `sum of every ${gname} in range` },
        { label: "Conversion", value: fmtPct(totL ? totD / totL : null, 2), cur: null, prev: null, note: "deals ÷ leads over the range" },
        { label: "Gross commission", value: fmtAED(totC), cur: null, prev: null, note: "final gross commission, whole range" },
      ];
    } else {
      const bi = buckets.order.indexOf(effBucket);
      const pi = bi - 1;
      const inProgress = buckets.map.get(effBucket)?.includes(lastMonthIdx) ?? false;
      const convCur = bSums.leads[bi] ? bSums.deals[bi] / bSums.leads[bi] : null;
      const convPrev = pi >= 0 && bSums.leads[pi] ? bSums.deals[pi] / bSums.leads[pi] : null;
      caption =
        `${gname[0].toUpperCase()}${gname.slice(1)} — ${bucketLabel(effBucket, groupBy)}` +
        (inProgress ? ` (in progress: to ${toPretty})` : "") +
        (pi >= 0 ? ` · change vs ${bucketLabel(buckets.order[pi], groupBy)}` : "");
      out = [
        { label: "Leads received", value: fmtInt(bSums.leads[bi]), cur: bSums.leads[bi], prev: pi >= 0 ? bSums.leads[pi] : null, note: `Total ${rangeText}: ${fmtInt(totL)}` },
        { label: "Deals reserved", value: fmtInt(bSums.deals[bi]), cur: bSums.deals[bi], prev: pi >= 0 ? bSums.deals[pi] : null, note: `Total ${rangeText}: ${fmtInt(totD)}` },
        { label: "Conversion", value: fmtPct(convCur, 2), cur: convCur, prev: convPrev, note: `Range average: ${fmtPct(totL ? totD / totL : null, 2)}` },
        { label: "Gross commission", value: fmtAED(bSums.comm[bi]), cur: bSums.comm[bi], prev: pi >= 0 ? bSums.comm[pi] : null, note: `Total ${rangeText}: ${fmtAED(totC)}` },
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
        out[2] = { label: "Avg commission / deal", value: totD ? fmtAED(totC / totD) : "—", cur: null, prev: null, note: `gross commission ÷ ${dvName} deals` };
      } else {
        const bi = buckets.order.indexOf(effBucket);
        const pi = bi - 1;
        const shareCur = bSums.salesDeals[bi] ? bSums.deals[bi] / bSums.salesDeals[bi] : null;
        const sharePrev = pi >= 0 && bSums.salesDeals[pi] ? bSums.deals[pi] / bSums.salesDeals[pi] : null;
        const avgCur = bSums.deals[bi] ? bSums.comm[bi] / bSums.deals[bi] : null;
        const avgPrev = pi >= 0 && bSums.deals[pi] ? bSums.comm[pi] / bSums.deals[pi] : null;
        out[0] = { label: "Share of sales deals", value: fmtPct(shareCur, 1), cur: shareCur, prev: sharePrev, note: `Range: ${fmtPct(totDS ? totD / totDS : null, 1)} of sales deals` };
        out[2] = { label: "Avg commission / deal", value: avgCur != null ? fmtAED(avgCur) : "—", cur: avgCur, prev: avgPrev, note: `Range average: ${totD ? fmtAED(totC / totD) : "—"}` };
      }
    }
    return { cap: caption, items: out };
  }, [bSums, buckets, effBucket, groupBy, rangeText, channel, convValid, division, lastMonthIdx, toPretty]);

  /**
   * Fetch day grain for the selected month. Straight from a handler would be
   * neater, but the selection also moves when groupBy or the period changes, so
   * it has to react to the resolved bucket rather than to one control.
   */
  useEffect(() => {
    if (!dayMode) return;
    if (daily?.month === effBucket) return;
    let live = true;
    const month = effBucket;
    const qs = new URLSearchParams({ month });
    if (brand) qs.set("brand", brand);
    fetch(`/api/company/daily?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        // Record the month either way. Without the failure case the charts would
        // report "loading daily…" for as long as the page stayed open.
        setDaily(Array.isArray(j?.days) ? (j as CompanyDaily) : dailyMiss(month));
      })
      .catch(() => { if (live) setDaily(dailyMiss(month)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayMode, effBucket, brand]);

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
          : buckets.order.map((b) => {
              let t = 0;
              for (const dv of divs) for (const i of buckets.map.get(b)!) t += block[dv]?.[c]?.[i] ?? 0;
              return t;
            }),
        backgroundColor: CH_COLOR[c] ?? C.mid,
        borderWidth: 0,
      })),
    [activeChannels, buckets, dailyReady, daily],
  );

  /** X labels: days of the month when in day mode, otherwise the buckets. */
  const chartLabels = dailyReady
    ? (daily?.days ?? []).map((d) => String(Number(d.slice(8, 10))))
    : buckets.order.map((b) => prettyBucket(b, groupBy));

  /** Appended to each chart's subtitle so the grain on screen is never a guess. */
  const grainNote = dailyReady
    ? `daily · ${bucketLabel(effBucket, groupBy)}`
    : dayMode && dailyLoading
      ? "loading daily…"
      : `by ${groupBy}`;

  const stackedOpts = (money = false, pct = false) => ({
    responsive: true,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: { position: "bottom" as const, labels: { boxWidth: 10, font: { size: 10 }, padding: 10 } },
      tooltip: {
        callbacks: {
          label: (ctx: any) =>
            `${ctx.dataset.label}: ${pct ? `${Number(ctx.raw).toFixed(1)}%` : money ? fmtAED(Number(ctx.raw)) : fmtInt(Number(ctx.raw))}`,
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

  const revDatasets = useMemo(() => {
    const ds = stack(data.comm, dealDivs, daily?.comm);
    return revShare ? toPercent(ds) : ds;
  }, [stack, data.comm, dealDivs, revShare, daily]);

  const leadDatasets = useMemo(() => stack(data.leads, leadDivs, daily?.leads), [stack, data.leads, leadDivs, daily]);
  const dealDatasets = useMemo(() => stack(data.deals, dealDivs, daily?.deals), [stack, data.deals, dealDivs, daily]);

  /* ── channel summary ───────────────────────────────────────────────────── */
  const summary = useMemo(() => {
    const L = byChannel(data.leads, leadDivs, idxs);
    const D = byChannel(data.deals, dealDivs, idxs);
    const R = byChannel(data.comm, dealDivs, idxs);
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
  }, [data, channels, leadDivs, dealDivs, idxs, byChannel, convValid]);

  const convRows = useMemo(
    () => summary.filter((r) => r.conv != null).sort((a, b) => (b.conv ?? 0) - (a.conv ?? 0)),
    [summary],
  );

  const contribDatasets = useMemo(() => {
    const block = contribMetric === "leads" ? data.leads : contribMetric === "deals" ? data.deals : data.comm;
    const dayBlock = contribMetric === "leads" ? daily?.leads : contribMetric === "deals" ? daily?.deals : daily?.comm;
    const divs = contribMetric === "leads" ? leadDivs : dealDivs;
    return toPercent(stack(block, divs, dayBlock));
  }, [contribMetric, data, leadDivs, dealDivs, stack, daily]);

  /* ── full data table + CSV (always the whole dataset, ignoring filters) ─── */
  const fullRows = useMemo(() => {
    const rows: { month: string; channel: string; division: string; leads: number | ""; deals: number; revenue: number }[] = [];
    for (let i = 0; i < months.length; i++) {
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
  }, [months, channels, data]);

  const downloadCsv = () => {
    const head = ["Month", "Channel", "Division", "Leads", "Deals", "Gross commission (AED)"];
    const body = fullRows.map((r) => [r.month, r.channel, r.division, r.leads === "" ? "" : r.leads, r.deals, Math.round(r.revenue)]);
    const csv = [head, ...body].map((r) => r.map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v)).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `company-performance-${data.from}-to-${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const notConnected = !data.connected;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Company Performance</div>
          <div className="page-sub">
            Leads, deals and revenue by channel · {periodLabel} · live from the Engage CRM
            {loading ? " · updating…" : ""}
          </div>
        </div>
      </div>

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
          {data.error ? (
            <div className="chart-card" style={{ marginBottom: 18, borderColor: C.amber }}>
              <div style={{ fontSize: 12, color: C.amber, fontWeight: 600 }}>Partial data</div>
              <div style={{ fontSize: 12, color: C.mid, marginTop: 4 }}>{data.error}</div>
            </div>
          ) : null}

          {/* ── controls ──────────────────────────────────────────────────── */}
          <div className="controls-bar">
            <div className="field">
              <label>Period <HelpTip text="Jan 2025 onwards. Deltas compare against the immediately preceding window of equal length." /></label>
              <div className="ps-platforms">
                {[
                  ["all", "All"],
                  ["2025", "2025"],
                  ["2026", "2026 YTD"],
                ].map(([v, l]) => (
                  <button key={v} className={`filter-btn${period === v ? " active" : ""}`} onClick={() => setPeriod(v)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Division <HelpTip text="Deals split Sale vs Rent as recorded in the CRM. A sale is off-plan when its linked property is flagged “Off Plan”. Enquiries carry no off-plan flag, so lead counts and conversion aren't available for off-plan or secondary on their own." /></label>
              <div className="ps-platforms">
                {(["All", "Sales", "Offplan", "Secondary", "Leasing"] as DivKey[]).map((d) => (
                  <button key={d} className={`filter-btn${division === d ? " active" : ""}`} onClick={() => setDivision(d)}>
                    {DIV_LABEL[d]}
                  </button>
                ))}
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
                <HelpTip text="Betterhomes combines the main book with Local, BH Elite and BH Exclusive. Prime is reported separately. Changing this refetches from the CRM." />
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
                <HelpTip text="Which single period the four cards describe. Pick a month, quarter or year to see it against the one before it; “Entire period” totals the whole range instead." />
              </label>
              <select className="ps-select" value={effBucket} onChange={(e) => setBucket(e.target.value)}>
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
            Showing: {period === "all" ? "All" : period === "2026" ? "2026 to date" : period} · {DIV_PHRASE[division]} · by{" "}
            {groupBy} · cards: {effBucket === "__all__" ? "entire period" : bucketLabel(effBucket, groupBy)} ·{" "}
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
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
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
                        ? `${up ? "\u25b2" : down ? "\u25bc" : "\u00b7"} ${Math.abs(ch * 100).toFixed(1)}% vs previous ${GRAIN_NOUN[groupBy]}`
                        : `no previous ${GRAIN_NOUN[groupBy]} in range`}
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
              <ChartBox
                type="bar"
                data={{ labels: chartLabels, datasets: revDatasets }}
                options={stackedOpts(!revShare, revShare)}
              />
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
                <ChartBox
                  type="bar"
                  data={{ labels: chartLabels, datasets: leadDatasets }}
                  options={stackedOpts()}
                />
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-title">Deals by channel</div>
              <div className="chart-sub">Reservations + completions · {dealDivs.map((d) => DIV_LABEL[d]).join(" + ")}</div>
              <div className="chart-canvas-wrap" style={{ height: 280 }}>
                <ChartBox
                  type="bar"
                  data={{ labels: chartLabels, datasets: dealDatasets }}
                  options={stackedOpts()}
                />
              </div>
            </div>
          </div>

          {/* ── conversion by channel ─────────────────────────────────────── */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-title">Conversion rate by channel</div>
            <div className="chart-sub">Deals ÷ leads · {periodLabel}</div>
            <div className="chart-canvas-wrap" style={{ height: Math.max(180, convRows.length * 34) }}>
              {convRows.length ? (
                <ChartBox
                  type="bar"
                  data={{
                    labels: convRows.map((r) => r.channel),
                    datasets: [
                      {
                        label: "Conversion",
                        data: convRows.map((r) => (r.conv ?? 0) * 100),
                        backgroundColor: convRows.map((r) => CH_COLOR[r.channel] ?? C.mid),
                        borderWidth: 0,
                      },
                    ],
                  }}
                  options={{
                    indexAxis: "y" as const,
                    responsive: true,
                    plugins: {
                      legend: { display: false },
                      tooltip: { callbacks: { label: (ctx: any) => `${Number(ctx.raw).toFixed(2)}%` } },
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
            <div className="chart-sub">{periodLabel} · sorted by revenue</div>
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
                            background: CH_COLOR[r.channel] ?? C.mid,
                            marginRight: 8,
                          }}
                        />
                        {r.channel}
                      </td>
                      <td style={{ textAlign: "right" }}>{leadDivs.length ? fmtInt(r.leads) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{fmtInt(r.deals)}</td>
                      <td style={{ textAlign: "right" }}>{fmtPct(r.conv, 2)}</td>
                      <td style={{ textAlign: "right" }}>{fmtAED(r.revenue)}</td>
                      <td style={{ textAlign: "right" }}>{fmtPct(r.revPct)}</td>
                      <td style={{ textAlign: "right" }}>{fmtAED(r.avgComm)}</td>
                      <td style={{ textAlign: "right" }}>{leadDivs.length ? fmtPct(r.leadPct) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{fmtPct(r.dealPct)}</td>
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
              <ChartBox
                type="bar"
                data={{ labels: chartLabels, datasets: contribDatasets }}
                options={stackedOpts(false, true)}
              />
            </div>
          </div>

          {/* ── full data ────────────────────────────────────────────────── */}
          <div className="chart-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div className="chart-title">Full data</div>
                <div className="chart-sub">Every month, division and channel — regardless of the filters above</div>
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
                      <td style={{ textAlign: "right" }}>{r.leads === "" ? "—" : fmtInt(r.leads)}</td>
                      <td style={{ textAlign: "right" }}>{r.deals ? fmtInt(r.deals) : "—"}</td>
                      <td style={{ textAlign: "right" }}>{r.revenue ? fmtAED(r.revenue) : "—"}</td>
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
                &ldquo;Other&rdquo; groups Website, Agent internal, WhatsApp, Google, Instagram, Previous seller/landlord
                and all smaller sources.
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
                <strong>Data notes.</strong> April 2025 lead volume includes a one-off bulk import of ~98,900
                unattributed enquiries — lead totals and overall conversion for that month, and for 2025 as a whole, are
                distorted. Channel-level figures other than &ldquo;No Source&rdquo; are unaffected.
              </p>
              <p style={{ margin: "0 0 8px" }}>
                <strong>Brands.</strong> &ldquo;Betterhomes&rdquo; combines the main book with the Local bucket and the
                BH Elite and BH Exclusive licences. Prime is reported separately. Any trading entity added to the CRM in
                future appears as its own brand rather than being folded into a total.
              </p>
              <p style={{ margin: 0 }}>
                <strong>Not shown.</strong> Portal spend, cost per deal, revenue after portal expense and return on spend
                are omitted — the CRM holds no spend data. Figures cover {START_LABEL} onwards and update automatically
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
