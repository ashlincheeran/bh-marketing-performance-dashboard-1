"use client";

// Portals — the listing-portal channel (Property Finder, Bayut, Dubizzle) and
// the unit economics of it.
//
// Spend is REAL, from the PPA workbook's monthly expense schedule (see
// lib/portalSpend.ts) — not an assumption. Only spend is taken from that
// workbook; deals, leads and commission stay live from the CRM.
//
// Spend is each month's RECORDED figure, pro-rated by the days of it in the
// range, and cost per lead, cost per deal, net and return on spend divide it by
// the leads, deals and commission of those same months (portalEconomics). It
// used to be an average rate times the calendar months touched: "Last 30 days"
// paid for two months, and Apr–Oct 2026, which the workbook doesn't cover,
// carried AED 6.4M of spend labelled actual.
//
// Range, brand and the Sale/Leasing side all refetch. The workbook doesn't
// split spend by side or brand, so under either filter the cost figures are
// blank rather than charging all the spend to a slice. Spend recomputes
// client-side, so editing a rate is instant.
//
// Area = locations.name, one level above communities: a community is a building
// ("Al Meraikhi Tower"), a location is the area ("Dubai Marina"). See lib/portals.ts.
import { useCallback, useMemo, useRef, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import DateRangePicker from "@/components/DateRangePicker";
import { C } from "@/lib/theme";
import type { PortalsData, Side } from "@/lib/portals";
import { SPEND_MONTHS, SPEND_SOURCE_LABEL, SPEND_SPAN, portalEconomics, sumOrNull } from "@/lib/portalSpend";

/** null is a figure that failed to load or doesn't apply: "—", never 0. */
const fmtInt = (n: number | null) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n || 0)));
const fmtAED = (n: number | null) => {
  if (n == null) return "—";
  const a = Math.abs(n || 0);
  if (a >= 1e6) return `AED ${((n || 0) / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `AED ${Math.round((n || 0) / 1e3)}K`;
  return `AED ${Math.round(n || 0)}`;
};
/** Exact dirhams — for per-unit costs, where rounding to "K" would hide the number. */
const fmtAEDExact = (n: number | null) =>
  n == null || !Number.isFinite(n) ? "—" : `AED ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)}`;
const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);
const fmtX = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}×`);

const PORTAL_COLOR: Record<string, string> = {
  "Property Finder": C.amber,
  Bayut: C.green,
  Dubizzle: C.red,
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => {
  const [y, mm] = m.split("-");
  return `${MONTH_SHORT[Number(mm) - 1] ?? mm} ${String(y).slice(2)}`;
};

type Metric = "leads" | "deals" | "commission";

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
      {[300, 260, 300].map((h, i) => (
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

  /**
   * Per-portal monthly spend override, AED. Empty = the recorded figures from
   * the PPA workbook. There is no single "total spend" input any more: spend is
   * known per portal, so a total would have to be split by a guess.
   */
  const [rateOverride, setRateOverride] = useState<Record<string, string>>({});
  const [metric, setMetric] = useState<Metric>("leads");
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
      setLoadError(e instanceof Error ? e.message : String(e));
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

  /** Monthly figures typed into the table, replacing the recorded ones. */
  const overrides = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(rateOverride)
          .filter(([, raw]) => raw !== "")
          .map(([p, raw]) => [p, Math.max(0, Number(raw.replace(/[^0-9.]/g, "")) || 0)]),
      ) as Record<string, number>,
    [rateOverride],
  );

  const monthCount = data.months.length;
  const anyOverride = Object.keys(overrides).length > 0;

  /**
   * Spend and every cost ratio, over the months with RECORDED spend and against
   * the leads, deals and commission of those months. Null — "—" — when a query
   * failed, when the period has no recorded spend, or under a side or brand
   * filter the workbook can't split. Ratios are null rather than 0 when the
   * denominator is 0, so "no deals" never renders as "zero cost".
   */
  const cost = useMemo(() => portalEconomics(data, overrides), [data, overrides]);

  /** Per portal: leads, deals and commission over the whole range; spend and cost over the recorded months. */
  const econ = useMemo(
    () =>
      rows.map((r) => {
        const c = cost.rows.find((x) => x.portal === r.portal);
        return {
          ...r,
          conv: r.leads && r.deals != null ? r.deals / r.leads : null,
          rate: c?.rate ?? null,
          spend: c?.spend ?? null,
          /** Commission in the recorded months: what the spend is set against. */
          spendComm: c?.spend == null ? null : c.commission,
          cpl: c?.cpl ?? null,
          cpd: c?.cpd ?? null,
          net: c?.net ?? null,
          roas: c?.roas ?? null,
        };
      }),
    [rows, cost],
  );

  const tot = useMemo(() => {
    const leads = sumOrNull(rows.map((r) => r.leads));
    const deals = sumOrNull(rows.map((r) => r.deals));
    const commission = sumOrNull(rows.map((r) => r.commission));
    const { rate, spend, cpl, cpd, net, roas } = cost.total;
    return { leads, deals, commission, conv: leads && deals != null ? deals / leads : null, rate, spend, cpl, cpd, net, roas };
  }, [rows, cost]);

  const series = metric === "leads" ? data.leadsByMonth : metric === "deals" ? data.dealsByMonth : data.commByMonth;
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

  const costChart = useMemo(
    () => ({
      labels: econ.map((r) => r.portal),
      // null stays null — a gap. As 0 it drew "zero cost" for a portal with no
      // leads or deals, the very reading the null ratios exist to prevent.
      datasets: [
        { label: "Cost / lead", data: econ.map((r) => r.cpl), backgroundColor: C.blue, borderRadius: 4 },
        { label: "Cost / deal", data: econ.map((r) => r.cpd), backgroundColor: C.amber, borderRadius: 4, hidden: true },
      ],
    }),
    [econ],
  );

  const spendVsComm = useMemo(
    () => ({
      labels: econ.map((r) => r.portal),
      datasets: [
        { label: "Portal spend", data: econ.map((r) => r.spend), backgroundColor: C.sand, borderRadius: 4 },
        { label: "Gross commission", data: econ.map((r) => r.spendComm), backgroundColor: C.green, borderRadius: 4 },
      ],
    }),
    [econ],
  );

  const areas = useMemo(() => {
    const q = areaQuery.trim().toLowerCase();
    return q ? data.areas.filter((a) => a.area.toLowerCase().includes(q)) : data.areas;
  }, [data.areas, areaQuery]);

  /** Shares are of the AREA-attributable total, not the headline deal count —
   *  deals with no linked property have no area and would make the shares
   *  silently sum to less than 100%. */
  const areaDealTotal = useMemo(() => data.areas.reduce((s, a) => s + a.deals, 0), [data.areas]);
  const topArea = data.areas.length ? data.areas[0] : null;

  const areaChart = useMemo(() => {
    const top = areas.slice(0, 15);
    return {
      labels: top.map((a) => a.area),
      datasets: [{ label: "Deals", data: top.map((a) => a.deals), backgroundColor: C.blue, borderRadius: 4 }],
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

  return (
    <>
      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="filter-grid" style={{ marginBottom: 18 }}>
        <DateRangePicker key={pickerKey} initialKey="custom" initialFrom={from} initialTo={to} onApply={pickRange} />
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
        <span style={{ fontSize: 12, color: C.mid, alignSelf: "center" }}>
          Spend recorded: {SPEND_SPAN}
          {anyOverride ? <strong style={{ color: C.amber }}> (edited)</strong> : null}
        </span>
        <HelpTip text={`Monthly portal spend from ${SPEND_SOURCE_LABEL}, each month pro-rated by the days of it in the range. Months it doesn't cover add nothing and are left out of every cost figure, not estimated. Override a portal's monthly figure in the table below.`} />
      </div>

      {/* Everything below waits for the whole payload — a partial fill would show
          cost per lead against a lead count that hasn't landed yet. */}
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

      {/* ── KPIs ─────────────────────────────────────────────────── */}
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        {[
          { label: "Portal leads", value: fmtInt(tot.leads), tip: "Leads whose enquiry_source is Property Finder, Bayut or Dubizzle, created in the selected period." },
          { label: "Portal deals", value: fmtInt(tot.deals), tip: "Deals (Reserved/Closed/Completed, not Withdrawn) dated by reservation, whose originating lead came from a portal." },
          { label: "Lead → deal", value: fmtPct(tot.conv), tip: "Portal deals ÷ portal leads in the same period. A deal can be reserved in a later month than its lead arrived, so this is a period ratio, not a cohort conversion." },
          { label: "Gross commission", value: fmtAED(tot.commission), color: C.green, tip: "final_gross_commission_amount summed over portal deals." },
          { label: "Portal spend", value: fmtAED(tot.spend), tip: `Recorded spend from ${SPEND_SOURCE_LABEL}, each month pro-rated by the days of it in the range. Months the workbook doesn't cover add nothing.` },
          { label: "Cost / lead", value: fmtAEDExact(tot.cpl), tip: "Portal spend ÷ portal leads created in the months with recorded spend." },
          { label: "Cost / deal", value: fmtAEDExact(tot.cpd), tip: "Portal spend ÷ portal deals reserved in the months with recorded spend." },
          { label: "Return on spend", value: fmtX(tot.roas), color: tot.roas == null ? undefined : tot.roas >= 1 ? C.green : C.red, tip: "Gross commission ÷ portal spend, both over the months with recorded spend. Above 1× means commission exceeded spend." },
        ].map((k) => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-label">
              {k.label} <HelpTip text={k.tip} />
            </div>
            <div className="kpi-value" style={k.color ? { color: k.color } : undefined}>{k.value}</div>
          </div>
        ))}
      </div>
      {/* What the cost figures cover, beside them rather than down in the notes. */}
      <p style={{ fontSize: 12, color: cost.blank ? C.amber : C.mid, margin: "-8px 0 18px" }}>{cost.note}</p>

      {/* ── per-portal table, with the spend split editable inline ── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>By portal</h3>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
          Leads, deals and commission cover the whole range; spend, cost, net and RoS only the months with recorded
          spend. Type a portal&apos;s monthly figure to model a different rate over those months — blank uses the
          recorded figures.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="perf-table" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Portal</th>
                <th>Leads</th>
                <th>Deals</th>
                <th>Lead → deal</th>
                <th>Gross commission</th>
                <th>Spend / month</th>
                <th>Spend in period</th>
                <th>Cost / lead</th>
                <th>Cost / deal</th>
                <th>Net</th>
                <th>RoS</th>
              </tr>
            </thead>
            <tbody>
              {econ.map((r) => (
                <tr key={r.portal}>
                  <td>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: PORTAL_COLOR[r.portal] ?? C.mid, marginRight: 7 }} />
                    {r.portal}
                  </td>
                  <td>{fmtInt(r.leads)}</td>
                  <td>{fmtInt(r.deals)}</td>
                  <td>{fmtPct(r.conv)}</td>
                  <td style={{ color: C.green }}>{fmtAED(r.commission)}</td>
                  <td>
                    <input
                      value={rateOverride[r.portal] ?? ""}
                      placeholder={fmtInt(r.rate)}
                      onChange={(e) => setRateOverride((prev) => ({ ...prev, [r.portal]: e.target.value }))}
                      inputMode="numeric"
                      style={{ width: 82, textAlign: "right", fontSize: 11, padding: "2px 4px", border: "1px solid var(--border)", borderRadius: 4 }}
                      aria-label={`${r.portal} monthly spend in AED`}
                    />
                  </td>
                  <td>{fmtAED(r.spend)}</td>
                  <td>{fmtAEDExact(r.cpl)}</td>
                  <td>{fmtAEDExact(r.cpd)}</td>
                  <td style={{ color: r.net == null ? undefined : r.net >= 0 ? C.green : C.red }}>{fmtAED(r.net)}</td>
                  <td>{fmtX(r.roas)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 600, borderTop: `2px solid var(--border)` }}>
                <td>Total</td>
                <td>{fmtInt(tot.leads)}</td>
                <td>{fmtInt(tot.deals)}</td>
                <td>{fmtPct(tot.conv)}</td>
                <td style={{ color: C.green }}>{fmtAED(tot.commission)}</td>
                <td>{fmtAED(tot.rate)}</td>
                <td>{fmtAED(tot.spend)}</td>
                <td>{fmtAEDExact(tot.cpl)}</td>
                <td>{fmtAEDExact(tot.cpd)}</td>
                <td style={{ color: tot.net == null ? undefined : tot.net >= 0 ? C.green : C.red }}>{fmtAED(tot.net)}</td>
                <td>{fmtX(tot.roas)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── trend ────────────────────────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Over time</h3>
          <div style={{ display: "flex", gap: 6 }}>
            {(["leads", "deals", "commission"] as Metric[]).map((m) => (
              <button key={m} className={`filter-btn${metric === m ? " active" : ""}`} onClick={() => setMetric(m)}>
                {m === "commission" ? "Commission" : m === "leads" ? "Leads" : "Deals"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ height: 300 }}>
          <ChartBox type="line" data={trend} options={baseOpts} />
        </div>
      </div>

      <div className="chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 18, marginBottom: 20 }}>
        <div className="chart-card">
          <h3 style={{ marginBottom: 4 }}>Cost per lead & per deal</h3>
          <p style={{ fontSize: 11, color: C.mid, marginBottom: 8 }}>
Toggle &ldquo;Cost / deal&rdquo; in the legend — it&apos;s an order of magnitude larger, so
            it starts hidden to keep the lead bars readable.
          </p>
          <div style={{ height: 260 }}>
            {cost.blank ? <p style={{ fontSize: 13, color: C.mid }}>{cost.blank}</p> : <ChartBox type="bar" data={costChart} options={baseOpts} />}
          </div>
        </div>
        <div className="chart-card">
          <h3 style={{ marginBottom: 4 }}>Spend vs gross commission</h3>
          <p style={{ fontSize: 11, color: C.mid, marginBottom: 8 }}>
            Both over the months with recorded spend — commission from the CRM, spend from the workbook.
          </p>
          <div style={{ height: 260 }}>
            {cost.blank ? <p style={{ fontSize: 13, color: C.mid }}>{cost.blank}</p> : <ChartBox type="bar" data={spendVsComm} options={baseOpts} />}
          </div>
        </div>
      </div>

      {/* ── areas, ranked by deals ───────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>
            Areas by deals{" "}
            <HelpTip text={`Portal deals grouped by area, biggest first. Area is ${data.areaSource} — properties sit in a community (a building or sub-development) which sits in a location, and the location is the area. Grouping by community would list towers, not areas. Deals and commission respect the date range; the listing count is a snapshot of now, because listing_portals keeps no history.`} />
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
              <strong>{topArea.area}</strong> leads on {fmtInt(topArea.deals)} deals ({fmtAED(topArea.commission)}) ·{" "}
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
                    <th>Deals</th>
                    <th>Share of deals</th>
                    <th>Gross commission</th>
                    <th>Comm / deal</th>
                    <th>Listings live</th>
                  </tr>
                </thead>
                <tbody>
                  {areas.map((a) => (
                    <tr key={a.area}>
                      <td>{a.area}</td>
                      <td>{fmtInt(a.deals)}</td>
                      <td>{areaDealTotal ? fmtPct(a.deals / areaDealTotal) : "—"}</td>
                      <td style={{ color: C.green }}>{fmtAED(a.commission)}</td>
                      <td>{a.deals > 0 ? fmtAEDExact(a.commission / a.deals) : "—"}</td>
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
            (3,541 vs 2,523), matching Bayut&apos;s far larger spend, so 2 is taken as Bayut.{" "}
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
            <strong>Spend source.</strong> Portal spend is the month-by-month schedule in {SPEND_SOURCE_LABEL}, each
            month pro-rated by the days of it in the range{tot.spend != null ? <> — {fmtAED(tot.spend)} here</> : null}.
            Cost per lead, cost per deal, net and return on spend divide it by the leads, deals and commission of the
            same months; those are live CRM figures.
          </li>
          <li>
            <strong>Dubizzle&apos;s monthly figure is derived.</strong> Property Finder and Bayut have true
            month-by-month schedules in the workbook; Dubizzle appears only as a period total, so its monthly rate is
            that total spread evenly over {SPEND_MONTHS} months — right in size, assumed in shape.
          </li>
          {monthCount > cost.covered.length && (
            <li>
              <strong>
                {monthCount - cost.covered.length} of the {monthCount} month{monthCount === 1 ? "" : "s"} in view{" "}
                {monthCount - cost.covered.length === 1 ? "has" : "have"} no recorded spend.
              </strong>{" "}
              They are left out of spend and every cost figure rather than estimated; leads, deals and commission
              above still cover the whole range.
            </li>
          )}
          <li>
            <strong>Deal counts here will not match the PPA workbook.</strong> The workbook holds about 4,600 deals
            across all sources; the CRM has more than that from portals alone. This page uses the CRM definition —
            status Reserved/Closed/Completed, not Withdrawn, dated by reservation — which reproduces the verified
            &ldquo;Leads &amp; deals by channel&rdquo; report to the dirham (Jan 2025: 970 deals / AED 9,502,546).
            The workbook&apos;s extract is narrower, so its cost per deal reads higher.
          </li>
          <li>
            <strong>Lead → deal is a period ratio, not a cohort.</strong> A deal can be reserved in a later month
            than its lead arrived, so it divides deals in the period by leads in the same period.
          </li>
        </ul>
      </div>
        </>
      )}
    </>
  );
}
