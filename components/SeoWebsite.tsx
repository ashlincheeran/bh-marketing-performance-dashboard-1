"use client";

import { useCallback, useEffect, useState } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { C } from "@/lib/theme";
import type { WebMetrics } from "@/lib/posthog";

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
const ymd = (d: Date) => d.toISOString().slice(0, 10);

const legendBottom = { legend: { position: "bottom" as const, labels: { font: { size: 10 } } } };

export default function SeoWebsite({ initial }: { initial: WebMetrics }) {
  const [data, setData] = useState<WebMetrics>(initial);
  const [mode, setMode] = useState<"preset" | "custom">("preset");
  const [days, setDays] = useState<number>(initial.days || 30);
  const [from, setFrom] = useState<string>(ymd(new Date(Date.now() - 30 * 864e5)));
  const [to, setTo] = useState<string>(ymd(new Date()));
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [humansOnly, setHumansOnly] = useState<boolean>(initial.humansOnly ?? true);

  const load = useCallback(async (qs: string, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/seo?${qs}`, { cache: "no-store" });
      const json = (await res.json()) as WebMetrics;
      setData(json);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch {
      /* keep last good data */
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // range query string (without the humans flag)
  const rangeQs = useCallback(
    () => (mode === "custom" && from && to && from <= to ? `from=${from}&to=${to}` : `days=${days}`),
    [mode, from, to, days],
  );
  const qsFor = useCallback(() => `${rangeQs()}&humans=${humansOnly ? 1 : 0}`, [rangeQs, humansOnly]);

  useEffect(() => setUpdatedAt(new Date().toLocaleTimeString()), []);

  // Silent auto-refresh every 60s while Live (no overlay flash).
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => load(qsFor(), true), 60_000);
    return () => clearInterval(id);
  }, [live, qsFor, load]);

  function pickPreset(d: number) {
    setMode("preset");
    setDays(d);
    load(`days=${d}&humans=${humansOnly ? 1 : 0}`, false);
  }
  function applyCustom() {
    if (from && to && from <= to) load(`from=${from}&to=${to}&humans=${humansOnly ? 1 : 0}`, false);
  }
  function toggleHumans() {
    const next = !humansOnly;
    setHumansOnly(next);
    load(`${rangeQs()}&humans=${next ? 1 : 0}`, false);
  }

  const ov = data.overview;
  const organicPct = ov && ov.sessions ? Math.round((ov.organic / ov.sessions) * 100) : null;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">SEO &amp; Website</div>
          <div className="page-sub">Live website traffic &amp; search performance — from PostHog · {data.label}</div>
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
          <label>Range <HelpTip text="Time window for every metric on this page. Use a preset or pick a custom From/To range." /></label>
          <div className="ps-platforms">
            {[7, 30, 90].map((d) => (
              <button key={d} className={`filter-btn${mode === "preset" && days === d ? " active" : ""}`} onClick={() => pickPreset(d)}>
                {d}d
              </button>
            ))}
            <button className={`filter-btn${mode === "custom" ? " active" : ""}`} onClick={() => setMode("custom")}>
              Custom
            </button>
          </div>
        </div>

        {mode === "custom" && (
          <>
            <div className="field">
              <label>From</label>
              <input type="date" className="ps-select" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field">
              <label>To</label>
              <input type="date" className="ps-select" value={to} min={from} max={ymd(new Date())} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <button className="filter-btn" onClick={applyCustom} disabled={loading || !(from && to && from <= to)}>
                Apply
              </button>
            </div>
          </>
        )}

        <div className="field">
          <label>Traffic <HelpTip text="Humans only excludes bots/crawlers — PostHog-flagged bots, traffic from cloud datacenters (e.g. AWS Ashburn), and desktop-Linux/server traffic (the China/Singapore/Hong Kong server bots). Switch to All traffic to see the raw, bot-inflated numbers." /></label>
          <button className={`filter-btn${humansOnly ? " active" : ""}`} onClick={toggleHumans}>
            {humansOnly ? "🧍 Humans only" : "All traffic"}
          </button>
        </div>
        <div className="field">
          <label>Auto-refresh <HelpTip text="When on, re-queries PostHog every 60 seconds so the numbers stay live (no spinner flash)." /></label>
          <button className={`filter-btn${live ? " active" : ""}`} onClick={() => setLive((v) => !v)}>
            {live ? "● Live (60s)" : "Paused"}
          </button>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={() => load(qsFor(), false)} disabled={loading}>
            {loading ? "Refreshing…" : "↻ Refresh now"}
          </button>
        </div>
      </div>

      {/* results (with loading overlay) */}
      <div style={{ position: "relative", minHeight: 120 }}>
        {loading && (
          <div className="seo-loading">
            <span className="spinner" />Updating…
          </div>
        )}
        <div style={{ opacity: loading ? 0.4 : 1, transition: "opacity .15s", pointerEvents: loading ? "none" : "auto" }}>
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
                Connected to PostHog, but no <code>$pageview</code> events were found in {data.label}.<br />
                Make sure PostHog web tracking (posthog-js) is installed on the website, or widen the range.
              </div>
            </div>
          ) : (
            <>
              {data.bots.pageviews > 0 && (
                <div className="seo-bot-banner">
                  <span>
                    🤖 <strong>{fmt(data.bots.pageviews)}</strong> automated / bot pageviews detected — <strong>{data.bots.pct}%</strong> of all traffic
                    (headless crawlers + cloud-datacenter &amp; Linux/server traffic — e.g. AWS Ashburn, plus China / Singapore / Hong Kong servers).{" "}
                    {humansOnly ? "Excluded from the figures below." : "Currently included in the figures below."}
                  </span>
                  <button className="filter-btn" onClick={toggleHumans}>
                    {humansOnly ? "Show all traffic" : "Hide bots"}
                  </button>
                </div>
              )}

              {/* KPIs */}
              <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
                <div className="kpi-card">
                  <div className="kpi-label">Unique visitors</div>
                  <div className="kpi-value">{fmt(ov!.visitors)}</div>
                  <div className="kpi-change">{data.label}</div>
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
        </div>
      </div>
    </>
  );
}
