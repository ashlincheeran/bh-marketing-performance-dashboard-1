"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { RunLog, useRunLog } from "@/components/RunLog";
import { receivePerfInsightsAction, savePerfConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
import { errorMessage } from "@/lib/coerce";
import { MONTHS, ago, fmt } from "@/lib/format";
import {
  PERF_PLATFORMS,
  PERF_PLATFORM_META,
  type PerfConfig,
  type PerfMetrics,
  type PerfPlatform,
  type PerfPost,
  type PerfRun,
} from "@/lib/perfTypes";
import { WINDOW_DAYS, WINDOW_LABEL, type TimeWindow } from "@/lib/socialTypes";

const fmt1 = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
// Engagement rates here sit well under 1%: at one decimal betterhomes' LinkedIn
// 0.04% and Facebook 0.01% both read "0%".
const fmt2 = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/** A snapshot with no posts is a scrape that returned nothing, not a page with 0 engagement. */
const noData = (r: PerfMetrics) => r.posts === 0;

const dayLabel = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

// Stable per-brand colour (betterhomes always coral; competitors from the palette).
const COMPETITOR_COLORS = [C.blue, C.sage, C.sand, C.dark, C.amber];
function useBrandColors(brands: string[], isUs: (b: string) => boolean) {
  return useMemo(() => {
    const map = new Map<string, string>();
    let ci = 0;
    for (const b of brands) map.set(b, isUs(b) ? C.coral : COMPETITOR_COLORS[ci++ % COMPETITOR_COLORS.length]);
    return map;
  }, [brands, isUs]);
}

const legendTop = { legend: { position: "top" as const, labels: { font: { size: 10 } } } };

export default function SocialPerformance({
  config,
  metrics,
  posts,
  runs,
}: {
  config: PerfConfig;
  metrics: PerfMetrics[];
  posts: PerfPost[];
  runs: PerfRun[];
}) {
  const router = useRouter();
  const last = runs[0];

  // platforms that already have data → default the selector to the first of those
  const platformsWithData = useMemo(() => new Set(metrics.map((m) => m.platform)), [metrics]);
  const [platform, setPlatform] = useState<PerfPlatform>(
    (PERF_PLATFORMS.find((p) => platformsWithData.has(p.key))?.key ?? "instagram") as PerfPlatform,
  );

  // editable config
  const [cfg, setCfg] = useState<PerfConfig>(config);
  const [savePending, startSave] = useTransition();
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [cfgOpen, setCfgOpen] = useState(metrics.length === 0);
  const [advOpen, setAdvOpen] = useState(false);

  // run variables
  const [window, setWindow] = useState<TimeWindow>(config.defaults.window);
  const [maxItems, setMaxItems] = useState<number>(config.defaults.maxItems);
  const [runPlatforms, setRunPlatforms] = useState<PerfPlatform[]>(PERF_PLATFORMS.map((p) => p.key));

  // streaming run
  const { running, logs, logRef, start } = useRunLog();

  // insights
  const [insights, setInsights] = useState<{ kind: string; label: string; text: string }[] | null>(null);
  const [insErr, setInsErr] = useState<string | null>(null);
  const [insLabel, setInsLabel] = useState<string>("");
  const [insPending, startInsights] = useTransition();

  const meta = PERF_PLATFORM_META[platform];

  // rows for the selected platform, betterhomes first then by reach
  const rows = useMemo(() => {
    return metrics
      .filter((m) => m.platform === platform)
      .sort((a, b) => (a.is_us === b.is_us ? b.total_plays - a.total_plays : a.is_us ? -1 : 1));
  }, [metrics, platform]);
  const me = rows.find((r) => r.is_us) ?? rows[0];
  const meNoData = !!me && noData(me);
  const isIg = platform === "instagram";
  const periodLabel = rows[0]?.period_label ?? WINDOW_LABEL[window];
  const brandColors = useBrandColors(rows.map((r) => r.brand), (b) => rows.find((r) => r.brand === b)?.is_us ?? false);

  // What this platform's scrapes actually return. A number no brand has (Instagram gives no plays, LinkedIn no
  // videos or plays, TikTok no comments) is left out of the cards, the table and the charts, rather than shown as
  // a row of dashes or noughts.
  const withPosts = rows.filter((r) => !noData(r));
  const has = {
    followers: rows.some((r) => (r.followers ?? 0) > 0),
    videos: withPosts.some((r) => r.reels > 0),
    likes: withPosts.some((r) => (r.avg_likes ?? 0) > 0),
    comments: withPosts.some((r) => (r.avg_comments ?? 0) > 0),
    plays: meta.hasPlays && withPosts.some((r) => (r.avg_plays ?? 0) > 0),
    engagement: withPosts.some((r) => (r.engagement_rate ?? 0) > 0),
  };
  const kpiCount = [has.followers, has.plays, has.plays, has.engagement].filter(Boolean).length;
  /** Bars that read cleanly: rounded, no wider than they need to be. */
  const bar = { borderRadius: 6, maxBarThickness: 56 };
  /** Light horizontal grid lines only. */
  const quietScales = { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: C.border } } };
  const reachWord = has.plays ? meta.playLabel.toLowerCase() : "likes and comments";

  // The window the snapshot covers, from the run that wrote it.
  const period = useMemo(() => {
    const end = rows.reduce<string | null>((max, r) => (r.captured_at && (!max || r.captured_at > max) ? r.captured_at : max), null);
    if (!end) return null;
    const days = WINDOW_DAYS[rows[0]?.time_window as TimeWindow] ?? WINDOW_DAYS.month;
    const endMs = Date.parse(end);
    return { startMs: endMs - days * 864e5, endMs };
  }, [rows]);

  /**
   * Each account's posts from its latest run: what the scraper returned last,
   * with likes and plays as of then. A post that has since dropped out of the
   * scrape keeps the counts of the last run that saw it, so it is left out.
   */
  const latestPosts = useMemo(() => {
    const runOf = new Map(rows.map((r) => [r.brand, r.run_id]));
    return posts.filter((p) => p.platform === platform && p.run_id != null && p.run_id === runOf.get(p.brand));
  }, [posts, platform, rows]);
  /**
   * How many recent posts Instagram gave the accounts in the latest run: its
   * feed returns only an account's most recent posts, whatever the run asks
   * for, so Instagram figures are labelled by that number, read from the data.
   */
  const igFeed = isIg ? Math.max(0, ...rows.map((r) => latestPosts.filter((p) => p.brand === r.brand).length)) : 0;
  const latestN = igFeed ? `latest ${igFeed}` : "latest";

  // Top posts from that window only: the all-time list put a 25 Jun post at the
  // top of a "Last month" view. LinkedIn has no play count, so it ranks by
  // likes + comments.
  const topPosts = useMemo(() => {
    if (!period) return [];
    // Ranked by plays where the platform gives them, else by likes and comments together.
    const reach = (p: PerfPost) => (has.plays && (p.plays ?? 0) > 0 ? (p.plays ?? 0) : p.likes + p.comments);
    return latestPosts
      .filter((p) => {
        const t = p.posted_at ? Date.parse(p.posted_at) : NaN;
        return t >= period.startMs && t <= period.endMs;
      })
      .sort((a, b) => reach(b) - reach(a))
      .slice(0, 4);
  }, [latestPosts, period, has.plays]);

  // best (max) / betterhomes-weak (min) per numeric column, for table
  // highlighting. Post-based columns only rank accounts that returned posts.
  const fromPosts = (key: keyof PerfMetrics) => key !== "followers";
  function colStats(key: keyof PerfMetrics) {
    const vals = rows.filter((r) => !(fromPosts(key) && noData(r))).map((r) => Number(r[key] ?? 0));
    return { max: Math.max(...vals), min: Math.min(...vals) };
  }
  function cellClass(key: keyof PerfMetrics, r: PerfMetrics): string {
    if (!rows.length || (fromPosts(key) && noData(r))) return "";
    const v = Number(r[key] ?? 0);
    const { max, min } = colStats(key);
    if (max !== min && v === max) return "win";
    if (r.is_us && max !== min && v === min) return "lose";
    return "";
  }

  function setActor(pf: PerfPlatform, actor: string) {
    setCfg((c) => ({ ...c, actors: { ...c.actors, [pf]: actor } }));
  }
  function setHandle(bi: number, pf: PerfPlatform, val: string) {
    setCfg((c) => {
      const brands = c.brands.map((b, i) => (i === bi ? { ...b, handles: { ...b.handles, [pf]: val } } : b));
      return { ...c, brands };
    });
  }
  function setBrandName(bi: number, name: string) {
    setCfg((c) => ({ ...c, brands: c.brands.map((b, i) => (i === bi ? { ...b, name } : b)) }));
  }
  function addBrand() {
    setCfg((c) => ({ ...c, brands: [...c.brands, { name: "", isUs: false, handles: {} }] }));
  }
  function removeBrand(bi: number) {
    setCfg((c) => ({ ...c, brands: c.brands.filter((_, i) => i !== bi) }));
  }

  function saveConfig() {
    setSaveMsg(null);
    startSave(async () => {
      const r = await savePerfConfigAction(cfg);
      setSaveMsg(r.ok ? "Saved." : r.error);
      if (r.ok) router.refresh();
    });
  }

  function toggleRunPlatform(pf: PerfPlatform) {
    setRunPlatforms((cur) => (cur.includes(pf) ? cur.filter((x) => x !== pf) : [...cur, pf]));
  }

  function run() {
    setCfgOpen(true);
    return start("/api/perf/stream", () => ({
      window,
      maxItems,
      platforms: runPlatforms,
      brands: cfg.brands.filter((b) => b.name.trim()),
    }));
  }

  function getInsights() {
    setInsErr(null);
    startInsights(async () => {
      // A thrown action (an expired session, a dropped connection) would
      // otherwise replace the whole tab with the error screen.
      try {
        const r = await receivePerfInsightsAction(platform);
        if (r.ok) {
          setInsights(r.insights);
          setInsLabel(r.label);
        } else {
          setInsErr(r.error);
          setInsights(null);
        }
      } catch (e) {
        setInsErr(errorMessage(e));
        setInsights(null);
      }
    });
  }


  return (
    <>
      {/* CONFIG + RUN — collapsible */}
      <div className="chart-card" style={{ marginBottom: 18 }}>
        <button className="ps-collapse-head" onClick={() => setCfgOpen((v) => !v)} aria-expanded={cfgOpen}>
          <span className="chart-title" style={{ margin: 0 }}>{cfgOpen ? "▾" : "▸"} Run the benchmark</span>
          <span className="ps-collapse-hint">
            {cfgOpen ? "configure & run below" : "click to configure & run"}
            {last ? ` · last run ${ago(last.ran_at)}` : ""}
          </span>
        </button>

        {cfgOpen && (
          <div style={{ marginTop: 12 }}>
            <div className="chart-sub">
              Reads each brand&apos;s public account through Apify and rebuilds the comparison: followers, posting volume and
              format, likes, comments, reach and engagement rate. Add competitor handles per platform in Advanced.
            </div>

            <div className="controls-bar" style={{ marginTop: 14, marginBottom: 0 }}>
              <div className="field">
                <label>Date window <HelpTip text="How far back to scrape each account. Posts older than this are dropped from the aggregates." /></label>
                <select className="ps-select" value={window} onChange={(e) => setWindow(e.target.value as TimeWindow)}>
                  {(Object.keys(WINDOW_LABEL) as TimeWindow[]).map((w) => (
                    <option key={w} value={w}>{WINDOW_LABEL[w]}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Items / account <HelpTip text="Max posts to pull per account per run. Higher = better averages but slower and more Apify credit." /></label>
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
                <label>Platforms <HelpTip text="Which networks to benchmark this run. Accounts without a handle for a platform are skipped." /></label>
                <div className="ps-platforms">
                  {PERF_PLATFORMS.map((pf) => (
                    <button
                      key={pf.key}
                      className={`filter-btn${runPlatforms.includes(pf.key) ? " active" : ""}`}
                      onClick={() => toggleRunPlatform(pf.key)}
                      title={pf.note}
                    >
                      {pf.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button className="ps-run" onClick={run} disabled={running || runPlatforms.length === 0}>
                  {running ? "Running…" : "▶ Run benchmark"}
                </button>
              </div>
            </div>

            {/* advanced — brands + handles + actors */}
            <button className="ps-adv-toggle" onClick={() => setAdvOpen((v) => !v)}>
              {advOpen ? "▾" : "▸"} Advanced — brands, handles &amp; Apify actors
            </button>
            {advOpen && (
              <div style={{ marginTop: 10 }}>
                <div className="perf-brand-editor">
                  {cfg.brands.map((b, bi) => (
                    <div key={bi} className="ps-adv-card">
                      <div className="ps-adv-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          className="perf-brand-name"
                          value={b.name}
                          placeholder="Brand name"
                          onChange={(e) => setBrandName(bi, e.target.value)}
                        />
                        {b.isUs ? <span className="perf-us-tag">us</span> : (
                          <button className="ps-chip-x" title="Remove brand" onClick={() => removeBrand(bi)}>×</button>
                        )}
                      </div>
                      {PERF_PLATFORMS.map((pf) => (
                        <label key={pf.key} className="ps-adv-field">
                          <span>{pf.name} {pf.key === "facebook" || pf.key === "linkedin" ? "URL / handle" : "@handle"}</span>
                          <input
                            value={b.handles[pf.key] ?? ""}
                            placeholder={pf.key === "instagram" || pf.key === "tiktok" ? "username" : "page url or slug"}
                            onChange={(e) => setHandle(bi, pf.key, e.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                <button className="filter-btn" style={{ marginTop: 10 }} onClick={addBrand}>+ Add competitor</button>

                <div className="ps-adv" style={{ marginTop: 14 }}>
                  {PERF_PLATFORMS.map((pf) => (
                    <div key={pf.key} className="ps-adv-card">
                      <div className="ps-adv-head">{pf.name} actor</div>
                      <label className="ps-adv-field">
                        <span>Apify actor id</span>
                        <input value={cfg.actors[pf.key]} onChange={(e) => setActor(pf.key, e.target.value)} />
                      </label>
                      <div className="ps-adv-note">{pf.hasPlays ? `Reach proxy: ${pf.playLabel.toLowerCase()}` : "No public reach figure"}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="ps-save-row">
              <button className="filter-btn" onClick={saveConfig} disabled={savePending}>
                {savePending ? "Saving…" : "Save brands & sources"}
              </button>
              <HelpTip text="Saves the benchmarked brands, their per-platform handles, and the Apify actor ids to the database so they persist across runs and reloads." />
              {saveMsg && <span className="ps-save-msg">{saveMsg}</span>}
            </div>
          </div>
        )}
      </div>

      {/* run log */}
      <RunLog running={running} logs={logs} logRef={logRef} />

      {/* platform selector */}
      <div className="ps-platforms" style={{ marginBottom: 16 }}>
        {PERF_PLATFORMS.map((pf) => (
          <button
            key={pf.key}
            className={`filter-btn${platform === pf.key ? " active" : ""}`}
            onClick={() => setPlatform(pf.key)}
          >
            {pf.name}
            {!platformsWithData.has(pf.key) && <span style={{ opacity: 0.5, marginLeft: 4 }}>· no data</span>}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: 160 }}>
            No {meta.name} benchmark yet.<br />
            Add each brand&apos;s {meta.name} handle in <strong>Advanced</strong> and click <strong>Run benchmark</strong>.
            <br /><br />
            <span className="muted">Requires APIFY_TOKEN in the deployment environment.</span>
          </div>
        </div>
      ) : (
        <>
          <div className="chart-sub" style={{ marginTop: -4, marginBottom: 14 }}>
            {meta.name} ·{" "}
            {isIg
              ? `each account's ${latestN} posts, counting those from ${periodLabel.toLowerCase()}`
              : periodLabel}
            {period ? ` to ${dayLabel(new Date(period.endMs).toISOString())}` : ""}{" "}
            · {rows.length} brands
          </div>
          {isIg && (
            <div style={{ fontSize: 11.5, color: C.mid, margin: "-8px 0 14px", lineHeight: 1.5 }}>
              Instagram only returns an account&apos;s {igFeed ? `${igFeed} ` : ""}most recent posts, so Posts counts how many of those
              fall in the window, and averages and reach cover those posts only. For an account that posts often that is a
              few days rather than a month, so compare the averages, not the totals.
            </div>
          )}

          {/* KPI strip — betterhomes at a glance */}
          <div className="kpi-strip" style={{ gridTemplateColumns: `repeat(${Math.max(1, kpiCount)},1fr)` }}>
            {has.followers && (
            <div className="kpi-card">
              <div className="kpi-label">Followers</div>
              <div className="kpi-value">{fmt(me?.followers)}</div>
              <div className="kpi-change">betterhomes on {meta.name}</div>
            </div>
            )}
            {has.plays && (
            <div className="kpi-card">
              <div className="kpi-label">Avg {meta.playLabel.toLowerCase()} <HelpTip text={`Average ${meta.playLabel.toLowerCase()} per video post — the closest public proxy for reach beyond followers.`} /></div>
              <div className="kpi-value">{meNoData ? "No posts" : fmt(me?.avg_plays)}</div>
              <div className="kpi-change">per {meta.videoLabel.toLowerCase().replace(/s$/, "")}</div>
            </div>
            )}
            {has.plays && (
            <div className="kpi-card">
              <div className="kpi-label">Total reach <HelpTip text={`Sum of ${meta.playLabel.toLowerCase()} across ${isIg ? `the ${latestN} posts Instagram returned` : "all video posts this period"}.`} /></div>
              <div className="kpi-value">{meNoData ? "No posts" : fmt(me?.total_plays)}</div>
              <div className="kpi-change">
                {meNoData ? "No posts came back" : `${me?.reels ?? 0} ${meta.videoLabel.toLowerCase()}${isIg ? ` in its ${latestN} posts` : ""}`}
              </div>
            </div>
            )}
            {has.engagement && (
            <div className="kpi-card">
              <div className="kpi-label">Engagement rate <HelpTip text="(avg likes + avg comments) ÷ followers, per post. How efficiently the audience is converted to interaction." /></div>
              <div className="kpi-value" style={{ color: C.blue }}>
                {meNoData ? "No posts" : me?.engagement_rate == null ? "n/a" : `${fmt2(me.engagement_rate)}%`}
              </div>
              <div className="kpi-change">per post</div>
            </div>
            )}
          </div>

          {/* snapshot table */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-title">
              All brands
              <HelpTip text="Green = best in that column. Red = betterhomes' weak spot (lowest in the column). betterhomes' row is highlighted." />
            </div>
            <div className="chart-sub">Every brand&apos;s {meta.name} performance this period</div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Brand</th>
                    {has.followers && <th>Followers</th>}
                    <th>{isIg ? `Posts (of ${latestN})` : "Posts"}</th>
                    {has.videos && <th>{meta.videoLabel}</th>}
                    {has.likes && <th>Avg likes</th>}
                    {has.comments && <th>Avg comments</th>}
                    {has.plays && <th>Avg {meta.playLabel.toLowerCase()}</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.brand} className={r.is_us ? "bh" : ""}>
                      <td>{r.brand}</td>
                      {has.followers && <td className={cellClass("followers", r)}>{r.followers ? fmt(r.followers) : <span className="muted">Not found</span>}</td>}
                      <td className={cellClass("posts", r)} title={noData(r) ? "The scraper returned no posts for this account in this run." : undefined}>
                        {noData(r) ? <span className="muted">No posts</span> : r.posts}
                      </td>
                      {has.videos && <td className={cellClass("reels", r)}>{noData(r) ? "" : r.reels}</td>}
                      {has.likes && <td className={cellClass("avg_likes", r)}>{noData(r) ? "" : fmt1(r.avg_likes)}</td>}
                      {has.comments && <td className={cellClass("avg_comments", r)}>{noData(r) ? "" : fmt1(r.avg_comments)}</td>}
                      {has.plays && <td className={cellClass("avg_plays", r)}>{noData(r) ? "" : fmt(r.avg_plays)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* charts */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">{has.videos ? "Posting volume and format mix" : "Posting volume"}</div>
              <div className="chart-sub">{has.videos ? `${meta.videoLabel} and static posts per brand` : "Posts per brand"}</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: rows.map((r) => r.brand),
                    datasets: has.videos
                      ? [
                          { label: meta.videoLabel, data: rows.map((r) => (noData(r) ? null : r.reels)), backgroundColor: C.dark, stack: "s", maxBarThickness: 56 },
                          { label: "Static", data: rows.map((r) => (noData(r) ? null : r.images)), backgroundColor: C.sand, stack: "s", maxBarThickness: 56 },
                        ]
                      : [{ label: "Posts", data: rows.map((r) => (noData(r) ? null : r.posts)), backgroundColor: rows.map((r) => brandColors.get(r.brand) ?? C.blue), ...bar }],
                  }}
                  options={{
                    plugins: has.videos ? legendTop : { legend: { display: false } },
                    scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: C.border } } },
                  }}
                />
              </div>
            </div>

            {has.plays && (
              <div className="chart-card">
                <div className="chart-title">Average {meta.playLabel.toLowerCase()}</div>
                <div className="chart-sub">How far each brand&apos;s videos reach</div>
                <div className="chart-canvas-wrap">
                  <ChartBox
                    type="bar"
                    data={{
                      labels: rows.map((r) => r.brand),
                      datasets: [{ label: `Avg ${meta.playLabel.toLowerCase()}`, data: rows.map((r) => (noData(r) ? null : (r.avg_plays ?? 0))), backgroundColor: rows.map((r) => brandColors.get(r.brand) ?? C.blue), ...bar }],
                    }}
                    options={{ plugins: { legend: { display: false } }, scales: quietScales }}
                  />
                </div>
              </div>
            )}

            {(has.likes || has.comments) && (
            <div className="chart-card">
              <div className="chart-title">{has.likes && has.comments ? "Average likes and comments" : has.likes ? "Average likes" : "Average comments"}</div>
              <div className="chart-sub">Per post</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: rows.map((r) => r.brand),
                    datasets: [
                      ...(has.likes ? [{ label: "Avg likes", data: rows.map((r) => (noData(r) ? null : r.avg_likes)), backgroundColor: C.blue, ...bar }] : []),
                      ...(has.comments ? [{ label: "Avg comments", data: rows.map((r) => (noData(r) ? null : r.avg_comments)), backgroundColor: C.sand, ...bar }] : []),
                    ],
                  }}
                  options={{ plugins: has.likes && has.comments ? legendTop : { legend: { display: false } }, scales: quietScales }}
                />
              </div>
            </div>
            )}

            {has.engagement && (
            <div className="chart-card">
              <div className="chart-title">Engagement rate</div>
              <div className="chart-sub">(likes + comments) ÷ followers, per post</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: rows.map((r) => r.brand),
                    datasets: [{ label: "Engagement rate %", data: rows.map((r) => (noData(r) ? null : (r.engagement_rate ?? 0))), backgroundColor: rows.map((r) => brandColors.get(r.brand) ?? C.blue), ...bar }],
                  }}
                  options={{ plugins: { legend: { display: false } }, scales: quietScales }}
                />
              </div>
            </div>
            )}
          </div>

          {/* top posts */}
          {topPosts.length > 0 && (
            <div className="chart-card" style={{ marginTop: 4, marginBottom: 20 }}>
              <div className="chart-title">Top-performing posts</div>
              <div className="chart-sub">
                {meta.name} posts with the most {reachWord}, across all brands
                {period ? `, posted ${dayLabel(new Date(period.startMs).toISOString())} – ${dayLabel(new Date(period.endMs).toISOString())}` : ""}
              </div>
              <div className="perf-tops">
                {topPosts.map((p) => (
                  <div key={p.id} className="perf-top-card" style={{ borderLeftColor: brandColors.get(p.brand) ?? C.sand }}>
                    {/* Each number on its own, never added together: plays where the platform gives them, then likes and comments. */}
                    <div style={{ display: "flex", gap: 18, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 6 }}>
                      {has.plays && (p.plays ?? 0) > 0 && (
                        <div>
                          <div className="perf-top-big">{fmt(p.plays)}</div>
                          <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>{meta.playLabel.toLowerCase()}</div>
                        </div>
                      )}
                      <div>
                        <div className="perf-top-big">{fmt(p.likes)}</div>
                        <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>likes</div>
                      </div>
                      {has.comments && (
                        <div>
                          <div className="perf-top-big">{fmt(p.comments)}</div>
                          <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>comments</div>
                        </div>
                      )}
                    </div>
                    <div className="perf-top-brand">
                      {p.brand} · {p.type}{p.posted_at ? ` · ${p.posted_at.slice(0, 10)}` : ""}
                    </div>
                    <div className="perf-top-cap">{p.caption ? p.caption.slice(0, 120) : <span className="muted">No caption</span>}</div>
                    <div className="perf-top-foot">
                      {p.shares ? `${fmt(p.shares)} shares` : ""}
                      {p.url && (
                        <>
                          {p.shares ? " · " : ""}
                          <a className="link-btn" href={p.url} target="_blank" rel="noopener noreferrer">Open</a>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI insights */}
          <div className="insights-panel">
            <div className="insights-head">
              <div>
                <div className="insights-title">What betterhomes should take from this</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 4 }}>
                  AI takeaways from the {meta.name} benchmark{insLabel ? ` · ${insLabel}` : ""}
                </div>
              </div>
              <button className="filter-btn" onClick={getInsights} disabled={insPending}>
                {insPending ? "Analysing…" : insights ? "Refresh" : "Receive insights"}
              </button>
            </div>
            {insErr && <div className="insights-err">{insErr}</div>}
            {!insights && !insErr && !insPending && (
              <div style={{ color: "rgba(255,255,255,.45)", fontSize: 13, padding: "12px 0 4px" }}>
                Click &ldquo;Receive insights&rdquo; for AI recommendations comparing betterhomes to the competitors above.
              </div>
            )}
            {insPending && <div style={{ color: "rgba(255,255,255,.55)", fontSize: 13, padding: "12px 0 4px" }}>Asking Gemini to analyse the {meta.name} benchmark…</div>}
            {insights && (
              <div className="insights-grid">
                {insights.map((ins, i) => (
                  <div key={i} className="insight-card" style={{ borderLeftColor: ins.kind === "high" ? C.red : ins.kind === "win" ? C.green : C.amber }}>
                    <div className="i-type">{ins.label}</div>
                    <div className="i-text">{ins.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
