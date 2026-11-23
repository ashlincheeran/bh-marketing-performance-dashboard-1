// Chart.js settings for the SEO tab's charts, in the report's colours. Each
// builder takes the live series and returns what components/Chart.tsx draws.
// A null in a series is a month a source did not answer for: drawn as a gap,
// never as zero.
import type { ChartType } from "chart.js";
import { aed, compact } from "@/lib/growthMath";

export const C = {
  seo: "#1f4e8c", seoSoft: "#9db8dc", ai: "#3f8fbf", aiSoft: "#b9dbe8", aiMid: "#7fbfdb", aiPale: "#d6ebf4",
  pr: "#5c6b80", prSoft: "#c3cbd6", biz: "#2d6a4f", biz2: "#74a892", biz3: "#c5dfd2", bizMid: "#52917a",
  bizLight: "#a7cbb9", bizDark: "#1b4332", bad: "#c0392b", grid: "#e9edf1", ink2: "#56616d", before: "#dfe4ea",
};

/** The colours the assistants are stacked in, most visitors first; the rest share the last. */
export const ASSISTANT_COLOURS = [C.ai, C.aiMid, C.aiSoft, C.aiPale];

export interface ChartSpec {
  type: ChartType;
  data: any;
  options: any;
}

type Series = (number | null)[];

const ticks = { color: C.ink2, font: { size: 11 } };
const noGrid = { grid: { display: false }, border: { display: false }, ticks };
const valueAxis = (extra: object = {}) => ({ grid: { color: C.grid }, border: { display: false }, ticks: { ...ticks, callback: (v: number) => compact(v) }, ...extra });
const legend = (show = true) => ({
  display: show,
  position: "bottom",
  labels: { boxWidth: 10, boxHeight: 10, color: C.ink2, font: { size: 11 } },
});

/** What every chart shares: month labels in the tooltip in full, lines smooth, points only on hover. */
function base(fullLabels: string[] | null, extra: { plugins?: object; scales?: object; [k: string]: unknown } = {}) {
  const { plugins, scales, ...rest } = extra;
  return {
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    elements: { line: { tension: 0.35 }, point: { radius: 0, hoverRadius: 4 } },
    plugins: {
      legend: legend(),
      tooltip: fullLabels ? { callbacks: { title: (items: any[]) => fullLabels[items[0]?.dataIndex ?? 0] ?? "" } } : {},
      ...plugins,
    },
    scales: scales ?? {},
    ...rest,
  };
}

/** Tooltip lines in dirhams. */
const money = { callbacks: { label: (c: any) => `${c.dataset.label}: ${aed(c.parsed.y)}` } };

export function spark(values: Series, color: string): ChartSpec {
  return {
    type: "line",
    data: { labels: values.map((_, i) => i), datasets: [{ data: values, borderColor: color, borderWidth: 2, fill: true, backgroundColor: `${color}22` }] },
    options: {
      maintainAspectRatio: false,
      animation: false,
      elements: { line: { tension: 0.35 }, point: { radius: 0 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  };
}

/** SEO and AI visitors, stacked. */
export function reach(labels: string[], full: string[], seo: Series, ai: Series): ChartSpec {
  return {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "SEO", data: seo, borderColor: C.seo, backgroundColor: `${C.seoSoft}cc`, fill: "origin" },
        { label: "AI assistants", data: ai, borderColor: C.ai, backgroundColor: `${C.aiSoft}ee`, fill: "-1" },
      ],
    },
    options: base(full, { scales: { x: noGrid, y: valueAxis({ stacked: true }) } }),
  };
}

export function percentLine(labels: string[], full: string[], label: string, values: Series, color: string): ChartSpec {
  return {
    type: "line",
    data: { labels, datasets: [{ label, data: values, borderColor: color, backgroundColor: `${color}22`, fill: true, borderWidth: 2.5 }] },
    options: base(full, {
      plugins: { legend: legend(false), tooltip: { callbacks: { title: (it: any[]) => full[it[0]?.dataIndex ?? 0], label: (c: any) => `${label}: ${c.parsed.y}%` } } },
      scales: { x: noGrid, y: { ...valueAxis(), min: 0, ticks: { ...ticks, callback: (v: number) => `${v}%` } } },
    }),
  };
}

/** Two measures of different size, each on its own axis. */
export function twoLines(labels: string[], full: string[], a: { label: string; data: Series; color: string }, b: { label: string; data: Series; color: string }): ChartSpec {
  return {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: a.label, data: a.data, borderColor: a.color, backgroundColor: `${a.color}22`, borderWidth: 2.5, yAxisID: "y" },
        { label: b.label, data: b.data, borderColor: b.color, borderWidth: 2, yAxisID: "y1" },
      ],
    },
    options: base(full, { scales: { x: noGrid, y: valueAxis(), y1: { ...valueAxis(), position: "right", grid: { display: false } } } }),
  };
}

/** Average position, best at the top. */
export function position(labels: string[], full: string[], values: Series): ChartSpec {
  const known = values.filter((v): v is number => v != null);
  const lo = known.length ? Math.floor(Math.min(...known) - 1) : 0;
  const hi = known.length ? Math.ceil(Math.max(...known) + 1) : 10;
  return {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Average position", data: values, borderColor: C.seo, backgroundColor: `${C.seo}18`, fill: "start", borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: C.seo }],
    },
    options: base(full, {
      plugins: { legend: legend(false) },
      scales: { x: noGrid, y: { ...valueAxis(), reverse: true, min: Math.max(0, lo), max: hi, ticks } },
    }),
  };
}

/** Bars stacked month by month. */
export function stackedBars(labels: string[], full: string[], sets: { label: string; data: Series; color: string }[]): ChartSpec {
  return {
    type: "bar",
    data: { labels, datasets: sets.map((s) => ({ label: s.label, data: s.data, backgroundColor: s.color, borderRadius: 2 })) },
    options: base(full, { scales: { x: { ...noGrid, stacked: true }, y: valueAxis({ stacked: true }) } }),
  };
}

export function bars(labels: string[], full: string[], label: string, values: Series, color: string): ChartSpec {
  return {
    type: "bar",
    data: { labels, datasets: [{ label, data: values, backgroundColor: color, borderRadius: 3 }] },
    options: base(full, { plugins: { legend: legend(false) }, scales: { x: noGrid, y: valueAxis({ ticks: { ...ticks, precision: 0 } }) } }),
  };
}

/** Sideways bars, one per item, largest first. */
export function sideways(labels: string[], values: number[], color: string, label: string): ChartSpec {
  return {
    type: "bar",
    data: { labels, datasets: [{ label, data: values, backgroundColor: color, borderRadius: 3 }] },
    options: base(null, { indexAxis: "y", plugins: { legend: legend(false) }, scales: { x: valueAxis(), y: noGrid } }),
  };
}

/** Each search's average position in the three months before and in the quarter: blue where it rose, red where it fell. */
export function keywords(rows: { keyword: string; before: number | null; position: number | null }[], beforeLabel: string, nowLabel: string): ChartSpec {
  return {
    type: "bar",
    data: {
      labels: rows.map((k) => k.keyword),
      datasets: [
        { label: beforeLabel, data: rows.map((k) => k.before), backgroundColor: C.before, borderRadius: 3 },
        {
          label: nowLabel,
          data: rows.map((k) => k.position),
          backgroundColor: rows.map((k) => (k.before != null && k.position != null && k.position > k.before ? C.bad : C.seo)),
          borderRadius: 3,
        },
      ],
    },
    options: base(null, {
      indexAxis: "y",
      plugins: { tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${c.parsed.x == null ? "not in results" : Number(c.parsed.x).toFixed(1)}` } } },
      scales: { x: { ...valueAxis(), min: 0, title: { display: true, text: "Average position (lower is better)", color: C.ink2, font: { size: 11 } } }, y: noGrid },
    }),
  };
}

/** Bars with a line on its own axis: monthly counts and their running total, or a line card's leads. */
export function barsAndLine(
  labels: string[],
  full: string[],
  sets: { label: string; data: Series; color: string }[],
  line: { label: string; data: Series; color: string },
  opts: { stacked?: boolean; money?: boolean; axisTitles?: [string, string] } = {},
): ChartSpec {
  const title = (text?: string) => (text ? { display: true, text, color: C.ink2, font: { size: 11 } } : undefined);
  const tip = opts.money ? { tooltip: { callbacks: { title: (it: any[]) => full[it[0]?.dataIndex ?? 0], label: money.callbacks.label } } } : {};
  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        // The line is drawn last, over the bars (a lower order is drawn on top).
        ...sets.map((s) => ({ type: "bar", label: s.label, data: s.data, backgroundColor: s.color, borderRadius: 2, stack: opts.stacked ? "a" : undefined, yAxisID: "y", order: 1 })),
        { type: "line", label: line.label, data: line.data, borderColor: line.color, borderWidth: 2.5, pointRadius: 2, pointBackgroundColor: line.color, yAxisID: "y1", order: 0 },
      ],
    },
    options: base(full, {
      plugins: tip,
      scales: {
        x: { ...noGrid, stacked: !!opts.stacked },
        y: { ...valueAxis(), stacked: !!opts.stacked, title: title(opts.axisTitles?.[0]), ticks: { ...ticks, precision: 0, callback: (v: number) => compact(v) } },
        y1: { ...valueAxis(), position: "right", grid: { display: false }, min: 0, title: title(opts.axisTitles?.[1]), ticks: { ...ticks, precision: 0, callback: (v: number) => compact(v) } },
      },
    }),
  };
}

/** Reservations beside completions, each split sale and rent. */
export function dealBars(labels: string[], full: string[], reserved: { sale: Series; rent: Series }, completed: { sale: Series; rent: Series }): ChartSpec {
  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Reserved · sale", data: reserved.sale, backgroundColor: C.bizLight, stack: "r", borderRadius: 2 },
        { label: "Reserved · rent", data: reserved.rent, backgroundColor: C.biz3, stack: "r", borderRadius: 2 },
        { label: "Completed · sale", data: completed.sale, backgroundColor: C.bizDark, stack: "c", borderRadius: 2 },
        { label: "Completed · rent", data: completed.rent, backgroundColor: C.biz, stack: "c", borderRadius: 2 },
      ],
    },
    options: base(full, { scales: { x: { ...noGrid, stacked: true }, y: valueAxis({ stacked: true, ticks: { ...ticks, precision: 0 } }) } }),
  };
}

/** Lines per 100 leads. */
export function perHundred(labels: string[], full: string[], a: Series, b: Series): ChartSpec {
  return {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Listed with us per 100 leads", data: a, borderColor: C.biz, borderWidth: 2.5 },
        { label: "Reservations per 100 leads", data: b, borderColor: C.bizDark, borderWidth: 2, borderDash: [5, 4] },
      ],
    },
    options: base(full, {
      plugins: { tooltip: { callbacks: { title: (it: any[]) => full[it[0]?.dataIndex ?? 0], label: (c: any) => `${c.dataset.label}: ${c.parsed.y == null ? "—" : c.parsed.y.toFixed(1)}` } } },
      scales: { x: noGrid, y: { ...valueAxis(), min: 0 } },
    }),
  };
}
