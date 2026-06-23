"use client";

import ChartBox from "@/components/Chart";
import { C } from "@/lib/theme";
import type { SovItem } from "@/lib/data";

// News Share of Voice — betterhomes vs the tracked Dubai brokerages, computed
// from stored bot-found mentions and filtered to the date range selected above.
// betterhomes' historical archive is excluded so it's comparable to competitors.
export default function ShareOfVoice({
  items,
  from,
  to,
}: {
  items: SovItem[];
  from: string;
  to: string;
}) {
  const us = items.find((s) => s.isUs);
  const rank = us ? items.filter((s) => s.mentions > us.mentions).length + 1 : null;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Share of Voice</div>
          <div className="page-sub">
            betterhomes vs Dubai competitors · news the bot logged · {from} → {to}
          </div>
        </div>
        <span className="verified-badge">🤖 Bot-found · follows the date range</span>
      </div>

      <div className="kpi-strip">
        <div className="kpi-card">
          <div className="kpi-label">Your share</div>
          <div className="kpi-value">{us ? `${us.share}%` : "—"}</div>
          <div className="kpi-change">{us ? `${us.mentions} mentions in range` : "no mentions in range"}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Rank</div>
          <div className="kpi-value">{rank ? `#${rank}` : "—"}</div>
          <div className="kpi-change">of {items.length || "—"} brands tracked</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Leader</div>
          <div className="kpi-value" style={{ fontSize: 20 }}>{items[0]?.brand ?? "—"}</div>
          <div className="kpi-change">{items[0] ? `${items[0].mentions} mentions in range` : ""}</div>
        </div>
      </div>

      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">News Share of Voice — {from} → {to}</div>
        <div className="chart-sub">
          Each brand&apos;s share of the news the bot logged in this range · betterhomes&apos; historical archive is excluded so it&apos;s comparable to competitors
        </div>
        {items.length ? (
          <div className="chart-canvas-wrap">
            <ChartBox
              type="bar"
              data={{
                labels: items.map((s) => `${s.brand} (${s.share}%)`),
                datasets: [
                  {
                    label: "Mentions in range",
                    data: items.map((s) => s.mentions),
                    backgroundColor: items.map((s) => (s.isUs ? C.coral : C.sand)),
                  },
                ],
              }}
              options={{ indexAxis: "y", plugins: { legend: { display: false } } }}
            />
          </div>
        ) : (
          <div className="empty-state">
            No bot-logged mentions in this date range yet — widen the range, or the next bot run will add more.
          </div>
        )}
      </div>
    </>
  );
}
