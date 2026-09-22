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
import { avgMonthlySpendTotal } from "@/lib/portalSpend";
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
const fmtPct = (n: number | null, dp = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(dp)}%`);
const fmtX = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(1)}×`);

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTH_SHORT[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(2, 4)}`;

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

type PaidSummary = { spend: number; leads: number };

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
    fetch("/api/company", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (live && Array.isArray(j?.months)) setCompany(j); else if (live) fail("Company"); })
      .catch(() => live && fail("Company"));
    fetch("/api/portals", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (live && Array.isArray(j?.rows)) setPortals(j); else if (live) fail("Portals"); })
      .catch(() => live && fail("Portals"));
    fetch("/api/digital?days=90", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        const rows = Array.isArray(j?.byDateFine) ? j.byDateFine : null;
        if (!rows) return fail("Digital");
        setPaid({
          spend: rows.reduce((s: number, r: { cost?: number }) => s + (r.cost ?? 0), 0),
          leads: rows.reduce((s: number, r: { leads?: number }) => s + (r.leads ?? 0), 0),
        });
      })
      .catch(() => live && fail("Digital"));
    fetch("/api/seo", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (live && j?.traffic) setSeo(j); else if (live) fail("SEO"); })
      .catch(() => live && fail("SEO"));
    fetch("/api/summary", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (live && j?.pr) setExtra(j); else if (live) fail("PR & social"); })
      .catch(() => live && fail("PR & social"));
    return () => { live = false; };
  }, [fail]);

  // ── company totals across every channel and division ──────────
  const sum = (o: Record<string, number[]> | undefined) =>
    o ? Object.values(o).reduce((t, arr) => t + arr.reduce((a, b) => a + b, 0), 0) : 0;
  const leads = company ? sum(company.leads.Sales) + sum(company.leads.Leasing) : 0;
  const deals = company ? (["Offplan", "Secondary", "Leasing"] as const).reduce((t, d) => t + sum(company.deals[d]), 0) : 0;
  const comm = company ? (["Offplan", "Secondary", "Leasing"] as const).reduce((t, d) => t + sum(company.comm[d]), 0) : 0;

  const portalDeals = portals ? portals.rows.reduce((s, r) => s + r.deals, 0) : 0;
  const portalLeads = portals ? portals.rows.reduce((s, r) => s + r.leads, 0) : 0;
  const portalComm = portals ? portals.rows.reduce((s, r) => s + r.commission, 0) : 0;
  // Same basis as the Portals tab: the workbook's average monthly rate over the
  // months the payload covers. Recomputed here rather than sent, because spend
  // is a client-side constant, not CRM data.
  const portalSpend = portals ? avgMonthlySpendTotal() * portals.months.length : 0;
  const portalCpd = portalDeals > 0 ? portalSpend / portalDeals : null;

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

  const trend = {
    labels: months.map(monthLabel),
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
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        <Kpi href="/company" label="Gross commission" value={fmtAED(comm)} color={C.green} loading={!company} />
        <Kpi href="/company" label="Deals" value={fmtInt(deals)} loading={!company} />
        <Kpi href="/company" label="Leads" value={fmtInt(leads)} loading={!company} />
        <Kpi href="/company" label="Lead → deal" value={fmtPct(leads > 0 ? deals / leads : null)} loading={!company} />
        <Kpi href="/portals" label="Portal deals" value={fmtInt(portalDeals)} sub={`${fmtInt(portalLeads)} leads · ${fmtAED(portalComm)}`} loading={!portals} />
        <Kpi href="/portals" label="Portal spend" value={fmtAED(portalSpend)} sub={portalCpd ? `${fmtAED(portalCpd)} / deal` : undefined} loading={!portals} />
        <Kpi href="/digital" label="Paid spend · 90d" value={fmtAED(paid?.spend ?? 0)} sub={`${fmtInt(paid?.leads ?? 0)} leads`} loading={!paid} />
        <Kpi
          href="/digital"
          label="Paid cost / lead · 90d"
          value={paid && paid.leads > 0 ? fmtAED(paid.spend / paid.leads) : "—"}
          loading={!paid}
        />
      </div>

      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        <Kpi
          href="/seo"
          label="Organic clicks · this month"
          value={fmtInt(seo?.gsc.totals?.clicks ?? 0)}
          sub={seo?.gsc.totals ? `${fmtInt(seo.gsc.totals.impressions)} impressions` : undefined}
          loading={!seo}
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
          value={fmtInt(seo?.ai.visitors ?? 0)}
          sub={
            seo && seo.ai.organicVisitors
              ? `${((seo.ai.visitors / seo.ai.organicVisitors) * 100).toFixed(1)}% of ${fmtInt(seo.ai.organicVisitors)} organic`
              : undefined
          }
          loading={!seo}
        />
        <Kpi
          href="/pr"
          label="Press mentions · 12m"
          value={fmtInt(extra?.pr.mentions ?? 0)}
          sub={extra?.pr.sov != null ? `${fmtPct(extra.pr.sov)} share of voice` : undefined}
          loading={!extra}
        />
        <Kpi
          href="/people"
          label="Social followers"
          value={fmtInt(extra?.social.followers ?? 0)}
          sub={
            extra?.social.share != null
              ? `${fmtPct(extra.social.share)} of benchmarked set`
              : extra?.social.engagement != null
                ? `${fmtPct(extra.social.engagement, 2)} engagement`
                : undefined
          }
          loading={!extra}
        />
      </div>

      <div className="chart-card" style={{ marginBottom: 18 }}>
        <h3 style={{ marginBottom: 10 }}>Deals &amp; commission by month</h3>
        <div style={{ height: 300 }}>
          {company ? (
            <ChartBox
              type="bar"
              data={trend}
              options={{
                ...baseOpts,
                scales: {
                  x: { ticks: { font: { size: 10 } } },
                  y: { beginAtZero: true, position: "left" as const, ticks: { font: { size: 10 } } },
                  y1: { beginAtZero: true, position: "right" as const, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
                },
              }}
            />
          ) : (
            <div className="skeleton" style={{ width: "100%", height: "100%" }} />
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 18 }}>
        <div className="chart-card">
          <h3 style={{ marginBottom: 10 }}>Deals by channel</h3>
          <div style={{ height: 280 }}>
            {company ? (
              <ChartBox type="bar" data={mix} options={{ ...baseOpts, indexAxis: "y" as const, plugins: { legend: { display: false } } }} />
            ) : (
              <div className="skeleton" style={{ width: "100%", height: "100%" }} />
            )}
          </div>
        </div>

        <div className="chart-card">
          <h3 style={{ marginBottom: 10 }}>
            Portals{portals && portalSpend > 0 ? <span style={{ fontWeight: 400, fontSize: 12, color: C.mid }}> · {fmtX(portalComm / portalSpend)} return on spend</span> : null}
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
                      <td>{fmtInt(r.leads)}</td>
                      <td>{fmtInt(r.deals)}</td>
                      <td style={{ color: C.green }}>{fmtAED(r.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
