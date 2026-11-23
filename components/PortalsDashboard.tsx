"use client";

// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) from
// the CRM: leads, completed viewings, and reservations with their reserved
// commission, counted as the business's own portal table counts them
// (lib/portals.ts has the definitions).
//
// What the portals cost is the business's own figures (lib/portalSpend.ts),
// set against the CRM figures that spend pays for (lib/portals.ts
// getPortalCost): cost per lead, per viewing, per reservation, and the
// reserved commission each dirham brings back.
//
// Range, brand and the Sale/Leasing side all refetch, and every figure follows
// the date range. The trend is one chart with a tick box for Sales, Leasing
// and each portal, to draw any mix of them together. The tab opens on the remembered answer and then asks the CRM
// for the latest (components/useLiveRefresh.ts), every few minutes while open.
//
// Area = locations.name, one level above communities: a community is a building
// ("Al Meraikhi Tower"), a location is the area ("Dubai Marina"). See lib/portals.ts.
// The Emirate tick boxes narrow every figure to Dubai, Abu Dhabi or Sharjah
// (lib/emirates.ts), and each area's bar is split by portal, its shares written on it.
import { useCallback, useMemo, useRef, useState } from "react";
import ChartBox from "@/components/Chart";
import { DataStatus, Filter, FilterBar, Kpi, KpiGrid, Notes, Notice, Pills, Section } from "@/components/ui";
import DateRangePicker, { rangeFor } from "@/components/DateRangePicker";
import { C, PORTAL_COLORS as PORTAL_COLOR } from "@/lib/theme";
import { errorMessage } from "@/lib/coerce";
import { MONTHS, dayLabel, fmtPct, sumOrNull } from "@/lib/format";
import { liveUrl } from "@/lib/live";
import { useLiveRefresh } from "@/components/useLiveRefresh";
import { ALL_EMIRATES, EMIRATES, emiratesText, narrows, type EmirateKey } from "@/lib/emirates";
import { SPEND_DIVISIONS, SPEND_EMIRATE, spendSource, spendWithin } from "@/lib/portalSpend";
import type { AreaRow, PortalMetric, PortalsData, Side, SideKey } from "@/lib/portals";

/** null is a figure that failed to load or doesn't apply: "—", never 0. */
const fmtInt = (n: number | null) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n || 0)));
const fmtAED = (n: number | null) => {
  if (n == null) return "—";
  const a = Math.abs(n || 0);
  if (a >= 1e6) return `AED ${((n || 0) / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `AED ${Math.round((n || 0) / 1e3)}K`;
  return `AED ${Math.round(n || 0)}`;
};
/** Exact dirhams — for per-unit figures, where rounding to "K" would hide the number. */
const fmtAEDExact = (n: number | null) =>
  n == null || !Number.isFinite(n) ? "—" : `AED ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)}`;
/** How many per 100 leads, to one decimal, as the business's portal table writes it. */
const per100 = (n: number | null, leads: number | null) => (n == null || !leads ? null : (n / leads) * 100);
const fmt1 = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(1));

/** Every figure the tab totals. */
const METRIC_KEYS: PortalMetric[] = ["leads", "viewings", "reservations", "reservedComm"];
/** The trend's choices. */
const TREND_OPTIONS = [
  ["leads", "Leads"],
  ["viewings", "Viewings"],
  ["reservations", "Reservations"],
  ["reservedComm", "Reserved commission"],
] as const;
type TrendMetric = (typeof TREND_OPTIONS)[number][0];
const SIDES = [["all", "All"], ["sale", "Sale"], ["leasing", "Leasing"]] as const;
/**
 * The trend's halves, each a tick box under All. Leasing's lines are dashed and
 * pointed with triangles, so a line never tells its side by colour alone.
 */
const TREND_SIDES: { key: SideKey; label: string; dash?: number[]; point: "circle" | "triangle" }[] = [
  { key: "sale", label: "Sales", point: "circle" },
  { key: "leasing", label: "Leasing", dash: [6, 4], point: "triangle" },
];

/** A short line in a side's style, beside its tick box. */
function LineSample({ dash }: { dash?: number[] }) {
  return (
    <svg width="20" height="8" aria-hidden="true" style={{ flex: "none" }}>
      <line x1="1" y1="4" x2="19" y2="4" stroke={C.mid} strokeWidth="2" strokeDasharray={dash?.join(" ")} />
    </svg>
  );
}
const isMoney = (m: PortalMetric) => m === "reservedComm";

/** The cost chart's choices. */
const COST_OPTIONS = [
  ["lead", "Cost per lead"],
  ["reservation", "Cost per reservation"],
  ["spend", "Spend and commission"],
] as const;
type CostView = (typeof COST_OPTIONS)[number][0];
/**
 * Spend, and the reserved commission set against it, in colours no portal
 * wears: blue and amber, checked with the dataviz palette validator (normal
 * vision ΔE 25.0, colour-blind 21.4).
 */
const SPEND_COLOR = C.blue;
const COMMISSION_COLOR = C.amber;
/** Spend over a count: what each one cost. Null without both. */
const each = (spend: number | null, n: number | null) => (spend == null || !n ? null : spend / n);
/** Reserved commission for each dirham of spend, "3.4×". */
const fmtTimes = (x: number | null) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(1)}×`);

/** What the area chart ranks by, one tab each. */
const AREA_OPTIONS = [
  ["leads", "Leads"],
  ["viewings", "Viewings"],
  ["reservations", "Reservations"],
  ["reservedComm", "Reserved commission"],
  ["commPer", "Commission per reservation"],
  ["listings", "Listings on portals"],
] as const;
type AreaMetric = (typeof AREA_OPTIONS)[number][0];
/**
 * A bar's colour where it is not split by portal: commission per reservation,
 * or an area with no portal figures. Never green, pink or red, which would
 * read as Bayut, Property Finder or Dubizzle.
 */
const AREA_COLOR: Record<AreaMetric, string> = { leads: C.blue, viewings: C.blue, reservations: C.blue, reservedComm: C.blue, commPer: C.amber, listings: C.blue };
/** How the figure reads after a number: "401 reservations", "AED 4.20M reserved commission". */
const AREA_NOUN: Record<AreaMetric, string> = {
  leads: "leads",
  viewings: "viewings completed",
  reservations: "reservations",
  reservedComm: "reserved commission",
  commPer: "commission per reservation",
  listings: "listings on portals",
};
/** How many areas the chart shows; search finds any other. */
const AREA_BARS = 15;
/** An area's figure; commission per reservation has none without reservations. */
const areaValue = (a: AreaRow, m: AreaMetric): number | null =>
  m === "commPer" ? (a.reservations > 0 ? a.reservedComm / a.reservations : null) : a[m];
const areaMoney = (m: AreaMetric) => m === "reservedComm" || m === "commPer";

const monthLabel = (m: string) => {
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1] ?? mm} ${String(y).slice(2)}`;
};
/** "2026-01-01" → "2026-11-18" as "1 Jan – 18 Nov 2026" (both years when they differ). */
function rangeLabel(from: string, to: string): string {
  const day = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? d.slice(5, 7)}`;
  return from.slice(0, 4) === to.slice(0, 4) ? `${day(from)} – ${day(to)} ${to.slice(0, 4)}` : `${day(from)} ${from.slice(0, 4)} – ${day(to)} ${to.slice(0, 4)}`;
}
/** "2026-03" as "March 2026"'s short form, "Mar 2026". */
/** Placeholder shaped like the real body, so the layout doesn't jump on load. */
function PortalsSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <div className="kpi-card" key={i}>
            <div className="skeleton" style={{ width: "60%", height: 9, marginBottom: 10 }} />
            <div className="skeleton" style={{ width: "45%", height: 20 }} />
          </div>
        ))}
      </div>
      {[220, 300, 300].map((h, i) => (
        <div className="chart-card" key={i} style={{ marginBottom: 18 }}>
          <div className="skeleton" style={{ width: 160, height: 12, marginBottom: 14 }} />
          <div className="skeleton" style={{ width: "100%", height: h }} />
        </div>
      ))}
    </div>
  );
}

/** A portal's share as written beside its area: whole percent, and "<1%" for a sliver rather than a "0%" that is not nothing. */
const sharePct = (x: number) => (x > 0 && x < 0.005 ? "<1%" : fmtPct(x, 0));
/** The longest bar's share of its row, leaving room beside it for the portals' shares. */
const AREA_BAR_MAX = 60;

/**
 * Top areas: one bar per area, as long as its figure, split into each portal's
 * part in the portal's colour, with every portal's share written beside it (a
 * dot in the portal's colour, then the share). Commission per reservation is an
 * average, so its bar is whole and the hover gives each portal's.
 */
function AreaBars({ rows, metric, portals, total, fmt }: {
  rows: { area: string; v: number; n: number; row: AreaRow }[];
  metric: AreaMetric;
  portals: string[];
  /** All areas' figure added up, for "x% of all areas"; null for an average. */
  total: number | null;
  fmt: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  const figure = metric === "commPer" ? null : metric;
  return (
    <div className="area-bars">
      {figure && (
        <div className="area-legend" aria-hidden="true">
          {portals.map((p) => (
            <span key={p}><i style={{ background: PORTAL_COLOR[p] ?? C.mid }} />{p}</span>
          ))}
          <span className="area-legend-note">
            {figure === "listings" ? "share of the area's portal placements" : `share of the area's ${AREA_NOUN[metric]}`}
          </span>
        </div>
      )}
      {rows.map(({ area, v, n, row }) => {
        const parts = figure ? portals.map((p) => ({ p, v: row.byPortal?.[p]?.[figure] ?? 0 })).filter((x) => x.v > 0) : [];
        const whole = parts.reduce((s, x) => s + x.v, 0);
        const width = (v / max) * 100;
        const each = parts.map((x) => `${x.p} ${sharePct(x.v / whole)}`).join(" · ");
        const averages = figure
          ? ""
          : portals
              .map((p) => {
                const b = row.byPortal?.[p];
                return b && b.reservations ? `${p} ${fmt(b.reservedComm / b.reservations)}` : null;
              })
              .filter(Boolean)
              .join(" · ");
        const title = figure
          ? `${area}: ${fmt(v)} ${AREA_NOUN[metric]}${total ? ` · ${fmtPct(v / total)} of all areas` : ""}${each ? ` · ${each}` : ""}`
          : `${area}: ${fmt(v)} per reservation, from ${fmtInt(n)} reservation${n === 1 ? "" : "s"}${averages ? ` · ${averages}` : ""}`;
        return (
          <div key={area} className="area-row" title={title}>
            <span className="area-name">{area}</span>
            <div className="area-cell">
              <div className="area-bar" style={{ width: `${(Math.max(width, 0.5) * AREA_BAR_MAX) / 100}%` }}>
                {parts.length ? (
                  parts.map((x) => <span key={x.p} className="area-seg" style={{ flexGrow: x.v, background: PORTAL_COLOR[x.p] ?? C.mid }} />)
                ) : (
                  <span className="area-seg" style={{ flexGrow: 1, background: AREA_COLOR[metric] }} />
                )}
              </div>
              {parts.length > 0 && (
                <span className="area-shares">
                  {parts.map((x) => (
                    <span key={x.p}>
                      <i style={{ background: PORTAL_COLOR[x.p] ?? C.mid }} />
                      {sharePct(x.v / whole)}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <span className="area-val">{fmt(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function PortalsDashboard({ initial }: { initial: PortalsData }) {
  const [data, setData] = useState<PortalsData>(initial);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [brand, setBrand] = useState(initial.brand);
  const [side, setSide] = useState<Side>(initial.side);
  const [emirates, setEmirates] = useState<EmirateKey[]>(initial.emirates ?? ALL_EMIRATES);
  const [metric, setMetric] = useState<TrendMetric>("leads");
  /** What the trend draws: a tick box per side and per portal, every one ticked to start. */
  const [sideOn, setSideOn] = useState<Record<SideKey, boolean>>({ sale: true, leasing: true });
  const [portalOff, setPortalOff] = useState<Record<string, boolean>>({});
  const [areaMetric, setAreaMetric] = useState<AreaMetric>("reservations");
  const [costView, setCostView] = useState<CostView>("lead");
  const [areaQuery, setAreaQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The start someone picked, when the CRM's portal figures begin later and the range was moved to start there. */
  const [movedFrom, setMovedFrom] = useState<string | null>(null);
  /** Bumped to remount the date picker on the range the numbers are actually for. */
  const [pickerKey, setPickerKey] = useState(0);

  /**
   * The payload on screen, and the newest request. Each pick fetches, and a
   * slower, older response used to land last and overwrite a newer pick:
   * Sale numbers under the Leasing tab.
   */
  const shown = useRef(initial);
  const latest = useRef(0);

  /**
   * Fetch a selection. A live ask (`live`) wants figures at most a minute old
   * and is quiet: no skeleton, and a failure keeps what is shown without a
   * word, for the next turn to try again.
   */
  const load = useCallback(async (f: string, t: string, b: string, sd: Side, em: EmirateKey[], live = false) => {
    const id = ++latest.current;
    if (!live) setLoading(true);
    try {
      const qs = new URLSearchParams({ from: f, to: t, side: sd });
      if (b) qs.set("brand", b);
      // Every emirate ticked narrows nothing, and the address says so by leaving them out.
      if (narrows(em)) qs.set("emirates", em.join(","));
      const url = `/api/portals?${qs}`;
      const res = await fetch(live ? liveUrl(url) : url, { cache: "no-store" });
      const j = (await res.json()) as Partial<PortalsData>;
      if (id !== latest.current) return;
      if (!Array.isArray(j.portals)) throw new Error(j.error || `HTTP ${res.status}`);
      const d = j as PortalsData;
      shown.current = d;
      setData(d);
      setLoadError(null);
      // A start before the portal figures begin is moved to where they begin
      // (lib/portals.ts portalsRange); say so rather than show a shorter range unremarked.
      if (!live) setMovedFrom(d.from > f ? f : null);
      // The server may reorder or clamp the range; show the one it answered.
      if (d.from !== f || d.to !== t) {
        setFrom(d.from);
        setTo(d.to);
        setPickerKey((k) => k + 1);
      }
    } catch (e) {
      if (id !== latest.current || live) return;
      // Keep the previous payload and put the controls back on it, so they
      // never describe numbers that aren't on screen.
      const d = shown.current;
      setFrom(d.from);
      setTo(d.to);
      setBrand(d.brand);
      setSide(d.side);
      setEmirates(d.emirates ?? ALL_EMIRATES);
      setPickerKey((k) => k + 1);
      setLoadError(errorMessage(e));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  /**
   * Range and brand fetch straight from their handlers rather than via an effect
   * — same as Company Performance. An effect would re-run on every render that
   * touched the key and needs a setState inside it to show the spinner.
   */
  const pickRange = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
    load(f, t, brand, side, emirates);
  };
  const pickBrand = (b: string) => {
    setBrand(b);
    load(from, to, b, side, emirates);
  };
  /** Leasing / Sale changes the SQL on both sides of every ratio, so it refetches. */
  const pickSide = (sd: Side) => {
    setSide(sd);
    load(from, to, brand, sd, emirates);
  };
  /** An emirate ticked or unticked; the last one ticked stays, as nothing would be left to show. */
  const pickEmirate = (key: EmirateKey) => {
    const next = emirates.includes(key) ? emirates.filter((k) => k !== key) : ALL_EMIRATES.filter((k) => k === key || emirates.includes(k));
    if (!next.length) return;
    setEmirates(next);
    load(from, to, brand, side, next);
  };

  /** The latest figures for what is on screen; held back while a pick is loading. */
  const updating = useLiveRefresh(data.cachedAt, () => load(data.from, data.to, data.brand, data.side, data.emirates ?? ALL_EMIRATES, true), !loading);

  const rows = data.rows;

  /** Each figure across the three portals; "—" when its query failed. */
  const tot = useMemo(
    () => Object.fromEntries(METRIC_KEYS.map((m) => [m, sumOrNull(rows.map((r) => r[m]))])) as Record<PortalMetric, number | null>,
    [rows],
  );

  /**
   * The trend: one chart, a line for each ticked side and portal. Under Sale or
   * Leasing the Side filter has already chosen, so only the portals have boxes.
   */
  const split = data.side === "all";
  const trend = useMemo(() => {
    const labels = data.months.map(monthLabel);
    const sides = TREND_SIDES.filter((x) => (split ? sideOn[x.key] : x.key === data.side));
    const datasets = sides.flatMap((x) =>
      data.portals
        .filter((p) => !portalOff[p])
        .map((p) => ({
          label: split ? `${p} · ${x.label}` : p,
          data: data.bySide[x.key][metric][p] ?? [],
          borderColor: PORTAL_COLOR[p] ?? C.mid,
          backgroundColor: PORTAL_COLOR[p] ?? C.mid,
          // Dashes and triangles tell the sides apart, so only when both can be drawn.
          borderDash: split ? x.dash : undefined,
          borderWidth: 2,
          tension: 0.3,
          pointStyle: split ? x.point : "circle",
          pointRadius: labels.length > 18 ? 0 : 3,
          fill: false,
        })),
    );
    return { labels, datasets };
  }, [data.bySide, data.months, data.portals, data.side, split, sideOn, portalOff, metric]);

  /**
   * The cost section: the spend over the range (a month the range starts or
   * ends inside takes its share by days) against the CRM figures it pays for.
   */
  const cost = useMemo(() => {
    const c = data.cost;
    if (!c) return null;
    const spend = c.months.map((m) => spendWithin(m, data.from, data.to));
    // The months whose spend repeats an earlier year's, as no figure was given for them.
    const carried = c.months.filter((m) => {
      const src = spendSource(m);
      return src != null && src !== m;
    });
    return {
      ...c,
      spend,
      carried,
      total: {
        spend: sumOrNull(spend),
        leads: sumOrNull(c.leads),
        viewings: sumOrNull(c.viewings),
        reservations: sumOrNull(c.reservations),
        reservedComm: sumOrNull(c.reservedComm),
      },
    };
  }, [data.cost, data.from, data.to]);

  const costChart = useMemo(() => {
    if (!cost) return null;
    const labels = cost.months.map(monthLabel);
    if (costView === "spend") {
      return {
        type: "bar" as const,
        data: {
          labels,
          datasets: [
            { label: "Portal spend", data: cost.spend, backgroundColor: SPEND_COLOR, borderRadius: 4, maxBarThickness: 22 },
            { label: "Reserved commission", data: cost.reservedComm, backgroundColor: COMMISSION_COLOR, borderRadius: 4, maxBarThickness: 22 },
          ],
        },
      };
    }
    const n = costView === "lead" ? cost.leads : cost.reservations;
    return {
      type: "line" as const,
      data: {
        labels,
        datasets: [
          {
            label: costView === "lead" ? "Cost per lead" : "Cost per reservation",
            data: cost.spend.map((s, i) => each(s, n[i])),
            borderColor: SPEND_COLOR,
            backgroundColor: SPEND_COLOR,
            borderWidth: 2,
            tension: 0.3,
            pointRadius: labels.length > 18 ? 0 : 4,
            fill: false,
          },
        ],
      },
    };
  }, [cost, costView]);

  const costOpts = useMemo(() => {
    if (!cost) return {};
    /** What a month's figure came from, under the tooltip: its spend and count, and where the spend repeats an earlier year's. */
    const footer = (items: { dataIndex: number }[]) => {
      const i = items[0]?.dataIndex;
      if (i == null) return "";
      const m = cost.months[i];
      const lines = [];
      if (costView !== "spend") {
        const n = costView === "lead" ? cost.leads[i] : cost.reservations[i];
        lines.push(`${fmtAED(cost.spend[i])} spend · ${fmtInt(n)} ${costView === "lead" ? "leads" : "reservations"}`);
      }
      const src = spendSource(m);
      if (src && src !== m) lines.push(`Spend repeats ${monthLabel(src)}'s: no figure was given for this month`);
      return lines.join("\n");
    };
    return {
      responsive: true,
      interaction: { mode: "index" as const, intersect: false },
      plugins: {
        legend: { display: costView === "spend", position: "top" as const, labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) =>
              `${ctx.dataset.label}: ${costView === "spend" ? fmtAED(ctx.parsed.y) : fmtAEDExact(ctx.parsed.y)}`,
            footer,
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: (v: number | string) => (costView === "spend" ? fmtAED(Number(v)) : fmtAEDExact(Number(v))) } },
        x: { ticks: { font: { size: 10 } } },
      },
    };
  }, [cost, costView]);

  const areas = useMemo(() => {
    const q = areaQuery.trim().toLowerCase();
    return q ? data.areas.filter((a) => a.area.toLowerCase().includes(q)) : data.areas;
  }, [data.areas, areaQuery]);

  /** The areas the search leaves, ranked by the chosen figure, biggest first; an area without that figure is left off. */
  const ranked = useMemo(
    () =>
      areas
        .map((a) => ({ area: a.area, v: areaValue(a, areaMetric), n: a.reservations, row: a }))
        .filter((x): x is { area: string; v: number; n: number; row: AreaRow } => x.v != null && x.v > 0)
        .sort((x, y) => y.v - x.v),
    [areas, areaMetric],
  );
  /**
   * The share of all areas' total, for the tooltip. Of the AREA-attributable
   * total, not the headline count: reservations with no linked property have no
   * area and would make the shares sum to less than 100%. No share for an average.
   */
  const areaTotal = useMemo(
    () => (areaMetric === "commPer" ? null : data.areas.reduce((s, a) => s + (areaValue(a, areaMetric) ?? 0), 0)),
    [data.areas, areaMetric],
  );
  const fmtArea = useCallback((v: number) => (areaMoney(areaMetric) ? (areaMetric === "commPer" ? fmtAEDExact(v) : fmtAED(v)) : fmtInt(v)), [areaMetric]);

  const fmtTrend = isMoney(metric) ? fmtAED : fmtInt;
  const trendOpts = {
    responsive: true,
    // Hovering anywhere over a month shows every drawn line's figure for it.
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      // The tick boxes above the chart are its legend: each portal's colour, each side's line.
      legend: { display: false },
      tooltip: {
        usePointStyle: true,
        callbacks: { label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) => `${ctx.dataset.label}: ${fmtTrend(ctx.parsed.y)}` },
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: {
          font: { size: 10 },
          // Whole-number steps: a small line (Dubizzle alone, say) otherwise steps by 0.2 and reads "0 0 0 1 1 1".
          precision: 0,
          // Under AED 10K the axis steps by 500 or less, which "AED 2K" style rounds into wrong labels: exact dirhams there.
          callback: (v: number | string, _i: number, ticks: { value: number }[]) =>
            isMoney(metric) && Math.abs(ticks[ticks.length - 1]?.value ?? 0) < 1e4 ? fmtAEDExact(Number(v)) : fmtTrend(Number(v)),
        },
      },
      x: { ticks: { font: { size: 10 } } },
    },
  };

  if (!data.connected) {
    return (
      <Notice tone="error">
        Not connected to the CRM. Set <code>METABASE_URL</code> and either <code>METABASE_API_KEY</code> or{" "}
        <code>METABASE_USERNAME</code> / <code>METABASE_PASSWORD</code>.
      </Notice>
    );
  }

  return (
    <>
      <FilterBar>
        <Filter label="Period">
          {/* Named "This year" when the range is the year to date, the default; any other range is a custom one. */}
          <DateRangePicker
            key={pickerKey}
            initialKey={from === rangeFor("this_year").from && to === rangeFor("this_year").to ? "this_year" : "custom"}
            initialFrom={from}
            initialTo={to}
            onApply={pickRange}
          />
        </Filter>
        <Filter label="Side">
          <Pills label="Business side" options={SIDES} value={side} onChange={pickSide} />
        </Filter>
        <Filter label="Brand">
          <select className="search-box" style={{ width: 160 }} value={brand} onChange={(e) => pickBrand(e.target.value)} aria-label="Brand">
            {data.brands.map((b) => (
              <option key={b.key} value={b.key}>{b.label}</option>
            ))}
          </select>
        </Filter>
        <Filter label="Emirate" help="Narrows every figure to the ticked emirates, by the property each enquiry, viewing, deal or listing is about. With all three ticked nothing is narrowed: enquiries and deals with no linked property count too.">
          <div className="pill-group" role="group" aria-label="Emirates">
            {EMIRATES.map((e) => {
              const on = emirates.includes(e.key);
              return (
                <label key={e.key} className={`filter-btn emirate-pick${on ? " active" : ""}`}>
                  <input type="checkbox" aria-label={e.label} checked={on} disabled={on && emirates.length === 1} onChange={() => pickEmirate(e.key)} />
                  {e.label}
                </label>
              );
            })}
          </div>
        </Filter>
      </FilterBar>

      {/* Everything below waits for the whole payload, so no figure sits beside one that hasn't landed. */}
      {loading ? (
        <PortalsSkeleton />
      ) : (
        <>
          {data.error && (
            <Notice tone="error">
              <strong>CRM error.</strong> {data.error}
            </Notice>
          )}
          {loadError && (
            <Notice tone="error">
              <strong>Couldn&apos;t load that selection.</strong> Still showing {data.label}. ({loadError})
            </Notice>
          )}
          {movedFrom && (
            <Notice>
              The CRM&apos;s portal figures start on {dayLabel(data.from)}, so the range you picked from {dayLabel(movedFrom)} starts there.
            </Notice>
          )}

          <DataStatus
            source="From the Engage CRM"
            detail={`${rangeLabel(data.from, data.to)}${narrows(data.emirates ?? ALL_EMIRATES) ? ` · ${emiratesText(data.emirates)} only` : ""}`}
            at={data.cachedAt}
            updating={updating}
          />

          <KpiGrid cols={3}>
            <Kpi label="Portal leads" value={fmtInt(tot.leads)} help="Leads whose enquiry source is Property Finder, Bayut or Dubizzle, by the day they were created. Test forms, staff and internal cards are left out, as on every tab." />
            <Kpi label="Viewings completed" value={fmtInt(tot.viewings)} help="Viewing activities marked Completed on portal leads, by the day the viewing took place." />
            <Kpi label="Viewings per 100 leads" value={fmt1(per100(tot.viewings, tot.leads))} help="Viewings completed in the period for every 100 portal leads created in it. A period ratio: a viewing can follow its lead by weeks." />
            <Kpi label="Reservations" value={fmtInt(tot.reservations)} help="Portal deals by the day they were reserved (status Reserved, Closed or Completed, not withdrawn). The deal's portal is its lead's enquiry source." />
            <Kpi label="Reserved commission" value={fmtAED(tot.reservedComm)} help="The reserved gross commission of those reservations." />
            <Kpi label="Reservations per 100 leads" value={fmt1(per100(tot.reservations, tot.leads))} help="Reservations in the period for every 100 portal leads created in it. A period ratio, not a cohort: a deal can be reserved months after its lead." />
          </KpiGrid>

          <Section
            title="What the portals cost"
            help={`The spend is the business's own figures for its BH DXB and BH ELITE portal accounts, added together; its other accounts are left out. Each is set against the CRM figures it pays for: portal leads, completed viewings and reservations of the ${SPEND_DIVISIONS.join(" and ")} divisions, about property in ${SPEND_EMIRATE} or with no property recorded, sale and leasing together. A month the range starts or ends inside takes its share of that month's spend by days. A month with no figure given repeats the same month of the latest year given.`}
            sub={`BH DXB and BH ELITE spend against the ${SPEND_DIVISIONS.join(" and ")} divisions' ${SPEND_EMIRATE} portal figures, sale and leasing together. The Brand, Side and Emirate filters don't change this section.`}
            actions={cost ? <Pills label="Cost chart" options={COST_OPTIONS} value={costView} onChange={setCostView} /> : null}
          >
            {!cost ? (
              <p style={{ fontSize: 13, color: C.mid, margin: 0 }}>The CRM figures behind the cost didn&apos;t load. They are asked for again with the rest of the tab.</p>
            ) : (
              <>
                {cost.error && (
                  <Notice tone="warn">
                    Part of the CRM figures behind the cost didn&apos;t load, so some costs show “—”. ({cost.error})
                  </Notice>
                )}
                <KpiGrid cols={5}>
                  <Kpi
                    label="Portal spend"
                    value={fmtAED(cost.total.spend)}
                    sub={
                      cost.carried.length === 1
                        ? `${monthLabel(cost.carried[0])} repeats ${monthLabel(spendSource(cost.carried[0]) ?? "")}'s figure`
                        : cost.carried.length
                          ? `${monthLabel(cost.carried[0])} – ${monthLabel(cost.carried[cost.carried.length - 1])} repeat earlier years' figures`
                          : "As the business gave it"
                    }
                    help="BH DXB and BH ELITE together, for the range. The business gave figures to Oct 2026; a later month repeats the same month of the latest year given, so Nov and Dec 2026 repeat 2025's and 2027 repeats 2026's."
                  />
                  <Kpi label="Cost per lead" value={fmtAEDExact(each(cost.total.spend, cost.total.leads))} sub={`${fmtInt(cost.total.leads)} leads`} help="Portal spend ÷ portal leads created in the range." />
                  <Kpi label="Cost per viewing" value={fmtAEDExact(each(cost.total.spend, cost.total.viewings))} sub={`${fmtInt(cost.total.viewings)} viewings completed`} help="Portal spend ÷ viewings completed in the range on portal leads." />
                  <Kpi label="Cost per reservation" value={fmtAEDExact(each(cost.total.spend, cost.total.reservations))} sub={`${fmtInt(cost.total.reservations)} reservations`} help="Portal spend ÷ portal deals reserved in the range. A period ratio: a deal can be reserved months after its lead." />
                  <Kpi
                    label="Return on spend"
                    value={fmtTimes(each(cost.total.reservedComm, cost.total.spend))}
                    sub={`${fmtAED(cost.total.reservedComm)} reserved commission`}
                    help="Reserved gross commission of those reservations ÷ portal spend: the commission each dirham of spend brought back."
                  />
                </KpiGrid>
                {costChart && (
                  <div style={{ height: 280 }}>
                    <ChartBox type={costChart.type} data={costChart.data} options={costOpts} />
                  </div>
                )}
              </>
            )}
          </Section>

          <Section title="By portal">
            <div style={{ overflowX: "auto" }}>
              <table className="perf-table" style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th>Portal</th>
                    <th>Leads</th>
                    <th>Viewings completed</th>
                    <th>Viewings per 100 leads</th>
                    <th>Reservations</th>
                    <th>Reserved commission</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows.map((r) => ({ key: r.portal, label: r.portal, v: r as Record<PortalMetric, number | null> })), { key: "total", label: "Total", v: tot }].map((r) => (
                    <tr key={r.key} style={r.key === "total" ? { fontWeight: 600, borderTop: `2px solid var(--border)` } : undefined}>
                      <td>
                        {r.key !== "total" && (
                          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: PORTAL_COLOR[r.label] ?? C.mid, marginRight: 7 }} />
                        )}
                        {r.label}
                      </td>
                      <td>{fmtInt(r.v.leads)}</td>
                      <td>{fmtInt(r.v.viewings)}</td>
                      <td>{fmt1(per100(r.v.viewings, r.v.leads))}</td>
                      <td>{fmtInt(r.v.reservations)}</td>
                      <td>{fmtAED(r.v.reservedComm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title={`Over time${isMoney(metric) ? " (AED)" : ""}`}
            sub={`Each portal, month by month, for the figure chosen. ${split ? "Tick what to draw: Sales lines are solid, Leasing lines dashed." : `${data.side === "sale" ? "Sales" : "Leasing"} only, as the Side filter is set.`}`}
            actions={<Pills label="Figure" options={TREND_OPTIONS} value={metric} onChange={setMetric} />}
          >
            <div role="group" aria-label="Lines to draw" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 18px", fontSize: 12, marginBottom: 12 }}>
              {split
                ? TREND_SIDES.map((x) => (
                    <label key={x.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                      <input type="checkbox" aria-label={x.label} checked={sideOn[x.key]} onChange={() => setSideOn((o) => ({ ...o, [x.key]: !o[x.key] }))} />
                      <LineSample dash={x.dash} />
                      {x.label}
                    </label>
                  ))
                : null}
              {data.portals.map((p) => (
                <label key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" aria-label={p} checked={!portalOff[p]} onChange={() => setPortalOff((o) => ({ ...o, [p]: !o[p] }))} />
                  <span aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: PORTAL_COLOR[p] ?? C.mid }} />
                  {p}
                </label>
              ))}
            </div>
            {trend.datasets.length ? (
              <div style={{ height: 320 }}>
                <ChartBox type="line" data={trend} options={trendOpts} />
              </div>
            ) : (
              <p style={{ fontSize: 13, color: C.mid, margin: 0 }}>Nothing to draw: tick {split ? "a side and a portal" : "a portal"} to draw a line.</p>
            )}
          </Section>

          <Section
            title="Top areas"
            help={`Each area's figure for the range, biggest first, split by portal with each portal's share written on its part: pick the figure with the tabs, and search to find any area. Area is ${data.areaSource}: properties sit in a community (a building or sub-development) which sits in a location, and the location is the area. Leads and viewings take the area of the listing the enquiry was about. Listings are those on Property Finder, Bayut or Dubizzle at any point in the range; one on two portals counts once in the total and on each portal in the split. Commission per reservation leaves out areas with no reservations and is not split.`}
            sub={
              ranked.length ? (
                <>
                  <strong>{ranked[0].area}</strong> leads with {fmtArea(ranked[0].v)} {AREA_NOUN[areaMetric]} · {fmtInt(ranked.length)} area
                  {ranked.length === 1 ? "" : "s"}
                  {ranked.length > AREA_BARS ? `, top ${AREA_BARS} shown` : ""}
                </>
              ) : null
            }
            actions={
              <>
                <Pills label="Area figure" options={AREA_OPTIONS} value={areaMetric} onChange={setAreaMetric} />
                <input className="search-box" style={{ width: 180 }} placeholder="Search area…" value={areaQuery} onChange={(e) => setAreaQuery(e.target.value)} aria-label="Search area" />
              </>
            }
          >
            {ranked.length === 0 ? (
              <p style={{ fontSize: 13, color: C.mid, margin: 0 }}>No areas with {AREA_NOUN[areaMetric]} for this selection.</p>
            ) : (
              <AreaBars rows={ranked.slice(0, AREA_BARS)} metric={areaMetric} portals={data.portals} total={areaTotal} fmt={fmtArea} />
            )}
          </Section>

          <Notes warnings={data.warnings}>
            <li>
              <strong>How each figure is counted.</strong> Leads by the day they arrived;
              viewings marked Completed, by the day they took place; reservations by reservation date with the reserved
              commission. A viewing or deal belongs to the portal its lead came from.
            </li>
            <li>
              <strong>Leads leave out test forms, staff and internal cards</strong>, as on every tab
              {data.leadsLeftOut != null ? <>: {fmtInt(data.leadsLeftOut)} portal lead{data.leadsLeftOut === 1 ? "" : "s"} in this range</> : null}.
              Viewings follow the same rule; reservations count every deal on a portal lead.
            </li>
            {data.unnamedSources && data.unnamedSources.leads + data.unnamedSources.reservations > 0 ? (
              <li>
                <strong>Sources the tab doesn&apos;t name.</strong> {fmtInt(data.unnamedSources.leads)} lead
                {data.unnamedSources.leads === 1 ? "" : "s"} and {fmtInt(data.unnamedSources.reservations)} reservation
                {data.unnamedSources.reservations === 1 ? "" : "s"} in this range came from sources that are neither a portal
                here nor a named channel
                {data.unnamedSources.top.length
                  ? `, most from ${data.unnamedSources.top.map((x) => `${x.source} (${fmtInt(x.leads)})`).join(", ")}`
                  : ""}
                . A new portal would show here first.
              </li>
            ) : null}
            {tot.leads != null && data.areas.length > 0 ? (
              <li>
                <strong>Areas for leads and viewings.</strong> A lead takes the area of the listing it asked about, or of the property an
                owner&apos;s lead carries; {fmtInt(Math.max(0, tot.leads - data.areas.reduce((s, a) => s + (a.leads ?? 0), 0)))} of the{" "}
                {fmtInt(tot.leads)} portal leads in this selection name no property, so they are in the totals but in no area.
              </li>
            ) : null}
            <li>
              <strong>What the portals cost.</strong> The spend is the business&apos;s own monthly figures for its BH DXB and BH
              ELITE portal accounts, typed in at its request: the CRM holds no spend. They run to Oct 2026, and each later
              month repeats the same month of the latest year given. The costs set that spend against the{" "}
              {SPEND_DIVISIONS.join(" and ")} divisions&apos; portal figures about property in {SPEND_EMIRATE} (or none recorded),
              whatever the filters above are set to.
            </li>
            <li>
              <strong>Per 100 leads is a period ratio, not a cohort.</strong> A viewing or reservation can come weeks or
              months after its lead, so it divides what happened in the period by the leads that arrived in it.
            </li>
            <li>
              <strong>Listings by portal.</strong> The CRM has no list of portals, so its portal numbers are read as{" "}
              {Object.entries(data.portalIds ?? {}).map(([id, name]) => `${id} ${name}`).join(", ") || "Property Finder, Bayut and Dubizzle"}.
              {data.unmappedPortalIds.length > 0 && (
                <>
                  {" "}Other portals the CRM does not name are left out:{" "}
                  {data.unmappedPortalIds.map((u) => `portal_id ${u.id} (${fmtInt(u.published)} listings in the range)`).join(", ")}.
                </>
              )}
            </li>
          </Notes>
        </>
      )}
    </>
  );
}
