"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ChartBox from "@/components/Chart";
import HelpTip from "@/components/HelpTip";
import { PlatformIcon } from "@/components/PlatformIcon";
import { receivePerfInsightsAction, savePerfConfigAction } from "@/app/actions";
import { C } from "@/lib/theme";
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

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US").format(Math.round(n));
const fmt1 = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
// Engagement rates here sit well under 1%: at one decimal betterhomes' LinkedIn
// 0.04% and Facebook 0.01% both read "0%".
const fmt2 = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/**
 * Instagram's profile feed returns an account's 12 most recent posts, whatever
 * the run asks for: on 19 Oct 2026 every rival came back with exactly 12, and
 * betterhomes with 9 from 12–16 Oct while it had posted 24 in the month. So
 * Instagram figures are labelled as what they are, not as a month.
 */
const IG_FEED_POSTS = 12;

/** A snapshot with no posts is a scrape that returned nothing, not a page with 0 engagement. */
const noData = (r: PerfMetrics) => r.posts === 0;

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTH_ABBR[Number(iso.slice(5, 7)) - 1]}`;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

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

  // The window the snapshot covers, from the run that wrote it.
  const period = useMemo(() => {
    const end = rows.reduce<string | null>((max, r) => (r.captured_at && (!max || r.captured_at > max) ? r.captured_at : max), null);
    if (!end) return null;
    const days = WINDOW_DAYS[rows[0]?.time_window as TimeWindow] ?? WINDOW_DAYS.month;
    const endMs = Date.parse(end);
    return { startMs: endMs - days * 864e5, endMs };
  }, [rows]);

  // Top posts from that window only: the all-time list put a 25 Jun post at the
  // top of a "Last month" view. LinkedIn has no play count, so it ranks by
  // likes + comments.
  const topPosts = useMemo(() => {
    if (!period) return [];
    const reach = (p: PerfPost) => (meta.hasPlays ? (p.plays ?? 0) : p.likes + p.comments);
    return posts
      .filter((p) => {
        const t = p.posted_at ? Date.parse(p.posted_at) : NaN;
        return p.platform === platform && t >= period.startMs && t <= period.endMs;
      })
      .sort((a, b) => reach(b) - reach(a))
      .slice(0, 4);
  }, [posts, platform, period, meta.hasPlays]);

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

  async function run() {
    setRunning(true);
    setCfgOpen(true);
    setLogs([]);
    try {
      const res = await fetch("/api/perf/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          window,
          maxItems,
          platforms: runPlatforms,
          brands: cfg.brands.filter((b) => b.name.trim()),
        }),
      });
      if (!res.body) throw new Error("No stream body returned");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const msg = JSON.parse(line.slice(6)) as string;
                setLogs((prev) => {
                  const next = [...prev, msg].slice(-300);
                  requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
                  return next;
                });
              } catch {}
            }
          }
        }
      }
    } catch (e) {
      setLogs((prev) => [...prev, `ERROR: ${String(e)}`]);
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  function getInsights() {
    setInsErr(null);
    startInsights(async () => {
      const r = await receivePerfInsightsAction(platform);
      if (r.ok) {
        setInsights(r.insights);
        setInsLabel(r.label);
      } else {
        setInsErr(r.error);
        setInsights(null);
      }
    });
  }

  const seeded = rows.some((r) => r.source === "seed");

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
              Scrapes each brand&apos;s public account via Apify and rebuilds the comparison — followers, posting volume &amp; format mix,
              likes, comments, reach and engagement rate. Add competitor handles per platform in Advanced.
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
                      <PlatformIcon channel={pf.key} size={14} /> {pf.name}
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
                      <div className="ps-adv-head"><PlatformIcon channel={pf.key} size={15} /> {pf.name} actor</div>
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
      {(running || logs.length > 0) && (
        <div className="bot-log-wrap" style={{ marginBottom: 18, borderRadius: 10, border: "1px solid var(--border)" }}>
          <div ref={logRef} className="bot-log">
            {logs.map((line, i) => {
              const isHeader = line.startsWith("─") || line.startsWith("Starting") || line.startsWith("Done");
              const isKept = line.includes("✓");
              const isRejected = line.includes("✗") || line.includes("ERROR") || line.includes("failed");
              const isStep = line.startsWith("▶");
              return (
                <div
                  key={i}
                  className={
                    "bot-log-line" +
                    (isHeader ? " bot-log-header" : "") +
                    (isKept ? " bot-log-kept" : "") +
                    (isRejected ? " bot-log-rejected" : "") +
                    (isStep ? " bot-log-step" : "")
                  }
                >
                  {line}
                </div>
              );
            })}
            {running && <div className="bot-log-cursor">▌</div>}
          </div>
        </div>
      )}

      {/* platform selector */}
      <div className="ps-platforms" style={{ marginBottom: 16 }}>
        {PERF_PLATFORMS.map((pf) => (
          <button
            key={pf.key}
            className={`filter-btn${platform === pf.key ? " active" : ""}`}
            onClick={() => setPlatform(pf.key)}
          >
            <PlatformIcon channel={pf.key} size={14} /> {pf.name}
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
              ? `each account's latest ${IG_FEED_POSTS} posts, counting those from ${periodLabel.toLowerCase()}`
              : periodLabel}{" "}
            · {rows.length} brands
            {seeded && <span className="perf-seed-tag" title="Seeded from the shared report — run the benchmark to refresh with live data.">seed data</span>}
          </div>
          {isIg && (
            <div style={{ fontSize: 11.5, color: C.mid, margin: "-8px 0 14px", lineHeight: 1.5 }}>
              Instagram only returns an account&apos;s {IG_FEED_POSTS} most recent posts, so Posts counts how many of those
              fall in the window, and averages and reach cover those posts only. For an account that posts often that is a
              few days rather than a month, so compare the averages, not the totals.
            </div>
          )}

          {/* KPI strip — betterhomes at a glance */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">Followers</div>
              <div className="kpi-value">{fmt(me?.followers)}</div>
              <div className="kpi-change">betterhomes on {meta.name}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Avg {meta.playLabel.toLowerCase()} <HelpTip text={`Average ${meta.playLabel.toLowerCase()} per video post — the closest public proxy for reach beyond followers.`} /></div>
              <div className="kpi-value">{meNoData ? "no data" : meta.hasPlays ? fmt(me?.avg_plays) : "—"}</div>
              <div className="kpi-change">per {meta.videoLabel.toLowerCase().replace(/s$/, "")}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Total reach <HelpTip text={`Sum of ${meta.playLabel.toLowerCase()} across ${isIg ? `the latest ${IG_FEED_POSTS} posts Instagram returned` : "all video posts this period"}.`} /></div>
              <div className="kpi-value">{meNoData ? "no data" : meta.hasPlays ? fmt(me?.total_plays) : "—"}</div>
              <div className="kpi-change">
                {meNoData ? "no posts returned" : `${me?.reels ?? 0} ${meta.videoLabel.toLowerCase()}${isIg ? ` in its latest ${IG_FEED_POSTS} posts` : ""}`}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Engagement rate <HelpTip text="(avg likes + avg comments) ÷ followers, per post. How efficiently the audience is converted to interaction." /></div>
              <div className="kpi-value" style={{ color: C.blue }}>
                {meNoData ? "no data" : me?.engagement_rate == null ? "—" : `${fmt2(me.engagement_rate)}%`}
              </div>
              <div className="kpi-change">per post</div>
            </div>
          </div>

          {/* snapshot table */}
          <div className="chart-card" style={{ marginBottom: 20 }}>
            <div className="chart-title">
              Snapshot — all brands
              <HelpTip text="Green = best in that column. Red = betterhomes' weak spot (lowest in the column). betterhomes' row is highlighted." />
            </div>
            <div className="chart-sub">Every brand&apos;s {meta.name} performance this period</div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Brand</th><th>Followers</th><th>{isIg ? `Posts (of latest ${IG_FEED_POSTS})` : "Posts"}</th><th>{meta.videoLabel}</th>
                    <th>Avg likes</th><th>Avg comments</th><th>Avg {meta.playLabel.toLowerCase()}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.brand} className={r.is_us ? "bh" : ""}>
                      <td>{r.brand}</td>
                      <td className={cellClass("followers", r)}>{fmt(r.followers)}</td>
                      <td className={cellClass("posts", r)} title={noData(r) ? "The scraper returned no posts for this account in this run." : undefined}>
                        {noData(r) ? "no data" : r.posts}
                      </td>
                      <td className={cellClass("reels", r)}>{noData(r) ? "—" : r.reels}</td>
                      <td className={cellClass("avg_likes", r)}>{noData(r) ? "—" : fmt1(r.avg_likes)}</td>
                      <td className={cellClass("avg_comments", r)}>{noData(r) ? "—" : fmt1(r.avg_comments)}</td>
                      <td className={meta.hasPlays ? cellClass("avg_plays", r) : ""}>{meta.hasPlays && !noData(r) ? fmt(r.avg_plays) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* charts */}
          <div className="charts-grid-2">
            <div className="chart-card">
              <div className="chart-title">Posting volume &amp; format mix</div>
              <div className="chart-sub">{meta.videoLabel} vs static per brand — format, not volume, drives reach</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: rows.map((r) => r.brand),
                    datasets: [
                      { label: meta.videoLabel, data: rows.map((r) => (noData(r) ? null : r.reels)), backgroundColor: C.dark, stack: "s" },
                      { label: "Static", data: rows.map((r) => (noData(r) ? null : r.images)), backgroundColor: C.sand, stack: "s" },
                    ],
                  }}
                  options={{ plugins: legendTop, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }}
                />
              </div>
            </div>

            {meta.hasPlays && (
              <div className="chart-card">
                <div className="chart-title">Avg {meta.playLabel.toLowerCase()} — reach proxy</div>
                <div className="chart-sub">The headline competitive gap</div>
                <div className="chart-canvas-wrap">
                  <ChartBox
                    type="bar"
                    data={{
                      labels: rows.map((r) => r.brand),
                      datasets: [{ label: `Avg ${meta.playLabel.toLowerCase()}`, data: rows.map((r) => (noData(r) ? null : (r.avg_plays ?? 0))), backgroundColor: rows.map((r) => brandColors.get(r.brand) ?? C.blue), borderRadius: 5 }],
                    }}
                    options={{ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }}
                  />
                </div>
              </div>
            )}

            <div className="chart-card">
              <div className="chart-title">Avg likes &amp; comments</div>
              <div className="chart-sub">Engagement volume per post</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: rows.map((r) => r.brand),
                    datasets: [
                      { label: "Avg likes", data: rows.map((r) => (noData(r) ? null : r.avg_likes)), backgroundColor: C.blue, borderRadius: 4 },
                      { label: "Avg comments", data: rows.map((r) => (noData(r) ? null : r.avg_comments)), backgroundColor: C.sand, borderRadius: 4 },
                    ],
                  }}
                  options={{ plugins: legendTop, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }}
                />
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-title">Engagement rate</div>
              <div className="chart-sub">(likes + comments) ÷ followers, per post</div>
              <div className="chart-canvas-wrap">
                <ChartBox
                  type="bar"
                  data={{
                    labels: rows.map((r) => r.brand),
                    datasets: [{ label: "Engagement rate %", data: rows.map((r) => (noData(r) ? null : (r.engagement_rate ?? 0))), backgroundColor: rows.map((r) => brandColors.get(r.brand) ?? C.blue), borderRadius: 5 }],
                  }}
                  options={{ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }}
                />
              </div>
            </div>
          </div>

          {/* top posts */}
          {topPosts.length > 0 && (
            <div className="chart-card" style={{ marginTop: 4, marginBottom: 20 }}>
              <div className="chart-title">Top-performing posts</div>
              <div className="chart-sub">
                Widest-reaching {meta.name} posts across all brands
                {period ? `, posted ${dayLabel(new Date(period.startMs).toISOString())} – ${dayLabel(new Date(period.endMs).toISOString())}` : ""}
              </div>
              <div className="perf-tops">
                {topPosts.map((p) => (
                  <div key={p.id} className="perf-top-card" style={{ borderLeftColor: brandColors.get(p.brand) ?? C.sand }}>
                    <div className="perf-top-big">{meta.hasPlays ? fmt(p.plays) : fmt(p.likes + p.comments)}</div>
                    <div className="perf-top-brand">
                      {p.brand}{p.is_us ? " ★" : ""} · {p.type}{p.posted_at ? ` · ${p.posted_at.slice(0, 10)}` : ""}
                    </div>
                    <div className="perf-top-cap">{p.caption ? p.caption.slice(0, 120) : "—"}</div>
                    <div className="perf-top-foot">
                      {fmt(p.likes)} likes · {fmt(p.comments)} comments{p.shares ? ` · ${fmt(p.shares)} shares` : ""}
                      {p.url && <a className="link-btn" href={p.url} target="_blank" rel="noopener noreferrer"> ↗</a>}
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
                {insPending ? "Analysing…" : insights ? "↻ Refresh" : "Receive insights"}
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
