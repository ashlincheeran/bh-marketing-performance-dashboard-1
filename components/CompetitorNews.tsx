"use client";

import { useMemo, useState } from "react";
import { C } from "@/lib/theme";
import type { CompetitorNewsItem } from "@/lib/data";

// Recent news the bot logged for each tracked competitor, so the team can see
// what angles rivals are pushing (this feeds the competitive insights too).
export default function CompetitorNews({ items }: { items: CompetitorNewsItem[] }) {
  const brands = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.brand, (counts.get(it.brand) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const [brand, setBrand] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const rows = brand === "all" ? items : items.filter((i) => i.brand === brand);

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">What Competitors Are Publishing</div>
          <div className="page-sub">
            Recent news the bot logged for the tracked Dubai brokerages — their angles, side by side with yours.
          </div>
        </div>
        <span className="verified-badge">🤖 Google News</span>
      </div>

      <div className="chart-card">
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, width: "100%", textAlign: "left" }}
        >
          <div className="chart-title" style={{ marginBottom: open ? 12 : 0 }}>
            {open ? "▾" : "▸"} {items.length} competitor stories on record — click to {open ? "collapse" : "expand"}
          </div>
        </button>

        {open && (
          <>
            <div className="table-controls">
              <div style={{ fontSize: 13, color: C.mid }}>Filter by competitor</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className={`filter-btn${brand === "all" ? " active" : ""}`} onClick={() => setBrand("all")}>
                  All ({items.length})
                </button>
                {brands.map(([b, n]) => (
                  <button key={b} className={`filter-btn${brand === b ? " active" : ""}`} onClick={() => setBrand(b)}>
                    {b} ({n})
                  </button>
                ))}
              </div>
            </div>

            <div className="table-wrapper">
              <div className="table-scroll">
                <table className="mentions-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Competitor</th>
                      <th>Source</th>
                      <th style={{ minWidth: 300 }}>Headline</th>
                      <th>Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="muted" style={{ padding: 16 }}>
                          No competitor coverage logged yet — the bot stores it on the next daily run.
                        </td>
                      </tr>
                    )}
                    {rows.map((it) => (
                      <tr key={it.id}>
                        <td>{it.published_on ?? "—"}</td>
                        <td><span className="tier-badge tier-t2">{it.brand}</span></td>
                        <td>{it.outlet_name ?? "—"}</td>
                        <td>{it.title ?? "—"}</td>
                        <td>
                          {it.url && it.url.startsWith("http") ? (
                            <a className="link-btn" href={it.url} target="_blank" rel="noopener noreferrer">↗</a>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.mid, marginTop: 8 }}>
              Tracked competitors come from the Monitored Keywords list. Social coverage is added once Apify is connected.
            </div>
          </>
        )}
      </div>
    </>
  );
}
