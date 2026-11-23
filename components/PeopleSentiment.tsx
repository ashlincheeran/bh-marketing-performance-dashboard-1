"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { saveSocialConfigAction } from "@/app/actions";
import HelpTip from "@/components/HelpTip";
import ChartBox from "@/components/Chart";
import { RunLog, useRunLog } from "@/components/RunLog";
import { PageHeader } from "@/components/ui";
import { C } from "@/lib/theme";
import { MONTHS, ago, dayLabel } from "@/lib/format";
import { brandHandle, distinctPosts, isScored, namesSubject, netScore, postKey } from "@/lib/peopleSentiment";
import {
  CHANNELS,
  WINDOW_LABEL,
  type SocialChannel,
  type SocialConfig,
  type SocialMention,
  type SocialRun,
  type TimeWindow,
} from "@/lib/socialTypes";

const CHANNEL_META = Object.fromEntries(CHANNELS.map((c) => [c.key, c])) as Record<
  SocialChannel,
  (typeof CHANNELS)[number]
>;

function scoreColor(n: number | null): string {
  if (n == null) return C.mid;
  if (n > 0.05) return C.green;
  if (n < -0.05) return C.red;
  return C.amber;
}

interface SentCounts { positive: number; neutral: number; negative: number; mixed: number; none: number; total: number }
function sentCounts(items: SocialMention[]): SentCounts {
  const c: SentCounts = { positive: 0, neutral: 0, negative: 0, mixed: 0, none: 0, total: items.length };
  for (const m of items) {
    if (m.sentiment === "positive") c.positive++;
    else if (m.sentiment === "neutral") c.neutral++;
    else if (m.sentiment === "negative") c.negative++;
    else if (m.sentiment === "mixed") c.mixed++;
    else c.none++;
  }
  return c;
}
// Which mentions count, and how: lib/peopleSentiment.ts, shared with the Dashboard.

// The last `n` calendar months as "YYYY-MM" keys, oldest → newest, ending this month.
function lastNMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth(); // 0-11
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m + 1).padStart(2, "0")}`);
    m--;
    if (m < 0) { m = 11; y--; }
  }
  return out;
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${String(y).slice(2)}`;
}

/** Where a net score from −1 to +1 sits on a track from −100 to +100: red, through neutral, to green. */
function NetGauge({ net }: { net: number | null }) {
  const at = net == null ? null : Math.min(100, Math.max(0, ((net + 1) / 2) * 100));
  return (
    <div className="ps-gauge" title="−100 is all very negative, 0 neutral, +100 all very positive">
      {at != null && <span className="ps-gauge-mark" style={{ left: `${at}%` }} />}
    </div>
  );
}

/** "62% positive · 30% neutral · 8% negative", leaving out what is nought. */
function sentShares(c: SentCounts): string {
  const scored = c.positive + c.neutral + c.negative + c.mixed;
  if (!scored) return "No scored posts yet";
  const parts: [number, string][] = [
    [c.positive, "positive"],
    [c.mixed, "mixed"],
    [c.neutral, "neutral"],
    [c.negative, "negative"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${Math.round((n / scored) * 100)}% ${word}`)
    .join(" · ");
}

function SentBar({ c }: { c: SentCounts }) {
  const scored = c.positive + c.neutral + c.negative + c.mixed;
  if (!scored) return <div className="ps-bar"><div style={{ width: "100%", background: "var(--border)" }} /></div>;
  const pct = (n: number) => `${(n / scored) * 100}%`;
  return (
    <div className="ps-bar" title={`${c.positive} positive · ${c.neutral} neutral · ${c.negative} negative · ${c.mixed} mixed`}>
      {c.positive > 0 && <div style={{ width: pct(c.positive), background: C.green }} />}
      {c.mixed > 0 && <div style={{ width: pct(c.mixed), background: C.blue }} />}
      {c.neutral > 0 && <div style={{ width: pct(c.neutral), background: C.amber }} />}
      {c.negative > 0 && <div style={{ width: pct(c.negative), background: C.red }} />}
    </div>
  );
}

export default function PeopleSentiment({
  config,
  mentions,
  runs,
  tabs,
}: {
  config: SocialConfig & { readError?: string };
  mentions: SocialMention[];
  runs: SocialRun[];
  /** The section's pages (components/PrTabs), along the foot of the header. */
  tabs?: ReactNode;
}) {
  const router = useRouter();
  const last = runs[0];

  // ── editable config (subjects + per-platform sources) ──────────
  const [cfg, setCfg] = useState<SocialConfig>(config);
  const [savePending, startSave] = useTransition();
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  // Config panel starts open only when there's no data yet (so a first-time user
  // is guided to run it); otherwise collapsed so results show first.
  const [cfgOpen, setCfgOpen] = useState(mentions.length === 0);

  // ── per-run variables ──────────────────────────────────────────
  const [window, setWindow] = useState<TimeWindow>(config.defaults.window);
  const [maxItems, setMaxItems] = useState<number>(config.defaults.maxItems);

  // ── run streaming state ─────────────────────────────────────────
  const { running, logs, logRef, start } = useRunLog();

  // ── results filters ─────────────────────────────────────────────
  const [subjFilter, setSubjFilter] = useState<string>("all");
  const [chanFilter, setChanFilter] = useState<string>("all");
  const [showPending, setShowPending] = useState(false);
  const [feedOpen, setFeedOpen] = useState(true);

  // ── trend controls (read stored data only — no Apify run) ───────
  // By default the months of this year so far (January to now), like every other date range.
  const [trendN, setTrendN] = useState<number>(() => new Date().getUTCMonth() + 1);
  const [trendSubject, setTrendSubject] = useState<string>("betterhomes");

  const company = cfg.subjects.find((s) => s.kind === "company");
  const enabledChannels = (Object.keys(cfg.platforms) as SocialChannel[]).filter((c) => cfg.platforms[c].enabled);
  /** The platforms a run reads: switched on, with the handle or address each needs saved. */
  const runningNames = CHANNELS.filter((c) => {
    const p = cfg.platforms[c.key];
    if (!p?.enabled) return false;
    if (c.key === "instagram") return !!p.username?.trim();
    if (c.key === "glassdoor") return !!p.companyUrl?.trim();
    if (c.key === "facebook") return !!p.pageUrl?.trim();
    return true;
  }).map((c) => c.name);

  function saveConfig() {
    setSaveMsg(null);
    startSave(async () => {
      const r = await saveSocialConfigAction(cfg);
      setSaveMsg(r.ok ? "Saved." : r.error);
      if (r.ok) router.refresh();
    });
  }

  function setPlatform<K extends keyof SocialConfig["platforms"][SocialChannel]>(
    ch: SocialChannel,
    key: K,
    val: SocialConfig["platforms"][SocialChannel][K],
  ) {
    setCfg((c) => ({ ...c, platforms: { ...c.platforms, [ch]: { ...c.platforms[ch], [key]: val } } }));
  }
  function setSubjectName(idx: number, name: string) {
    setCfg((c) => {
      const subjects = [...c.subjects];
      subjects[idx] = { ...subjects[idx], name };
      return { ...c, subjects };
    });
  }
  function addPerson() {
    setCfg((c) => ({ ...c, subjects: [...c.subjects, { name: "", kind: "person" }] }));
  }
  function removeSubject(idx: number) {
    setCfg((c) => ({ ...c, subjects: c.subjects.filter((_, i) => i !== idx) }));
  }

  function run() {
    setCfgOpen(true);
    return start("/api/social/stream", () => ({
      window,
      maxItems,
      channels: enabledChannels,
      subjects: cfg.subjects.filter((s) => s.name.trim()),
    }));
  }

  // ── aggregates ──────────────────────────────────────────────────
  // Every figure below is computed from `checked` only; see namesSubject().
  const handle = brandHandle(cfg);
  const { checked, pending, offTopic } = useMemo(() => {
    const checked: SocialMention[] = [];
    const pending: SocialMention[] = [];
    let offTopic = 0;
    for (const m of mentions) {
      if (!namesSubject(m, handle)) offTopic++;
      else if (isScored(m)) checked.push(m);
      else pending.push(m);
    }
    return { checked, pending, offTopic };
  }, [mentions, handle]);
  const overallNet = useMemo(() => netScore(checked), [checked]);
  const channelsWithData = useMemo(() => new Set(checked.map((m) => m.channel)).size, [checked]);
  const platformsWithData = useMemo(() => CHANNELS.filter((c) => checked.some((m) => m.channel === c.key)), [checked]);
  const checkedPosts = useMemo(() => distinctPosts(checked), [checked]);
  const pendingPosts = useMemo(() => distinctPosts(pending), [pending]);
  const negativePosts = useMemo(() => distinctPosts(checked.filter((m) => m.sentiment === "negative")), [checked]);
  // The period the figures cover, from the posts' own dates.
  const span = useMemo(() => {
    const days = checked.map((m) => m.posted_at?.slice(0, 10)).filter((d): d is string => Boolean(d)).sort();
    return days.length ? `${dayLabel(days[0])} – ${dayLabel(days[days.length - 1])}` : null;
  }, [checked]);

  const bySubject = useMemo(() => {
    const order = cfg.subjects.map((s) => s.name);
    const map = new Map<string, SocialMention[]>();
    for (const m of checked) {
      const arr = map.get(m.subject) ?? [];
      arr.push(m);
      map.set(m.subject, arr);
    }
    return [...map.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [checked, cfg.subjects]);

  const feed = useMemo(() => {
    return (showPending ? pending : checked).filter((m) => {
      if (subjFilter !== "all" && m.subject !== subjFilter) return false;
      if (chanFilter !== "all" && m.channel !== chanFilter) return false;
      return true;
    });
  }, [checked, pending, showPending, subjFilter, chanFilter]);

  // Monthly trend over the selected window, computed entirely from stored
  // mentions (Apify does not run for this — that's the point of storing them).
  const trend = useMemo(() => {
    const months = lastNMonths(trendN);
    const idx = new Map(months.map((k, i) => [k, i]));
    const z = () => new Array(months.length).fill(0);
    const count = z(), pos = z(), neu = z(), neg = z(), mix = z(), eng = z(), scoreSum = z(), scoreN = z();
    // Volume and engagement once per post, even when it is filed under several
    // subjects; tone stays per subject, since each is scored on its own.
    const seen = new Set<string>();
    for (const m of checked) {
      if (trendSubject !== "all" && m.subject !== trendSubject) continue;
      if (!m.posted_at) continue;
      const i = idx.get(m.posted_at.slice(0, 7));
      if (i === undefined) continue;
      if (!seen.has(postKey(m))) {
        seen.add(postKey(m));
        count[i]++;
        eng[i] += (m.likes || 0) + (m.comments || 0) + (m.shares || 0);
      }
      if (typeof m.sentiment_score === "number") { scoreSum[i] += m.sentiment_score; scoreN[i]++; }
      if (m.sentiment === "positive") pos[i]++;
      else if (m.sentiment === "neutral") neu[i]++;
      else if (m.sentiment === "negative") neg[i]++;
      else if (m.sentiment === "mixed") mix[i]++;
    }
    return {
      labels: months.map(monthLabel),
      count, pos, neu, neg, mix, eng,
      net: months.map((_, i) => (scoreN[i] ? Math.round((scoreSum[i] / scoreN[i]) * 100) : null)),
      total: count.reduce((a, b) => a + b, 0),
    };
  }, [checked, trendN, trendSubject]);

  const legendBottom = { legend: { position: "bottom" as const, labels: { font: { size: 10 } } } };

  return (
    <>
      <PageHeader
        title="PR & People Sentiment"
        sub={
          <>
            What people say online about betterhomes and its people
            {runningNames.length ? ` on ${runningNames.length > 1 ? `${runningNames.slice(0, -1).join(", ")} and ${runningNames[runningNames.length - 1]}` : runningNames[0]}` : ""},
            with the tone of each post scored by AI.
          </>
        }
        actions={<span className="chip">{mentions.length ? `${checkedPosts} posts checked by AI` : "No data yet: run the bot"}</span>}
        tabs={tabs}
      />

      {config.readError ? (
        <div className="notice notice-warn" style={{ marginBottom: 18 }}>
          The saved People sentiment settings could not be read ({config.readError}). The defaults are shown, and saving is
          off until the settings load, so they can&apos;t be written over the real ones.
        </div>
      ) : null}

      {/* CONFIG + RUN — collapsible */}
      <div className="chart-card" style={{ marginBottom: 18 }}>
        <button className="ps-collapse-head" onClick={() => setCfgOpen((v) => !v)} aria-expanded={cfgOpen}>
          <span className="chart-title" style={{ margin: 0 }}>{cfgOpen ? "▾" : "▸"} Run the sentiment bot</span>
          <span className="ps-collapse-hint">
            {cfgOpen ? "configure & run below" : "click to configure & run"}
            {last ? ` · last run ${ago(last.ran_at)}` : ""}
          </span>
        </button>

        {cfgOpen && (
          <div style={{ marginTop: 12 }}>
            <div className="chart-sub">
              Pick the window and depth, then run. Scraping is via Apify; tone is scored by Gemini on a fixed −1…+1 rubric so months compare fairly.
            </div>

            {/* subjects */}
            <div className="ps-cfg-row" style={{ marginTop: 12 }}>
              <div className="ps-cfg-label">
                Tracking
                <HelpTip text="Who to monitor. betterhomes is always tracked; add the executives/people you want sentiment for, then Save. Names are used as the search terms." />
              </div>
              <div className="ps-chips">
                <span className="ps-chip ps-chip-company">{company?.name ?? "betterhomes"}</span>
                {cfg.subjects.map((s, idx) =>
                  s.kind !== "person" ? null : (
                    <span key={idx} className="ps-chip">
                      <input
                        className="ps-chip-input"
                        value={s.name}
                        placeholder="Person name"
                        onChange={(e) => setSubjectName(idx, e.target.value)}
                      />
                      <button className="ps-chip-x" onClick={() => removeSubject(idx)} title="Remove">×</button>
                    </span>
                  ),
                )}
                <button className="filter-btn" onClick={addPerson}>+ Add person</button>
              </div>
            </div>

            {/* run variables */}
            <div className="controls-bar" style={{ marginTop: 14, marginBottom: 0 }}>
              <div className="field">
                <label>Date window <HelpTip text="How far back to scrape each platform. Posts/reviews older than this are dropped." /></label>
                <select className="ps-select" value={window} onChange={(e) => setWindow(e.target.value as TimeWindow)}>
                  {(Object.keys(WINDOW_LABEL) as TimeWindow[]).map((w) => (
                    <option key={w} value={w}>{WINDOW_LABEL[w]}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Items / platform <HelpTip text="Max posts/reviews to pull from each platform per run. Higher = more coverage but slower and more Apify credit; lower is faster and cheaper." /></label>
                <input
                  className="ps-select"
                  type="number"
                  min={5}
                  max={100}
                  value={maxItems}
                  onChange={(e) => setMaxItems(Math.max(1, Number(e.target.value) || 1))}
                  style={{ width: 90 }}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Platforms <HelpTip text="Which networks to scrape this run. Turn off any you don't need: fewer platforms run faster and cost less." /></label>
                <div className="ps-platforms">
                  {CHANNELS.map((c) => (
                    <button
                      key={c.key}
                      className={`filter-btn${cfg.platforms[c.key].enabled ? " active" : ""}`}
                      onClick={() => setPlatform(c.key, "enabled", !cfg.platforms[c.key].enabled)}
                      title={c.note}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button className="ps-run" onClick={run} disabled={running || enabledChannels.length === 0}>
                  {running ? "Running…" : "▶ Run sentiment bot"}
                </button>
              </div>
            </div>

            {/* advanced sources */}
            <button className="ps-adv-toggle" onClick={() => setAdvOpen((v) => !v)}>
              {advOpen ? "▾" : "▸"} Advanced: sources and handles (actor IDs, Instagram handle, Glassdoor and Facebook addresses)
            </button>
            {advOpen && (
              <div className="ps-adv">
                {CHANNELS.map((c) => {
                  const pc = cfg.platforms[c.key];
                  return (
                    <div key={c.key} className="ps-adv-card">
                      <div className="ps-adv-head">{c.name}</div>
                      <label className="ps-adv-field">
                        <span>Apify actor</span>
                        <input value={pc.actor} onChange={(e) => setPlatform(c.key, "actor", e.target.value)} />
                      </label>
                      {c.key === "instagram" && (
                        <label className="ps-adv-field"><span>IG handle</span>
                          <input value={pc.username ?? ""} placeholder="betterhomesuae" onChange={(e) => setPlatform(c.key, "username", e.target.value)} /></label>
                      )}
                      {c.key === "glassdoor" && (
                        <label className="ps-adv-field"><span>Company URL</span>
                          <input value={pc.companyUrl ?? ""} placeholder="https://www.glassdoor.com/Reviews/…" onChange={(e) => setPlatform(c.key, "companyUrl", e.target.value)} /></label>
                      )}
                      {c.key === "facebook" && (
                        <label className="ps-adv-field"><span>Page URL</span>
                          <input value={pc.pageUrl ?? ""} placeholder="https://www.facebook.com/…" onChange={(e) => setPlatform(c.key, "pageUrl", e.target.value)} /></label>
                      )}
                      <div className="ps-adv-note">{c.coversPeople ? "Covers company + people" : "Company only"}</div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="ps-save-row">
              <button className="filter-btn" onClick={saveConfig} disabled={savePending || !!config.readError} title={config.readError ? "The saved settings could not be read, so saving is off: it would replace them with the defaults." : undefined}>
                {savePending ? "Saving…" : "Save subjects & sources"}
              </button>
              <HelpTip text="Saves the tracked people and the per-platform sources (actor IDs, handles, URLs, on/off) to the database so they persist across runs and reloads. The date window and items per run aren't saved: they apply to the current run only." />
              {saveMsg && <span className="ps-save-msg">{saveMsg}</span>}
            </div>
          </div>
        )}
      </div>

      {/* run log — stays visible even when the config is collapsed */}
      <RunLog running={running} logs={logs} logRef={logRef} />

      {mentions.length === 0 ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: 140 }}>
            No sentiment data stored yet.<br />
            Set your platforms above and click <strong>Run sentiment bot</strong>. Results appear here once it finishes.
            <br /><br />
            <span className="muted">Requires APIFY_TOKEN and GEMINI_API_KEY in the deployment environment.</span>
          </div>
        </div>
      ) : (
        <>
          {/* KPIs — the universe they count, stated */}
          <div className="chart-sub" style={{ marginBottom: 10 }}>
            {checkedPosts} AI-checked post{checkedPosts === 1 ? "" : "s"}
            {span ? `, dated ${span}` : ""}, from every run so far
            {pendingPosts ? ` · ${pendingPosts} more pending an AI check, not counted` : ""}
            {offTopic ? ` · ${offTopic} search hit${offTopic === 1 ? "" : "s"} naming no tracked subject, hidden` : ""}
          </div>
          <div className="kpi-strip cols-4">
            <div className="kpi-card">
              <div className="kpi-label">Mentions <HelpTip text="Distinct posts and reviews the AI has checked and kept. A post that names betterhomes and one of its people is counted once here, and once under each subject below." /></div>
              <div className="kpi-value">{checkedPosts}</div>
              <div className="kpi-change">{pendingPosts ? `+${pendingPosts} waiting for an AI check` : "All checked by AI"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Net sentiment <HelpTip text="Average tone of all scored mentions, from −100 (all very negative) to +100 (all very positive); 0 is neutral. It's an index, not a percentage. Based only on mentions that have an AI tone score." /></div>
              <div className="kpi-value" style={{ color: scoreColor(overallNet) }}>
                {overallNet == null ? "n/a" : `${overallNet > 0 ? "+" : ""}${Math.round(overallNet * 100)}`}
              </div>
              <NetGauge net={overallNet} />
              <div className="kpi-change">On a scale of −100 to +100</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Negative flags</div>
              <div className="kpi-value" style={{ color: negativePosts ? C.red : undefined }}>{negativePosts}</div>
              <div className="kpi-change">{negativePosts ? `of ${checkedPosts} checked posts need a look` : `None of ${checkedPosts} checked posts`}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Platforms with data</div>
              <div className="kpi-value">
                {channelsWithData} <span className="ps-kpi-of">of {CHANNELS.length}</span>
              </div>
              <div className="kpi-change">{platformsWithData.map((c) => c.name).join(", ")}</div>
            </div>
          </div>

          {/* trends over time — from stored mentions, no Apify run */}
          <div className="chart-title" style={{ marginBottom: 10 }}>
            Trends over time
            <HelpTip text="Worked out from mentions already stored by past runs: Apify does not run for this. Shows how volume and sentiment moved month by month, so you can see the trend over X months without re-scraping." />
          </div>
          <div className="controls-bar">
            <div className="field">
              <label>Subject <HelpTip text="Whose trend to chart: the company or a tracked person." /></label>
              <select className="ps-select" value={trendSubject} onChange={(e) => setTrendSubject(e.target.value)}>
                <option value="all">All subjects</option>
                {cfg.subjects.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Window <HelpTip text="How many months of stored history to plot." /></label>
              <select className="ps-select" value={trendN} onChange={(e) => setTrendN(Number(e.target.value))}>
                <option value={new Date().getUTCMonth() + 1}>This year</option>
                <option value={3}>Last 3 months</option>
                <option value={6}>Last 6 months</option>
                <option value={12}>Last 12 months</option>
                <option value={24}>Last 24 months</option>
              </select>
            </div>
            <div className="field" style={{ alignSelf: "center", marginLeft: "auto" }}>
              <span style={{ fontSize: 12, color: C.mid }}>{trend.total} mention{trend.total === 1 ? "" : "s"} in window</span>
            </div>
          </div>

          {trend.total === 0 ? (
            <div className="chart-card" style={{ marginBottom: 20 }}>
              <div className="empty-state" style={{ height: 120 }}>
                No stored mentions for {trendSubject === "all" ? "any subject" : trendSubject} in this window yet.<br />
                The trend fills in as the bot runs over the coming months. The data is kept, so it builds up without scraping again.
              </div>
            </div>
          ) : (
            <>
              <div className="charts-grid-2">
                <div className="chart-card">
                  <div className="chart-title">Mentions &amp; net sentiment</div>
                  <div className="chart-sub">Bars = mentions per month · line = net sentiment (−100…+100)</div>
                  <div className="chart-canvas-wrap">
                    <ChartBox
                      type="bar"
                      data={{
                        labels: trend.labels,
                        datasets: [
                          { type: "bar", label: "Mentions", data: trend.count, backgroundColor: C.coral + "99", hoverBackgroundColor: C.coral, borderRadius: 6, maxBarThickness: 44, yAxisID: "y" },
                          { type: "line", label: "Net sentiment", data: trend.net, borderColor: C.dark, backgroundColor: "transparent", borderWidth: 2, yAxisID: "y1", tension: 0.35, spanGaps: true, pointRadius: 3.5, pointBackgroundColor: "#fff", pointBorderWidth: 2 },
                        ],
                      }}
                      options={{
                        plugins: legendBottom,
                        scales: {
                          x: { grid: { display: false } },
                          y: { position: "left", beginAtZero: true, ticks: { precision: 0 }, grid: { color: C.border } },
                          y1: { position: "right", min: -100, max: 100, grid: { drawOnChartArea: false } },
                        },
                      }}
                    />
                  </div>
                </div>

                <div className="chart-card">
                  <div className="chart-title">Sentiment mix by month</div>
                  <div className="chart-sub">Tone composition of scored mentions</div>
                  <div className="chart-canvas-wrap">
                    <ChartBox
                      type="bar"
                      data={{
                        labels: trend.labels,
                        datasets: [
                          { label: "Positive", data: trend.pos, backgroundColor: C.green, stack: "s", maxBarThickness: 44 },
                          { label: "Mixed", data: trend.mix, backgroundColor: C.blue, stack: "s", maxBarThickness: 44 },
                          { label: "Neutral", data: trend.neu, backgroundColor: C.amber, stack: "s", maxBarThickness: 44 },
                          { label: "Negative", data: trend.neg, backgroundColor: C.red, stack: "s", maxBarThickness: 44 },
                        ],
                      }}
                      options={{
                        plugins: legendBottom,
                        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { precision: 0 }, grid: { color: C.border } } },
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="chart-card" style={{ marginTop: 16, marginBottom: 20 }}>
                <div className="chart-title">Engagement by month</div>
                <div className="chart-sub">Likes + comments + shares on scraped posts (where the platform reports them)</div>
                <div className="chart-canvas-wrap short">
                  <ChartBox
                    type="bar"
                    data={{ labels: trend.labels, datasets: [{ label: "Engagement", data: trend.eng, backgroundColor: C.sage, borderRadius: 6, maxBarThickness: 44 }] }}
                    options={{
                      plugins: { legend: { display: false } },
                      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: C.border } } },
                    }}
                  />
                </div>
              </div>
            </>
          )}

          {/* per-subject */}
          <div className="chart-title" style={{ marginBottom: 10 }}>By subject</div>
          <div className="ps-subjects">
            {bySubject.map(([name, items]) => {
              const c = sentCounts(items);
              const net = netScore(items);
              const chans = new Map<string, number>();
              for (const m of items) chans.set(m.channel, (chans.get(m.channel) ?? 0) + 1);
              return (
                <div key={name} className="chart-card ps-subject-card">
                  <div className="ps-subject-head">
                    <span>{name}</span>
                    <span className="ps-net" style={{ color: scoreColor(net) }} title="Net sentiment: average tone of this subject's scored mentions, −100 to +100 (0 = neutral).">
                      {net == null ? "n/a" : `${net > 0 ? "+" : ""}${Math.round(net * 100)}`}
                    </span>
                  </div>
                  <div className="ps-subject-sub">
                    {c.total} AI-checked posts
                    {(() => {
                      const waiting = pending.filter((m) => m.subject === name).length;
                      return waiting ? ` · ${waiting} pending` : "";
                    })()}
                    <HelpTip text="AI-checked posts that name this subject. Posts still waiting for an AI check are listed as pending and don't count. A low count means the score above is a small sample." />
                  </div>
                  <SentBar c={c} />
                  <div className="ps-shares">{sentShares(c)}</div>
                  <div className="ps-chan-chips">
                    {[...chans.entries()].map(([ch, n]) => (
                      <span key={ch} className="ps-chan-chip">
                        {CHANNEL_META[ch as SocialChannel]?.name ?? ch} {n}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* feed — collapsible */}
          <div className="chart-card" style={{ marginTop: 20 }}>
            <button
              onClick={() => setFeedOpen((v) => !v)}
              style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, width: "100%", textAlign: "left" }}
            >
              <div className="chart-title" style={{ marginBottom: 0 }}>
                {feedOpen ? "▾" : "▸"} {showPending ? "Pending AI check" : "Mentions feed"} ({feed.length}) · click to {feedOpen ? "collapse" : "expand"}
              </div>
            </button>
            {feedOpen && (
              <>
                <div className="table-controls" style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className={`filter-btn${subjFilter === "all" ? " active" : ""}`} onClick={() => setSubjFilter("all")}>All subjects</button>
                    {cfg.subjects.map((s) => (
                      <button key={s.name} className={`filter-btn${subjFilter === s.name ? " active" : ""}`} onClick={() => setSubjFilter(s.name)}>
                        {s.name}
                      </button>
                    ))}
                    {pending.length > 0 && (
                      <button
                        className={`filter-btn${showPending ? " active" : ""}`}
                        onClick={() => setShowPending((v) => !v)}
                        title="Stored but not yet scored by the AI, so not counted in any figure above."
                        style={{ marginLeft: "auto" }}
                      >
                        {showPending ? "Show AI-checked" : `Pending AI check (${pending.length})`}
                      </button>
                    )}
                  </div>
                </div>
                <div className="table-controls" style={{ marginTop: 0 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className={`filter-btn${chanFilter === "all" ? " active" : ""}`} onClick={() => setChanFilter("all")}>All platforms</button>
                    {CHANNELS.map((c) => (
                      <button key={c.key} className={`filter-btn${chanFilter === c.key ? " active" : ""}`} onClick={() => setChanFilter(c.key)}>
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="table-wrapper">
                  <div className="table-scroll">
                    <table className="mentions-table">
                      <thead>
                        <tr>
                          <th>Date</th><th>Platform</th><th>Subject</th><th>Author</th>
                          <th style={{ minWidth: 320 }}>What they said</th><th>Tone</th><th>Link</th>
                        </tr>
                      </thead>
                      <tbody>
                        {feed.slice(0, 150).map((m) => (
                          <tr key={m.id}>
                            <td style={{ whiteSpace: "nowrap" }}>{m.posted_at ? m.posted_at.slice(0, 10) : <span className="muted">Undated</span>}</td>
                            <td>{CHANNEL_META[m.channel as SocialChannel]?.name ?? m.channel}</td>
                            <td>{m.subject}</td>
                            <td>{m.author ?? <span className="muted">Not given</span>}</td>
                            <td title={m.sentiment_reason ?? undefined}>
                              {(m.content ?? "").slice(0, 180)}{(m.content ?? "").length > 180 ? "…" : ""}
                            </td>
                            <td>{m.sentiment ? <span className={`sent-badge sent-${m.sentiment}`}>{m.sentiment}</span> : <span className="muted">Not scored</span>}</td>
                            <td>{m.url ? <a className="link-btn" href={m.url} target="_blank" rel="noopener noreferrer">Open</a> : <span className="muted">No link</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.mid, marginTop: 8 }}>
                  {feed.length} shown{feed.length > 150 ? " (first 150)" : ""} · {checked.length} AI-checked
                  {pending.length ? ` · ${pending.length} pending AI check` : ""}
                  {offTopic ? ` · ${offTopic} search hits naming no tracked subject hidden` : ""} ·
                  {" "}<span className="muted">Each row is a real scraped post/review; tone is AI-assigned. Hover a row for the AI&apos;s reason.</span>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
