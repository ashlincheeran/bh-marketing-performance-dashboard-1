"use client";

import { useState } from "react";
import { C } from "@/lib/theme";
import type { FlowData } from "@/lib/posthog";

// Dependency-free N-column Sankey. Flow conserves where it continues; where a
// node's outgoing ribbons sum to less than its height, that gap is the drop-off
// (sessions that didn't go further) — no explicit "Exit" node needed.
//
// Entry-source (column 0) nodes carry a per-domain `breakdown`: hover shows the
// top sub-sources, click opens the full list below the diagram.
const NODE_W = 13;
const GAP = 13;
const PAD_TOP = 18;
const PAD_BOT = 16;
const PAD_L = 110;
const PAD_R = 140;
const W = 940;

const COLORS: Record<string, string> = {
  // entry sources
  "Organic Search": C.green,
  Direct: C.sand,
  Social: C.blue,
  Referral: C.coral,
  "AI Assistant": "#7c5cbf",
  // page sections — the SEO tab's labels (PAGE_SECTION_LABELS in lib/posthog)
  "Home page": C.dark,
  "Property listings": C.coral,
  Buy: "#d9614c",
  Rent: C.blue,
  Blog: C.sage,
  "Area guides": C.amber,
  "Building guides": "#a86b2d",
  "New projects": C.mid,
  Commercial: "#8c6d46",
  Careers: C.green,
  "Team pages": "#6b8f71",
  "List your property": "#b5838d",
  Valuation: "#9a7fb8",
  "Property management": "#5f8aa6",
  Other: C.sand,
};
const nodeColor = (label: string) => COLORS[label] ?? C.mid;
const trunc = (s: string, n = 16) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export default function Sankey({ flow, captions }: { flow: FlowData; captions?: string[] }) {
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const numCols = Math.max(1, ...flow.nodes.map((n) => n.col + 1));
  const cols = Array.from({ length: numCols }, (_, c) => flow.nodes.filter((n) => n.col === c));
  const total = (cols[0]?.reduce((a, n) => a + n.value, 0)) || flow.sessions || 1;
  const maxNodes = Math.max(1, ...cols.map((c) => c.length));
  const H = Math.max(340, maxNodes * 46);
  const innerH = H - PAD_TOP - PAD_BOT;
  const scale = (innerH - GAP * (maxNodes - 1)) / total;
  const lastX = W - PAD_R - NODE_W;
  const colX = (c: number) => (numCols === 1 ? PAD_L : PAD_L + c * ((lastX - PAD_L) / (numCols - 1)));

  // place nodes, centred per column
  const pos = new Map<string, { x: number; y: number; h: number; label: string; col: number }>();
  cols.forEach((colNodes, c) => {
    const stackH = colNodes.reduce((a, n) => a + Math.max(2, n.value * scale), 0) + GAP * (colNodes.length - 1);
    let y = PAD_TOP + Math.max(0, (innerH - stackH) / 2);
    const x = colX(c);
    for (const n of colNodes) {
      const h = Math.max(2, n.value * scale);
      pos.set(n.id, { x, y, h, label: n.label, col: c });
      y += h + GAP;
    }
  });

  // ribbons, stacked along each node edge
  const out = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const n of flow.nodes) { out.set(n.id, pos.get(n.id)!.y); inc.set(n.id, pos.get(n.id)!.y); }
  const ordered = [...flow.links].sort((a, b) => {
    const sa = pos.get(a.source)!, sb = pos.get(b.source)!;
    return sa.x - sb.x || sa.y - sb.y || pos.get(a.target)!.y - pos.get(b.target)!.y;
  });
  const ribbons = ordered.map((l, i) => {
    const s = pos.get(l.source); const t = pos.get(l.target);
    if (!s || !t) return null;
    const th = Math.max(1, l.value * scale);
    const sx = s.x + NODE_W, sy = out.get(l.source)!;
    const tx = t.x, ty = inc.get(l.target)!;
    out.set(l.source, sy + th); inc.set(l.target, ty + th);
    const mx = (sx + tx) / 2;
    const d = `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty} L${tx},${ty + th} C${mx},${ty + th} ${mx},${sy + th} ${sx},${sy + th} Z`;
    return <path key={i} d={d} fill={nodeColor(t.label)} opacity={0.26} />;
  });

  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const hoverNode = hover ? nodeById.get(hover.id) : null;
  const openNode = openId ? nodeById.get(openId) : null;

  return (
    <div style={{ position: "relative" }}>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 680, display: "block" }}>
          {captions && cols.map((_, c) => (
            <text
              key={`cap-${c}`}
              x={c === 0 ? colX(0) : c === numCols - 1 ? colX(c) + NODE_W : colX(c) + NODE_W / 2}
              y={11}
              fontSize="10"
              fontWeight={700}
              fill={C.mid}
              textAnchor={c === 0 ? "start" : c === numCols - 1 ? "end" : "middle"}
            >
              {(captions[c] ?? "").toUpperCase()}
            </text>
          ))}
          {ribbons}
          {flow.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const isFirst = n.col === 0;
            const hasBreak = (n.breakdown?.length ?? 0) > 0;
            const isOpen = openId === n.id;
            const labelX = isFirst ? p.x - 8 : p.x + NODE_W + 8;
            return (
              <g
                key={n.id}
                style={{ cursor: hasBreak ? "pointer" : "default" }}
                onMouseEnter={hasBreak ? (e) => setHover({ x: e.clientX, y: e.clientY, id: n.id }) : undefined}
                onMouseMove={hasBreak ? (e) => setHover({ x: e.clientX, y: e.clientY, id: n.id }) : undefined}
                onMouseLeave={hasBreak ? () => setHover((h) => (h?.id === n.id ? null : h)) : undefined}
                onClick={hasBreak ? () => setOpenId((o) => (o === n.id ? null : n.id)) : undefined}
              >
                <rect
                  x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2}
                  fill={nodeColor(n.label)}
                  stroke={isOpen ? C.dark : "transparent"} strokeWidth={isOpen ? 1.5 : 0}
                />
                <text x={labelX} y={p.y + p.h / 2} fontSize="10.5" fill={C.dark} textAnchor={isFirst ? "end" : "start"} dominantBaseline="middle">
                  {hasBreak ? (isOpen ? "▾ " : "▸ ") : ""}{trunc(n.label)} <tspan fill={C.mid}>· {n.value}</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* hover tooltip — top 5 sub-entries with view rate */}
      {hover && hoverNode?.breakdown?.length ? (() => {
        const denom = hoverNode.breakdown.reduce((a, b) => a + b.value, 0) || 1;
        const metric = hoverNode.col === 0 ? "sessions" : "views";
        const top = hoverNode.breakdown.slice(0, 5);
        return (
          <div
            style={{
              position: "fixed", left: Math.min(hover.x + 14, (typeof window !== "undefined" ? window.innerWidth : 9999) - 290),
              top: hover.y + 14, zIndex: 60, pointerEvents: "none",
              background: "#fff", border: "1px solid var(--border)", borderRadius: 8,
              boxShadow: "0 6px 24px rgba(0,0,0,.16)", padding: "10px 12px", width: 260,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: C.dark, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: nodeColor(hoverNode.label), display: "inline-block" }} />
              {hoverNode.label} · {hoverNode.value}
            </div>
            {top.map((b) => {
              const pct = Math.round((b.value / denom) * 100);
              return (
                <div key={b.label} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, color: C.mid, lineHeight: 1.8 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>{b.label}</span>
                  <span style={{ fontWeight: 600, color: C.dark, whiteSpace: "nowrap" }}>{b.value} <span style={{ color: C.mid, fontWeight: 400 }}>· {pct}%</span></span>
                </div>
              );
            })}
            <div style={{ fontSize: 10, color: C.sand, marginTop: 6 }}>
              top 5 by {metric}{hoverNode.breakdown.length > 5 ? ` · +${hoverNode.breakdown.length - 5} more` : ""} · click to open ▾
            </div>
          </div>
        );
      })() : null}

      {/* click-to-open — full breakdown panel */}
      {openNode?.breakdown?.length ? (() => {
        const unit = openNode.col === 0 ? "source" : "page";
        const metric = openNode.col === 0 ? "sessions" : "pageviews";
        const denom = openNode.breakdown.reduce((a, b) => a + b.value, 0) || 1;
        return (
          <div className="sankey-open">
            <div className="sankey-open-head">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 11, height: 11, borderRadius: 3, background: nodeColor(openNode.label), display: "inline-block" }} />
                {openNode.label} — {openNode.breakdown.length} {unit}{openNode.breakdown.length === 1 ? "" : "s"} · by {metric}
              </span>
              <button className="filter-btn" onClick={() => setOpenId(null)}>Close ✕</button>
            </div>
            <div className="sankey-open-list">
              {openNode.breakdown.map((b) => {
                const pct = Math.round((b.value / denom) * 100);
                return (
                  <div key={b.label} className="sankey-open-row">
                    <span className="sankey-open-name" title={b.label}>{b.label}</span>
                    <span className="sankey-open-bar"><span style={{ width: `${Math.max(2, pct)}%`, background: nodeColor(openNode.label) }} /></span>
                    <span className="sankey-open-val">{b.value}<span className="muted"> · {pct}%</span></span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })() : null}
    </div>
  );
}
