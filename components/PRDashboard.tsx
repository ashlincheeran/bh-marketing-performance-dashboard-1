"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { receiveInsightsAction } from "@/app/actions";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import PressMentions from "@/components/PressMentions";
import { C, TIER_COLOR, TIERS, TIER_LABEL } from "@/lib/theme";
import {
  MONTHS,
  annualByTier,
  comparisonNote,
  filterRange,
  fmtEAV,
  fmtReach,
  fmtReachFull,
  isMonthIn,
  kpis,
  monthlySeries,
  periodBefore,
  plural,
  sentimentBreakdown,
  tierByMonth,
  topOutlets,
} from "@/lib/pr";
import type { Insight } from "@/lib/pr";
import type { Mention, Tier } from "@/lib/types";
import type { CompetitorNewsItem, PressMentionsResult, SovItem } from "@/lib/data";

/**
 * Days of headlines a cached analysis read, when the page doesn't say:
 * INSIGHT_WINDOW_DAYS in lib/insights.ts, a server-only module.
 */
const CACHED_WINDOW_DAYS = 75;

/** "2026-06-22" → "22 Jun 2026"; "2026-07" → "Jul 2026". */
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** "Knight Frank", "A and B", "A, B and C". */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pctDelta(a: number, b: number): { text: string; cls?: "up" | "down" } {
  if (b === 0) return { text: a > 0 ? "▲ new vs B" : "— vs B", cls: a > 0 ? "up" : undefined };
  const d = Math.round(((a - b) / b) * 100);
  return { text: `${d > 0 ? "+" : ""}${d}% vs B`, cls: d > 0 ? "up" : d < 0 ? "down" : undefined };
}
function ppDelta(a: number | null, b: number | null): { text: string; cls?: "up" | "down" } {
  if (a == null || b == null) return { text: "vs B" };
  const d = a - b;
  return { text: `${d > 0 ? "+" : ""}${d}pp vs B`, cls: d > 0 ? "up" : d < 0 ? "down" : undefined };
}

const divider = <div style={{ borderTop: "2px solid var(--border)", margin: "34px 0 26px" }} />;

export default function PRDashboard({
  mentions,
  minMonth,
  maxMonth,
  defaultFrom,
  insights,
  insightsMeta,
  competitorNews,
  competitorError = null,
  trackedBrands,
  rivalsTrackedSince,
  press,
}: {
  mentions: Mention[];
  minMonth: string;
  maxMonth: string;
  defaultFrom: string;
  insights: Insight[];
  /** windowDays: how many days before generatedAt a cached analysis read (INSIGHT_WINDOW_DAYS). */
  insightsMeta?: { source: "ai" | "auto"; generatedAt: string | null; windowDays?: number };
  /** The active rivals' stories, one per placement (getCompetitorNews). */
  competitorNews: CompetitorNewsItem[];
  /** Why the rivals' stories could not be read. Share of Voice then says so instead of "no coverage". */
  competitorError?: string | null;
  /** Every brand tracked for Share of Voice, betterhomes included, whether or not it has a story in range. */
  trackedBrands?: string[];
  /** Each rival's label and the Dubai day the bot began looking for it (tracked_keywords.created_at). */
  rivalsTrackedSince?: Record<string, string>;
  /** Every story on record, one row per article, from the same rows as the figures (getPressMentions). */
  press: PressMentionsResult;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(maxMonth);
  const [receiving, startReceive] = useTransition();
  const [receiveErr, setReceiveErr] = useState<string | null>(null);
  const [liveInsights, setLiveInsights] = useState<Insight[] | null>(null);
  const [liveRange, setLiveRange] = useState<{ from: string; to: string } | null>(null);

  function receiveInsights() {
    setReceiveErr(null);
    startReceive(async () => {
      // A call that throws (the connection dropped, the request timed out, or
      // the page is older than the deployed app) is an error for this panel.
      // Uncaught inside a transition it reached the error boundary, and the
      // whole tab became "Something went wrong".
      try {
        const r = await receiveInsightsAction(from, to);
        if (r.ok) {
          setLiveInsights(r.insights as Insight[]);
          setLiveRange({ from: r.from, to: r.to });
        } else {
          setReceiveErr(r.error);
        }
      } catch (e) {
        console.error("Receive Insights failed", e);
        setReceiveErr("Insights could not be fetched: the request did not finish. Check the connection, reload the page and try again.");
      }
    });
  }

  // Comparison (Period B) defaults to the equal-length window before Period A.
  // With no records before A, B starts as A itself, and the note under the
  // compare controls says the two overlap.
  const initB = periodBefore(defaultFrom, maxMonth, minMonth) ?? { from: defaultFrom, to: maxMonth };
  const [compare, setCompare] = useState(false);
  const [fromB, setFromB] = useState(initB.from);
  const [toB, setToB] = useState(initB.to);

  // An undated clip is in no range of months, so it counts only when the range
  // is every month on file (All time, which promises every record). Before,
  // it counted nowhere, while "total on record" included it.
  const undated = useMemo(() => mentions.filter((m) => !m.date).length, [mentions]);
  const allTime = from === minMonth && to === maxMonth;
  const filtered = useMemo(() => filterRange(mentions, from, to, allTime), [mentions, from, to, allTime]);
  const k = useMemo(() => kpis(filtered), [filtered]);
  const series = useMemo(() => monthlySeries(filtered, from, to), [filtered, from, to]);
  const tiers = useMemo(() => tierByMonth(filtered, from, to), [filtered, from, to]);
  const annual = useMemo(() => annualByTier(mentions), [mentions]);
  const outlets = useMemo(() => topOutlets(filtered, 10), [filtered]);
  const sent = useMemo(() => sentimentBreakdown(filtered), [filtered]);

  // Share of Voice — bot-found mentions per brand, filtered to the selected range.
  // betterhomes counts its bot articles only (historical archive excluded) so it's
  // comparable to competitors, who are bot-found only. A bot find whose archive
  // twin is the copy kept on the page still counts (foundByBot, set by getMentions).
  //
  // And only where competitor coverage is stored. None was stored after 22 Jun
  // 2026 while ours kept arriving, so the default range read 34% (17% like for
  // like) and any Jul-Oct range read 100%, "#1 of 1". The count stops at the
  // latest stored competitor story, and a month with no competitor story at all
  // is left out rather than read as every rival going quiet. Same rule as
  // getSov() in lib/data.ts.
  const compThrough = useMemo(
    () =>
      competitorNews.reduce<string | null>(
        (max, c) => (c.published_on && (!max || c.published_on > max) ? c.published_on : max),
        null,
      ),
    [competitorNews],
  );
  const sovView = useMemo(() => {
    const compMonths = new Set(competitorNews.map((c) => c.published_on?.slice(0, 7)).filter(Boolean));
    const counts = new Map<string, number>();
    const leftOut = new Set<string>();
    const count = (brand: string, d: string | null) => {
      if (!d || !compThrough || d.slice(0, 7) < from || d.slice(0, 7) > to || d > compThrough) return;
      if (!compMonths.has(d.slice(0, 7))) {
        leftOut.add(d.slice(0, 7));
        return;
      }
      counts.set(brand, (counts.get(brand) ?? 0) + 1);
    };
    for (const m of mentions) if (m.source === "googlenews" || m.foundByBot) count("betterhomes", m.date);
    for (const c of competitorNews) count(c.brand, c.published_on);
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    const items = [...counts.entries()]
      .map(([brand, n]) => ({ brand, mentions: n, share: Math.round((n / total) * 100), isUs: brand === "betterhomes" }))
      .sort((a, b) => b.mentions - a.mentions) as SovItem[];
    // `${to}-31` sorts after every real day of that month, so this reads "the
    // stored coverage ends before the selected range does".
    const cutAt = compThrough && compThrough < `${to}-31` ? compThrough : null;
    return { items, cutAt, leftOut: [...leftOut].sort() };
  }, [mentions, competitorNews, compThrough, from, to]);
  const sov = sovView.items;
  const sovEnd = sovView.cutAt ? dayLabel(sovView.cutAt) : to;
  const sovNote = [
    sovView.cutAt ? `competitor coverage stored to ${dayLabel(sovView.cutAt)}` : "",
    sovView.leftOut.length
      ? `${sovView.leftOut.map(monthLabel).join(", ")} left out: no competitor coverage stored`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // A rival tracked only from partway through the range has no stories before
  // then because nobody was looking, not because the press ignored it. Said,
  // so its small share reads right. Rivals tracked from the same day are named
  // together.
  const trackedNote = useMemo(() => {
    const start = `${from}-01`;
    const first = new Map<string, string>();
    for (const c of competitorNews) {
      const seen = first.get(c.brand);
      if (c.published_on && (!seen || c.published_on < seen)) first.set(c.brand, c.published_on);
    }
    const byDay = new Map<string, string[]>();
    for (const [brand, since] of Object.entries(rivalsTrackedSince ?? {})) {
      const earliest = first.get(brand);
      if (since > start && !(earliest && earliest < since)) byDay.set(since, [...(byDay.get(since) ?? []), brand]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([since, brands]) => `${andList(brands)} tracked since ${dayLabel(since)}`)
      .join(" · ");
  }, [competitorNews, rivalsTrackedSince, from]);
  const sovEmpty = competitorError
    ? `Share of Voice could not be worked out: the rivals' coverage did not load (${competitorError}). Reload the page to try again.`
    : !compThrough
      ? "No competitor coverage is stored, so there is no Share of Voice to show."
      : compThrough < `${from}-01`
        ? `No competitor coverage is stored for this range: it ends on ${dayLabel(compThrough)}. Widen the range to include it.`
        : "No bot-logged mentions in this date range yet. Widen the range, or the next bot run will add more.";

  // betterhomes' competitive standing in that SoV ranking (for the top cards).
  // The field is every tracked brand, not only those with a story in range:
  // nine tracked with two rivals in the news read "#1 of 3". With rivals'
  // stories counted and none of ours, our share is a real 0% and we rank below
  // every rival that has one. Brands with the same count share a rank.
  const sovUs = sov.find((s) => s.isUs) ?? null;
  const usMentions = sovUs?.mentions ?? 0;
  const sovRivals = sov.filter((s) => !s.isUs);
  const sovShare = sovUs ? sovUs.share : sov.length ? 0 : null;
  // Without the tracked list, the rivals with any story on record and us; with
  // no rival known at all, the field is unknown.
  const rivalsOnRecord = new Set(competitorNews.map((c) => c.brand)).size;
  const sovField =
    trackedBrands || rivalsOnRecord
      ? Math.max(trackedBrands?.length ?? rivalsOnRecord + 1, sovRivals.length + 1)
      : null;
  const sovRank = sov.length ? sovRivals.filter((s) => s.mentions > usMentions).length + 1 : null;
  // sov holds only brands with a story, so at 0 we are level with every rival that has none.
  const sovTied = !sov.length
    ? 0
    : usMentions
      ? sovRivals.filter((s) => s.mentions === usMentions).length
      : (sovField ?? 0) - 1 - sovRivals.length;

  // Period B aggregates (only meaningful when compare is on); B counts undated
  // clips by the same rule as A.
  const allTimeB = fromB === minMonth && toB === maxMonth;
  const filteredB = useMemo(() => filterRange(mentions, fromB, toB, allTimeB), [mentions, fromB, toB, allTimeB]);
  const kB = useMemo(() => kpis(filteredB), [filteredB]);

  const tierTotals = (ms: Mention[]) => {
    const r: Record<Tier, number> = { "T1-Global": 0, "T1-Local": 0, T2: 0, T3: 0, Other: 0 };
    for (const m of ms) r[m.tier] += 1;
    return r;
  };
  const tA = useMemo(() => tierTotals(filtered), [filtered]);
  const tB = useMemo(() => tierTotals(filteredB), [filteredB]);
  const tiersPresent = TIERS.filter((t) => tA[t] > 0 || tB[t] > 0);

  // B was clamped to the first month on file, so with A starting there B was
  // that one month, inside A, and Mentions read +115,800%. Now B is cut short
  // where the records start, the note below says so, and with no records
  // before A at all the button is off.
  const bBeforeA = periodBefore(from, to, minMonth);
  function setBToPeriodBeforeA() {
    if (!bBeforeA) return;
    setFromB(bBeforeA.from);
    setToB(bBeforeA.to);
  }
  const bNote = comparisonNote({ from, to }, { from: fromB, to: toB }, minMonth);

  // Export the selected date range to a CSV (opens in Excel), flagging which
  // clips came from the AI bot vs. the manual/historical record.
  function exportCsv() {
    const cols = ["Date", "Tier", "Publication", "Headline", "EAV", "Reach", "EAV/Reach source", "Sentiment", "Sentiment by", "Origin", "URL"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.join(",")];
    for (const m of filtered) {
      const ai = m.source === "googlenews";
      lines.push([
        m.date ?? "",
        TIER_LABEL[m.tier],
        m.outlet ?? "",
        m.title ?? "",
        m.eavEff || "",
        m.reachEff || "",
        m.modeled ? "modeled (rate card)" : m.eav != null ? "verified" : "",
        m.sentiment ?? "",
        m.sentiment ? "AI" : "",
        ai ? "AI · Google News" : "Manual / Historical",
        m.url ?? "",
      ].map(esc).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `betterhomes-pr_${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const legendBottom = { legend: { position: "bottom" as const, labels: { font: { size: 10 } } } };

  // What the cards are when they are not a fresh answer for a range, said
  // whatever else the panel shows. After a failed Receive the note on the
  // cached set went away, and cached or rule-based cards sat under a header
  // naming the range selected above.
  const fallbackNote = (() => {
    const made = insightsMeta?.source === "ai" ? insightsMeta.generatedAt : null;
    const at = made ? Date.parse(made) : NaN;
    if (made && Number.isFinite(at)) {
      const end = new Date(at).toISOString().slice(0, 10);
      const start = new Date(at - (insightsMeta?.windowDays ?? CACHED_WINDOW_DAYS) * 864e5).toISOString().slice(0, 10);
      return `Shown below: the last cached analysis, made on ${dayLabel(end)} (${ago(made)}). It covers ${dayLabel(start)} to ${dayLabel(end)}, not the range above.`;
    }
    if (insightsMeta?.source === "auto") {
      return "Shown below: rule-based cards, not AI. Share of Voice covers this year to date and the other cards the last 30 days, not the range above.";
    }
    return "Shown below: earlier cards, not made for the range above.";
  })();

  // sentiment card sub + tooltip (so "how is this calculated" is answerable in the UI)
  const sentTitle =
    k.posPct == null
      ? "No clips in this range have an AI-assigned tone yet."
      : `Positive Sentiment = positive clips ÷ clips that have an AI tone (not ÷ all clips). ` +
        `In range: ${sent.total} of ${k.count} clips are tone-scored — ` +
        `${sent.counts.positive} positive, ${sent.counts.neutral} neutral, ${sent.counts.negative} negative, ${sent.counts.mixed} mixed.`;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">PR &amp; Media</div>
          <div className="page-sub">
            {filtered.length} clips · {from} → {to}
            {compare ? ` vs ${fromB} → ${toB} (${filteredB.length} clips)` : " · internal press-clipping records + daily bot"}
            {undated > 0 &&
              (allTime ? ` · includes ${plural(undated, "undated clip")}` : ` · All time also counts ${plural(undated, "undated clip")}`)}
          </div>
        </div>
        {/* Kept clear of the notification bell, which is fixed to the window's top right corner. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 30 }}>
          <span className="verified-badge">✓ Verified from press clippings</span>
          <SettingsLink />
        </div>
      </div>

      {/* DATE RANGE + COMPARE */}
      <div className="controls-bar">
        <div className="field">
          <label>From <HelpTip text="Start of the date range. The KPIs, charts and Share of Voice follow it, except Annual Mention Totals, which shows every year. Press mentions lists every story on record." /></label>
          <MonthField value={from} min={minMonth} max={to} onChange={setFrom} />
        </div>
        <div className="field">
          <label>To <HelpTip text="End of the date range." /></label>
          <MonthField value={to} min={from} max={maxMonth} onChange={setTo} />
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={() => { setFrom(minMonth); setTo(maxMonth); }} title="Reset the range to cover every record on file, undated clips included.">
            All time
          </button>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <button className={`filter-btn${compare ? " active" : ""}`} onClick={() => setCompare((v) => !v)} title="Compare this period against another">
            ⇄ Compare {compare ? "on" : "off"}
          </button>
        </div>
        <div className="field" style={{ marginLeft: "auto" }}>
          <label>&nbsp;</label>
          <button className="filter-btn" onClick={exportCsv} title="Export the selected date range to Excel">
            ⬇ Export to Excel
          </button>
        </div>
      </div>

      {compare && (
        <div className="controls-bar" style={{ background: "var(--warm-white, #f8f6f3)", borderRadius: 8, padding: "8px 10px" }}>
          <div className="field">
            <label>Compare to — From</label>
            <MonthField value={fromB} min={minMonth} max={toB} onChange={setFromB} />
          </div>
          <div className="field">
            <label>To</label>
            <MonthField value={toB} min={fromB} max={maxMonth} onChange={setToB} />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            {/* The tooltip sits on a wrapper: a disabled button takes no pointer events, so shows none. */}
            <span
              title={
                bBeforeA
                  ? "Set Period B to the equal-length window right before Period A, cut short if the records start sooner."
                  : `No records before Period A: they start in ${monthLabel(minMonth)}, the month Period A starts.`
              }
            >
              <button
                className="filter-btn"
                onClick={setBToPeriodBeforeA}
                disabled={!bBeforeA}
                style={bBeforeA ? undefined : { opacity: 0.55, pointerEvents: "none" }}
              >
                ↤ Period before A
              </button>
            </span>
          </div>
          <div className="field" style={{ alignSelf: "center", marginLeft: 8 }}>
            <span style={{ fontSize: 12, color: C.mid }}>
              <strong style={{ color: C.coral }}>A</strong> = {from}→{to} · <strong style={{ color: C.sand }}>B</strong> = {fromB}→{toB}
            </span>
          </div>
          {bNote && (
            <div style={{ flexBasis: "100%", fontSize: 12, color: C.dark, borderLeft: `3px solid ${C.amber}`, paddingLeft: 8 }}>
              {bNote}
            </div>
          )}
        </div>
      )}

      {/* KPIs (show Δ vs B when comparing) */}
      <div className="kpi-strip">
        <KpiCard label="Total Mentions" value={String(k.count)}
          {...(compare ? pctDeltaProps(k.count, kB.count) : { sub: "in date range" })} />
        <KpiCard label="Tier-1 Placements" value={String(k.tier1)}
          {...(compare ? pctDeltaProps(k.tier1, kB.tier1) : { sub: "Global + Local", subClass: "up" })} />
        <KpiCard label="Est. Reach" value={fmtReachFull(k.reach)} title="Estimated audience reached by these clips, summed from each outlet's rate-card median when the clip has no measured figure."
          {...(compare ? pctDeltaProps(k.reach, kB.reach) : { sub: "rate-card modeled" })} />
        <KpiCard label="EAV" value={fmtEAV(k.eav)} title="Earned Advertising Value — what this coverage would have cost as paid advertising, modeled from outlet rate cards. A standard PR value proxy."
          {...(compare ? pctDeltaProps(k.eav, kB.eav) : { sub: "rate-card modeled" })} />
        <KpiCard label="Positive Sentiment" value={k.posPct == null ? "—" : `${k.posPct}%`} title={sentTitle}
          {...(compare
            ? ppDeltaProps(k.posPct, kB.posPct)
            : { sub: k.posPct == null ? "no tone scored yet" : `${sent.counts.positive} of ${sent.total} scored`, subClass: k.posPct == null ? undefined : "up" })} />
      </div>

      {/* SHARE OF VOICE — competitive standing, surfaced up top */}
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(2,1fr)" }}>
        <KpiCard
          label="Your Share of Voice"
          title={`betterhomes' share of all bot-found news mentions (betterhomes + tracked competitors) in the selected range, counted only where competitor coverage is stored. Higher = you're in the news more than rivals.${sovNote ? ` ${sovNote}.` : ""}${trackedNote ? ` ${trackedNote}.` : ""}`}
          value={sovShare == null ? "—" : `${sovShare}%`}
          sub={
            competitorError
              ? "rival coverage did not load"
              : sovShare != null
                ? `${plural(usMentions, "bot-found mention")} · ${from} → ${sovEnd}`
                : !compThrough
                  ? "no competitor coverage stored"
                  : compThrough < `${from}-01`
                    ? `competitor coverage ends ${dayLabel(compThrough)}`
                    : "no bot mentions in range"
          }
        />
        <KpiCard
          label="Share-of-Voice Rank"
          title="Where betterhomes ranks by news-mention count against every tracked Dubai brokerage in this range, those with no story included. #1 = most-covered. Brokerages with the same count share a rank."
          value={sovRank ? `#${sovRank}` : "—"}
          sub={`of ${sovField == null ? "— Dubai brokerages" : plural(sovField, "Dubai brokerage")} tracked${sovTied ? `, tied with ${plural(sovTied, "other")}` : ""}`}
          subClass={sovRank === 1 ? "up" : undefined}
        />
      </div>
      {(sovNote || trackedNote) && (
        <div style={{ fontSize: 11.5, color: C.mid, margin: "-8px 0 16px" }}>
          {sovNote && <div>Share of Voice counts only where competitor coverage is stored: {sovNote}.</div>}
          {trackedNote && <div>{trackedNote}.</div>}
        </div>
      )}

      {/* COMPARISON PANEL */}
      {compare && (
        <div className="charts-grid-2" style={{ marginBottom: 20 }}>
          <div className="chart-card">
            <div className="chart-title">Period A vs Period B</div>
            <div className="chart-sub">
              A = {from}→{to} ({filtered.length} clips) · B = {fromB}→{toB} ({filteredB.length} clips)
            </div>
            <table className="mentions-table" style={{ marginTop: 10 }}>
              <thead>
                <tr><th>Metric</th><th style={{ textAlign: "right" }}>A</th><th style={{ textAlign: "right" }}>B</th><th style={{ textAlign: "right" }}>Change</th></tr>
              </thead>
              <tbody>
                <CmpRow label="Mentions" a={String(k.count)} b={String(kB.count)} d={pctDelta(k.count, kB.count)} />
                <CmpRow label="Tier-1" a={String(k.tier1)} b={String(kB.tier1)} d={pctDelta(k.tier1, kB.tier1)} />
                <CmpRow label="Est. Reach" a={fmtReachFull(k.reach)} b={fmtReachFull(kB.reach)} d={pctDelta(k.reach, kB.reach)} />
                <CmpRow label="EAV" a={fmtEAV(k.eav)} b={fmtEAV(kB.eav)} d={pctDelta(k.eav, kB.eav)} />
                <CmpRow label="Positive %" a={k.posPct == null ? "—" : `${k.posPct}%`} b={kB.posPct == null ? "—" : `${kB.posPct}%`} d={ppDelta(k.posPct, kB.posPct)} />
              </tbody>
            </table>
          </div>
          <div className="chart-card">
            <div className="chart-title">Mentions by Tier — A vs B</div>
            <div className="chart-sub">Same scale, so the mix is directly comparable</div>
            <div className="chart-canvas-wrap">
              <ChartBox
                type="bar"
                data={{
                  labels: tiersPresent.map((t) => TIER_LABEL[t]),
                  datasets: [
                    { label: `A (${from}→${to})`, data: tiersPresent.map((t) => tA[t]), backgroundColor: C.coral },
                    { label: `B (${fromB}→${toB})`, data: tiersPresent.map((t) => tB[t]), backgroundColor: C.sand },
                  ],
                }}
                options={{ plugins: legendBottom }}
              />
            </div>
          </div>
        </div>
      )}

      {/* CHARTS ROW 1 */}
      <div className="charts-grid-2">
        <ChartCard title="EAV & Reach by Month" sub="Bars = EAV ($, left) · Line = Reach (right) · modeled from rate cards">
          <ChartBox
            type="bar"
            data={{
              labels: series.labels,
              datasets: [
                { type: "bar", label: "EAV ($)", data: series.eav, backgroundColor: C.coral + "99", yAxisID: "y" },
                { type: "line", label: "Reach", data: series.reach, borderColor: C.dark, backgroundColor: "transparent", yAxisID: "y1", tension: 0.3, pointRadius: 2 },
              ],
            }}
            options={{
              plugins: legendBottom,
              scales: {
                y: { position: "left", ticks: { callback: (v: number) => fmtEAV(v) } },
                y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v: number) => fmtReach(v) } },
              },
            }}
          />
        </ChartCard>

        <ChartCard title="Mentions by Tier" sub="Stacked by month — filtered by date range">
          <ChartBox
            type="bar"
            data={{
              labels: tiers.labels,
              datasets: TIERS.filter((t) => tiers.series[t].some((n) => n > 0)).map((t) => ({
                label: TIER_LABEL[t],
                data: tiers.series[t],
                backgroundColor: TIER_COLOR[t],
                stack: "s",
              })),
            }}
            options={{ plugins: legendBottom, scales: { x: { stacked: true }, y: { stacked: true } } }}
          />
        </ChartCard>
      </div>

      {/* CHARTS ROW 2 */}
      <div className="charts-grid-2">
        <ChartCard
          title="Annual Mention Totals"
          sub={`Year-on-year by tier, full history, not date-filtered${undated ? ` · ${plural(undated, "undated clip")} not in any year` : ""}`}
        >
          <ChartBox
            type="bar"
            data={{
              labels: annual.years,
              datasets: TIERS.filter((t) => annual.series[t].some((n) => n > 0)).map((t) => ({
                label: TIER_LABEL[t],
                data: annual.series[t],
                backgroundColor: TIER_COLOR[t],
                stack: "a",
              })),
            }}
            options={{ plugins: legendBottom, scales: { x: { stacked: true }, y: { stacked: true } } }}
          />
        </ChartCard>

        <ChartCard title="Top Outlets in Range" sub="Most frequent placements (clip count)">
          <ChartBox
            type="bar"
            data={{
              labels: outlets.map((o) => o.outlet),
              datasets: [{
                label: "Clips",
                data: outlets.map((o) => o.count),
                backgroundColor: outlets.map((o) => TIER_COLOR[o.tier]),
              }],
            }}
            options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false, font: { size: 10 } } } } }}
          />
        </ChartCard>
      </div>

      {/* SENTIMENT + SHARE OF VOICE — side by side */}
      <div className="charts-grid-2">
        <div className="chart-card">
          <div className="chart-title">PR Sentiment</div>
          <div className="chart-sub">Tone of coverage in range · AI-assigned</div>
          {sent.total > 0 ? (
            <div className="chart-canvas-wrap short">
              <ChartBox
                type="doughnut"
                data={{
                  labels: ["Positive", "Neutral", "Negative", "Mixed"],
                  datasets: [{
                    data: [sent.counts.positive, sent.counts.neutral, sent.counts.negative, sent.counts.mixed],
                    backgroundColor: [C.green, C.amber, C.red, C.blue],
                  }],
                }}
                options={{ plugins: legendBottom }}
              />
            </div>
          ) : (
            <div className="empty-state">
              No tone scored for this range yet.<br />
              The daily bot auto-classifies each new article; historical clips without a tone stay blank.
            </div>
          )}
        </div>

        <div className="chart-card">
          <div className="chart-title">News Share of Voice</div>
          <div className="chart-sub">
            betterhomes vs Dubai competitors · bot-found news · {from} → {sovEnd}
            {sovNote ? ` · ${sovNote}` : ""}
            {trackedNote ? ` · ${trackedNote}` : ""}
          </div>
          {sov.length ? (
            <div className="chart-canvas-wrap short">
              <ChartBox
                type="bar"
                data={{
                  labels: sov.map((s) => `${s.brand} (${s.share}%)`),
                  datasets: [{
                    label: "Mentions in range",
                    data: sov.map((s) => s.mentions),
                    backgroundColor: sov.map((s) => (s.isUs ? C.coral : C.sand)),
                  }],
                }}
                options={{ indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true }, y: { ticks: { autoSkip: false, font: { size: 10 } } } } }}
              />
            </div>
          ) : (
            <div className="empty-state">{sovEmpty}</div>
          )}
        </div>
      </div>

      {/* INSIGHTS — date-range-aware, forward-looking strategy */}
      {divider}
      <div className="insights-panel">
        <div className="insights-head">
          <div>
            <div className="insights-title">Receive Insights <HelpTip text="Sends the selected date range's headlines and figures to the AI (Claude) and returns forward-looking strategy: what to publish, which competitor topic to counter, which outlet or angle to target next. Not a metrics recap." /></div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 4 }}>
              {liveRange
                ? `AI analysis for ${liveRange.from} → ${liveRange.to}`
                : `No analysis received yet for ${from} → ${to}`}
            </div>
          </div>
          <div className="insights-actions">
            {liveRange && (
              <span className="insights-meta">for {liveRange.from} → {liveRange.to}</span>
            )}
            <button
              className="filter-btn"
              onClick={receiveInsights}
              disabled={receiving}
              style={{ whiteSpace: "nowrap" }}
            >
              {receiving ? "Analysing…" : liveInsights ? "↻ Receive Insights" : "Receive Insights"}
            </button>
          </div>
        </div>
        {receiveErr && <div className="insights-err">{receiveErr}</div>}
        {!liveInsights && !receiveErr && !receiving && (
          <div style={{ color: "rgba(255,255,255,.45)", fontSize: 13, padding: "20px 0 8px" }}>
            Click &ldquo;Receive Insights&rdquo; to ask the AI for strategic recommendations based on {from} → {to} data.
          </div>
        )}
        {receiving && (
          <div style={{ color: "rgba(255,255,255,.55)", fontSize: 13, padding: "20px 0 8px" }}>
            Asking the AI to analyse {from} → {to}…
          </div>
        )}
        {!liveInsights && insights.length > 0 && (
          <div style={{ color: "rgba(255,255,255,.45)", fontSize: 11, padding: "0 0 10px" }}>{fallbackNote}</div>
        )}
        <div className="insights-grid" style={{ marginTop: liveInsights || receiveErr ? 0 : 4 }}>
          {(liveInsights ?? insights).map((ins, i) => (
            <div key={i} className="insight-card" style={{ borderLeftColor: insightColor(ins.kind) }}>
              <div className="i-type">{ins.label}</div>
              <div className="i-text">{ins.text}</div>
            </div>
          ))}
        </div>
      </div>

      {/* PRESS MENTIONS: every story on record, ours and the rivals', one row per article */}
      {divider}
      <PressMentions
        items={press.items}
        companies={press.companies}
        rivalsError={competitorError}
        peopleError={press.peopleError}
      />
    </>
  );
}

/**
 * The way to PR & Media settings, where everything that sets the tab up
 * rather than reports on it now lives: a gear, drawn here so no icon package
 * is needed. Left out of the weekly email's picture (lib/reportCapture.ts).
 */
function SettingsLink() {
  return (
    <Link href="/pr/settings" className="icon-link" title="PR & Media settings" aria-label="PR & Media settings" data-report-hide>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" fillRule="evenodd" aria-hidden="true" focusable="false">
        <path d="M9.90 3.87L10.18 1.15L13.82 1.15L14.10 3.87A8.4 8.4 0 0 1 16.26 4.76L18.39 3.04L20.96 5.61L19.24 7.74A8.4 8.4 0 0 1 20.13 9.90L22.85 10.18L22.85 13.82L20.13 14.10A8.4 8.4 0 0 1 19.24 16.26L20.96 18.39L18.39 20.96L16.26 19.24A8.4 8.4 0 0 1 14.10 20.13L13.82 22.85L10.18 22.85L9.90 20.13A8.4 8.4 0 0 1 7.74 19.24L5.61 20.96L3.04 18.39L4.76 16.26A8.4 8.4 0 0 1 3.87 14.10L1.15 13.82L1.15 10.18L3.87 9.90A8.4 8.4 0 0 1 4.76 7.74L3.04 5.61L5.61 3.04L7.74 4.76A8.4 8.4 0 0 1 9.90 3.87ZM15.4 12A3.4 3.4 0 1 0 8.6 12A3.4 3.4 0 1 0 15.4 12Z" />
      </svg>
    </Link>
  );
}

function insightColor(kind: string) {
  return kind === "high" ? C.red : kind === "medium" ? C.amber : kind === "test" ? C.blue : C.green;
}

function pctDeltaProps(a: number, b: number): { sub: string; subClass?: string } {
  const d = pctDelta(a, b);
  return { sub: d.text, subClass: d.cls };
}
function ppDeltaProps(a: number | null, b: number | null): { sub: string; subClass?: string } {
  const d = ppDelta(a, b);
  return { sub: d.text, subClass: d.cls };
}

function CmpRow({ label, a, b, d }: { label: string; a: string; b: string; d: { text: string; cls?: "up" | "down" } }) {
  const color = d.cls === "up" ? C.green : d.cls === "down" ? C.red : C.mid;
  return (
    <tr>
      <td>{label}</td>
      <td style={{ textAlign: "right", fontWeight: 600 }}>{a}</td>
      <td style={{ textAlign: "right", color: C.mid }}>{b}</td>
      <td style={{ textAlign: "right", color, fontWeight: 600 }}>{d.text.replace(" vs B", "")}</td>
    </tr>
  );
}

/**
 * A month box that passes on only a real "YYYY-MM" between its min and max.
 *
 * Chrome reports "" while part of the month is cleared, and browsers with no
 * month picker show a plain text box where "2025-1" can be typed. Both went
 * straight to the filters: a blank "From" showed all history, and "2025-1"
 * sorted after every month of 2025. What is typed stays in the box while it is
 * typed; the page keeps the last good month and shows it again on leaving.
 */
function MonthField({ value, min, max, onChange }: { value: string; min: string; max: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="month"
      value={draft ?? value}
      min={min}
      max={max}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        if (isMonthIn(v, min, max)) onChange(v);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

function KpiCard({ label, value, sub, subClass, title }: { label: string; value: string; sub?: string; subClass?: string; title?: string }) {
  return (
    <div className="kpi-card" title={title}>
      <div className="kpi-label">{label}{title ? " ⓘ" : ""}</div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-change${subClass ? " " + subClass : ""}`}>{sub ?? ""}</div>
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      <div className="chart-sub">{sub}</div>
      <div className="chart-canvas-wrap">{children}</div>
    </div>
  );
}
