"use client";

import { useMemo, useState } from "react";
import ChartBox from "@/components/Chart";
import { C, TIER_COLOR, TIERS, TIER_LABEL, tierClass } from "@/lib/theme";
import {
  annualByTier,
  buildInsights,
  filterRange,
  fmtEAV,
  fmtReach,
  fmtReachFull,
  kpis,
  monthlySeries,
  sentimentBreakdown,
  tierByMonth,
  topOutlets,
} from "@/lib/pr";
import type { Mention, Sentiment, Tier } from "@/lib/types";

type SortCol = "date" | "tier" | "outlet" | "title" | "eav" | "reach";

const TIER_FILTERS: ("all" | Tier)[] = ["all", "T1-Global", "T1-Local", "T2", "T3"];
const SENT_FILTERS: ("all" | NonNullable<Sentiment>)[] = ["all", "positive", "neutral", "negative"];

export default function PRDashboard({
  mentions,
  minMonth,
  maxMonth,
  defaultFrom,
}: {
  mentions: Mention[];
  minMonth: string;
  maxMonth: string;
  defaultFrom: string;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(maxMonth);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<"all" | Tier>("all");
  const [sentFilter, setSentFilter] = useState<"all" | NonNullable<Sentiment>>("all");
  const [sortCol, setSortCol] = useState<SortCol>("date");
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);

  const filtered = useMemo(() => filterRange(mentions, from, to), [mentions, from, to]);
  const k = useMemo(() => kpis(filtered), [filtered]);
  const series = useMemo(() => monthlySeries(filtered, from, to), [filtered, from, to]);
  const tiers = useMemo(() => tierByMonth(filtered), [filtered]);
  const annual = useMemo(() => annualByTier(mentions), [mentions]);
  const outlets = useMemo(() => topOutlets(filtered, 10), [filtered]);
  const sent = useMemo(() => sentimentBreakdown(filtered), [filtered]);
  const insights = useMemo(() => buildInsights(mentions, filtered), [mentions, filtered]);

  const tableRows = useMemo(() => {
    const q = search.toLowerCase();
    const rows = filtered.filter((m) => {
      if (tierFilter !== "all" && m.tier !== tierFilter) return false;
      if (sentFilter !== "all" && m.sentiment !== sentFilter) return false;
      if (q && !(m.outlet ?? "").toLowerCase().includes(q) && !(m.title ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      if (sortCol === "eav") { av = a.eavEff; bv = b.eavEff; }
      else if (sortCol === "reach") { av = a.reachEff; bv = b.reachEff; }
      else { av = (a[sortCol] ?? "").toString().toLowerCase(); bv = (b[sortCol] ?? "").toString().toLowerCase(); }
      return sortDir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
    return rows;
  }, [filtered, search, tierFilter, sentFilter, sortCol, sortDir]);

  function sortBy(col: SortCol) {
    if (col === sortCol) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortCol(col); setSortDir(-1); }
  }

  // Export the selected date range to a CSV (opens in Excel), flagging which
  // clips came from the AI bot vs. the manual/historical record.
  function exportCsv() {
    const cols = ["Date", "Tier", "Publication", "Headline", "EAV", "Reach", "EAV/Reach source", "Sentiment", "Sentiment by", "Origin", "URL"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.join(",")];
    for (const m of filtered) {
      const ai = m.source === "googlenews";
      lines.push([
        m.date ?? "",
        TIER_LABEL[m.tier],
        m.outlet ?? "",
        m.title ?? "",
        m.eavEff || "",
        m.reachEff || "",
        m.modeled ? "modeled (rate card)" : m.eav != null ? "verified" : "",
        m.sentiment ?? "",
        m.sentiment ? "AI (Gemini)" : "",
        ai ? "AI · Google News" : "Manual / Historical",
        m.url ?? "",
      ].map(esc).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `betterhomes-pr_${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const legendBottom = { legend: { position: "bottom" as const, labels: { font: { size: 10 } } } };

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">PR &amp; Media</div>
          <div className="page-sub">
            {filtered.length} clips · {from} → {to} · sourced from internal press-clipping records
          </div>
        </div>
        <span className="verified-badge">✓ Verified from press clippings</span>
      </div>

      {/* DATE RANGE */}
      <div className="controls-bar">
        <div className="field">
          <label>From</label>
          <input type="month" value={from} min={minMonth} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>To</label>
          <input type="month" value={to} min={from} max={maxMonth} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={() => { setFrom(minMonth); setTo(maxMonth); }}>
            All time
          </button>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={exportCsv} title="Export the selected date range to Excel">
            ⬇ Export to Excel
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-strip">
        <KpiCard label="Total Mentions" value={String(k.count)} sub="in date range" />
        <KpiCard label="Tier-1 Placements" value={String(k.tier1)} sub="Global + Local" subClass="up" />
        <KpiCard label="Est. Reach" value={fmtReachFull(k.reach)} sub="rate-card modeled" />
        <KpiCard label="EAV" value={fmtEAV(k.eav)} sub="rate-card modeled" />
        <KpiCard
          label="Positive Sentiment"
          value={k.posPct == null ? "—" : `${k.posPct}%`}
          sub={k.posPct == null ? "pending enrichment" : `of ${k.sentimentCoverage} scored`}
          subClass={k.posPct == null ? undefined : "up"}
        />
      </div>

      {/* CHARTS ROW 1 */}
      <div className="charts-grid-2">
        <ChartCard title="EAV & Reach by Month" sub="Bars = EAV ($, left) · Line = Reach (right) · modeled from rate cards">
          <ChartBox
            type="bar"
            data={{
              labels: series.labels,
              datasets: [
                { type: "bar", label: "EAV ($)", data: series.eav, backgroundColor: C.coral + "99", yAxisID: "y" },
                { type: "line", label: "Reach", data: series.reach, borderColor: C.dark, backgroundColor: "transparent", yAxisID: "y1", tension: 0.3, pointRadius: 2 },
              ],
            }}
            options={{
              plugins: legendBottom,
              scales: {
                y: { position: "left", ticks: { callback: (v: number) => fmtEAV(v) } },
                y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v: number) => fmtReach(v) } },
              },
            }}
          />
        </ChartCard>

        <ChartCard title="Mentions by Tier" sub="Stacked by month — filtered by date range">
          <ChartBox
            type="bar"
            data={{
              labels: tiers.months,
              datasets: TIERS.filter((t) => tiers.series[t].some((n) => n > 0)).map((t) => ({
                label: TIER_LABEL[t],
                data: tiers.series[t],
                backgroundColor: TIER_COLOR[t],
                stack: "s",
              })),
            }}
            options={{ plugins: legendBottom, scales: { x: { stacked: true }, y: { stacked: true } } }}
          />
        </ChartCard>
      </div>

      {/* CHARTS ROW 2 */}
      <div className="charts-grid-2">
        <ChartCard title="Annual Mention Totals" sub="Year-on-year by tier — full history, not date-filtered">
          <ChartBox
            type="bar"
            data={{
              labels: annual.years,
              datasets: TIERS.filter((t) => annual.series[t].some((n) => n > 0)).map((t) => ({
                label: TIER_LABEL[t],
                data: annual.series[t],
                backgroundColor: TIER_COLOR[t],
                stack: "a",
              })),
            }}
            options={{ plugins: legendBottom, scales: { x: { stacked: true }, y: { stacked: true } } }}
          />
        </ChartCard>

        <ChartCard title="Top Outlets in Range" sub="Most frequent placements (clip count)">
          <ChartBox
            type="bar"
            data={{
              labels: outlets.map((o) => o.outlet),
              datasets: [{
                label: "Clips",
                data: outlets.map((o) => o.count),
                backgroundColor: outlets.map((o) => TIER_COLOR[o.tier]),
              }],
            }}
            options={{ indexAxis: "y", plugins: { legend: { display: false } } }}
          />
        </ChartCard>
      </div>

      {/* SENTIMENT */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">PR Sentiment</div>
        <div className="chart-sub">Tone of coverage in range</div>
        {sent.total > 0 ? (
          <div className="chart-canvas-wrap short">
            <ChartBox
              type="doughnut"
              data={{
                labels: ["Positive", "Neutral", "Negative", "Mixed"],
                datasets: [{
                  data: [sent.counts.positive, sent.counts.neutral, sent.counts.negative, sent.counts.mixed],
                  backgroundColor: [C.green, C.amber, C.red, C.blue],
                }],
              }}
              options={{ plugins: legendBottom }}
            />
          </div>
        ) : (
          <div className="empty-state">
            Sentiment isn&apos;t recorded in the source spreadsheet yet.<br />
            The upcoming ingestion step will auto-classify every clip with Claude — this chart lights up then.
          </div>
        )}
      </div>

      {/* TABLE */}
      <div className="chart-card">
        <div className="chart-title" style={{ marginBottom: 12 }}>
          Press Mentions ({tableRows.length} shown)
        </div>
        <div className="table-controls">
          <input
            className="search-box"
            placeholder="Search publication or headline…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {TIER_FILTERS.map((t) => (
              <button
                key={t}
                className={`filter-btn${tierFilter === t ? " active" : ""}`}
                onClick={() => setTierFilter(t)}
              >
                {t === "all" ? "All Tiers" : TIER_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrapper">
          <div className="table-scroll">
            <table className="mentions-table">
              <thead>
                <tr>
                  <Th col="date" onSort={sortBy} cur={sortCol} dir={sortDir}>Date</Th>
                  <Th col="tier" onSort={sortBy} cur={sortCol} dir={sortDir}>Tier</Th>
                  <Th col="outlet" onSort={sortBy} cur={sortCol} dir={sortDir}>Publication</Th>
                  <Th col="title" onSort={sortBy} cur={sortCol} dir={sortDir} style={{ minWidth: 280 }}>Headline</Th>
                  <Th col="eav" onSort={sortBy} cur={sortCol} dir={sortDir}>EAV</Th>
                  <Th col="reach" onSort={sortBy} cur={sortCol} dir={sortDir}>Reach</Th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((m) => (
                  <tr key={m.id}>
                    <td>{m.date ?? "—"}</td>
                    <td><span className={`tier-badge ${tierClass(m.tier)}`}>{TIER_LABEL[m.tier]}</span></td>
                    <td>{m.outlet ?? "—"}</td>
                    <td>{m.title ?? "—"}</td>
                    <td className={m.modeled ? "muted" : ""} title={m.modeled ? "Modeled from outlet rate card" : ""}>
                      {m.eavEff ? fmtEAV(m.eavEff) : "—"}{m.modeled ? "*" : ""}
                    </td>
                    <td className={m.modeled ? "muted" : ""}>
                      {m.reachEff ? fmtReach(m.reachEff) : "—"}{m.modeled ? "*" : ""}
                    </td>
                    <td>
                      {m.url && m.url.startsWith("http")
                        ? <a className="link-btn" href={m.url} target="_blank" rel="noopener noreferrer">↗</a>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.mid, marginTop: 8 }}>
          {tableRows.length} of {filtered.length} clips in range · {mentions.length} total on record ·
          {" "}<span className="muted">* EAV/reach modeled from outlet rate card</span>
        </div>
      </div>

      {/* INSIGHTS */}
      <div className="insights-panel">
        <div className="insights-title">💡 PR Insights</div>
        <div className="insights-grid">
          {insights.map((ins, i) => (
            <div key={i} className="insight-card" style={{ borderLeftColor: insightColor(ins.kind) }}>
              <div className="i-type">{ins.label}</div>
              <div className="i-text">{ins.text}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function insightColor(kind: string) {
  return kind === "high" ? C.red : kind === "medium" ? C.amber : kind === "test" ? C.blue : C.green;
}

function KpiCard({ label, value, sub, subClass }: { label: string; value: string; sub: string; subClass?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-change${subClass ? " " + subClass : ""}`}>{sub}</div>
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      <div className="chart-sub">{sub}</div>
      <div className="chart-canvas-wrap">{children}</div>
    </div>
  );
}

function Th({
  col, cur, dir, onSort, children, style,
}: {
  col: SortCol; cur: SortCol; dir: -1 | 1; onSort: (c: SortCol) => void;
  children: React.ReactNode; style?: React.CSSProperties;
}) {
  const arrow = cur === col ? (dir === 1 ? " ↑" : " ↓") : " ⇅";
  return (
    <th onClick={() => onSort(col)} style={style}>
      {children}{arrow}
    </th>
  );
}
