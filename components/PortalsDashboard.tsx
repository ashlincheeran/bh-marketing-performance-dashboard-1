"use client";

// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) from
// the CRM: leads, completed viewings, reservations with their reserved
// commission, and invoiced deals with their final commission, counted as the
// business's own portal table counts them (lib/portals.ts has the definitions).
//
// No spend: it is coming to Metabase, and will be read from there. The PPA
// workbook figures this tab used to show have gone.
//
// Range, brand and the Sale/Leasing side all refetch, and every figure follows
// the date range. The tab opens on the remembered answer and then asks the CRM
// for the latest (components/useLiveRefresh.ts), every few minutes while open.
//
// Area = locations.name, one level above communities: a community is a building
// ("Al Meraikhi Tower"), a location is the area ("Dubai Marina"). See lib/portals.ts.
import { useCallback, useMemo, useRef, useState } from "react";
import ChartBox from "@/components/Chart";
import { DataStatus, Filter, FilterBar, Kpi, KpiGrid, Notes, Notice, Pills, Section } from "@/components/ui";
import DateRangePicker, { rangeFor } from "@/components/DateRangePicker";
import { C } from "@/lib/theme";
import { errorMessage } from "@/lib/coerce";
import { MONTHS, dayLabel, fmtPct, sumOrNull } from "@/lib/format";
import { liveUrl } from "@/lib/live";
import { useLiveRefresh } from "@/components/useLiveRefresh";
import type { AreaRow, PortalMetric, PortalsData, Side } from "@/lib/portals";

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

const PORTAL_COLOR: Record<string, string> = {
  "Property Finder": C.amber,
  Bayut: C.green,
  Dubizzle: C.red,
};

/** Every figure the tab totals. */
const METRIC_KEYS: PortalMetric[] = ["leads", "viewings", "reservations", "reservedComm", "invoiced", "invoicedComm"];
/** The trend's choices. Invoiced figures stay in the cards and the table. */
const TREND_OPTIONS = [
  ["leads", "Leads"],
  ["viewings", "Viewings"],
  ["reservations", "Reservations"],
  ["reservedComm", "Reserved commission"],
] as const;
type TrendMetric = (typeof TREND_OPTIONS)[number][0];
const SIDES = [["all", "All"], ["sale", "Sale"], ["leasing", "Leasing"]] as const;
const isMoney = (m: PortalMetric) => m === "reservedComm" || m === "invoicedComm";

/** What the area chart ranks by, one tab each. */
const AREA_OPTIONS = [
  ["reservations", "Reservations"],
  ["reservedComm", "Reserved commission"],
  ["commPer", "Commission per reservation"],
  ["listings", "Listings on portals"],
] as const;
type AreaMetric = (typeof AREA_OPTIONS)[number][0];
const AREA_COLOR: Record<AreaMetric, string> = { reservations: C.blue, reservedComm: C.green, commPer: C.amber, listings: C.sage };
/** How the figure reads after a number: "401 reservations", "AED 4.20M reserved commission". */
const AREA_NOUN: Record<AreaMetric, string> = {
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
const fullMonth = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m.slice(5, 7)} ${m.slice(0, 4)}`;
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

export default function PortalsDashboard({ initial }: { initial: PortalsData }) {
  const [data, setData] = useState<PortalsData>(initial);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [brand, setBrand] = useState(initial.brand);
  const [side, setSide] = useState<Side>(initial.side);
  const [metric, setMetric] = useState<TrendMetric>("leads");
  const [areaMetric, setAreaMetric] = useState<AreaMetric>("reservations");
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
  const load = useCallback(async (f: string, t: string, b: string, sd: Side, live = false) => {
    const id = ++latest.current;
    if (!live) setLoading(true);
    try {
      const qs = new URLSearchParams({ from: f, to: t, side: sd });
      if (b) qs.set("brand", b);
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
    load(f, t, brand, side);
  };
  const pickBrand = (b: string) => {
    setBrand(b);
    load(from, to, b, side);
  };
  /** Leasing / Sale changes the SQL on both sides of every ratio, so it refetches. */
  const pickSide = (sd: Side) => {
    setSide(sd);
    load(from, to, brand, sd);
  };

  /** The latest figures for what is on screen; held back while a pick is loading. */
  const updating = useLiveRefresh(data.cachedAt, () => load(data.from, data.to, data.brand, data.side, true), !loading);

  const rows = data.rows;

  /** Each figure across the three portals; "—" when its query failed. */
  const tot = useMemo(
    () => Object.fromEntries(METRIC_KEYS.map((m) => [m, sumOrNull(rows.map((r) => r[m]))])) as Record<PortalMetric, number | null>,
    [rows],
  );

  const series = data.monthly[metric] ?? {};
  const labels = data.months.map(monthLabel);

  // Hoisted so the dep arrays hold plain identifiers — the lint rule rejects
  // expressions like `xs.join("|")` inline.
  const labelKey = labels.join("|");
  const portalKey = data.portals.join("|");
  const seriesKey = JSON.stringify(series);

  const trend = useMemo(
    () => ({
      labels,
      datasets: data.portals.map((p) => ({
        label: p,
        data: series[p] ?? [],
        borderColor: PORTAL_COLOR[p] ?? C.mid,
        backgroundColor: `${PORTAL_COLOR[p] ?? C.mid}22`,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: labels.length > 18 ? 0 : 3,
        fill: false,
      })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelKey, metric, portalKey, seriesKey],
  );

  const areas = useMemo(() => {
    const q = areaQuery.trim().toLowerCase();
    return q ? data.areas.filter((a) => a.area.toLowerCase().includes(q)) : data.areas;
  }, [data.areas, areaQuery]);

  /** The areas the search leaves, ranked by the chosen figure, biggest first; an area without that figure is left off. */
  const ranked = useMemo(
    () =>
      areas
        .map((a) => ({ area: a.area, v: areaValue(a, areaMetric) }))
        .filter((x): x is { area: string; v: number } => x.v != null && x.v > 0)
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

  const areaChart = useMemo(() => {
    const top = ranked.slice(0, AREA_BARS);
    return {
      labels: top.map((x) => x.area),
      datasets: [{ label: AREA_NOUN[areaMetric], data: top.map((x) => x.v), backgroundColor: AREA_COLOR[areaMetric], borderRadius: 4 }],
    };
  }, [ranked, areaMetric]);
  const areaOpts = useMemo(
    () => ({
      responsive: true,
      indexAxis: "y" as const,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: { parsed: { x: number } }) =>
              `${fmtArea(ctx.parsed.x)} ${AREA_NOUN[areaMetric]}${areaTotal ? ` · ${fmtPct(ctx.parsed.x / areaTotal)} of all areas` : ""}`,
          },
        },
      },
      scales: {
        x: { beginAtZero: true, ticks: { font: { size: 10 }, callback: (v: number | string) => fmtArea(Number(v)) } },
        y: { ticks: { font: { size: 11 } } },
      },
    }),
    [areaMetric, areaTotal, fmtArea],
  );

  const baseOpts = {
    responsive: true,
    plugins: { legend: { position: "bottom" as const, labels: { boxWidth: 12, font: { size: 11 } } } },
    scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } },
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

          <DataStatus source="From the Engage CRM" detail={rangeLabel(data.from, data.to)} at={data.cachedAt} updating={updating} />

          <KpiGrid>
            <Kpi label="Portal leads" value={fmtInt(tot.leads)} help="Leads whose enquiry source is Property Finder, Bayut or Dubizzle, by the day they were created. Test forms, staff and internal cards are left out, as on every tab." />
            <Kpi label="Viewings completed" value={fmtInt(tot.viewings)} help="Viewing activities marked Completed on portal leads, by the day the viewing took place." />
            <Kpi label="Viewings per 100 leads" value={fmt1(per100(tot.viewings, tot.leads))} help="Viewings completed in the period for every 100 portal leads created in it. A period ratio: a viewing can follow its lead by weeks." />
            <Kpi label="Reservations" value={fmtInt(tot.reservations)} help="Portal deals by the day they were reserved (status Reserved, Closed or Completed, not withdrawn). The deal's portal is its lead's enquiry source." />
            <Kpi label="Reserved commission" value={fmtAED(tot.reservedComm)} help="The reserved gross commission of those reservations." />
            <Kpi label="Invoiced deals" value={fmtInt(tot.invoiced)} help="Portal deals by the day they were invoiced." />
            <Kpi label="Invoiced commission" value={fmtAED(tot.invoicedComm)} help="The final gross commission of those invoiced deals." />
            <Kpi label="Reservations per 100 leads" value={fmt1(per100(tot.reservations, tot.leads))} help="Reservations in the period for every 100 portal leads created in it. A period ratio, not a cohort: a deal can be reserved months after its lead." />
          </KpiGrid>

          {/* Invoice dates only exist from a point in the CRM's life; say so where the invoiced figures are read. */}
          {data.invoicedFrom && data.invoicedFrom > data.from.slice(0, 7) && (
            <Notice>
              The CRM has recorded invoice dates since {fullMonth(data.invoicedFrom)}, so invoiced deals and commission
              start there; earlier months show —.
            </Notice>
          )}

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
                    <th>Invoiced deals</th>
                    <th>Invoiced commission</th>
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
                      <td>{fmtInt(r.v.invoiced)}</td>
                      <td>{fmtAED(r.v.invoicedComm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title={`Over time${isMoney(metric) ? " (AED)" : ""}`}
            sub="Each portal, month by month, for the figure chosen."
            actions={<Pills label="Figure" options={TREND_OPTIONS} value={metric} onChange={setMetric} />}
          >
            <div style={{ height: 300 }}>
              <ChartBox type="line" data={trend} options={baseOpts} />
            </div>
          </Section>

          <Section
            title="Top areas"
            help={`Each area's figure for the range, biggest first: pick the figure with the tabs, and search to find any area. Area is ${data.areaSource}: properties sit in a community (a building or sub-development) which sits in a location, and the location is the area. Listings are those on Property Finder, Bayut or Dubizzle at any point in the range. Commission per reservation leaves out areas with no reservations.`}
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
              <div style={{ height: Math.max(160, Math.min(ranked.length, AREA_BARS) * 24 + 40) }}>
                <ChartBox type="bar" data={areaChart} options={areaOpts} />
              </div>
            )}
          </Section>

          <Notes warnings={data.warnings}>
            <li>
              <strong>Counted as the business&apos;s portal table counts them.</strong> Leads by the day they arrived;
              viewings marked Completed, by the day they took place; reservations by reservation date with the reserved
              commission; invoiced deals by invoice date with the final commission. A viewing or deal belongs to the
              portal its lead came from.
            </li>
            <li>
              <strong>Leads leave out test forms, staff and internal cards</strong>, as on every tab
              {data.leadsLeftOut != null ? <>: {fmtInt(data.leadsLeftOut)} portal lead{data.leadsLeftOut === 1 ? "" : "s"} in this range</> : null}.
              Viewings follow the same rule; reservations and invoices count every deal on a portal lead.
            </li>
            <li>
              <strong>Per 100 leads is a period ratio, not a cohort.</strong> A viewing or reservation can come weeks or
              months after its lead, so it divides what happened in the period by the leads that arrived in it.
            </li>
            <li>
              <strong>Listings by portal.</strong> The CRM has no list of portals, so they are told apart by evidence:{" "}
              <code>portal_id</code> 1 is Property Finder (26-character ids no other portal uses); 2 and 3 are Bayut and
              Dubizzle, one platform sharing ids, and 2, the larger, is taken as Bayut. If that is the wrong way round,
              set <code>ENGAGE_PORTAL_IDS=1=Property Finder,2=Dubizzle,3=Bayut</code> and redeploy.
              {data.unmappedPortalIds.length > 0 && (
                <>
                  {" "}Other portals the CRM does not name are left out:{" "}
                  {data.unmappedPortalIds.map((u) => `portal_id ${u.id} (${fmtInt(u.published)} listings in the range)`).join(", ")}.
                </>
              )}
            </li>
            <li>
              <strong>No portal spend.</strong> It is moving to Metabase, and will be read from there.
            </li>
          </Notes>
        </>
      )}
    </>
  );
}
