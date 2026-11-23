"use client";

// The Dashboard: the business at a glance. Every figure links to the tab that
// owns it, so this stays a summary rather than a second source of truth.
//
// In four parts, in the order the business asked for them (23 Nov 2026):
//   1. Gross commission, split by the source it came from (the channel the
//      deal's enquiry came in through), beside how the listing portals did.
//   2. The best areas across the whole business, by leads, viewings, deals
//      (reservations included) and commission (lib/areas.ts).
//   3. Revenue for the year to date, month by month.
//   4. Two key figures from each marketing channel: PR and people sentiment,
//      social, digital and SEO.
//
// One Period picker sets the range parts 1, 2 and 4 follow: by default the
// year to date, resolved by the page on Dubai's calendar. Part 3 is always the
// year to date. Social followers are a count at the latest capture and share
// of voice the year to date, so those two say their own date.
//
// Each source is fetched INDEPENDENTLY and rendered as soon as it lands: nothing
// here is divided across sources, so a slow Supermetrics call shouldn't hold up
// CRM figures that are already in.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import ChartBox from "@/components/Chart";
import DateRangePicker from "@/components/DateRangePicker";
import { BarList, Filter, FilterBar, Pills, Section } from "@/components/ui";
import { C, PORTAL_COLORS, SIDE_COLORS, channelColor } from "@/lib/theme";
import { daysInMonth, isPresetKey, type RangeKey } from "@/lib/dateRanges";
import { dayLabel, dayMonth, fmtAED, fmtAEDExact, fmtInt, fmtMoney, fmtPct, monthShort, sharePct, sumOrNull } from "@/lib/format";
import { spendBetween } from "@/lib/portalSpend";
import type { AreaFigureKey, AreaSide, BusinessArea, BusinessAreas } from "@/lib/areas";
import type { CompanyData } from "@/lib/company";
import type { PortalsData } from "@/lib/portals";
import type { SummaryData } from "@/app/api/summary/route";
import type { SeoReport } from "@/lib/seoReport";

const DIVISIONS = ["Offplan", "Secondary", "Leasing"] as const;
/** A Company block's total for one channel: every division, every month. */
const channelTotal = (block: CompanyData["comm"], ch: string) =>
  DIVISIONS.reduce((t, d) => t + (block[d]?.[ch]?.reduce((a, b) => a + b, 0) ?? 0), 0);
/** A Company block month by month: every division and channel added up. */
const monthly = (block: CompanyData["comm"], months: number) =>
  Array.from({ length: months }, (_, i) =>
    DIVISIONS.reduce((t, d) => t + Object.values(block[d] ?? {}).reduce((a, arr) => a + (arr[i] ?? 0), 0), 0),
  );

/** What the best-areas tabs rank by, as the business named them. */
const AREA_TABS = [
  ["leads", "Leads"],
  ["viewings", "Viewings"],
  ["deals", "Deals"],
  ["commission", "Commission"],
  ["listings", "Listings"],
] as const satisfies readonly (readonly [AreaFigureKey, string])[];
const AREA_NOUN: Record<AreaFigureKey, string> = { leads: "leads", viewings: "viewings", deals: "deals", commission: "commission", listings: "listings live" };
/** How many areas the ranking shows. */
const AREA_TOP = 10;
const fmtAreaFigure = (k: AreaFigureKey, v: number) => (k === "commission" ? fmtAED(v) : fmtInt(v));
const SIDE_NAME = { sales: "Sales", leasing: "Leasing" } as const;
/** Sales first, then leasing, as their colours are listed (lib/theme.ts); lib/areas.ts is server-side, so only its types come here. */
const SIDES = Object.keys(SIDE_COLORS) as AreaSide[];

/**
 * A feed's JSON, asked once more when the first answer is a server error or no
 * answer at all. Three long CRM feeds answered 502 together in one load of this
 * page, blanking their tiles, and answered 200 when asked again.
 */
async function getJson(url: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status >= 500 && attempt < 2) {
        await new Promise((ok) => setTimeout(ok, 1500));
        continue;
      }
      return await r.json();
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
}

/** `currency` is null when the accounts bill in more than one: their spend cannot be added. */
type PaidSummary = { spend: number; leads: number; currency: string | null };

/** One figure of a channel card, linking to its tab. */
function Metric({ label, value, sub, href, loading }: { label: string; value: string; sub?: ReactNode; href: string; loading: boolean }) {
  return (
    <Link href={href} className="dash-metric">
      <span className="kpi-label">{label}</span>
      {loading ? <span className="skeleton" style={{ display: "block", width: "55%", height: 20, marginTop: 4 }} /> : <span className="dash-metric-value">{value}</span>}
      {sub && !loading ? <span className="dash-metric-sub">{sub}</span> : null}
    </Link>
  );
}

/** A marketing channel's two key figures. */
function ChannelCard({ title, href, children }: { title: string; href: string; children: ReactNode }) {
  return (
    <div className="chart-card dash-channel">
      <Link href={href} className="dash-channel-title">{title}</Link>
      <div className="dash-metrics">{children}</div>
    </div>
  );
}

export default function CeoDashboard({ initialFrom, initialTo }: {
  /** The year to date, as the page resolved it on Dubai's calendar: what the Dashboard opens on. */
  initialFrom: string;
  initialTo: string;
}) {
  const [range, setRange] = useState<{ from: string; to: string; key: RangeKey }>({ from: initialFrom, to: initialTo, key: "this_year" });
  /** The year to date, for part 3 whatever the Period; and part 1's figures while the Period is the year to date. */
  const [companyYtd, setCompanyYtd] = useState<CompanyData | null>(null);
  /** The Company figures for any other Period. */
  const [companyRange, setCompanyRange] = useState<CompanyData | null>(null);
  const [portals, setPortals] = useState<PortalsData | null>(null);
  const [areas, setAreas] = useState<BusinessAreas | null>(null);
  const [paid, setPaid] = useState<PaidSummary | null>(null);
  const [seo, setSeo] = useState<SeoReport | null>(null);
  const [extra, setExtra] = useState<SummaryData | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [areaFigure, setAreaFigure] = useState<AreaFigureKey>("commission");

  const fail = useCallback((what: string) => setFailed((f) => (f.includes(what) ? f : [...f, what])), []);
  /** The year to date is asked for once; the Period's own Company figures only when it is something else. */
  const isYtd = range.from === initialFrom && range.to === initialTo;
  const company = isYtd ? companyYtd : companyRange;
  const companyFailed = failed.includes(isYtd ? "Year to date" : "Company");

  /** A new range: every figure that follows it is asked for again, and shows as loading until its answer lands. */
  const pickRange = (from: string, to: string, key: RangeKey) => {
    if (from === range.from && to === range.to) return;
    setCompanyRange(null);
    setPortals(null);
    setAreas(null);
    setPaid(null);
    setSeo(null);
    setExtra(null);
    // The year to date does not follow the Period: its failure, if any, stands.
    setFailed((f) => f.filter((x) => x === "Year to date"));
    setRange({ from, to, key });
  };

  useEffect(() => {
    let live = true;
    // Unconfigured Metabase answers with zero series and no error; that is not a real zero either.
    getJson("/api/company")
      .then((j) => { if (live && Array.isArray(j?.months) && j?.connected !== false) setCompanyYtd(j); else if (live) fail("Year to date"); })
      .catch(() => live && fail("Year to date"));
    return () => { live = false; };
  }, [fail]);

  useEffect(() => {
    // Cleared when the range changes, so an answer for the range before never lands on this one.
    let live = true;
    const span = `from=${range.from}&to=${range.to}`;
    // Independent, so one slow source doesn't gate the others.
    if (!isYtd) {
      getJson(`/api/company?${span}`)
        .then((j) => { if (live && Array.isArray(j?.months) && j?.connected !== false) setCompanyRange(j); else if (live) fail("Company"); })
        .catch(() => live && fail("Company"));
    }
    getJson(`/api/portals?${span}`)
      // A payload with `error` carries blank figures, not real ones: a failure.
      .then((j) => { if (live && Array.isArray(j?.rows) && !j?.error && j?.connected !== false) setPortals(j); else if (live) fail("Portals"); })
      .catch(() => live && fail("Portals"));
    getJson(`/api/areas?${span}`)
      .then((j) => { if (live && Array.isArray(j?.areas) && j?.connected !== false) setAreas(j); else if (live) fail("Areas"); })
      .catch(() => live && fail("Areas"));
    getJson(`/api/digital?${span}`)
      .then((j) => {
        if (!live) return;
        const rows = Array.isArray(j?.byDateFine) ? j.byDateFine : null;
        // Paused, unconfigured and failed reads all arrive as 200 with no rows;
        // shown as AED 0 they would read as a period without advertising.
        if (!rows || j?.error || j?.paused || j?.unconfigured || j?.connected === false) return fail("Digital");
        const currencies: string[] = Array.isArray(j?.currencies) ? j.currencies : [];
        setPaid({
          spend: rows.reduce((s: number, r: { cost?: number }) => s + (r.cost ?? 0), 0),
          leads: rows.reduce((s: number, r: { leads?: number }) => s + (r.leads ?? 0), 0),
          currency: currencies.length > 1 ? null : (currencies[0] ?? "AED"),
        });
      })
      .catch(() => live && fail("Digital"));
    // A named range goes by its name: the server resolves it on Dubai's calendar, as the SEO feed's warm-up does.
    getJson(`/api/seo?${isPresetKey(range.key) ? `preset=${range.key}` : span}`)
      .then((j) => { if (live && j?.gsc && j?.ai) setSeo(j); else if (live) fail("SEO"); })
      .catch(() => live && fail("SEO"));
    getJson(`/api/summary?${span}`)
      // A press read that failed on its own comes as pr.error beside real social
      // figures: the social figures stay, and only the press figure is blank.
      .then((j) => {
        if (!live) return;
        if (!j?.pr || !j?.social || j?.error) return fail("PR & social");
        setExtra(j);
        if (j.pr.error) fail("PR");
      })
      .catch(() => live && fail("PR & social"));
    return () => { live = false; };
  }, [range, isYtd, fail]);

  // ── 1. Gross commission, by source ───────────────────────────────
  const dealsUp = !!company && !company.dealsError;
  const companyPending = !company && !companyFailed;
  const bySource = useMemo(() => {
    if (!company || company.dealsError) return null;
    const rows = company.channels
      .map((ch) => ({ ch, comm: channelTotal(company.comm, ch), deals: channelTotal(company.deals, ch) }))
      .filter((r) => r.comm > 0)
      .sort((a, b) => b.comm - a.comm);
    const comm = rows.reduce((s, r) => s + r.comm, 0);
    const deals = company.channels.reduce((s, ch) => s + channelTotal(company.deals, ch), 0);
    return { rows, comm, deals };
  }, [company]);

  // Portals: null when its query failed, "—" never 0. Counted as the Portals tab counts them.
  const portalTotal = (k: "leads" | "reservations" | "reservedComm") => (portals ? sumOrNull(portals.rows.map((r) => r[k])) : null);
  /** What the portals cost over the Period (lib/portalSpend.ts), against the CRM figures that spend pays for. */
  const portalCost = useMemo(() => {
    const c = portals?.cost;
    if (!portals || !c) return null;
    const spend = spendBetween(portals.from, portals.to);
    const leads = sumOrNull(c.leads), reservedComm = sumOrNull(c.reservedComm);
    return {
      spend,
      perLead: spend != null && leads ? spend / leads : null,
      ret: spend && reservedComm != null ? reservedComm / spend : null,
    };
  }, [portals]);
  const fmtPortal = (k: "leads" | "reservations" | "reservedComm") => {
    const v = portalTotal(k);
    return v == null ? "—" : k === "reservedComm" ? fmtAED(v) : fmtInt(v);
  };

  // ── 2. Best areas ────────────────────────────────────────────────
  const areaBest = (k: AreaFigureKey): BusinessArea | null =>
    areas && !areas.failed.includes(k) ? ([...areas.areas].filter((a) => a[k] > 0).sort((a, b) => b[k] - a[k])[0] ?? null) : null;
  const areaRanked = useMemo(
    () => (areas && !areas.failed.includes(areaFigure) ? [...areas.areas].filter((a) => a[areaFigure] > 0).sort((a, b) => b[areaFigure] - a[areaFigure]) : []),
    [areas, areaFigure],
  );
  const areaTotal = areaRanked.reduce((s, a) => s + a[areaFigure], 0);
  const placedLeads = areas && !areas.failed.includes("leads") ? areas.areas.reduce((s, a) => s + a.leads, 0) : null;
  const allLeads = company && !company.leadsError
    ? Object.values(company.leads).reduce((t, s) => t + Object.values(s).reduce((a, arr) => a + arr.reduce((x, y) => x + y, 0), 0), 0)
    : null;
  const areasPending = !areas && !failed.includes("Areas");

  // ── 3. Revenue, year to date ─────────────────────────────────────
  const ytd = useMemo(() => {
    if (!companyYtd || companyYtd.dealsError) return null;
    const months = companyYtd.months;
    const revenue = monthly(companyYtd.comm, months.length);
    const last = months[months.length - 1];
    // The month still in progress says so: a 23-day November beside a full October otherwise reads as a fall.
    const partialTo = last && companyYtd.to.slice(0, 7) === last && Number(companyYtd.to.slice(8, 10)) < daysInMonth(last) ? Number(companyYtd.to.slice(8, 10)) : null;
    return {
      total: revenue.reduce((a, b) => a + b, 0),
      chart: {
        labels: months.map((m) => (m === last && partialTo ? `${monthShort(m)} (1–${partialTo})` : monthShort(m))),
        datasets: [{ label: "Revenue", data: revenue, backgroundColor: C.dark, borderRadius: 4, maxBarThickness: 48 }],
      },
    };
  }, [companyYtd]);

  // ── 4. Channels ──────────────────────────────────────────────────
  // A part PostHog or Search Console did not answer is "—", never 0.
  const gscUp = !!seo && !seo.gsc.error && !!seo.gsc.totals;
  const aiUp = !!seo && !seo.ai.error && !seo.ai.missing.includes("AI totals");
  const prPending = !extra && !failed.includes("PR & social");
  const net = extra?.people?.net ?? null;

  return (
    <>
      <FilterBar>
        <Filter
          label="Period"
          help="Every figure on this page follows this range, except revenue for the year to date, listings by area (the stock held today), social followers (the latest weekly capture) and share of voice (the year to date). Search Console publishes about three days late, so organic clicks stop at its last published day."
        >
          <DateRangePicker initialKey="this_year" initialFrom={initialFrom} initialTo={initialTo} onApply={pickRange} />
        </Filter>
      </FilterBar>
      <div style={{ fontSize: 12, color: C.mid, margin: "0 0 10px" }}>
        {dayLabel(range.from)} – {dayLabel(range.to)}
        {/* The CRM's figures begin in January 2025: a range reaching back before it is read from there. */}
        {company && company.from > range.from ? ` · CRM figures from ${dayLabel(company.from)}` : ""}
      </div>

      {/* 1. Gross commission by source, beside the portals. */}
      <div className="dash-split">
        <Section
          title="Gross commission"
          help="Final gross commission of the deals reserved in the period, as the Company tab counts revenue, split by the source each deal came from: the channel its enquiry came in through."
        >
          {companyPending ? (
            <div className="skeleton" style={{ width: "100%", height: 260 }} />
          ) : !bySource ? (
            <p className="dash-note">{company && !dealsUp ? "Deal figures didn't load from the CRM. Reload to try again." : "—"}</p>
          ) : (
            <>
              <Link href="/company" className="dash-headline">
                <b>{fmtAED(bySource.comm)}</b>
                <span>from {fmtInt(bySource.deals)} deals</span>
              </Link>
              <BarList
                rows={bySource.rows.map((r) => ({
                  name: r.ch,
                  value: r.comm,
                  shown: fmtAED(r.comm),
                  share: bySource.comm ? sharePct(r.comm / bySource.comm) : undefined,
                  color: channelColor(r.ch, company?.channels ?? []),
                  title: `${r.ch}: ${fmtAED(r.comm)} gross commission from ${fmtInt(r.deals)} deal${r.deals === 1 ? "" : "s"}${bySource.comm ? ` · ${fmtPct(r.comm / bySource.comm)} of the total` : ""}`,
                }))}
              />
            </>
          )}
        </Section>

        <Section
          title="Portal performance"
          help="Property Finder, Bayut and Dubizzle from the CRM, as the Portals tab counts them: leads by the day they came in, reservations by reservation date with their reserved commission. The spend is BH DXB and BH ELITE's, set against the Betterhomes and BH Elite divisions' Dubai portal figures."
        >
          {portals ? (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="perf-table" style={{ minWidth: 300 }}>
                  <thead>
                    <tr><th>Portal</th><th>Leads</th><th>Reservations</th><th>Reserved commission</th></tr>
                  </thead>
                  <tbody>
                    {portals.rows.map((r) => (
                      <tr key={r.portal}>
                        <td>
                          <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: PORTAL_COLORS[r.portal] ?? C.mid, marginRight: 7 }} />
                          {r.portal}
                        </td>
                        <td>{r.leads == null ? "—" : fmtInt(r.leads)}</td>
                        <td>{r.reservations == null ? "—" : fmtInt(r.reservations)}</td>
                        <td>{r.reservedComm == null ? "—" : fmtAED(r.reservedComm)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 600 }}>
                      <td>Total</td>
                      <td>{fmtPortal("leads")}</td>
                      <td>{fmtPortal("reservations")}</td>
                      <td>{fmtPortal("reservedComm")}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {portalCost && (
                <div className="dash-metrics dash-metrics-3" style={{ marginTop: 14 }}>
                  <Metric href="/portals" label="Portal spend" value={portalCost.spend == null ? "—" : fmtAED(portalCost.spend)} loading={false} />
                  <Metric href="/portals" label="Cost per lead" value={fmtAEDExact(portalCost.perLead)} loading={false} />
                  <Metric href="/portals" label="Return on spend" value={portalCost.ret == null ? "—" : `${portalCost.ret.toFixed(1)}×`} loading={false} />
                </div>
              )}
            </>
          ) : failed.includes("Portals") ? (
            <p className="dash-note">—</p>
          ) : (
            <div className="skeleton" style={{ width: "100%", height: 220 }} />
          )}
        </Section>
      </div>

      {/* 2. Best areas, the whole business. */}
      <Section
        title="Best areas"
        help="Every channel together, counted as the Company tab counts the business: leads by the day they came in, completed viewings, deals by reservation date (so reservations count), and their final gross commission. A lead and its viewings take the area of the listing the enquiry was about, a deal the area of its own listing; what names no property has no area. Listings are the stock we hold today, whatever the Period: every listing the CRM has as Active, public or private, in its property's area. Sales and leasing split as on the Company tab: Buyer and Seller leads are sales, Tenant and Landlord leasing; a deal or listing is leasing when it is a rental."
        sub="Across the whole business, every channel · listings as held today"
        actions={<Pills label="Area figure" options={AREA_TABS} value={areaFigure} onChange={setAreaFigure} />}
      >
        <div className="kpi-strip cols-5" style={{ marginBottom: 16 }}>
          {AREA_TABS.map(([k, label]) => {
            const best = areaBest(k);
            return (
              <div key={k} className="kpi-card dash-best">
                <span className="kpi-label">Best for {label.toLowerCase()}</span>
                {areasPending ? (
                  <span className="skeleton" style={{ display: "block", width: "60%", height: 18, marginTop: 4 }} />
                ) : (
                  <>
                    <span className="dash-best-area">{best ? best.area : "—"}</span>
                    {best ? <span className="dash-metric-sub">{fmtAreaFigure(k, best[k])} {AREA_NOUN[k]}</span> : null}
                    {best && best[k] > 0 ? (
                      <span className="dash-metric-sub">
                        {sharePct(best.sides.sales[k] / best[k])} sales · {sharePct(best.sides.leasing[k] / best[k])} leasing
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {areasPending ? (
          <div className="skeleton" style={{ width: "100%", height: 240 }} />
        ) : !areas || areas.failed.includes(areaFigure) ? (
          <p className="dash-note">{AREA_TABS.find(([k]) => k === areaFigure)?.[1]} by area didn&apos;t load from the CRM. Reload to try again.</p>
        ) : areaRanked.length === 0 ? (
          <p className="dash-note">No {AREA_NOUN[areaFigure]} with an area {areaFigure === "listings" ? "today" : "in this period"}.</p>
        ) : (
          <BarList
            legend={{ items: SIDES.map((side) => ({ label: SIDE_NAME[side], color: SIDE_COLORS[side] })), note: "each side's share of the area" }}
            rows={areaRanked.slice(0, AREA_TOP).map((a) => ({
              name: a.area,
              value: a[areaFigure],
              shown: fmtAreaFigure(areaFigure, a[areaFigure]),
              parts: SIDES.map((side) => ({ value: a.sides[side][areaFigure], color: SIDE_COLORS[side] })),
              color: C.blue,
              title:
                `${a.area}: ${fmtAreaFigure(areaFigure, a[areaFigure])} ${AREA_NOUN[areaFigure]}` +
                (areaTotal ? `, ${sharePct(a[areaFigure] / areaTotal)} of all areas` : "") +
                ` · sales ${fmtAreaFigure(areaFigure, a.sides.sales[areaFigure])} · leasing ${fmtAreaFigure(areaFigure, a.sides.leasing[areaFigure])}`,
            }))}
          />
        )}
        {placedLeads != null && allLeads != null && allLeads > 0 ? (
          <p className="dash-note">
            Each bar is split into sales and leasing, with each side&apos;s share of the area; hover a bar for its share of all areas. Of the period&apos;s {fmtInt(allLeads)} leads, {fmtInt(placedLeads)} ({fmtPct(placedLeads / allLeads, 0)}) name a property; the rest have no area.
          </p>
        ) : null}
      </Section>

      {/* 3. Revenue for the year to date, whatever the Period. */}
      <Section
        title="Revenue, year to date"
        help="Final gross commission of the deals reserved since 1 January, month by month, as the Company tab counts revenue. Always the year to date, whatever the Period above."
        sub={ytd && companyYtd ? `${fmtAED(ytd.total)} · ${dayLabel(companyYtd.from)} – ${dayLabel(companyYtd.to)}` : undefined}
      >
        <div style={{ height: 280 }}>
          {ytd ? (
            <ChartBox
              type="bar"
              data={ytd.chart}
              options={{
                responsive: true,
                plugins: {
                  legend: { display: false },
                  tooltip: { callbacks: { label: (ctx: { parsed: { y: number } }) => `Revenue: ${fmtAED(ctx.parsed.y)}` } },
                },
                scales: {
                  x: { ticks: { font: { size: 10 } } },
                  y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: (v: number | string) => fmtAED(Number(v)) } },
                },
              }}
            />
          ) : failed.includes("Year to date") || companyYtd?.dealsError ? (
            <p className="dash-note">Revenue didn&apos;t load from the CRM. Reload to try again.</p>
          ) : (
            <div className="skeleton" style={{ width: "100%", height: "100%" }} />
          )}
        </div>
      </Section>

      {/* 4. Two key figures from each marketing channel. */}
      <div className="dash-channels">
        <ChannelCard title="PR & people sentiment" href="/pr">
          <Metric
            href="/pr"
            label="Press stories"
            // pr.error: the live press data did not load, and its zeros are not real.
            value={extra && !extra.pr.error ? fmtInt(extra.pr.mentions) : "—"}
            sub={
              !extra
                ? undefined
                : extra.pr.error
                  ? "press data unavailable"
                  : extra.pr.sov != null
                    ? `${fmtPct(extra.pr.sov, 0)} share of voice YTD${extra.pr.sovThroughLabel ? ` to ${extra.pr.sovThroughLabel}` : ""}`
                    : extra.pr.sovError
                      ? "share of voice unavailable"
                      : "found by the news bot"
            }
            loading={prPending}
          />
          <Metric
            href="/pr/people"
            label="Net sentiment"
            // An index from -100 to +100, as the People sentiment tab shows it.
            value={net == null ? "—" : `${net > 0 ? "+" : ""}${Math.round(net * 100)}`}
            sub={extra?.people ? (extra.people.posts ? `from ${fmtInt(extra.people.posts)} post${extra.people.posts === 1 ? "" : "s"} checked` : "no checked posts in this period") : undefined}
            loading={prPending}
          />
        </ChannelCard>
        <ChannelCard title="Social" href="/socials">
          <Metric
            href="/socials"
            label="Followers"
            value={extra ? fmtInt(extra.social.followers) : "—"}
            sub={
              [
                extra?.social.share != null ? `${fmtPct(extra.social.share)} of benchmarked set` : null,
                // When the figures were captured: the weekly run, or the last one that worked.
                extra?.social.asOf ? `as of ${dayMonth(extra.social.asOf)}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined
            }
            loading={prPending}
          />
          <Metric
            href="/socials"
            label="Engagement rate"
            value={extra?.social.engagement != null ? fmtPct(extra.social.engagement, 2) : "—"}
            sub={extra ? `average of ${fmtInt(extra.social.platforms)} platform${extra.social.platforms === 1 ? "" : "s"}` : undefined}
            loading={prPending}
          />
        </ChannelCard>
        <ChannelCard title="Digital" href="/digital">
          <Metric
            href="/digital"
            label="Paid spend"
            value={!paid ? "—" : paid.currency ? fmtMoney(paid.spend, paid.currency) : "Mixed currency"}
            loading={!paid && !failed.includes("Digital")}
          />
          {/* Leads here are what the ad platforms report (Google's include recruitment forms), not CRM leads. */}
          <Metric
            href="/digital"
            label="Cost per lead"
            value={paid?.currency && paid.leads > 0 ? fmtMoney(paid.spend / paid.leads, paid.currency) : "—"}
            sub={paid ? `${fmtInt(paid.leads)} platform-reported leads` : undefined}
            loading={!paid && !failed.includes("Digital")}
          />
        </ChannelCard>
        <ChannelCard title="SEO" href="/seo">
          <Metric
            href="/seo"
            label="Organic clicks"
            value={gscUp ? fmtInt(seo.gsc.totals!.clicks) : "—"}
            // Search Console publishes about three days late, so the period ends at its last published day.
            sub={gscUp ? `${fmtInt(seo.gsc.totals!.impressions)} impressions · to ${dayMonth(seo.gscRange.to)}` : undefined}
            loading={!seo && !failed.includes("SEO")}
          />
          <Metric
            href="/seo"
            label="AI visitors"
            value={aiUp ? fmtInt(seo.ai.visitors) : "—"}
            sub={
              aiUp && seo.ai.organicVisitors && !seo.ai.missing.includes("site totals")
                ? `${((seo.ai.visitors / seo.ai.organicVisitors) * 100).toFixed(1)}% of ${fmtInt(seo.ai.organicVisitors)} organic`
                : undefined
            }
            loading={!seo && !failed.includes("SEO")}
          />
        </ChannelCard>
      </div>

      {/* A source that failed must say so: a missing figure would otherwise read as zero. */}
      {failed.length > 0 && (
        <div className="chart-card" style={{ marginTop: 18, borderColor: C.amber }}>
          <span style={{ fontSize: 12 }}>
            Couldn&apos;t load: {failed.join(", ")}. Those figures are blank, not zero.
          </span>
        </div>
      )}
    </>
  );
}
