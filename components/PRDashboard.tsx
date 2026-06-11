"use client";

import { useMemo, useState } from "react";
import ChartBox from "@/components/Chart";
import { C, TIER_COLOR, TIERS, TIER_LABEL, tierClass } from "@/lib/theme";
import {
  annualByTier,
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
import type { Insight } from "@/lib/pr";
import type { Mention, Sentiment, Tier } from "@/lib/types";

type SortCol = "date" | "tier" | "outlet" | "title" | "eav" | "reach";

const TIER_FILTERS: ("all" | Tier)[] = ["all", "T1-Global", "T1-Local", "T2", "T3"];
const SENT_FILTERS: ("all" | NonNullable<Sentiment>)[] = ["all", "positive", "neutral", "negative", "mixed"];

// ── month helpers (for the A-vs-B comparison) ───────────────────
function shiftMonth(ym: string, delta: number): string {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}
const maxStr = (a: string, b: string) => (a > b ? a : b);

function pctDelta(a: number, b: number): { text: string; cls?: "up" | "down" } {
  if (b === 0) return { text: a > 0 ? "▲ new vs B" : "— vs B", cls: a > 0 ? "up" : undefined };
  const d = Math.round(((a - b) / b) * 100);
  return { text: `${d > 0 ? "+" : ""}${d}% vs B`, cls: d > 0 ? "up" : d < 0 ? "down" : undefined };
}
function ppDelta(a: number | null, b: number | null): { text: string; cls?: "up" | "down" } {
  if (a == null || b == null) return { text: "vs B" };
  const d = a - b;
  return { text: `${d > 0 ? "+" : ""}${d}pp vs B`, cls: d > 0 ? "up" : d < 0 ? "down" : undefined };
}

export default function PRDashboard({
  mentions,
  minMonth,
  maxMonth,
  defaultFrom,
  insights,
}: {
  mentions: Mention[];
  minMonth: string;
  maxMonth: string;
  defaultFrom: string;
  insights: Insight[];
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(maxMonth);

  // comparison (Period B) — defaults to the equal-length window before Period A
  const initLen = monthSpan(defaultFrom, maxMonth);
  const initToB = maxStr(shiftMonth(defaultFrom, -1), minMonth);
  const initFromB = maxStr(shiftMonth(initToB, -(initLen - 1)), minMonth);
  const [compare, setCompare] = useState(false);
  const [fromB, setFromB] = useState(initFromB);
  const [toB, setToB] = useState(initToB);

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

  // Period B aggregates (only meaningful when compare is on)
  const filteredB = useMemo(() => filterRange(mentions, fromB, toB), [mentions, fromB, toB]);
  const kB = useMemo(() => kpis(filteredB), [filteredB]);

  const tierTotals = (ms: Mention[]) => {
    const r: Record<Tier, number> = { "T1-Global": 0, "T1-Local": 0, T2: 0, T3: 0, Other: 0 };
    for (const m of ms) r[m.tier] += 1;
    return r;
  };
  const tA = useMemo(() => tierTotals(filtered), [filtered]);
  const tB = useMemo(() => tierTotals(filteredB), [filteredB]);
  const tiersPresent = TIERS.filter((t) => tA[t] > 0 || tB[t] > 0);

  function setBToPeriodBeforeA() {
    const len = monthSpan(from, to);
    const nToB = maxStr(shiftMonth(from, -1), minMonth);
    const nFromB = maxStr(shiftMonth(nToB, -(len - 1)), minMonth);
    setToB(nToB);
    setFromB(nFromB);
  }

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

  // sentiment card sub + tooltip (so "how is this calculated" is answerable in the UI)
  const sentTitle =
    k.posPct == null
      ? "No clips in this range have an AI-assigned tone yet."
      : `Positive Sentiment = positive clips ÷ clips that have an AI tone (not ÷ all clips). ` +
        `In range: ${sent.total} of ${k.count} clips are tone-scored — ` +
        `${sent.counts.positive} positive, ${sent.counts.neutral} neutral, ${sent.counts.negative} negative, ${sent.counts.mixed} mixed.`;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">PR &amp; Media</div>
          <div className="page-sub">
            {filtered.length} clips · {from} → {to}
            {compare ? ` vs ${fromB} → ${toB} (${filteredB.length} clips)` : " · internal press-clipping records + daily bot"}
          </div>
        </div>
        <span className="verified-badge">✓ Verified from press clippings</span>
      </div>

      {/* DATE RANGE + COMPARE */}
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
        <div className="field">
          <label>&nbsp;</label>
          <button className={`filter-btn${compare ? " active" : ""}`} onClick={() => setCompare((v) => !v)} title="Compare this period against another">
            ⇄ Compare {compare ? "on" : "off"}
          </button>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={exportCsv} title="Export the selected date range to Excel">
            ⬇ Export to Excel
          </button>
        </div>
      </div>

      {compare && (
        <div className="controls-bar" style={{ background: "var(--warm-white, #f8f6f3)", borderRadius: 8, padding: "8px 10px" }}>
          <div className="field">
            <label>Compare to — From</label>
            <input type="month" value={fromB} min={minMonth} max={toB} onChange={(e) => setFromB(e.target.value)} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="month" value={toB} min={fromB} max={maxMonth} onChange={(e) => setToB(e.target.value)} />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="filter-btn" onClick={setBToPeriodBeforeA} title="Set Period B to the equal-length window right before Period A">
              ↤ Period before A
            </button>
          </div>
          <div className="field" style={{ alignSelf: "center", marginLeft: 8 }}>
            <span style={{ fontSize: 12, color: C.mid }}>
              <strong style={{ color: C.coral }}>A</strong> = {from}→{to} · <strong style={{ color: C.sand }}>B</strong> = {fromB}→{toB}
            </span>
          </div>
        </div>
      )}

      {/* KPIs (show Δ vs B when comparing) */}
      <div className="kpi-strip">
        <KpiCard label="Total Mentions" value={String(k.count)}
          {...(compare ? pctDeltaProps(k.count, kB.count) : { sub: "in date range" })} />
        <KpiCard label="Tier-1 Placements" value={String(k.tier1)}
          {...(compare ? pctDeltaProps(k.tier1, kB.tier1) : { sub: "Global + Local", subClass: "up" })} />
        <KpiCard label="Est. Reach" value={fmtReachFull(k.reach)}
          {...(compare ? pctDeltaProps(k.reach, kB.reach) : { sub: "rate-card modeled" })} />
        <KpiCard label="EAV" value={fmtEAV(k.eav)}
          {...(compare ? pctDeltaProps(k.eav, kB.eav) : { sub: "rate-card modeled" })} />
        <KpiCard label="Positive Sentiment" value={k.posPct == null ? "—" : `${k.posPct}%`} title={sentTitle}
          {...(compare
            ? ppDeltaProps(k.posPct, kB.posPct)
            : { sub: k.posPct == null ? "no tone scored yet" : `${sent.counts.positive} of ${sent.total} scored`, subClass: k.posPct == null ? undefined : "up" })} />
      </div>

      {/* COMPARISON PANEL */}
      {compare && (
        <div className="charts-grid-2" style={{ marginBottom: 20 }}>
          <div className="chart-card">
            <div className="chart-title">Period A vs Period B</div>
            <div className="chart-sub">
              A = {from}→{to} ({filtered.length} clips) · B = {fromB}→{toB} ({filteredB.length} clips)
            </div>
            <table className="mentions-table" style={{ marginTop: 10 }}>
              <thead>
                <tr><th>Metric</th><th style={{ textAlign: "right" }}>A</th><th style={{ textAlign: "right" }}>B</th><th style={{ textAlign: "right" }}>Change</th></tr>
              </thead>
              <tbody>
                <CmpRow label="Mentions" a={String(k.count)} b={String(kB.count)} d={pctDelta(k.count, kB.count)} />
                <CmpRow label="Tier-1" a={String(k.tier1)} b={String(kB.tier1)} d={pctDelta(k.tier1, kB.tier1)} />
                <CmpRow label="Est. Reach" a={fmtReachFull(k.reach)} b={fmtReachFull(kB.reach)} d={pctDelta(k.reach, kB.reach)} />
                <CmpRow label="EAV" a={fmtEAV(k.eav)} b={fmtEAV(kB.eav)} d={pctDelta(k.eav, kB.eav)} />
                <CmpRow label="Positive %" a={k.posPct == null ? "—" : `${k.posPct}%`} b={kB.posPct == null ? "—" : `${kB.posPct}%`} d={ppDelta(k.posPct, kB.posPct)} />
              </tbody>
            </table>
          </div>
          <div className="chart-card">
            <div className="chart-title">Mentions by Tier — A vs B</div>
            <div className="chart-sub">Same scale, so the mix is directly comparable</div>
            <div className="chart-canvas-wrap">
              <ChartBox
                type="bar"
                data={{
                  labels: tiersPresent.map((t) => TIER_LABEL[t]),
                  datasets: [
                    { label: `A (${from}→${to})`, data: tiersPresent.map((t) => tA[t]), backgroundColor: C.coral },
                    { label: `B (${fromB}→${toB})`, data: tiersPresent.map((t) => tB[t]), backgroundColor: C.sand },
                  ],
                }}
                options={{ plugins: legendBottom }}
              />
            </div>
          </div>
        </div>
      )}

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
        <div className="chart-sub">Tone of coverage in range · AI-assigned (Gemini) from each article</div>
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
            No tone scored for this range yet.<br />
            The daily bot auto-classifies each new article; historical clips without a tone stay blank.
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
        <div className="table-controls" style={{ marginTop: 0 }}>
          <span style={{ fontSize: 12, color: C.mid }}>Tone:</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {SENT_FILTERS.map((s) => (
              <button
                key={s}
                className={`filter-btn${sentFilter === s ? " active" : ""}`}
                onClick={() => setSentFilter(s)}
              >
                {s === "all" ? "All Tones" : s.charAt(0).toUpperCase() + s.slice(1)}
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
                  <th>Tone</th>
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
                      {m.sentiment
                        ? <span className={`sent-badge sent-${m.sentiment}`}>{m.sentiment}</span>
                        : <span className="muted">—</span>}
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
          {" "}<span className="muted">* EAV/reach modeled from outlet rate card</span> ·
          {" "}Tone is AI-assigned; “—” means not scored.
        </div>
      </div>

      {/* INSIGHTS — competitive & actionable */}
      <div className="insights-panel">
        <div className="insights-title">💡 What to do next (vs competitors)</div>
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

function pctDeltaProps(a: number, b: number): { sub: string; subClass?: string } {
  const d = pctDelta(a, b);
  return { sub: d.text, subClass: d.cls };
}
function ppDeltaProps(a: number | null, b: number | null): { sub: string; subClass?: string } {
  const d = ppDelta(a, b);
  return { sub: d.text, subClass: d.cls };
}

function CmpRow({ label, a, b, d }: { label: string; a: string; b: string; d: { text: string; cls?: "up" | "down" } }) {
  const color = d.cls === "up" ? C.green : d.cls === "down" ? C.red : C.mid;
  return (
    <tr>
      <td>{label}</td>
      <td style={{ textAlign: "right", fontWeight: 600 }}>{a}</td>
      <td style={{ textAlign: "right", color: C.mid }}>{b}</td>
      <td style={{ textAlign: "right", color, fontWeight: 600 }}>{d.text.replace(" vs B", "")}</td>
    </tr>
  );
}

function KpiCard({ label, value, sub, subClass, title }: { label: string; value: string; sub?: string; subClass?: string; title?: string }) {
  return (
    <div className="kpi-card" title={title}>
      <div className="kpi-label">{label}{title ? " ⓘ" : ""}</div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-change${subClass ? " " + subClass : ""}`}>{sub ?? ""}</div>
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
