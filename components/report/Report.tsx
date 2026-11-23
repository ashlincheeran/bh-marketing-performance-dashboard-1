"use client";

// The report's building blocks, shared by the SEO and Website tabs (the house
// look the rest of the hub took from the SEO report): a numbered section with
// its takeaway and source, a card, a chart, a figure tile with its change and a
// sparkline, and a funnel. Styles in ./report.module.css, over the house
// palette in app/globals.css.
import type { ReactNode } from "react";
import ChartBox from "@/components/Chart";
import * as ch from "@/components/report/charts";
import s from "@/components/report/report.module.css";
import { change, num, pctText } from "@/lib/growthMath";

/** Class names that apply, joined: cx(s.card, wide && s.span2). */
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
/** A figure per month; null where its source did not answer. */
export type Series = (number | null)[];

/** A numbered section: its eyebrow, title, one-line takeaway and where the figures come from. */
export function Section({ id, n, eyebrow, title, takeaway, src, children }: {
  id: string; n: string; eyebrow: string; title: string; takeaway: ReactNode; src: string; children: ReactNode;
}) {
  return (
    <section id={id} className={s.section}>
      <div className={s.secHead}>
        <div className={s.secNum}>{n}</div>
        <div>
          <p className={s.eyebrow}>{eyebrow}</p>
          <h2>{title}</h2>
          <p className={s.takeaway}>{takeaway}</p>
        </div>
        <div className={s.src}>{src}</div>
      </div>
      {children}
    </section>
  );
}

/** A white card with its title, a tag on the right, and a note under its contents. */
export function Card({ title, tag, note, className, children }: { title: string; tag?: string; note?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cx(s.card, className)}>
      <div className={s.cardHead}>
        <h3>{title}</h3>
        {tag && <span className={s.tag}>{tag}</span>}
      </div>
      {children}
      {note && <p className={s.note}>{note}</p>}
    </div>
  );
}

/** A chart in its card, at the report's heights. */
export function Plot({ spec, tall, small, height }: { spec: ch.ChartSpec; tall?: boolean; small?: boolean; height?: number }) {
  return (
    <div className={cx(s.chart, tall && s.tall, small && s.small)} style={height ? { height } : undefined}>
      <ChartBox type={spec.type} data={spec.data} options={spec.options} />
    </div>
  );
}

/** Where a chart will be, while its figures load or when they could not. */
export function Waiting({ text }: { text: string }) {
  return <div className={s.waiting}>{text}</div>;
}

/** A figure tile: its label, the figure, its change on the period before, a line under it and a sparkline. */
export function Kpi({ label, value, q, sub, spark, color }: {
  label: string; value: string; q: { now: number | null; before: number | null } | null; sub: string; spark: Series; color: string;
}) {
  const c = q ? change(q.now, q.before) : null;
  return (
    <div className={s.kpi}>
      <p className={s.lbl}>{label}</p>
      <p className={s.val} style={value.length > 7 ? { fontSize: 22 } : undefined}>{value}</p>
      <span className={cx(s.delta, c != null && c < 0 && s.down, c == null && s.flat)}>{q ? (c == null ? "no comparison" : pctText(c)) : " "}</span>
      <span className={s.sub}>{sub}</span>
      <div className={s.spark}>
        {spark.some((v) => v != null) && <ChartBox {...ch.spark(spark, color)} />}
      </div>
    </div>
  );
}

/** Steps from many to few, each bar as long as its figure on a log scale, with its share of the step before. */
export function Funnel({ steps }: { steps: [string, number | null][] }) {
  const top = Math.log10(Math.max(10, steps[0][1] ?? 10));
  return (
    <div className={s.funnel}>
      {steps.map(([name, v], i) => {
        const prev = i ? steps[i - 1][1] : null;
        const width = v == null ? 18 : Math.max(18, (Math.log10(Math.max(1, v)) / top) * 100);
        return (
          <div key={name} className={s.fRow}>
            <span className={s.fName}>{name}</span>
            <div className={s.fBar} style={{ width: `${width}%`, opacity: 1 - i * 0.1 }}>{v == null ? "…" : num(v)}</div>
            <span className={s.fConv}>{i === 0 ? "SEO + AI" : v != null && prev ? `${((v / prev) * 100).toFixed(1)}% of previous` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

