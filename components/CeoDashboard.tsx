"use client";

// Executive overview — the headline number from each tab, nothing else.
//
// Deliberately thin: numbers and two charts, no commentary. Every figure links
// back to the tab that owns it, so this stays a summary rather than a second
// source of truth.
//
// Each source is fetched INDEPENDENTLY and rendered as soon as it lands. The
// other tabs wait for a whole payload because their ratios mix sources; here
// nothing is divided across sources, so a slow Supermetrics call shouldn't hold
// up CRM figures that are already in.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ChartBox from "@/components/Chart";
import { C } from "@/lib/theme";
import type { CompanyData } from "@/lib/company";
import type { PortalsData } from "@/lib/portals";
import { portalEconomics, sumOrNull } from "@/lib/portalSpend";
import type { SummaryData } from "@/app/api/summary/route";
import type { SeoReport } from "@/lib/seoReport";

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
const fmtAED = (n: number) => {
  const a = Math.abs(n || 0);
  if (a >= 1e9) return `AED ${((n || 0) / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `AED ${((n || 0) / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `AED ${Math.round((n || 0) / 1e3)}K`;
  return `AED ${Math.round(n || 0)}`;
};
/** The AED formatter's scaling, for whichever currency the accounts bill in. */
const fmtMoney = (n: number, currency: string) => fmtAED(n).replace(/^AED/, currency);
const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);
const fmtX = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}×`);

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTH_SHORT[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(2, 4)}`;
/** 2025-01-01 → "1 Jan 2025". */
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTH_SHORT[Number(d.slice(5, 7)) - 1] ?? ""} ${d.slice(0, 4)}`;
/** Last day of a YYYY-MM. */
const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

/** One number. `href` names the tab that owns it. */
function Kpi({ label, value, sub, href, color, loading }: {
  label: string;
  value: string;
  sub?: string;
  href: string;
  color?: string;
  loading?: boolean;
}) {
  return (
    <Link href={href} className="kpi-card" style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <div className="kpi-label">{label}</div>
      {loading ? (
        <div className="skeleton" style={{ width: "55%", height: 20, marginTop: 4 }} />
      ) : (
        <div className="kpi-value" style={color ? { color } : undefined}>{value}</div>
      )}
      {sub && !loading ? <div className="kpi-change" style={{ color: C.mid }}>{sub}</div> : null}
    </Link>
  );
}

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

export default function CeoDashboard() {
  const [company, setCompany] = useState<CompanyData | null>(null);
  const [portals, setPortals] = useState<PortalsData | null>(null);
  const [paid, setPaid] = useState<PaidSummary | null>(null);
  const [seo, setSeo] = useState<SeoReport | null>(null);
  const [extra, setExtra] = useState<SummaryData | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  const fail = useCallback((what: string) => setFailed((f) => (f.includes(what) ? f : [...f, what])), []);

  useEffect(() => {
    let live = true;
    // Independent, so one slow source doesn't gate the others.
    getJson("/api/company")
      // Unconfigured Metabase answers with zero series and no error; that is not a real zero either.
      .then((j) => { if (live && Array.isArray(j?.months) && j?.connected !== false) setCompany(j); else if (live) fail("Company"); })
      .catch(() => live && fail("Company"));
    getJson("/api/portals")
      // A payload with `error` carries blank figures, not real ones: a failure.
      .then((j) => { if (live && Array.isArray(j?.rows) && !j?.error) setPortals(j); else if (live) fail("Portals"); })
      .catch(() => live && fail("Portals"));
    getJson("/api/digital?days=90")
      .then((j) => {
        if (!live) return;
        const rows = Array.isArray(j?.byDateFine) ? j.byDateFine : null;
        // Paused, unconfigured and failed reads all arrive as 200 with no rows;
        // shown as AED 0 they would read as a quarter without advertising.
        if (!rows || j?.error || j?.paused || j?.unconfigured || j?.connected === false) return fail("Digital");
        const currencies: string[] = Array.isArray(j?.currencies) ? j.currencies : [];
        setPaid({
          spend: rows.reduce((s: number, r: { cost?: number }) => s + (r.cost ?? 0), 0),
          leads: rows.reduce((s: number, r: { leads?: number }) => s + (r.leads ?? 0), 0),
          currency: currencies.length > 1 ? null : (currencies[0] ?? "AED"),
        });
      })
      .catch(() => live && fail("Digital"));
    getJson("/api/seo")
      // The report carries `gsc` and `ai`. It used to be checked for `traffic`, a
      // field the SEO rebuild removed, so both SEO tiles stayed blank for good.
      .then((j) => { if (live && j?.gsc && j?.ai) setSeo(j); else if (live) fail("SEO"); })
      .catch(() => live && fail("SEO"));
    getJson("/api/summary")
      .then((j) => { if (live && j?.pr && !j?.error) setExtra(j); else if (live) fail("PR & social"); })
      .catch(() => live && fail("PR & social"));
    return () => { live = false; };
  }, [fail]);

  // A part PostHog or Search Console did not answer is "—", never 0: the report
  // returns zeros in its place, which would read as a month without visitors.
  const gscUp = !!seo && !seo.gsc.error && !!seo.gsc.totals;
  const aiUp = !!seo && !seo.ai.error && !seo.ai.missing.includes("AI totals");

  // ── company totals across every channel and division ──────────
  const sum = (o: Record<string, number[]> | undefined) =>
    o ? Object.values(o).reduce((t, arr) => t + arr.reduce((a, b) => a + b, 0), 0) : 0;
  const leads = company ? sum(company.leads.Sales) + sum(company.leads.Leasing) : 0;
  const deals = company ? (["Offplan", "Secondary", "Leasing"] as const).reduce((t, d) => t + sum(company.deals[d]), 0) : 0;
  const comm = company ? (["Offplan", "Secondary", "Leasing"] as const).reduce((t, d) => t + sum(company.comm[d]), 0) : 0;
  // One aggregate can fail while the other answers; its figures are "—", not the zeros it comes back as.
  const leadsUp = !!company && !company.leadsError;
  const dealsUp = !!company && !company.dealsError;
  const companyPending = !company && !failed.includes("Company");

  // Null when its query failed — "—", never 0.
  const portalDeals = portals ? sumOrNull(portals.rows.map((r) => r.deals)) : null;
  const portalLeads = portals ? sumOrNull(portals.rows.map((r) => r.leads)) : null;
  const portalComm = portals ? sumOrNull(portals.rows.map((r) => r.commission)) : null;
  // The Portals tab's own economics: recorded spend only, pro-rated by day, with
  // cost per deal and return on spend over those same months. The average rate
  // this used to multiply by the months in view charged Apr–Oct 2026, which the
  // workbook doesn't cover, AED 6.4M.
  const portalCost = portals ? portalEconomics(portals) : null;
  const portalSpend = portalCost?.total.spend ?? null;
  const portalCpd = portalCost?.total.cpd ?? null;

  // ── commission by month, all divisions ────────────────────────
  const months = company?.months ?? [];
  const commSeries = months.map((_, i) =>
    (["Offplan", "Secondary", "Leasing"] as const).reduce(
      (t, d) => t + Object.values(company?.comm[d] ?? {}).reduce((a, arr) => a + (arr[i] ?? 0), 0),
      0,
    ),
  );
  const dealSeries = months.map((_, i) =>
    (["Offplan", "Secondary", "Leasing"] as const).reduce(
      (t, d) => t + Object.values(company?.deals[d] ?? {}).reduce((a, arr) => a + (arr[i] ?? 0), 0),
      0,
    ),
  );

  // The month still in progress says so: a 20-day October beside a full
  // September otherwise reads as a collapse.
  const lastMonth = months[months.length - 1];
  const partialTo = company && lastMonth && company.to.slice(0, 7) === lastMonth && Number(company.to.slice(8, 10)) < monthEnd(lastMonth)
    ? Number(company.to.slice(8, 10))
    : null;
  const trend = {
    labels: months.map((m) => (m === lastMonth && partialTo ? `${monthLabel(m)} (1–${partialTo})` : monthLabel(m))),
    datasets: [
      { type: "bar" as const, label: "Deals", data: dealSeries, backgroundColor: `${C.blue}55`, borderRadius: 3, yAxisID: "y1", order: 2 },
      { type: "line" as const, label: "Gross commission", data: commSeries, borderColor: C.green, backgroundColor: `${C.green}22`, borderWidth: 2, tension: 0.3, pointRadius: 0, yAxisID: "y", order: 1 },
    ],
  };

  // ── channel mix by deals ──────────────────────────────────────
  const channelDeals = (company?.channels ?? [])
    .map((ch) => ({
      ch,
      n: (["Offplan", "Secondary", "Leasing"] as const).reduce((t, d) => t + (company?.deals[d]?.[ch]?.reduce((a, b) => a + b, 0) ?? 0), 0),
    }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  const mix = {
    labels: channelDeals.map((x) => x.ch),
    datasets: [{ label: "Deals", data: channelDeals.map((x) => x.n), backgroundColor: C.blue, borderRadius: 4 }],
  };

  const baseOpts = {
    responsive: true,
    plugins: { legend: { position: "bottom" as const, labels: { boxWidth: 12, font: { size: 11 } } } },
    scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } },
  };

  return (
    <>
      {/* The other tiles name their period (90d, this month, 12m); these run from the Company tab's default start. */}
      <div style={{ fontSize: 12, color: C.mid, margin: "0 0 6px" }}>
        {company ? `Company · ${dayLabel(company.from)} – ${dayLabel(company.to)} · CRM` : "\u00a0"}
      </div>
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        <Kpi href="/company" label="Gross commission" value={dealsUp ? fmtAED(comm) : "—"} color={dealsUp ? C.green : undefined} loading={companyPending} />
        <Kpi href="/company" label="Deals" value={dealsUp ? fmtInt(deals) : "—"} loading={companyPending} />
        <Kpi href="/company" label="Leads" value={leadsUp ? fmtInt(leads) : "—"} loading={companyPending} />
        <Kpi href="/company" label="Lead → deal" value={leadsUp && dealsUp ? fmtPct(leads > 0 ? deals / leads : null) : "—"} loading={companyPending} />
        <Kpi
          href="/portals"
          label="Portal deals"
          value={portalDeals == null ? "—" : fmtInt(portalDeals)}
          sub={portals ? `${portalLeads == null ? "—" : fmtInt(portalLeads)} leads · ${portalComm == null ? "—" : fmtAED(portalComm)}` : undefined}
          loading={!portals && !failed.includes("Portals")}
        />
        {/* Spend and cost per deal cover only the months the workbook records, and say which. */}
        <Kpi
          href="/portals"
          label="Portal spend"
          value={portalSpend == null ? "—" : fmtAED(portalSpend)}
          sub={portalCost ? (portalCost.blank ?? `${portalCpd == null ? "—" : fmtAED(portalCpd)} / deal · ${portalCost.span}`) : undefined}
          loading={!portals && !failed.includes("Portals")}
        />
        {/* Leads here are what the ad platforms report (Google's include recruitment forms), not CRM leads. */}
        <Kpi
          href="/digital"
          label="Paid spend · 90d"
          value={!paid ? "—" : paid.currency ? fmtMoney(paid.spend, paid.currency) : "Mixed currency"}
          sub={paid ? `${fmtInt(paid.leads)} platform-reported leads` : undefined}
          loading={!paid && !failed.includes("Digital")}
        />
        <Kpi
          href="/digital"
          label="Paid cost / lead · 90d"
          value={paid?.currency && paid.leads > 0 ? fmtMoney(paid.spend / paid.leads, paid.currency) : "—"}
          loading={!paid && !failed.includes("Digital")}
        />
      </div>

      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        <Kpi
          href="/seo"
          label="Organic clicks · this month"
          value={gscUp ? fmtInt(seo.gsc.totals!.clicks) : "—"}
          // Search Console publishes about three days late, so "this month" ends at its last published day.
          sub={gscUp ? `${fmtInt(seo.gsc.totals!.impressions)} impressions · to ${dayLabel(seo.gscRange.to).replace(/ \d{4}$/, "")}` : undefined}
          loading={!seo && !failed.includes("SEO")}
        />
        {/*
          Was total sessions across all channels. The SEO tab is now a report on
          the AI channel, and this is the figure it turns on: people arriving
          from an assistant, against the organic search visitors they are a
          share of.
        */}
        <Kpi
          href="/seo"
          label="AI visitors · this month"
          value={aiUp ? fmtInt(seo.ai.visitors) : "—"}
          sub={
            aiUp && seo.ai.organicVisitors && !seo.ai.missing.includes("site totals")
              ? `${((seo.ai.visitors / seo.ai.organicVisitors) * 100).toFixed(1)}% of ${fmtInt(seo.ai.organicVisitors)} organic`
              : undefined
          }
          loading={!seo && !failed.includes("SEO")}
        />
        <Kpi
          href="/pr"
          label="Press mentions · 12m"
          value={extra ? fmtInt(extra.pr.mentions) : "—"}
          // Year to date, and only to the latest stored competitor story: competitor
          // collection stopped in June, and counting on past it read 42% for 17%.
          sub={extra?.pr.sov != null ? `${fmtPct(extra.pr.sov, 0)} share of voice YTD${extra.pr.sovThroughLabel ? ` to ${extra.pr.sovThroughLabel}` : ""}` : undefined}
          loading={!extra && !failed.includes("PR & social")}
        />
        <Kpi
          href="/people"
          label="Social followers"
          value={extra ? fmtInt(extra.social.followers) : "—"}
          sub={
            extra?.social.share != null
              ? `${fmtPct(extra.social.share)} of benchmarked set`
              : extra?.social.engagement != null
                ? `${fmtPct(extra.social.engagement, 2)} engagement`
                : undefined
          }
          loading={!extra && !failed.includes("PR & social")}
        />
      </div>

      <div className="chart-card" style={{ marginBottom: 18 }}>
        <h3 style={{ marginBottom: 10 }}>Deals &amp; commission by month</h3>
        <div style={{ height: 300 }}>
          {company && !dealsUp ? (
            <div style={{ fontSize: 13, color: C.mid }}>Deal figures didn&apos;t load from the CRM. Reload to try again.</div>
          ) : company ? (
            <ChartBox
              type="bar"
              data={trend}
              options={{
                ...baseOpts,
                scales: {
                  x: { ticks: { font: { size: 10 } } },
                  // Labelled per axis: "25,000,000" beside "1,200" did not say which was money.
                  y: { beginAtZero: true, position: "left" as const, ticks: { font: { size: 10 }, callback: (v: number | string) => fmtAED(Number(v)) } },
                  y1: { beginAtZero: true, position: "right" as const, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, callback: (v: number | string) => `${fmtInt(Number(v))} deals` } },
                },
              }}
            />
          ) : failed.includes("Company") ? (
            <div style={{ fontSize: 13, color: C.mid }}>—</div>
          ) : (
            <div className="skeleton" style={{ width: "100%", height: "100%" }} />
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 18 }}>
        <div className="chart-card">
          <h3 style={{ marginBottom: 10 }}>Deals by channel</h3>
          <div style={{ height: 280 }}>
            {company && !dealsUp ? (
              <div style={{ fontSize: 13, color: C.mid }}>Deal figures didn&apos;t load from the CRM. Reload to try again.</div>
            ) : company ? (
              <ChartBox type="bar" data={mix} options={{ ...baseOpts, indexAxis: "y" as const, plugins: { legend: { display: false } } }} />
            ) : failed.includes("Company") ? (
              <div style={{ fontSize: 13, color: C.mid }}>—</div>
            ) : (
              <div className="skeleton" style={{ width: "100%", height: "100%" }} />
            )}
          </div>
        </div>

        <div className="chart-card">
          <h3 style={{ marginBottom: 10 }}>
            Portals{portalCost?.total.roas != null ? <span style={{ fontWeight: 400, fontSize: 12, color: C.mid }}> · {fmtX(portalCost.total.roas)} return on spend · {portalCost.span}</span> : null}
          </h3>
          {portals ? (
            <div style={{ overflowX: "auto" }}>
              <table className="perf-table" style={{ minWidth: 300 }}>
                <thead>
                  <tr><th>Portal</th><th>Leads</th><th>Deals</th><th>Commission</th></tr>
                </thead>
                <tbody>
                  {portals.rows.map((r) => (
                    <tr key={r.portal}>
                      <td>{r.portal}</td>
                      <td>{r.leads == null ? "—" : fmtInt(r.leads)}</td>
                      <td>{r.deals == null ? "—" : fmtInt(r.deals)}</td>
                      <td style={{ color: C.green }}>{r.commission == null ? "—" : fmtAED(r.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : failed.includes("Portals") ? (
            <p style={{ fontSize: 13, color: C.mid }}>—</p>
          ) : (
            <div className="skeleton" style={{ width: "100%", height: 200 }} />
          )}
        </div>
      </div>

      {/* A source that failed must say so — a missing KPI would otherwise read as zero. */}
      {failed.length > 0 && (
        <div className="chart-card" style={{ marginTop: 18, borderColor: C.amber }}>
          <span style={{ fontSize: 12 }}>
            ⚠ Couldn&apos;t load: {failed.join(", ")}. Those figures are blank, not zero.
          </span>
        </div>
      )}
    </>
  );
}
