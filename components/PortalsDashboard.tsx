"use client";

// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) from
// the CRM: leads, completed viewings, reservations with their reserved
// commission, and invoiced deals with their final commission, counted as the
// business's own portal table counts them (lib/portals.ts has the definitions).
//
// No spend: it is coming to Metabase, and will be read from there. The PPA
// workbook figures this tab used to show have gone.
//
// Range, brand and the Sale/Leasing side all refetch.
//
// Area = locations.name, one level above communities: a community is a building
// ("Al Meraikhi Tower"), a location is the area ("Dubai Marina"). See lib/portals.ts.
import UpdatedAgo from "@/components/UpdatedAgo";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import DateRangePicker, { rangeFor } from "@/components/DateRangePicker";
import { C } from "@/lib/theme";
import { errorMessage } from "@/lib/coerce";
import { MONTHS, fmtPct, sumOrNull } from "@/lib/format";
import type { PortalMetric, PortalsData, Side } from "@/lib/portals";

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

/** The trend's choices. Money ones read in AED. */
const METRIC_LABEL: Record<PortalMetric, string> = {
  leads: "Leads",
  viewings: "Viewings",
  reservations: "Reservations",
  reservedComm: "Reserved commission",
  invoiced: "Invoiced deals",
  invoicedComm: "Invoiced commission",
};
const METRIC_KEYS = Object.keys(METRIC_LABEL) as PortalMetric[];
const isMoney = (m: PortalMetric) => m === "reservedComm" || m === "invoicedComm";

/**
 * The month-by-month table sets Property Finder against Bayut and Dubizzle
 * together, as the business's own portal table does: the two are one company
 * (Dubizzle Group) and one platform behind the scenes.
 */
const GROUPS = [
  { label: "Property Finder", portals: ["Property Finder"] },
  { label: "Bayut + Dubizzle", portals: ["Bayut", "Dubizzle"] },
] as const;

const monthLabel = (m: string) => {
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1] ?? mm} ${String(y).slice(2)}`;
};
const ordinal = (d: number) =>
  `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;
/** "Nov 26", with "(to 17th)" or "(from 5th)" when the range covers only part of the month. */
function monthCell(m: string, from: string, to: string): string {
  const notes: string[] = [];
  if (from.slice(0, 7) === m && Number(from.slice(8, 10)) > 1) notes.push(`from ${ordinal(Number(from.slice(8, 10)))}`);
  if (to.slice(0, 7) === m) {
    const [y, mm] = m.split("-").map(Number);
    const last = new Date(Date.UTC(y, mm, 0)).getUTCDate();
    const d = Number(to.slice(8, 10));
    if (d < last) notes.push(`to ${ordinal(d)}`);
  }
  return notes.length ? `${monthLabel(m)} (${notes.join(", ")})` : monthLabel(m);
}

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
  const [metric, setMetric] = useState<PortalMetric>("leads");
  const [areaQuery, setAreaQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped to remount the date picker on the range the numbers are actually for. */
  const [pickerKey, setPickerKey] = useState(0);

  /**
   * The payload on screen, and the newest request. Each pick fetches, and a
   * slower, older response used to land last and overwrite a newer pick:
   * Sale numbers under the Leasing tab.
   */
  const shown = useRef(initial);
  const latest = useRef(0);

  const load = useCallback(async (f: string, t: string, b: string, sd: Side) => {
    const id = ++latest.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: f, to: t, side: sd });
      if (b) qs.set("brand", b);
      const res = await fetch(`/api/portals?${qs}`, { cache: "no-store" });
      const j = (await res.json()) as Partial<PortalsData>;
      if (id !== latest.current) return;
      if (!Array.isArray(j.portals)) throw new Error(j.error || `HTTP ${res.status}`);
      const d = j as PortalsData;
      shown.current = d;
      setData(d);
      setLoadError(null);
      // The server may reorder or clamp the range; show the one it answered.
      if (d.from !== f || d.to !== t) {
        setFrom(d.from);
        setTo(d.to);
        setPickerKey((k) => k + 1);
      }
    } catch (e) {
      if (id !== latest.current) return;
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

  const rows = data.rows;

  /** Each figure across the three portals; "—" when its query failed. */
  const tot = useMemo(
    () => Object.fromEntries(METRIC_KEYS.map((m) => [m, sumOrNull(rows.map((r) => r[m]))])) as Record<PortalMetric, number | null>,
    [rows],
  );

  /** Property Finder and Bayut + Dubizzle, month by month: the business's portal table. */
  const byGroup = useMemo(
    () =>
      GROUPS.map((g) => ({
        label: g.label,
        at: (m: PortalMetric, i: number) => sumOrNull(g.portals.map((p) => data.monthly[m]?.[p]?.[i])),
      })),
    [data.monthly],
  );
  /** Property Finder's share of the two-portal total, or null when either side is missing or both are zero. */
  const pfShare = (m: PortalMetric, i: number) => {
    const pf = byGroup[0].at(m, i);
    const bd = byGroup[1].at(m, i);
    return pf == null || bd == null || pf + bd === 0 ? null : pf / (pf + bd);
  };

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

  /** Shares are of the AREA-attributable total, not the headline reservation
   *  count — reservations with no linked property have no area and would make
   *  the shares silently sum to less than 100%. */
  const areaTotal = useMemo(() => data.areas.reduce((s, a) => s + a.reservations, 0), [data.areas]);
  const topArea = data.areas.length ? data.areas[0] : null;

  const areaChart = useMemo(() => {
    const top = areas.slice(0, 15);
    return {
      labels: top.map((a) => a.area),
      datasets: [{ label: "Reservations", data: top.map((a) => a.reservations), backgroundColor: C.blue, borderRadius: 4 }],
    };
  }, [areas]);

  const baseOpts = {
    responsive: true,
    plugins: { legend: { position: "bottom" as const, labels: { boxWidth: 12, font: { size: 11 } } } },
    scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } },
  };

  if (!data.connected) {
    return (
      <div className="chart-card">
        <h2>Portals</h2>
        <p style={{ color: C.mid, fontSize: 13 }}>
          Not connected to the CRM. Set <code>METABASE_URL</code> and either <code>METABASE_API_KEY</code> or{" "}
          <code>METABASE_USERNAME</code> / <code>METABASE_PASSWORD</code>.
        </p>
      </div>
    );
  }

  const kpis: { label: string; value: string; tip: string; color?: string }[] = [
    { label: "Portal leads", value: fmtInt(tot.leads), tip: "Leads whose enquiry source is Property Finder, Bayut or Dubizzle, by the day they were created. Test forms, staff and internal cards are left out, as on every tab." },
    { label: "Viewings completed", value: fmtInt(tot.viewings), tip: "Viewing activities marked Completed on portal leads, by the day the viewing took place." },
    { label: "Viewings per 100 leads", value: fmt1(per100(tot.viewings, tot.leads)), tip: "Viewings completed in the period for every 100 portal leads created in it. A period ratio: a viewing can follow its lead by weeks." },
    { label: "Reservations", value: fmtInt(tot.reservations), tip: "Portal deals by the day they were reserved (status Reserved, Closed or Completed, not withdrawn). The deal's portal is its lead's enquiry source." },
    { label: "Reserved commission", value: fmtAED(tot.reservedComm), color: C.green, tip: "The reserved gross commission of those reservations." },
    { label: "Invoiced deals", value: fmtInt(tot.invoiced), tip: "Portal deals by the day they were invoiced." },
    { label: "Invoiced commission", value: fmtAED(tot.invoicedComm), color: C.green, tip: "The final gross commission of those invoiced deals." },
    { label: "Reservations per 100 leads", value: fmt1(per100(tot.reservations, tot.leads)), tip: "Reservations in the period for every 100 portal leads created in it. A period ratio, not a cohort: a deal can be reserved months after its lead." },
  ];

  return (
    <>
      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="filter-grid" style={{ marginBottom: 18 }}>
        {/* Named "This year" when the range is the year to date, the default; any other range is a custom one. */}
        <DateRangePicker
          key={pickerKey}
          initialKey={from === rangeFor("this_year").from && to === rangeFor("this_year").to ? "this_year" : "custom"}
          initialFrom={from}
          initialTo={to}
          onApply={pickRange}
        />
        <div style={{ display: "flex", gap: 4, alignSelf: "center" }} role="tablist" aria-label="Business side">
          {([["all", "All"], ["sale", "Sale"], ["leasing", "Leasing"]] as [Side, string][]).map(([k, lbl]) => (
            <button key={k} role="tab" aria-selected={side === k} className={`filter-btn${side === k ? " active" : ""}`} onClick={() => pickSide(k)}>
              {lbl}
            </button>
          ))}
        </div>
        <select className="search-box" style={{ width: 150 }} value={brand} onChange={(e) => pickBrand(e.target.value)} aria-label="Brand">
          {data.brands.map((b) => (
            <option key={b.key} value={b.key}>{b.label}</option>
          ))}
        </select>
      </div>

      {/* Everything below waits for the whole payload, so no figure sits beside one that hasn't landed. */}
      {loading ? (
        <PortalsSkeleton />
      ) : (
        <>
      {data.error && (
        <div className="chart-card" style={{ marginBottom: 18, borderColor: C.red }}>
          <strong style={{ color: C.red }}>CRM error.</strong> <span style={{ fontSize: 13 }}>{data.error}</span>
        </div>
      )}
      {loadError && (
        <div className="chart-card" style={{ marginBottom: 18, borderColor: C.red }}>
          <strong style={{ color: C.red }}>Couldn&apos;t load that selection.</strong>{" "}
          <span style={{ fontSize: 13 }}>Still showing {data.label}. ({loadError})</span>
        </div>
      )}

      {data.cachedAt && (
        <div style={{ fontSize: 11.5, color: C.mid, margin: "0 0 10px" }}>
          Figures from the Engage CRM
          <UpdatedAgo at={data.cachedAt} />
        </div>
      )}
      {/* ── KPIs ─────────────────────────────────────────────────── */}
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        {kpis.map((k) => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-label">
              {k.label} <HelpTip text={k.tip} />
            </div>
            <div className="kpi-value" style={k.color ? { color: k.color } : undefined}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* ── per-portal table ─────────────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 10 }}>By portal</h3>
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
                  <td style={{ color: C.green }}>{fmtAED(r.v.reservedComm)}</td>
                  <td>{fmtInt(r.v.invoiced)}</td>
                  <td style={{ color: C.green }}>{fmtAED(r.v.invoicedComm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── month by month: Property Finder against Bayut + Dubizzle ── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>
          Month by month{" "}
          <HelpTip text="Property Finder against Bayut and Dubizzle together, the way the business's portal table sets them out. A month the range only partly covers says so." />
        </h3>
        <div style={{ overflowX: "auto" }}>
          <table className="perf-table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Month</th>
                <th>Leads</th>
                <th>Viewings completed</th>
                <th>Viewings per 100 leads</th>
                <th>Reservations</th>
                <th>Reserved comm</th>
                <th>Invoiced deals</th>
                <th>Invoiced comm</th>
              </tr>
            </thead>
            <tbody>
              {byGroup.map((g) => (
                <Fragment key={g.label}>
                  <tr>
                    <td colSpan={8} style={{ fontWeight: 600, color: C.dark, paddingTop: 12 }}>{g.label}</td>
                  </tr>
                  {data.months.map((m, i) => (
                    <tr key={m}>
                      <td>{monthCell(m, data.from, data.to)}</td>
                      <td>{fmtInt(g.at("leads", i))}</td>
                      <td>{fmtInt(g.at("viewings", i))}</td>
                      <td>{fmt1(per100(g.at("viewings", i), g.at("leads", i)))}</td>
                      <td>{fmtInt(g.at("reservations", i))}</td>
                      <td>{fmtAED(g.at("reservedComm", i))}</td>
                      <td>{fmtInt(g.at("invoiced", i))}</td>
                      <td>{fmtAED(g.at("invoicedComm", i))}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr>
                <td colSpan={8} style={{ fontWeight: 600, color: C.dark, paddingTop: 12 }}>Property Finder&apos;s share of the two</td>
              </tr>
              {data.months.map((m, i) => (
                <tr key={`share-${m}`}>
                  <td>{monthCell(m, data.from, data.to)}</td>
                  <td>{fmtPct(pfShare("leads", i), 0)}</td>
                  <td>{fmtPct(pfShare("viewings", i), 0)}</td>
                  <td></td>
                  <td>{fmtPct(pfShare("reservations", i), 0)}</td>
                  <td>{fmtPct(pfShare("reservedComm", i), 0)}</td>
                  <td>{fmtPct(pfShare("invoiced", i), 0)}</td>
                  <td>{fmtPct(pfShare("invoicedComm", i), 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── trend ────────────────────────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Over time{isMoney(metric) ? " (AED)" : ""}</h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {METRIC_KEYS.map((m) => (
              <button key={m} className={`filter-btn${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>
                {METRIC_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
        <div style={{ height: 300 }}>
          <ChartBox type="line" data={trend} options={baseOpts} />
        </div>
      </div>

      {/* ── areas, ranked by reservations ────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>
            Areas by reservations{" "}
            <HelpTip text={`Portal reservations grouped by area, biggest first. Area is ${data.areaSource} — properties sit in a community (a building or sub-development) which sits in a location, and the location is the area. Grouping by community would list towers, not areas. Reservations and reserved commission respect the date range; the listing count is a snapshot of now, because listing_portals keeps no history.`} />
          </h3>
          <input
            className="search-box"
            style={{ width: 200 }}
            placeholder="Search area…"
            value={areaQuery}
            onChange={(e) => setAreaQuery(e.target.value)}
          />
        </div>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
          {topArea ? (
            <>
              <strong>{topArea.area}</strong> leads on {fmtInt(topArea.reservations)} reservations ({fmtAED(topArea.reservedComm)}) ·{" "}
            </>
          ) : null}
          {fmtInt(areas.length)} areas · grouped by <code>{data.areaSource}</code>
        </p>
        {areas.length === 0 ? (
          <p style={{ fontSize: 13, color: C.mid }}>No areas to show for this selection.</p>
        ) : (
          <>
            <div style={{ height: 320, marginBottom: 14 }}>
              <ChartBox
                type="bar"
                data={areaChart}
                options={{ ...baseOpts, indexAxis: "y" as const, plugins: { legend: { display: false } } }}
              />
            </div>
            <div style={{ overflowX: "auto", maxHeight: 340, overflowY: "auto" }}>
              <table className="perf-table" style={{ minWidth: 520 }}>
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Reservations</th>
                    <th>Share of reservations</th>
                    <th>Reserved commission</th>
                    <th>Comm / reservation</th>
                    <th>Listings live</th>
                  </tr>
                </thead>
                <tbody>
                  {areas.map((a) => (
                    <tr key={a.area}>
                      <td>{a.area}</td>
                      <td>{fmtInt(a.reservations)}</td>
                      <td>{areaTotal ? fmtPct(a.reservations / areaTotal) : "—"}</td>
                      <td style={{ color: C.green }}>{fmtAED(a.reservedComm)}</td>
                      <td>{a.reservations > 0 ? fmtAEDExact(a.reservedComm / a.reservations) : "—"}</td>
                      <td>{a.listings ? fmtInt(a.listings) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── how portal_id was resolved, and what stayed unmapped ── */}
      {(data.portalIdsAssumed || data.unmappedPortalIds.length > 0) && (
        <div className="chart-card" style={{ borderColor: C.sand }}>
          <h3 style={{ marginBottom: 4 }}>
            How listings were attributed to portals{" "}
            <HelpTip text="This database has no portals lookup table, so listing_portals.portal_id had to be resolved from the data itself. Shown here because the listing counts depend on it." />
          </h3>
          <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.6 }}>
            Listing counts come from <code>listing_portals</code> where <code>status = &apos;Published&apos;</code>. There
            is no portals lookup table, so <code>portal_id</code> was resolved from evidence:{" "}
            <strong>1 → Property Finder</strong> (its external ids are 26-character ULIDs, a format no other portal
            uses, and it shares ids with none of them). <strong>2 → Bayut, 3 → Dubizzle</strong> — those two carry
            8-digit numeric ids from one range and share the same id on 2,576 listings, which is Bayut and dubizzle
            being one platform. Which of the pair is which <em>cannot</em> be derived; 2 has more published listings
            (3,541 vs 2,523), so 2 is taken as Bayut.{" "}
            <strong>If that&apos;s the wrong way round, set <code>ENGAGE_PORTAL_IDS=1=Property Finder,2=Dubizzle,3=Bayut</code></strong>{" "}
            and it flips without a deploy.
            {data.unmappedPortalIds.length > 0 && (
              <>
                {" "}Also present but unmapped:{" "}
                {data.unmappedPortalIds.map((u) => `portal_id ${u.id} (${fmtInt(u.published)} published)`).join(", ")} —
                left out rather than guessed. Tell me what they are and they can be added.
              </>
            )}
          </div>
        </div>
      )}

      {/* ── notes, deliberately last: context, not headline ─────── */}
      <div className="chart-card" style={{ marginTop: 20 }}>
        <h3 style={{ marginBottom: 8 }}>Notes</h3>
        <ul style={{ fontSize: 12, color: C.mid, lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
          {data.warnings.map((w) => (
            <li key={w} style={{ color: C.amber }}>{w}</li>
          ))}
          <li>
            <strong>Counted as the business&apos;s portal table counts them.</strong> Leads by the day they arrived;
            viewings marked Completed, by the day they took place; reservations by reservation date with the reserved
            commission; invoiced deals by invoice date with the final commission. A viewing or deal belongs to the
            portal its lead came from.
          </li>
          <li>
            <strong>Leads leave out test forms, staff and internal cards</strong>, as on every tab: up to 80 a month
            fewer than a count of every portal lead row (Property Finder, October 2026: 53 from one test contact, 24 on
            bhomes or vendor addresses, 3 on internal cards).
          </li>
          <li>
            <strong>Per 100 leads is a period ratio, not a cohort.</strong> A viewing or reservation can come weeks or
            months after its lead, so it divides what happened in the period by the leads that arrived in it.
          </li>
          <li>
            <strong>No portal spend.</strong> It is moving to Metabase, and will be read from there.
          </li>
        </ul>
      </div>
        </>
      )}
    </>
  );
}
