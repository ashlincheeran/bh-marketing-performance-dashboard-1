"use client";

import ChartBox from "@/components/Chart";
import { C } from "@/lib/theme";
import type { SovItem } from "@/lib/data";

// The single card kept from the old Monthly Rollup: news Share of Voice,
// betterhomes vs the tracked Dubai brokerages, counted live from Google News
// (year-to-date — since Jan 1 of the current year).
export default function ShareOfVoice({
  sov,
  capturedOn,
}: {
  sov: SovItem[];
  capturedOn: string | null;
}) {
  const us = sov.find((s) => s.isUs);
  const rank = us ? sov.filter((s) => s.mentions > us.mentions).length + 1 : null;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Share of Voice</div>
          <div className="page-sub">
            betterhomes vs Dubai competitors · news mentions, year to date (since Jan 1)
            {capturedOn ? ` · as of ${capturedOn}` : ""}
          </div>
        </div>
        <span className="verified-badge">🤖 Live from Google News</span>
      </div>

      <div className="kpi-strip">
        <div className="kpi-card">
          <div className="kpi-label">Your share</div>
          <div className="kpi-value">{us ? `${us.share}%` : "—"}</div>
          <div className="kpi-change">{us ? `${us.mentions} mentions (YTD)` : "no snapshot yet"}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Rank</div>
          <div className="kpi-value">{rank ? `#${rank}` : "—"}</div>
          <div className="kpi-change">of {sov.length || "—"} brands tracked</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Leader</div>
          <div className="kpi-value" style={{ fontSize: 20 }}>{sov[0]?.brand ?? "—"}</div>
          <div className="kpi-change">{sov[0] ? `${sov[0].mentions} mentions (YTD)` : ""}</div>
        </div>
      </div>

      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">News Share of Voice — year to date</div>
        <div className="chart-sub">Each brand&apos;s share of total news mentions this year · same search per brand, so it&apos;s a fair comparison</div>
        {sov.length ? (
          <div className="chart-canvas-wrap">
            <ChartBox
              type="bar"
              data={{
                labels: sov.map((s) => `${s.brand} (${s.share}%)`),
                datasets: [
                  {
                    label: "Mentions (YTD)",
                    data: sov.map((s) => s.mentions),
                    backgroundColor: sov.map((s) => (s.isUs ? C.coral : C.sand)),
                  },
                ],
              }}
              options={{ indexAxis: "y", plugins: { legend: { display: false } } }}
            />
          </div>
        ) : (
          <div className="empty-state">
            No Share-of-Voice snapshot yet — it populates on the next bot run (it counts each brand&apos;s news mentions this year).
          </div>
        )}
      </div>
    </>
  );
}
