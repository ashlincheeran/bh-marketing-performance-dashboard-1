"use client";

import { useCallback, useEffect, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { C } from "@/lib/theme";
import type { WebMetrics } from "@/lib/posthog";

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));

const WINDOWS = [
  { d: 7, label: "Last 7 days" },
  { d: 30, label: "Last 30 days" },
  { d: 90, label: "Last 90 days" },
];

const legendBottom = { legend: { position: "bottom" as const, labels: { font: { size: 10 } } } };

export default function SeoWebsite({ initial }: { initial: WebMetrics }) {
  const [data, setData] = useState<WebMetrics>(initial);
  const [days, setDays] = useState<number>(initial.days || 30);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/seo?days=${d}`, { cache: "no-store" });
      const json = (await res.json()) as WebMetrics;
      setData(json);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch {
      /* keep last good data */
    } finally {
      setLoading(false);
    }
  }, []);

  // Stamp the initial (server-rendered) load time on mount.
  useEffect(() => setUpdatedAt(new Date().toLocaleTimeString()), []);

  // Auto-refresh every 60s while "Live" is on.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => load(days), 60_000);
    return () => clearInterval(id);
  }, [live, days, load]);

  function changeDays(d: number) {
    setDays(d);
    load(d);
  }

  const ov = data.overview;
  const organicPct = ov && ov.sessions ? Math.round((ov.organic / ov.sessions) * 100) : null;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">SEO &amp; Website</div>
          <div className="page-sub">Live website traffic &amp; search performance — from PostHog ({data.days}-day window)</div>
        </div>
        <span className="bot-left" style={{ gap: 8 }}>
          {data.connected && <span className="pulse-dot" style={{ background: live ? C.green : C.sand }} />}
          <span style={{ fontSize: 12, color: C.mid }}>
            {data.connected ? (live ? "Live" : "Paused") : "Not connected"}
            {updatedAt ? ` · updated ${updatedAt}` : ""}
          </span>
        </span>
      </div>

      {/* controls */}
      <div className="controls-bar">
        <div className="field">
          <label>Window <HelpTip text="How far back to measure. Applies to every metric on this page." /></label>
          <select className="ps-select" value={days} onChange={(e) => changeDays(Number(e.target.value))}>
            {WINDOWS.map((w) => <option key={w.d} value={w.d}>{w.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Auto-refresh <HelpTip text="When on, the page re-queries PostHog every 60 seconds so the numbers stay live." /></label>
          <button className={`filter-btn${live ? " active" : ""}`} onClick={() => setLive((v) => !v)}>
            {live ? "● Live (60s)" : "Paused"}
          </button>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={() => load(days)} disabled={loading}>
            {loading ? "Refreshing…" : "↻ Refresh now"}
          </button>
        </div>
      </div>

      {!data.connected ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: 150 }}>
            PostHog isn&apos;t connected yet.<br />
            Add <strong>POSTHOG_API_KEY</strong> (a personal API key with Query:Read) to the Vercel environment, then redeploy.
          </div>
        </div>
      ) : !data.hasData ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: 150 }}>
            Connected to PostHog, but no <code>$pageview</code> events were found in the last {data.days} days.<br />
            Make sure PostHog web tracking (posthog-js) is installed on the website, or widen the window.
          </div>
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">Unique visitors</div>
              <div className="kpi-value">{fmt(ov!.visitors)}</div>
              <div className="kpi-change">last {data.days} days</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Pageviews</div>
              <div className="kpi-value">{fmt(ov!.pageviews)}</div>
              <div className="kpi-change">{ov!.visitors ? `${(ov!.pageviews / ov!.visitors).toFixed(1)} per visitor` : ""}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Sessions</div>
              <div className="kpi-value">{fmt(ov!.sessions)}</div>
              <div className="kpi-change">visits</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Organic search <HelpTip text="Sessions that arrived from a search engine (Google, Bing, etc.) — your SEO-driven traffic." /></div>
              <div className="kpi-value" style={{ color: C.green }}>{fmt(ov!.organic)}</div>
              <div className="kpi-change up">{organicPct != null ? `${organicPct}% of sessions` : ""}</div>
            </div>
          </div>

          {/* trend + sources */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Traffic over time</div>
              <div className="chart-sub">Pageviews (bars) &amp; unique visitors (line) per day</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: data.trend.map((t) => t.day.slice(5)),
                    datasets: [
                      { type: "bar", label: "Pageviews", data: data.trend.map((t) => t.pageviews), backgroundColor: C.coral + "99", yAxisID: "y" },
                      { type: "line", label: "Visitors", data: data.trend.map((t) => t.visitors), borderColor: C.dark, backgroundColor: "transparent", yAxisID: "y", tension: 0.3, pointRadius: 2 },
                    ],
                  }}
                  options={{ plugins: legendBottom, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }}
                />
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-title">Top traffic sources</div>
              <div className="chart-sub">Sessions by referring domain</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: data.sources.map((s) => s.source),
                    datasets: [{ label: "Sessions", data: data.sources.map((s) => s.sessions), backgroundColor: C.sage }],
                  }}
                  options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }}
                />
              </div>
            </div>
          </div>

          {/* pages + countries */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Top pages</div>
              <div className="chart-sub">Most-viewed pages in range</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: data.topPages.map((p) => p.path),
                    datasets: [{ label: "Pageviews", data: data.topPages.map((p) => p.views), backgroundColor: C.coral }],
                  }}
                  options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }}
                />
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-title">Visitors by country</div>
              <div className="chart-sub">Where your audience is</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: data.countries.map((c) => c.country),
                    datasets: [{ label: "Visitors", data: data.countries.map((c) => c.visitors), backgroundColor: C.blue }],
                  }}
                  options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }}
                />
              </div>
            </div>
          </div>

          <div style={{ fontSize: 11, color: C.mid, marginTop: 4 }}>
            Source: PostHog <code>$pageview</code> events · organic = sessions from search engines · keyword rankings &amp; backlinks (Semrush) can be added next.
          </div>
        </>
      )}
    </>
  );
}
