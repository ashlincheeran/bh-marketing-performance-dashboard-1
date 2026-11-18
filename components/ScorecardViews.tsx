"use client";

// The parts of the Digital Pipeline Scorecard page (components/DigitalDashboard.tsx),
// laid out as the business's scorecard laid them out: nine cards that each pick
// the figure the campaign-by-month grid shows and open a trend; the KPI table by
// quarter; paid impact, direct and indirect; paid leads by quarter; and the
// campaigns table. Each part takes figures already added up (lib/scorecard.ts)
// and holds no data of its own.
import { useEffect, useRef } from "react";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { MONTHS } from "@/lib/format";
import { money, money2, n, ordinal, pct, ratio, type Figures, type Quarter, type ScCampaign } from "@/lib/scorecard";

const times = (v: number | null) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}x`);

/** What a figure needs: the ad data only, or the CRM as well (shown as "…" until it answers). */
export interface Ctx {
  /** The one currency spend is in, or null when the accounts bill in several. */
  cur: string | null;
  /** The CRM half has answered in full. */
  crm: boolean;
  /** Shown for a CRM figure while it has not: "…" on the way, "—" failed. */
  wait: string;
  /** Months the period covers, for "a month" averages. */
  monthsInPeriod: number;
}

// ── The nine cards ──────────────────────────────────────────────────────────
export type TileKey = "impr" | "clicks" | "pleads" | "people" | "viewed" | "deals" | "comm" | "spend" | "costPct";

export interface TileDef {
  key: TileKey;
  name: string;
  help: string;
  crm: boolean;
  /** The card: its figure, then two lines. */
  card: (f: Figures, c: Ctx) => [string, string, string];
  /** The campaign-by-month grid: the figure, and the cost of one where there is one. */
  grid: {
    label: string;
    value: (f: Figures) => number;
    /** The figure is spend: not added up across currencies. */
    money?: boolean;
    /** The cost of one; `pct` marks spend ÷ commission, which needs spend in AED. */
    cost?: { label: string; of: (f: Figures) => number | null; pct?: boolean };
    costOnly?: boolean;
  };
  /** The trend: a sum, or a rate of two sums. */
  trend: { sum: (f: Figures) => number } | { num: (f: Figures) => number; den: (f: Figures) => number };
}

const cost = (c: Ctx, spend: number, of: number, fmt: (v: number | null, cur?: string) => string = money) =>
  c.cur ? fmt(ratio(spend, of), c.cur) : "—";

export const TILES: TileDef[] = [
  {
    key: "impr",
    name: "Impressions",
    help: "Times the paid ads were shown on Google and Meta.",
    crm: false,
    card: (f, c) => [n(f.impr), `CPM ${c.cur ? money2(ratio(f.spend, f.impr / 1000), c.cur) : "—"}`, "cost per 1,000 impressions"],
    grid: { label: "Impressions", value: (f) => f.impr, cost: { label: "CPM", of: (f) => (f.impr ? (f.spend / f.impr) * 1000 : null) } },
    trend: { sum: (f) => f.impr },
  },
  {
    key: "clicks",
    name: "Clicks",
    help: "Clicks from the paid ads to the site. Meta counts link clicks.",
    crm: false,
    card: (f, c) => [n(f.clicks), `${cost(c, f.spend, f.clicks, money2)} per click`, `${pct(ratio(f.clicks, f.impr))} click rate`],
    grid: { label: "Clicks", value: (f) => f.clicks, cost: { label: "Cost per click", of: (f) => ratio(f.spend, f.clicks) } },
    trend: { sum: (f) => f.clicks },
  },
  {
    key: "pleads",
    name: "Platform-reported leads",
    help: "Leads as the ad platforms report them: Meta form and website leads, Google conversions. Platforms count every form, so this runs above the CRM's people.",
    crm: false,
    card: (f, c) => [n(f.pleads), `${cost(c, f.spend, f.pleads)} per platform lead`, `${pct(ratio(f.pleads, f.clicks))} of clicks`],
    grid: { label: "Platform leads", value: (f) => f.pleads, cost: { label: "Cost per platform lead", of: (f) => ratio(f.spend, f.pleads) } },
    trend: { sum: (f) => f.pleads },
  },
  {
    key: "people",
    name: "Paid leads in the CRM",
    help: "People whose CRM lead carries one of these campaigns as its utm_campaign (its name, or its Meta campaign id), each counted once, under the campaign and month of their first paid lead in the range. Test, staff and internal leads are left out.",
    crm: true,
    card: (f, c) => (c.crm ? [n(f.people), `CPL ${cost(c, f.spend, f.people)}`, `${pct(ratio(f.people, f.clicks))} of clicks became a lead`] : [c.wait, "CPL —", " "]),
    grid: { label: "Leads", value: (f) => f.people, cost: { label: "Cost per lead", of: (f) => ratio(f.spend, f.people) } },
    trend: { sum: (f) => f.people },
  },
  {
    key: "viewed",
    name: "Viewings",
    help: "People with a viewing logged in the CRM after their first paid lead, scheduled or completed and dated up to today, on any of their leads. Agents often leave a viewing that took place at Scheduled; the card says how many were marked completed.",
    crm: true,
    card: (f, c) =>
      c.crm
        ? [n(f.viewed), `${cost(c, f.spend, f.viewed)} per viewing`, `${pct(ratio(f.viewed, f.people))} lead to viewing rate, ${n(f.viewedDone)} marked completed, ${n(f.listings)} listings won at ${cost(c, f.spend, f.listings)} each`]
        : [c.wait, "—", " "],
    grid: { label: "Viewings", value: (f) => f.viewed, cost: { label: "Cost per viewing", of: (f) => ratio(f.spend, f.viewed) } },
    trend: { sum: (f) => f.viewed },
  },
  {
    key: "deals",
    name: "Deals",
    help: "Deals reserved, closed or completed (not withdrawn) from the people who came in on a paid lead, on any of their leads or on a listing taken from them.",
    crm: true,
    card: (f, c) => (c.crm ? [n(f.deals), `CPA ${cost(c, f.spend, f.deals)}`, `${pct(ratio(f.deals, f.people))} lead to deal rate`] : [c.wait, "CPA —", " "]),
    grid: { label: "Deals", value: (f) => f.deals, cost: { label: "Cost per deal", of: (f) => ratio(f.spend, f.deals) } },
    trend: { sum: (f) => f.deals },
  },
  {
    key: "comm",
    name: "Revenue: gross commission",
    help: "Gross commission on those deals: the final figure once the CRM has one, the reserved one until then.",
    crm: true,
    card: (f, c) =>
      c.crm ? [money(f.comm), `cost is ${c.cur === "AED" ? pct(ratio(f.spend, f.comm)) : "—"} of commission`, `deal value ${money(f.dealValue)}`] : [c.wait, "—", " "],
    grid: { label: "Commission (AED)", value: (f) => f.comm, cost: { label: "Cost % of commission", of: (f) => ratio(f.spend, f.comm), pct: true } },
    trend: { sum: (f) => f.comm },
  },
  {
    key: "spend",
    name: "Paid spend",
    help: "Google and Meta ad spend for the accounts ticked under Ad accounts, through Supermetrics.",
    crm: false,
    card: (f, c) => [
      c.cur ? money(f.spend, c.cur) : "—",
      c.monthsInPeriod >= 1 ? `average ${c.cur ? money(f.spend / c.monthsInPeriod, c.cur) : "—"} a month` : "less than a month in this view",
      " ",
    ],
    grid: { label: "Spend", value: (f) => f.spend, money: true },
    trend: { sum: (f) => f.spend },
  },
  {
    key: "costPct",
    name: "Marketing cost as % of commission",
    help: "Paid spend divided by gross commission on the deals from paid leads.",
    crm: true,
    card: (f, c) =>
      c.crm
        ? [
            c.cur === "AED" ? pct(ratio(f.spend, f.comm)) : "—",
            f.comm ? `${c.cur ? money(f.spend, c.cur) : "—"} spend on ${money(f.comm)} commission` : "No commission recorded yet",
            `commission is ${c.cur === "AED" ? times(ratio(f.comm, f.spend)) : "—"} the spend`,
          ]
        : [c.wait, "—", " "],
    grid: { label: "", value: (f) => f.comm, cost: { label: "Cost % of commission", of: (f) => ratio(f.spend, f.comm), pct: true }, costOnly: true },
    trend: { num: (f) => f.spend, den: (f) => f.comm },
  },
];

export function Tiles({ f, ctx, selected, onSelect, onTrend }: { f: Figures; ctx: Ctx; selected: number; onSelect: (i: number) => void; onTrend: (i: number) => void }) {
  return (
    <section className="sc-tiles" aria-label="Scorecards">
      {TILES.map((t, i) => {
        const [v, c2, s] = t.card(f, ctx);
        return (
          <div key={t.key} className={`sc-tile${selected === i ? " on" : ""}`}>
            <button type="button" className="sc-tile-main" aria-pressed={selected === i} onClick={() => onSelect(i)} title={`${t.help} Select to show it by month below.`}>
              <span className="k">
                {t.name}
                <HelpTip text={t.help} />
              </span>{" "}
              <span className="v">{v}</span>{" "}
              <span className="c2">{c2}</span>{" "}
              <span className="s">{s}</span>
            </button>
            <button type="button" className="sc-more" onClick={() => onTrend(i)} aria-label={`Show trend: ${t.name}`}>
              Show trend
            </button>
          </div>
        );
      })}
    </section>
  );
}

// ── Campaign by month ───────────────────────────────────────────────────────
export function monthLabels(months: string[]): string[] {
  const multiYear = months.length > 0 && months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  return months.map((m) => `${MONTHS[Number(m.slice(5, 7)) - 1]}${multiYear ? ` ${m.slice(2, 4)}` : ""}`);
}

export function Heatmap({
  tile,
  showCost,
  rows,
  total,
  months,
  to,
  ctx,
}: {
  tile: TileDef;
  showCost: boolean;
  /** Each campaign's figures per month. */
  rows: { campaign: ScCampaign; months: Figures[] }[];
  /** All of them together, when there is more than one. */
  total: Figures[] | null;
  months: string[];
  to: string;
  ctx: Ctx;
}) {
  const g = tile.grid;
  const isCost = !!g.cost && (showCost || !!g.costOnly);
  const value = (f: Figures): number | null => (isCost ? g.cost!.of(f) : g.value(f));
  const fmt = (v: number | null) =>
    v == null ? "" : isCost && g.cost!.pct ? pct(v) : isCost ? (Math.abs(v) < 100 ? v.toFixed(2) : n(v)) : n(v);
  const labels = monthLabels(months);
  const lastPartial = Number(to.slice(8, 10)) < new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0)).getUTCDate();
  // Spend and costs need spend in one currency, and spend ÷ commission needs it in
  // AED; the CRM figures need the CRM to have answered.
  const hidden =
    ((isCost || !!g.money) && !ctx.cur) || (isCost && !!g.cost?.pct && ctx.cur !== "AED") || (tile.crm && !ctx.crm);
  const line = (key: string, name: string, ms: Figures[], cls = "") => {
    const vals = ms.map((f) => value(f));
    const mx = Math.max(0, ...vals.map((v) => (v != null && Number.isFinite(v) ? v : 0))) || 1;
    return (
      <div className={`sc-run-row${cls}`} key={key}>
        <span className="nm" title={name}>
          {name}
        </span>{" "}
        {ms.map((f, j) => {
          const v = vals[j];
          const ran = f.spend > 0;
          const show = !hidden && (ran || (v != null && v > 0));
          const it = show && v != null && v > 0 ? 0.25 + 0.75 * Math.min(1, v / mx) : 0;
          const text = hidden ? "" : show ? fmt(v) || (isCost ? "–" : "0") : "";
          return (
            <span
              key={j}
              className={`c${it > 0.6 ? " hi" : ""}`}
              title={`${labels[j]}${j === ms.length - 1 && lastPartial ? ` to the ${ordinal(Number(to.slice(8, 10)))}` : ""}: ${hidden ? (tile.crm && !ctx.crm ? ctx.wait : "—") : show ? `${fmt(v) || "no result"}${ran ? "" : " (no ad spend this month)"}` : "not running"}`}
            >
              {it ? <i style={{ opacity: Number(it.toFixed(2)) }} /> : null}
              <b>{text}</b>{" "}
            </span>
          );
        })}
      </div>
    );
  };
  return (
    <div className="sc-run" style={{ gridTemplateColumns: `minmax(170px, 1.6fr) repeat(${months.length}, minmax(44px, 1fr))` }}>
      <div className="sc-run-row head">
        <span />
        {labels.map((m) => (
          <span key={m} className="mh">
            {m}{" "}
          </span>
        ))}
      </div>
      {rows.map((r) => line(r.campaign.id, r.campaign.name, r.months))}
      {total ? line("total", "All selected campaigns", total, " tot") : null}
    </div>
  );
}

// ── KPI scorecard ───────────────────────────────────────────────────────────
interface KpiRow {
  layer: string;
  name: string;
  note?: string;
  crm: boolean;
  /** Needs spend in one currency (a cost), or in AED against commission. */
  money?: "spend" | "aed";
  value: (f: Figures) => number | null;
  fmt: (v: number | null, cur: string) => string;
}
const KPI_ROWS: KpiRow[] = [
  { layer: "Investment", name: "Spend", crm: false, money: "spend", value: (f) => f.spend, fmt: (v, cur) => money(v, cur) },
  { layer: "1. Visibility", name: "Impressions", crm: false, value: (f) => f.impr, fmt: (v) => n(v) },
  { layer: "2. Traffic", name: "Clicks to site", crm: false, value: (f) => f.clicks, fmt: (v) => n(v) },
  { layer: "2. Traffic", name: "Cost per click", crm: false, money: "spend", value: (f) => ratio(f.spend, f.clicks), fmt: (v, cur) => money2(v, cur) },
  { layer: "3. Leads", name: "Platform-reported leads", crm: false, value: (f) => f.pleads, fmt: (v) => n(v) },
  { layer: "3. Leads", name: "Paid leads in the CRM", note: "people, each once", crm: true, value: (f) => f.people, fmt: (v) => n(v) },
  { layer: "4. Pipeline", name: "People with a viewing", note: "scheduled or completed", crm: true, value: (f) => f.viewed, fmt: (v) => n(v) },
  { layer: "4. Pipeline", name: "Listings won", crm: true, value: (f) => f.listings, fmt: (v) => n(v) },
  { layer: "5. Return", name: "Deals, reserved or completed", crm: true, value: (f) => f.deals, fmt: (v) => n(v) },
  { layer: "5. Return", name: "Deal value", crm: true, value: (f) => f.dealValue, fmt: (v) => money(v) },
  { layer: "5. Return", name: "Gross commission", crm: true, value: (f) => f.comm, fmt: (v) => money(v) },
  { layer: "5. Return", name: "Reserved share of commission", crm: true, value: (f) => ratio(f.resComm, f.comm), fmt: (v) => pct(v) },
  { layer: "5. Return", name: "Cost as % of commission", crm: true, money: "aed", value: (f) => ratio(f.spend, f.comm), fmt: (v) => pct(v) },
];

/** Each KPI row, and whether it opens its layer. */
const KPI_LINES = KPI_ROWS.map((k, i) => ({ k, opens: i === 0 || KPI_ROWS[i - 1].layer !== k.layer }));

export function KpiTable({ columns, selected, ctx }: { columns: { label: string; f: Figures }[]; selected: number; ctx: Ctx }) {
  return (
    <div className="sc-scroll">
      <table className="perf-table sc-kpi">
        <thead>
          <tr>
            <th>KPI</th>
            {columns.map((c, i) => (
              <th key={c.label} className={i === selected ? "sel" : undefined} style={{ textAlign: "right" }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KPI_LINES.map(({ k, opens }) => {
            const head = opens ? (
              <tr className="layer" key={`${k.layer}-head`}>
                <td colSpan={columns.length + 1}>{k.layer}</td>
              </tr>
            ) : null;
            const blocked = (k.money === "spend" && !ctx.cur) || (k.money === "aed" && ctx.cur !== "AED");
            return [
              head,
              <tr key={k.name}>
                <td>
                  {k.name}
                  {k.note ? <small className="muted"> {k.note}</small> : null}
                </td>
                {columns.map((c, i) => (
                  <td key={c.label} className={i === selected ? "sel" : undefined} style={{ textAlign: "right" }}>
                    {k.crm && !ctx.crm ? ctx.wait : blocked ? "—" : k.fmt(k.value(c.f), ctx.cur ?? "")}
                  </td>
                ))}
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Bars: paid impact ───────────────────────────────────────────────────────
export interface BarRow {
  key: string;
  label: string;
  parts: { v: number; kind: "direct" | "indirect" }[];
  text: string;
}
export function Bars({ rows, empty }: { rows: BarRow[]; empty: string }) {
  if (!rows.length) return <p className="section-sub">{empty}</p>;
  const mx = Math.max(1, ...rows.map((r) => r.parts.reduce((s, p) => s + p.v, 0)));
  return (
    <div className="sc-bars">
      {rows.map((r) => (
        <div className="sc-hrow" key={r.key}>
          <span className="l" title={r.label}>
            {r.label}
          </span>{" "}
          <span className="t">
            {r.parts.map((p, i) => (p.v > 0 ? <i key={i} className={p.kind} style={{ width: `${(p.v / mx) * 100}%` }} /> : null))}
          </span>{" "}
          <span className="nn">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
export const roiText = (comm: number, spend: number) => (comm && spend ? `${(comm / spend).toFixed(1)}x` : "—");

// ── Paid leads by quarter ───────────────────────────────────────────────────
export function QuarterBars({ quarters, values, active, ctx }: { quarters: Quarter[]; values: number[]; active: Set<number>; ctx: Ctx }) {
  const mx = Math.max(1, ...values) * 1.12;
  return (
    <div className="sc-qbars">
      {quarters.map((q, i) => (
        <div className={`col${active.has(i) ? "" : " dim"}`} key={q.label}>
          <div className="bar">
            <i style={{ height: `${ctx.crm ? (values[i] / mx) * 100 : 0}%` }} />
          </div>
          <span className="lab">
            {q.label}{" "}
            <b>{ctx.crm ? `${n(values[i])} leads` : ctx.wait}</b>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Campaigns table ─────────────────────────────────────────────────────────
export function CampaignTable({
  rows,
  ctx,
  picked,
  onPick,
}: {
  rows: { campaign: ScCampaign; f: Figures; platform: string }[];
  ctx: Ctx;
  picked: string;
  onPick: (id: string) => void;
}) {
  const crm = (v: number) => (ctx.crm ? n(v) : ctx.wait);
  return (
    <div className="sc-scroll">
      <table className="perf-table sc-camps">
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Spend</th>
            <th>Impressions</th>
            <th>Clicks</th>
            <th>Platform leads</th>
            <th>CRM leads</th>
            <th>Viewings</th>
            <th>Listings</th>
            <th>Deals</th>
            <th>Commission</th>
            <th>Cost per lead</th>
            <th>Cost per deal</th>
            <th>Cost % of commission</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ campaign: c, f, platform }) => {
            const cp = ctx.cur === "AED" ? ratio(f.spend, f.comm) : null;
            return (
              <tr
                key={c.id}
                className={picked === c.id ? "picked" : undefined}
                tabIndex={0}
                onClick={() => onPick(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onPick(c.id);
                }}
              >
                <td className="nm">
                  <button
                    type="button"
                    className="sc-link"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPick(c.id);
                    }}
                    title={picked === c.id ? "Show every campaign again" : "Filter the page to this campaign"}
                  >
                    {c.name}
                  </button>
                  <div className="muted sc-codes" title={c.codes.length ? c.codes.map((k) => `${k.code} (${k.leads})`).join("\n") : undefined}>
                    {platform}
                    {c.codes.length ? ` · ${c.codes.slice(0, 3).map((k) => k.code).join(" · ")}${c.codes.length > 3 ? ` · +${c.codes.length - 3} more` : ""}` : ctx.crm ? " · no Engage code" : ""}
                  </div>
                </td>
                <td>{ctx.cur ? money(f.spend, ctx.cur) : "—"}</td>
                <td>{n(f.impr)}</td>
                <td>{n(f.clicks)}</td>
                <td>{n(f.pleads)}</td>
                <td>{crm(f.people)}</td>
                <td>{crm(f.viewed)}</td>
                <td>{crm(f.listings)}</td>
                <td>{crm(f.deals)}</td>
                <td>{ctx.crm ? money(f.comm) : ctx.wait}</td>
                <td>{ctx.crm && ctx.cur ? money(ratio(f.spend, f.people), ctx.cur) : ctx.crm ? "—" : ctx.wait}</td>
                <td>{ctx.crm && ctx.cur ? money(ratio(f.spend, f.deals), ctx.cur) : ctx.crm ? "—" : ctx.wait}</td>
                <td>{!ctx.crm ? ctx.wait : cp == null ? <span className="muted">—</span> : pct(cp)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Trend, opened from a card ───────────────────────────────────────────────
/** A card's figure per period, or its running total: a sum, or a rate of two running sums. */
export function trendValues(tr: TileDef["trend"], series: Figures[], cumulative: boolean): (number | null)[] {
  const out: (number | null)[] = [];
  let a = 0;
  let b = 0;
  for (const f of series) {
    if ("sum" in tr) {
      a = cumulative ? a + tr.sum(f) : tr.sum(f);
      out.push(a);
    } else {
      a = cumulative ? a + tr.num(f) : tr.num(f);
      b = cumulative ? b + tr.den(f) : tr.den(f);
      out.push(ratio(a, b));
    }
  }
  return out;
}

export function TrendModal({
  tile,
  labels,
  series,
  gran,
  cumulative,
  onGran,
  onCumulative,
  onClose,
  scope,
  to,
  ctx,
}: {
  tile: TileDef;
  labels: string[];
  /** Each period's figures, quarters or months. */
  series: Figures[];
  gran: "q" | "m";
  cumulative: boolean;
  onGran: (g: "q" | "m") => void;
  onCumulative: (c: boolean) => void;
  onClose: () => void;
  /** What the page is filtered to, in words. */
  scope: string;
  to: string;
  ctx: Ctx;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  // Focus moves to Close when the dialog opens, and back to where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus?.();
    return () => before?.focus?.();
  }, []);

  const tr = tile.trend;
  const values = trendValues(tr, series, cumulative);
  const blocked = (tile.crm && !ctx.crm) || (tile.key === "spend" && !ctx.cur) || (tile.key === "costPct" && ctx.cur !== "AED");
  const why =
    tile.crm && !ctx.crm
      ? ctx.wait === "…"
        ? "Asking the CRM…"
        : "The CRM could not be read, so this trend is not shown."
      : !ctx.cur
        ? "Not shown: the ad accounts bill in more than one currency."
        : "Not shown: spend is not in AED, so it cannot be set against commission.";
  const isRate = !("sum" in tr);
  const fmtV = (v: number | null) => (isRate ? pct(v) : tile.key === "comm" || tile.key === "spend" ? money(v, tile.key === "spend" ? (ctx.cur ?? "") : "AED") : n(v));
  const title = `${tile.name}${cumulative ? ", running total" : gran === "q" ? " by quarter" : " by month"}`;
  return (
    <div className="sc-modal" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sc-mbox" role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="filter-btn sc-close" onClick={onClose} ref={close}>
          Close
        </button>
        <h2 className="section-title">{title}</h2>
        <p className="section-sub">
          {scope}. The chart covers the whole range; its last point runs to {Number(to.slice(8, 10))} {MONTHS[Number(to.slice(5, 7)) - 1]}.
        </p>
        <div className="sc-ctl">
          <span className="pill-group" role="group" aria-label="Periods">
            <button type="button" className={`filter-btn${gran === "q" ? " active" : ""}`} aria-pressed={gran === "q"} onClick={() => onGran("q")}>
              Quarterly
            </button>
            <button type="button" className={`filter-btn${gran === "m" ? " active" : ""}`} aria-pressed={gran === "m"} onClick={() => onGran("m")}>
              Monthly
            </button>
          </span>
          <span className="pill-group" role="group" aria-label="Running total">
            <button type="button" className={`filter-btn${!cumulative ? " active" : ""}`} aria-pressed={!cumulative} onClick={() => onCumulative(false)}>
              Per period
            </button>
            <button type="button" className={`filter-btn${cumulative ? " active" : ""}`} aria-pressed={cumulative} onClick={() => onCumulative(true)}>
              Cumulative
            </button>
          </span>
          <p className="section-sub" style={{ flexBasis: "100%", margin: 0 }}>
            {tile.help}
          </p>
        </div>
        {blocked ? (
          <p className="section-sub">{why}</p>
        ) : (
          <>
            <div className="sc-points" aria-label="Values">
              {labels.map((l, i) => (
                <span key={l}>
                  {l} <b>{fmtV(values[i])}</b>{" "}
                </span>
              ))}
            </div>
            <div style={{ height: 260 }}>
              <ChartBox
                type="line"
                data={{
                  labels,
                  datasets: [
                    {
                      label: tile.name,
                      data: values.map((v) => (v == null ? null : isRate ? v * 100 : v)),
                      borderColor: "#4a7fb5",
                      backgroundColor: "rgba(74,127,181,.10)",
                      fill: true,
                      tension: 0.25,
                      pointRadius: 4,
                    },
                  ],
                }}
                options={{
                  plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: { raw: number | null }) => fmtV(c.raw == null ? null : isRate ? c.raw / 100 : c.raw) } } },
                  scales: { y: { beginAtZero: true, ticks: { callback: (v: number) => (isRate ? `${v}%` : n(v)) } } },
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
