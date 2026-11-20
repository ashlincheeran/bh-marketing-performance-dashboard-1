// The house style every tab is built from, so the tabs look and read alike
// (styles under "HOUSE STYLE" in app/globals.css). A tab is, top to bottom:
//
//   PageHeader     the title, one line on what the tab shows, and actions on the right
//   FilterBar      labelled controls: the date range first, then the tab's other filters
//   DataStatus     where the figures come from and how old they are ("updated 3m ago")
//   KpiGrid / Kpi  the headline figures, four to a row
//   Section        a white card per chart or table, titled the same way everywhere
//   Notes          context last: how things are counted, and anything that failed
//
// Figures are written in the dark ink; colour is kept for change (green up, red
// down) and for a figure that is a warning. Nothing here fetches or holds state.
import type { ReactNode } from "react";
import HelpTip from "@/components/HelpTip";
import UpdatedAgo from "@/components/UpdatedAgo";

/** The tab's title, one line on what it shows, and actions (an export, a settings link) on the right. */
export function PageHeader({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1 className="page-title">{title}</h1>
        {sub ? <div className="page-sub">{sub}</div> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  );
}

/** The row of labelled controls under the header. `actions` (Refresh now, Export) sit at its right end. */
export function FilterBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="filter-bar">
      {children}
      {actions ? <div className="filter-actions">{actions}</div> : null}
    </div>
  );
}

/** One control in the FilterBar, with its label above it. */
export function Filter({ label, help, children }: { label: ReactNode; help?: string; children: ReactNode }) {
  return (
    <div className="filter">
      <span className="filter-label">
        {label}
        {help ? <HelpTip text={help} /> : null}
      </span>
      {children}
    </div>
  );
}

/** Pill buttons choosing one of a few values: the Sale / Leasing side, a platform. */
export function Pills<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly (readonly [T, ReactNode])[];
  value: T;
  onChange: (v: T) => void;
  /** Read out by screen readers for the group. */
  label: string;
}) {
  return (
    <div className="pill-group" role="tablist" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={`filter-btn${value === k ? " active" : ""}`} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * Where the figures come from and how old they are, just above them:
 * "From the Engage CRM · 1 Jan – 18 Nov 2026 · updated 3m ago · getting the latest".
 */
export function DataStatus({ source, detail, at, updating }: { source: ReactNode; detail?: ReactNode; at?: string | null; updating?: boolean }) {
  return (
    <div className="data-status">
      {source}
      {detail ? <> · {detail}</> : null}
      <UpdatedAgo at={at} updating={updating} />
    </div>
  );
}

/** The headline figures. Four to a row by default; three or five where a tab's set reads better that way. */
export function KpiGrid({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 | 5 }) {
  return <div className={`kpi-strip cols-${cols}`}>{children}</div>;
}

/** One headline figure. `change` is a comparison ("▲ 12% vs last month"); `tone` colours only that line. */
export function Kpi({
  label,
  help,
  value,
  sub,
  change,
  tone,
  warn,
}: {
  label: ReactNode;
  help?: string;
  value: ReactNode;
  sub?: ReactNode;
  change?: ReactNode;
  tone?: "up" | "down" | "flat";
  /** A figure that is itself a warning (a failed source, a backlog), shown in red. */
  warn?: boolean;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">
        {label}
        {help ? <HelpTip text={help} /> : null}
      </div>
      <div className={`kpi-value${warn ? " warn" : ""}`}>{value}</div>
      {change ? <div className={`kpi-change${tone && tone !== "flat" ? ` ${tone}` : ""}`}>{change}</div> : null}
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

/** A white card holding one chart or table, with the title, help and one line of explanation set the same way on every tab. */
export function Section({
  title,
  help,
  sub,
  actions,
  children,
  id,
}: {
  title?: ReactNode;
  help?: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="chart-card section" id={id}>
      {title || actions ? (
        <div className="section-head">
          <div className="section-head-text">
            {title ? (
              <h2 className="section-title">
                {title}
                {help ? <HelpTip text={help} /> : null}
              </h2>
            ) : null}
            {sub ? <p className="section-sub">{sub}</p> : null}
          </div>
          {actions ? <div className="section-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Two cards side by side, one under the other on a narrow screen. */
export function SectionGrid({ children }: { children: ReactNode }) {
  return <div className="section-grid">{children}</div>;
}

/** A line that needs reading before the figures: information, a caution, or a failure. */
export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

/** Context, last on the page: how figures are counted, and warnings (shown first, in amber). */
export function Notes({ warnings = [], children }: { warnings?: string[]; children?: ReactNode }) {
  if (!warnings.length && !children) return null;
  return (
    <Section title="Notes">
      <ul className="notes-list">
        {warnings.map((w) => (
          <li key={w} className="note-warn">
            {w}
          </li>
        ))}
        {children}
      </ul>
    </Section>
  );
}
