// Building blocks for the SEO & AI Channel report, one per recurring shape in
// the report's markup: section head, KPI card, card, bar row, total row, tag,
// sparkline and donut. Kept apart from the page so the page reads as the report
// does — section by section — rather than as styling.
import s from "@/components/seo/report.module.css";

/** Join module class names; falsy entries are dropped. */
export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).map((n) => s[n as string] ?? "").join(" ");

const nf = new Intl.NumberFormat("en-US");
export const fmt = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));
/**
 * Compact figure: 2.94M, 14.3K. `from` is where K starts — 10,000 by default,
 * 1,000 for figures that are only ever known to the nearest hundred (Semrush
 * reports "3.4K", and "3,400" would claim a precision nobody has).
 */
export const fmtK = (n: number | null | undefined, from = 1e4) => {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= from) return `${(n / 1e3).toFixed(1)}K`;
  return nf.format(Math.round(n));
};
export const pct = (n: number | null | undefined, dp = 1) => (n == null ? "—" : `${(n * 100).toFixed(dp)}%`);
/** Real minus sign, as the report sets it. */
export const signed = (n: number, digits = 0) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;

export type Dir = "up" | "down" | "flat";

export interface DeltaInfo {
  text: string;
  dir: Dir;
}

/** Percentage change, or null when there is no base to compare against. */
export function pctDelta(now: number, before: number, vs: string): DeltaInfo | null {
  if (!before) return null;
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return { text: `flat vs ${vs}`, dir: "flat" };
  return { text: `${d > 0 ? "▲" : "▼"} ${signed(d * 100)}% vs ${vs}`, dir: d > 0 ? "up" : "down" };
}

/** Percentage-point change between two ratios. */
export function ppDelta(now: number | null, before: number | null, vs: string): DeltaInfo | null {
  if (now == null || before == null) return null;
  const d = (now - before) * 100;
  if (Math.abs(d) < 0.05) return { text: `flat vs ${vs}`, dir: "flat" };
  return { text: `${d > 0 ? "▲" : "▼"} ${signed(d, 1)} pp vs ${vs}`, dir: d > 0 ? "up" : "down" };
}

export function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className={cx("section")}>
      <div className={cx("secHead")}>
        <h2 className={cx("secTitle")}>
          <span className={cx("dmd")}>◆</span>
          {title}
        </h2>
        {note && <div className={cx("secNote")}>{note}</div>}
      </div>
      {children}
    </section>
  );
}

export function NewTag() {
  return <span className={cx("newTag")}>NEW</span>;
}

export function Kpi({
  label, value, sub, delta, isNew, pending, mark,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  delta?: DeltaInfo | null;
  isNew?: boolean;
  pending?: boolean;
  /** The corner diamond, when it should not simply follow the delta. */
  mark?: Dir;
}) {
  const dia = mark ?? delta?.dir;
  return (
    <div className={cx("kpi", isNew && "new")}>
      {isNew && <NewTag />}
      <span className={cx("dia", dia === "up" && "up", dia === "down" && "down")} />
      <div className={cx("lbl")}>{label}</div>
      <div className={cx("val", pending && "pending")}>{value}</div>
      {sub && <div className={cx("sub")}>{sub}</div>}
      {delta && <div className={cx("delta", delta.dir)}>{delta.text}</div>}
    </div>
  );
}

export function Card({
  title, cap, isNew, children, className,
}: {
  title?: string;
  cap?: string;
  isNew?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${cx("card", isNew && "new")} ${className ?? ""}`}>
      {isNew && <NewTag />}
      {title && <h3>{title}</h3>}
      {cap && <div className={cx("cap")}>{cap}</div>}
      {children}
    </div>
  );
}

export function Bar({
  name, sub, value, max, color = "navy", right,
}: {
  name: React.ReactNode;
  sub?: React.ReactNode;
  value: number;
  max: number;
  color?: "navy" | "tan" | "green";
  right?: React.ReactNode;
}) {
  const w = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <div className={cx("bar")}>
      <div className={cx("name")}>
        {name}
        {sub && <small>{sub}</small>}
      </div>
      <div className={cx("track")}>
        <div className={cx("fill", color)} style={{ width: `${w}%` }} />
      </div>
      <div className={cx("num")}>{right ?? fmt(value)}</div>
    </div>
  );
}

export function Tot({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className={cx("tot")}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function Tag({ kind, children }: { kind: "up" | "down" | "flat" | "b" | "pend" | "focus"; children: React.ReactNode }) {
  return <span className={cx("tag", kind)}>{children}</span>;
}

/** Tag for a signed count change: green when up, red when down. */
export function DeltaTag({ now, before }: { now: number; before: number }) {
  const d = now - before;
  if (d === 0) return <Tag kind="flat">flat</Tag>;
  return <Tag kind={d > 0 ? "up" : "down"}>{d > 0 ? `+${d}` : `${d}`}</Tag>;
}

/** Tag for a percentage change, as the report's Leads & deals column sets it. */
export function PctTag({ now, before }: { now: number; before: number }) {
  if (!before) return <Tag kind="flat">—</Tag>;
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return <Tag kind="flat">flat</Tag>;
  return <Tag kind={d > 0 ? "up" : "down"}>{d > 0 ? "▲ " : ""}{signed(d * 100)}%</Tag>;
}

/** Month-by-month line with a soft area and an end dot, as on the assistant cards. */
export function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className={cx("spark")} viewBox="0 0 180 40" />;
  const W = 180, H = 40, pad = 4;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [pad + (i * (W - pad * 2)) / (values.length - 1), H - pad - (v / max) * (H - pad * 2)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
  const [ex, ey] = pts[pts.length - 1];
  return (
    <svg className={cx("spark")} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={area} fill="rgba(44,83,122,0.10)" />
      <path d={line} fill="none" stroke="#2c537a" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <circle cx={ex} cy={ey} r="2.6" fill="#1f4456" />
    </svg>
  );
}

/** Share ring. Segments drawn with stroke-dasharray, largest first, clockwise from twelve. */
export function Donut({
  parts, centre, centreSub,
}: {
  parts: { value: number; color: string }[];
  centre: string;
  centreSub: string;
}) {
  // The report's ring: 250 across, 119 out and 75 in.
  const size = 250, r = 97, stroke = 44, C = 2 * Math.PI * r;
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  // Each segment's start is the sum of the ones before it — computed up front,
  // because accumulating it inside the render map is a mutation during render.
  const segs = parts.map((p, i) => ({
    color: p.color,
    len: (p.value / total) * C,
    off: (parts.slice(0, i).reduce((a, q) => a + q.value, 0) / total) * C,
  }));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: "none" }} aria-hidden>
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {segs.map((g, i) => (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={g.color}
            strokeWidth={stroke}
            strokeDasharray={`${Math.max(0, g.len - 1.5)} ${C}`}
            strokeDashoffset={-g.off}
          />
        ))}
      </g>
      <text x={size / 2} y="119" textAnchor="middle" fontFamily="Georgia, serif" fontSize="30" fill="#16323d">{centre}</text>
      <text x={size / 2} y="139" textAnchor="middle" fontSize="11" letterSpacing="1.4" fill="#6e7b82">{centreSub}</text>
    </svg>
  );
}
