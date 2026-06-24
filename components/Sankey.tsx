"use client";

import { C } from "@/lib/theme";
import type { FlowData } from "@/lib/posthog";

// Dependency-free N-column Sankey. Flow conserves where it continues; where a
// node's outgoing ribbons sum to less than its height, that gap is the drop-off
// (sessions that didn't go further) — no explicit "Exit" node needed.
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
  // page categories
  Home: C.dark,
  "Buy listings": C.coral,
  "Rent listings": C.blue,
  Blog: C.sage,
  "Blog: Market reports": C.green,
  "Area guides": C.amber,
  Developers: C.mid,
  Branches: C.sand,
  Commercial: "#a86b2d",
  Agents: "#6b8f71",
  Other: C.sand,
};
const nodeColor = (label: string) => COLORS[label] ?? C.mid;
const trunc = (s: string, n = 16) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export default function Sankey({ flow, captions }: { flow: FlowData; captions?: string[] }) {
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

  return (
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
          const labelX = isFirst ? p.x - 8 : p.x + NODE_W + 8;
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2} fill={nodeColor(n.label)} />
              <text x={labelX} y={p.y + p.h / 2} fontSize="10.5" fill={C.dark} textAnchor={isFirst ? "end" : "start"} dominantBaseline="middle">
                {trunc(n.label)} <tspan fill={C.mid}>· {n.value}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
