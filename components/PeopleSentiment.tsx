"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveSocialConfigAction } from "@/app/actions";
import { PlatformIcon, SubjectIcon } from "@/components/PlatformIcon";
import { C } from "@/lib/theme";
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

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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
function netScore(items: SocialMention[]): number | null {
  const scored = items.filter((m) => typeof m.sentiment_score === "number");
  if (!scored.length) return null;
  return scored.reduce((a, m) => a + (m.sentiment_score as number), 0) / scored.length;
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
}: {
  config: SocialConfig;
  mentions: SocialMention[];
  runs: SocialRun[];
}) {
  const router = useRouter();
  const last = runs[0];

  // ── editable config (subjects + per-platform sources) ──────────
  const [cfg, setCfg] = useState<SocialConfig>(config);
  const [savePending, startSave] = useTransition();
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [advOpen, setAdvOpen] = useState(false);

  // ── per-run variables ──────────────────────────────────────────
  const [window, setWindow] = useState<TimeWindow>(config.defaults.window);
  const [maxItems, setMaxItems] = useState<number>(config.defaults.maxItems);

  // ── run streaming state ─────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // ── results filters ─────────────────────────────────────────────
  const [subjFilter, setSubjFilter] = useState<string>("all");
  const [chanFilter, setChanFilter] = useState<string>("all");

  const company = cfg.subjects.find((s) => s.kind === "company");
  const enabledChannels = (Object.keys(cfg.platforms) as SocialChannel[]).filter((c) => cfg.platforms[c].enabled);

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

  async function run() {
    setRunning(true);
    setLogs([]);
    try {
      const res = await fetch("/api/social/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          window,
          maxItems,
          channels: enabledChannels,
          subjects: cfg.subjects.filter((s) => s.name.trim()),
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

  // ── aggregates ──────────────────────────────────────────────────
  const overall = useMemo(() => sentCounts(mentions), [mentions]);
  const overallNet = useMemo(() => netScore(mentions), [mentions]);
  const channelsWithData = useMemo(() => new Set(mentions.map((m) => m.channel)).size, [mentions]);

  const bySubject = useMemo(() => {
    const order = cfg.subjects.map((s) => s.name);
    const map = new Map<string, SocialMention[]>();
    for (const m of mentions) {
      const arr = map.get(m.subject) ?? [];
      arr.push(m);
      map.set(m.subject, arr);
    }
    return [...map.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [mentions, cfg.subjects]);

  const feed = useMemo(() => {
    return mentions.filter((m) => {
      if (subjFilter !== "all" && m.subject !== subjFilter) return false;
      if (chanFilter !== "all" && m.channel !== chanFilter) return false;
      return true;
    });
  }, [mentions, subjFilter, chanFilter]);

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">People &amp; Brand Sentiment</div>
          <div className="page-sub">
            What the internet says about betterhomes and its people — Instagram · LinkedIn · Reddit · Glassdoor · Facebook, scored by AI.
          </div>
        </div>
        <span className={mentions.length ? "verified-badge" : "pending-badge"}>
          {mentions.length ? `🤖 ${mentions.length} mentions stored` : "⏳ No data yet — run the bot"}
        </span>
      </div>

      {/* CONFIG + RUN */}
      <div className="chart-card" style={{ marginBottom: 18 }}>
        <div className="chart-title">Run the sentiment bot</div>
        <div className="chart-sub">
          Pick the window and depth, then run. Scraping is via Apify; tone is scored by Gemini on a fixed −1…+1 rubric so months compare fairly.
        </div>

        {/* subjects */}
        <div className="ps-cfg-row" style={{ marginTop: 12 }}>
          <div className="ps-cfg-label">Tracking</div>
          <div className="ps-chips">
            <span className="ps-chip ps-chip-company"><SubjectIcon kind="company" size={15} /> {company?.name ?? "betterhomes"}</span>
            {cfg.subjects.map((s, idx) =>
              s.kind !== "person" ? null : (
                <span key={idx} className="ps-chip">
                  <SubjectIcon kind="person" size={15} />
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
            <label>Date window</label>
            <select className="ps-select" value={window} onChange={(e) => setWindow(e.target.value as TimeWindow)}>
              {(Object.keys(WINDOW_LABEL) as TimeWindow[]).map((w) => (
                <option key={w} value={w}>{WINDOW_LABEL[w]}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Items / platform</label>
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
            <label>Platforms</label>
            <div className="ps-platforms">
              {CHANNELS.map((c) => (
                <button
                  key={c.key}
                  className={`filter-btn${cfg.platforms[c.key].enabled ? " active" : ""}`}
                  onClick={() => setPlatform(c.key, "enabled", !cfg.platforms[c.key].enabled)}
                  title={c.note}
                >
                  <PlatformIcon channel={c.key} size={14} /> {c.name}
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
          {advOpen ? "▾" : "▸"} Advanced — sources &amp; handles (actor IDs, IG handle, Glassdoor/Facebook URLs)
        </button>
        {advOpen && (
          <div className="ps-adv">
            {CHANNELS.map((c) => {
              const pc = cfg.platforms[c.key];
              return (
                <div key={c.key} className="ps-adv-card">
                  <div className="ps-adv-head"><PlatformIcon channel={c.key} size={15} /> {c.name}</div>
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
          <button className="filter-btn" onClick={saveConfig} disabled={savePending}>
            {savePending ? "Saving…" : "Save subjects & sources"}
          </button>
          {saveMsg && <span className="ps-save-msg">{saveMsg}</span>}
          <span className="ps-status">
            {last
              ? `Last run ${ago(last.ran_at)} · ${last.inserted} kept · ${last.skipped} filtered${last.ok ? "" : " · ⚠️ error"}`
              : "Bot hasn't run yet"}
          </span>
        </div>

        {(running || logs.length > 0) && (
          <div className="bot-log-wrap" style={{ marginTop: 12, borderRadius: 10, border: "1px solid var(--border)" }}>
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
      </div>

      {mentions.length === 0 ? (
        <div className="chart-card">
          <div className="empty-state" style={{ height: 140 }}>
            No sentiment data stored yet.<br />
            Set your platforms above and click <strong>Run sentiment bot</strong> — results appear here once it finishes.
            <br /><br />
            <span className="muted">Requires APIFY_TOKEN and GEMINI_API_KEY in the deployment environment.</span>
          </div>
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
            <div className="kpi-card">
              <div className="kpi-label">Total mentions</div>
              <div className="kpi-value">{overall.total}</div>
              <div className="kpi-change">{overall.total - overall.none} tone-scored</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Net sentiment</div>
              <div className="kpi-value" style={{ color: scoreColor(overallNet) }}>
                {overallNet == null ? "—" : `${overallNet > 0 ? "+" : ""}${Math.round(overallNet * 100)}`}
              </div>
              <div className="kpi-change">−100 … +100 on fixed rubric</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Negative flags</div>
              <div className="kpi-value" style={{ color: overall.negative ? C.red : undefined }}>{overall.negative}</div>
              <div className="kpi-change">posts needing attention</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Platforms with data</div>
              <div className="kpi-value">{channelsWithData}</div>
              <div className="kpi-change">of {CHANNELS.length} tracked</div>
            </div>
          </div>

          {/* per-subject */}
          <div className="chart-title" style={{ marginBottom: 10 }}>By subject</div>
          <div className="ps-subjects">
            {bySubject.map(([name, items]) => {
              const c = sentCounts(items);
              const net = netScore(items);
              const subj = cfg.subjects.find((s) => s.name === name);
              const chans = new Map<string, number>();
              for (const m of items) chans.set(m.channel, (chans.get(m.channel) ?? 0) + 1);
              return (
                <div key={name} className="chart-card ps-subject-card">
                  <div className="ps-subject-head">
                    <span><SubjectIcon kind={subj?.kind === "person" ? "person" : "company"} size={16} /> {name}</span>
                    <span className="ps-net" style={{ color: scoreColor(net) }}>
                      {net == null ? "—" : `${net > 0 ? "+" : ""}${Math.round(net * 100)}`}
                    </span>
                  </div>
                  <div className="ps-subject-sub">{c.total} mentions · {c.total - c.none} scored</div>
                  <SentBar c={c} />
                  <div className="ps-chan-chips">
                    {[...chans.entries()].map(([ch, n]) => (
                      <span key={ch} className="ps-chan-chip">
                        <PlatformIcon channel={ch} size={13} /> {n}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* feed */}
          <div className="chart-card" style={{ marginTop: 20 }}>
            <div className="chart-title">Mentions feed</div>
            <div className="table-controls" style={{ marginTop: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className={`filter-btn${subjFilter === "all" ? " active" : ""}`} onClick={() => setSubjFilter("all")}>All subjects</button>
                {cfg.subjects.map((s) => (
                  <button key={s.name} className={`filter-btn${subjFilter === s.name ? " active" : ""}`} onClick={() => setSubjFilter(s.name)}>
                    <SubjectIcon kind={s.kind} size={13} /> {s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="table-controls" style={{ marginTop: 0 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className={`filter-btn${chanFilter === "all" ? " active" : ""}`} onClick={() => setChanFilter("all")}>All platforms</button>
                {CHANNELS.map((c) => (
                  <button key={c.key} className={`filter-btn${chanFilter === c.key ? " active" : ""}`} onClick={() => setChanFilter(c.key)}>
                    <PlatformIcon channel={c.key} size={14} /> {c.name}
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
                        <td>{m.posted_at ? m.posted_at.slice(0, 10) : "—"}</td>
                        <td><PlatformIcon channel={m.channel} size={14} /> {CHANNEL_META[m.channel as SocialChannel]?.name ?? m.channel}</td>
                        <td><SubjectIcon kind={m.subject_kind} size={14} /> {m.subject}</td>
                        <td>{m.author ?? "—"}</td>
                        <td title={m.sentiment_reason ?? undefined}>
                          {(m.content ?? "").slice(0, 180)}{(m.content ?? "").length > 180 ? "…" : ""}
                        </td>
                        <td>{m.sentiment ? <span className={`sent-badge sent-${m.sentiment}`}>{m.sentiment}</span> : <span className="muted">—</span>}</td>
                        <td>{m.url ? <a className="link-btn" href={m.url} target="_blank" rel="noopener noreferrer">↗</a> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.mid, marginTop: 8 }}>
              {feed.length} shown{feed.length > 150 ? " (first 150)" : ""} · {mentions.length} kept total ·
              {" "}<span className="muted">Each row is a real scraped post/review; tone is AI-assigned. Hover a row for the AI&apos;s reason.</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
