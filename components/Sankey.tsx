"use client";

import { C } from "@/lib/theme";
import type { FlowData } from "@/lib/posthog";

// Lightweight 3-column Sankey (Channel → Landing page → outcome), drawn as SVG.
// Flow is conserved: every session has one channel, one landing, one outcome,
// so all three columns sum to the same total and a single px-per-session scale
// makes node heights and ribbon thicknesses line up.
const NODE_W = 13;
const GAP = 13;
const PAD_TOP = 16;
const PAD_BOT = 16;
const PAD_L = 124; // room for channel labels
const PAD_R = 150; // room for landing/outcome labels
const W = 920;

const CH_COLORS: Record<string, string> = {
  "Organic Search": C.green,
  Direct: C.sand,
  Social: C.blue,
  Referral: C.coral,
};

function nodeColor(kind: string, label: string): string {
  if (kind.startsWith("channel:")) return CH_COLORS[label] ?? C.mid;
  if (kind.startsWith("outcome:")) return label.includes("Bounced") ? C.red : C.green;
  return C.dark; // landing
}

function trunc(s: string, n = 24): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export default function Sankey({ flow }: { flow: FlowData }) {
  const cols = [0, 1, 2].map((c) => flow.nodes.filter((n) => n.col === c));
  const total = cols[0].reduce((a, n) => a + n.value, 0) || flow.sessions || 1;
  const maxNodes = Math.max(1, ...cols.map((c) => c.length));
  const H = Math.max(340, maxNodes * 46);
  const innerH = H - PAD_TOP - PAD_BOT;
  const scale = (innerH - GAP * (maxNodes - 1)) / total;

  // place nodes
  const pos = new Map<string, { x: number; y: number; h: number; label: string; kind: string }>();
  const colX = [PAD_L, (PAD_L + (W - PAD_R - NODE_W)) / 2, W - PAD_R - NODE_W];
  cols.forEach((colNodes, c) => {
    const stackH = colNodes.reduce((a, n) => a + n.value * scale, 0) + GAP * (colNodes.length - 1);
    let y = PAD_TOP + Math.max(0, (innerH - stackH) / 2);
    for (const n of colNodes) {
      const h = Math.max(2, n.value * scale);
      pos.set(n.id, { x: colX[c], y, h, label: n.label, kind: n.kind });
      y += h + GAP;
    }
  });

  // ribbons — stack along each node's edge, ordered to reduce crossings
  const out = new Map<string, number>();
  const inc = new Map<string, number>();
  for (const n of flow.nodes) { out.set(n.id, pos.get(n.id)!.y); inc.set(n.id, pos.get(n.id)!.y); }
  const ordered = [...flow.links].sort((a, b) => {
    const sa = pos.get(a.source)!, sb = pos.get(b.source)!;
    if (sa.x !== sb.x) return sa.x - sb.x;
    if (sa.y !== sb.y) return sa.y - sb.y;
    return pos.get(a.target)!.y - pos.get(b.target)!.y;
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
    // colour channel→landing by channel; landing→outcome by outcome
    const color = t.kind.startsWith("outcome:") ? (t.label.includes("Bounced") ? C.red : C.green) : nodeColor(s.kind, s.label);
    return <path key={i} d={d} fill={color} opacity={0.28} />;
  });

  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 620, display: "block" }}>
        {/* column captions */}
        <text x={PAD_L} y={11} fontSize="10" fontWeight={700} fill={C.mid}>CHANNEL</text>
        <text x={colX[1]} y={11} fontSize="10" fontWeight={700} fill={C.mid} textAnchor="middle">LANDING PAGE</text>
        <text x={W - PAD_R - NODE_W + NODE_W} y={11} fontSize="10" fontWeight={700} fill={C.mid} textAnchor="end">OUTCOME</text>
        {ribbons}
        {flow.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const isCol0 = n.col === 0;
          const labelX = isCol0 ? p.x - 8 : p.x + NODE_W + 8;
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2} fill={nodeColor(n.kind, n.label)} />
              <text
                x={labelX}
                y={p.y + p.h / 2}
                fontSize="11"
                fill={C.dark}
                textAnchor={isCol0 ? "end" : "start"}
                dominantBaseline="middle"
              >
                {trunc(n.label)} <tspan fill={C.mid}>· {n.value}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
