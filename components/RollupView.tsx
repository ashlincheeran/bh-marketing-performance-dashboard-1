"use client";

import ChartBox from "@/components/Chart";
import { C } from "@/lib/theme";
import type { RollupData } from "@/lib/rollup";
import type { SovItem } from "@/lib/data";

function Kpi({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-change${cls ? " " + cls : ""}`}>{sub ?? ""}</div>
    </div>
  );
}

export default function RollupView({
  rollup, sov, capturedOn,
}: { rollup: RollupData; sov: SovItem[]; capturedOn: string | null }) {
  const us = sov.find((s) => s.isUs);
  const net = rollup.netSentiment;
  const netLabel = net == null ? "—" : `${net > 0 ? "+" : ""}${net.toFixed(2)}`;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Monthly Rollup — {rollup.monthLabel}</div>
          <div className="page-sub">
            Built from your real news data. Social & review sections need a listening tool — left blank, not invented.
          </div>
        </div>
        <span className="verified-badge">✓ Real news data</span>
      </div>

      <div className="kpi-strip">
        <Kpi label="Mentions this month" value={String(rollup.total)} sub="news clips" />
        <Kpi label="MoM change" value={rollup.momPct == null ? "—" : `${rollup.momPct > 0 ? "+" : ""}${rollup.momPct}%`}
          cls={rollup.momPct != null ? (rollup.momPct >= 0 ? "up" : "down") : undefined} />
        <Kpi label="Net sentiment" value={netLabel} sub={`${rollup.scored} scored`} cls={net != null && net >= 0 ? "up" : net != null ? "down" : undefined} />
        <Kpi label="Share of Voice" value={us ? `${us.share}%` : "—"} sub="vs Dubai brokerages" cls="up" />
        <Kpi label="Top theme" value={rollup.themes[0]?.theme ?? "—"} sub={rollup.themes[0] ? `${rollup.themes[0].count} mentions` : ""} />
      </div>

      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">Share of Voice — news mentions (last 30 days){capturedOn ? ` · as of ${capturedOn}` : ""}</div>
        <div className="chart-sub">betterhomes vs competitors · live from Google News</div>
        {sov.length ? (
          <div className="chart-canvas-wrap">
            <ChartBox
              type="bar"
              data={{
                labels: sov.map((s) => `${s.brand} (${s.share}%)`),
                datasets: [{ label: "Mentions (30d)", data: sov.map((s) => s.mentions), backgroundColor: sov.map((s) => (s.isUs ? C.coral : C.sand)) }],
              }}
              options={{ indexAxis: "y", plugins: { legend: { display: false } } }}
            />
          </div>
        ) : (
          <div className="empty-state">No Share-of-Voice snapshot yet — it populates on the next bot run (it counts each brand&apos;s news mentions).</div>
        )}
      </div>

      <div className="charts-grid-2">
        <div className="chart-card">
          <div className="chart-title">Top stories</div>
          <div className="chart-sub">Highest-reach coverage this month</div>
          <table className="mentions-table" style={{ marginTop: 8 }}>
            <tbody>
              {rollup.topStories.map((s, i) => (
                <tr key={i}>
                  <td>{s.title}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{s.outlet}</td>
                  <td>{s.sentiment ? <span className={`sent-badge sent-${s.sentiment}`}>{s.sentiment}</span> : <span className="muted">—</span>}</td>
                  <td>{s.url && s.url.startsWith("http") ? <a className="link-btn" href={s.url} target="_blank" rel="noopener noreferrer">↗</a> : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {rollup.topStories.length === 0 && <tr><td className="muted">No stories this month.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="chart-card">
          <div className="chart-title">Themes that drove coverage</div>
          <div className="chart-sub">Derived from headlines</div>
          <table className="mentions-table" style={{ marginTop: 8 }}>
            <tbody>
              {rollup.themes.map((t) => (<tr key={t.theme}><td>{t.theme}</td><td style={{ textAlign: "right" }}>{t.count}</td></tr>))}
              {rollup.themes.length === 0 && <tr><td className="muted">—</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="charts-grid-2">
        <div className="chart-card">
          <div className="chart-title">Spokesperson share of voice</div>
          <div className="chart-sub">betterhomes people named in this month&apos;s coverage</div>
          <table className="mentions-table" style={{ marginTop: 8 }}>
            <tbody>
              {rollup.spokespeople.map((s) => (<tr key={s.name}><td>{s.name}</td><td style={{ textAlign: "right" }}>{s.mentions}</td></tr>))}
              {rollup.spokespeople.length === 0 && <tr><td className="muted">No named spokespeople in this month&apos;s headlines.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="chart-card">
          <div className="chart-title">Social & online reviews</div>
          <div className="chart-sub">LinkedIn / Instagram / X / TikTok sentiment · Google & Trustpilot reviews</div>
          <div className="empty-state">
            Not connected. These need a social-listening tool (Brand24 / Meltwater) or review scrapers —
            left blank on purpose instead of inventing numbers.
          </div>
        </div>
      </div>
    </>
  );
}
