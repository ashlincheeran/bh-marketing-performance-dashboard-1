"use client";

import { useEffect, useMemo, useState } from "react";
import { C } from "@/lib/theme";
import type { SeoReport } from "@/lib/seoReport";
import type { LeadsData } from "@/lib/metabase";

/**
 * SEO & AI Channel report.
 *
 * Measured in PEOPLE, not sessions. The AI channel is a small number of humans
 * arriving from assistants, and sessions overstate it — 1,415 sessions came
 * from 1,227 people in the month this was built against. Every headline here is
 * unique visitors, with sessions and pageviews shown beside them so the ratios
 * stay visible rather than being folded away.
 *
 * Month-on-month throughout, because that is how the channel is read: the story
 * is organic declining while AI climbs, and a single month's figure cannot show
 * it. Deltas compare like with like — the same calendar month, one year's
 * worth of history behind them.
 */

const nf = new Intl.NumberFormat("en-US");
const fmt = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));
const fmtK = (n: number | null | undefined) => {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return nf.format(Math.round(n));
};
const pct = (n: number | null | undefined, dp = 1) => (n == null ? "—" : `${(n * 100).toFixed(dp)}%`);
const pp = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)} pp`);

/** A signed change, coloured by direction, with the sign always shown. */
function Delta({ value, suffix = "vs prev" }: { value: number | null; suffix?: string }) {
  if (value == null) return <span className="muted" style={{ fontSize: 11 }}>no prior month</span>;
  const up = value > 0;
  const flat = Math.abs(value) < 0.005;
  return (
    <span style={{ fontSize: 11, color: flat ? C.mid : up ? C.green : C.coral }}>
      {flat ? "flat" : `${up ? "▲" : "▼"} ${up ? "+" : ""}${(value * 100).toFixed(0)}%`} {suffix}
    </span>
  );
}

function change(now: number, before: number): number | null {
  if (!before) return null;
  return (now - before) / before;
}

function Kpi({
  label, value, sub, delta,
}: { label: string; value: string; sub?: string; delta?: React.ReactNode }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}
      {delta && <div style={{ marginTop: 2 }}>{delta}</div>}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      {sub && <div className="chart-sub">{sub}</div>}
      {children}
    </div>
  );
}

/** A horizontal bar for share-of-total rows, so the shape reads without a chart. */
function Bar({ value, max, color = C.blue }: { value: number; max: number; color?: string }) {
  const w = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return (
    <div style={{ background: "rgba(127,127,127,0.15)", borderRadius: 3, height: 6, width: "100%" }}>
      <div style={{ width: `${w}%`, background: color, height: 6, borderRadius: 3 }} />
    </div>
  );
}

const monthLabel = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mm - 1, 1)).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
};

const ASSISTANT_COLORS: Record<string, string> = {
  chatgpt: "#7c5cbf", gemini: C.blue, perplexity: C.green, claude: C.coral, copilot: C.sand,
};

export default function SeoDashboard({ initial }: { initial: SeoReport }) {
  /**
   * The month is switched by FETCHING, not by navigating.
   *
   * router.push('/seo?month=…') looked right and did nothing: next.config.ts
   * sets staleTimes.dynamic to 120, so the client router cache served the
   * previous render for two minutes and the page simply did not change. That
   * setting exists to make tab switching instant and is worth keeping — so this
   * tab stops routing for what is really a parameter change, and asks the API
   * directly instead. The URL is still updated so a month stays shareable.
   *
   * Keeping the loaded month IN the state is what makes `loading` derivable
   * rather than stored, and means the previous month's figures stay on screen,
   * dimmed, instead of the page emptying while the next one loads.
   */
  const [month, setMonth] = useState(initial.month);
  const [loaded, setLoaded] = useState<{ month: string; report: SeoReport }>({
    month: initial.month,
    report: initial,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * Auto-refresh, off by default.
   *
   * Each refresh is three live queries, one of them a month-long PostHog scan,
   * so leaving it on for everyone would be a standing cost for a page most
   * people read once. On, it re-fetches the month currently shown — never
   * switching months underneath the reader.
   */
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((n) => n + 1), 120_000);
    return () => clearInterval(id);
  }, [live]);

  useEffect(() => {
    if (!tick) return;
    let alive = true;
    fetch(`/api/seo?month=${encodeURIComponent(loaded.month)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((d: SeoReport & { error?: string }) => {
        // A failed background refresh must not wipe good figures off the screen.
        if (alive && !d?.error) setLoaded({ month: d.month, report: d });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [tick, loaded.month]);
  const loading = loaded.month !== month;
  const r = loaded.report;

  useEffect(() => {
    if (loaded.month === month) return;
    let live = true;
    fetch(`/api/seo?month=${encodeURIComponent(month)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((d: SeoReport & { error?: string }) => {
        if (!live) return;
        if (d?.error) {
          setLoadError(String(d.error));
          setMonth(loaded.month); // fall back so the control matches what is shown
        } else {
          setLoadError(null);
          setLoaded({ month: d.month, report: d });
          window.history.replaceState(null, "", `/seo?month=${d.month}`);
        }
      })
      .catch((e) => {
        if (!live) return;
        setLoadError(String(e));
        setMonth(loaded.month);
      });
    return () => { live = false; };
  }, [month, loaded.month]);
  /**
   * The CRM half, tagged with the month it belongs to.
   *
   * Keeping the month IN the state is what lets "loading" be derived rather
   * than stored: clearing two pieces of state at the top of the effect is a
   * synchronous setState during render, and it also meant a stale month's
   * figures could flash under a new month's heading before the fetch landed.
   * Comparing tags rules both out.
   */
  const [leadsState, setLeadsState] = useState<
    { month: string; data?: { current: LeadsData; previous: LeadsData }; error?: string } | null
  >(null);
  const fresh = leadsState?.month === loaded.month ? leadsState : null;
  const leads = fresh?.data ?? null;
  const leadsError = fresh?.error ?? null;

  useEffect(() => {
    let live = true;
    fetch(`/api/seo/leads?month=${encodeURIComponent(loaded.month)}`)
      .then((res) => res.json())
      .then((d) => {
        if (!live) return;
        setLeadsState(d?.error ? { month: loaded.month, error: String(d.error) } : { month: loaded.month, data: d });
      })
      .catch((e) => live && setLeadsState({ month: loaded.month, error: String(e) }));
    return () => { live = false; };
  }, [loaded.month]);

  const aiLeads = leads?.current.aiLeads ?? null;
  const aiLeadsPrev = leads?.previous.aiLeads ?? null;
  const leadRate = aiLeads != null && r.ai.visitors > 0 ? aiLeads / r.ai.visitors : null;
  const leadRatePrev = aiLeadsPrev != null && r.aiPrev.visitors > 0 ? aiLeadsPrev / r.aiPrev.visitors : null;
  const shareOrganic = r.ai.organicVisitors > 0 ? r.ai.visitors / r.ai.organicVisitors : null;
  const shareOrganicPrev = r.aiPrev.organicVisitors > 0 ? r.aiPrev.visitors / r.aiPrev.organicVisitors : null;

  const months = r.months;
  const monthOptions = useMemo(() => {
    const out: string[] = [];
    const [y, m] = initial.month.split("-").map(Number);
    for (let i = 0; i < 18; i++) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    return out;
    // Anchored to the month the page loaded with: the list is the 18 months up
    // to today, so rebuilding it from the month being VIEWED would shift the
    // options every time one was picked.
  }, [initial.month]);

  /**
   * All five assistants, always, in a stable order — including any with zero
   * visitors this month. A silently missing row reads as "we did not measure
   * it" rather than "nobody came from it", and the difference matters when the
   * point of the table is which assistants send people at all.
   */
  const assistants = r.ai.assistants;
  const maxAssistant = Math.max(1, ...assistants.map((a) => a.visitors));

  return (
    <>
      <div className="page-title">SEO &amp; AI Channel</div>
      <div className="page-sub">
        bhomes.com · {monthLabel(r.month)} vs {monthLabel(r.previous)} · PostHog, Metabase and Google Search Console
      </div>

      <div className="controls-bar">
        <label className="field">
          <span>Month</span>
          <select value={month} disabled={loading} onChange={(e) => setMonth(e.target.value)}>
            {monthOptions.map((m) => (
              <option key={m} value={m}>{monthLabel(m)}</option>
            ))}
          </select>
        </label>
        {loading ? (
          <span className="muted" style={{ fontSize: 11 }}>
            <span className="spinner" />
            Loading {monthLabel(month)}…
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            Updated {new Date(r.generatedAt).toLocaleString("en-GB")}
          </span>
        )}
        {loadError && (
          <span style={{ fontSize: 11, color: C.coral }}>Could not load that month: {loadError}</span>
        )}

        <button className={`filter-btn${live ? " active" : ""}`} onClick={() => setLive((v) => !v)}>
          {live ? "● Live (2m)" : "Live off"}
        </button>

        {/*
          One dot per source. Three services sit behind this page and a zero
          from a dead one looks exactly like a zero from a quiet month — the
          ambiguity that let the press bot report "no coverage" for a quarter
          while it was really reading nothing.
        */}
        <span style={{ display: "flex", gap: 12, alignItems: "center", marginLeft: "auto" }}>
          {r.sources.map((src) => {
            const colour =
              src.state === "ok" ? C.green : src.state === "empty" ? C.sand : C.coral;
            return (
              <span key={src.name} title={`${src.name}: ${src.detail}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.mid }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: colour, display: "inline-block" }} />
                {src.name}
              </span>
            );
          })}
        </span>
      </div>

      {r.ai.error && <div className="empty-state">{r.ai.error}</div>}

      {/*
        The figures below belong to `loaded.month`. While another month is in
        flight they are still correct, just not the month the control now says —
        so they are dimmed and made inert rather than blanked. An empty page
        would lose the comparison the reader had, and a page that looks normal
        would be showing one month under another month's heading.
      */}
      <div style={loading ? { opacity: 0.45, pointerEvents: "none", transition: "opacity .15s" } : undefined}>

      {/* ── 1. Summary ─────────────────────────────────────────────── */}
      <div className="kpi-strip">
        <Kpi
          label="AI referral leads"
          value={aiLeads == null ? (leadsError ? "—" : "…") : fmt(aiLeads)}
          sub={leadsError ? "CRM unavailable" : "Metabase · assistant utm source"}
          delta={aiLeads != null && aiLeadsPrev != null ? <Delta value={change(aiLeads, aiLeadsPrev)} /> : undefined}
        />
        <Kpi
          label="AI visitors"
          value={fmt(r.ai.visitors)}
          sub={`PostHog · unique people`}
          delta={<Delta value={change(r.ai.visitors, r.aiPrev.visitors)} />}
        />
        <Kpi
          label="AI sessions"
          value={fmt(r.ai.sessions)}
          sub={`${fmt(r.ai.pageviews)} pageviews`}
          delta={<Delta value={change(r.ai.sessions, r.aiPrev.sessions)} />}
        />
        <Kpi
          label="AI cost per lead"
          value="AED 0"
          sub="no media spend on this channel"
        />
        <Kpi
          label="Visitor → lead rate"
          value={pct(leadRate)}
          sub={leadRatePrev != null ? `prev ${pct(leadRatePrev)}` : "AI visitors to enquiries"}
          delta={
            leadRate != null && leadRatePrev != null
              ? <span style={{ fontSize: 11, color: leadRate >= leadRatePrev ? C.green : C.coral }}>{pp(leadRate - leadRatePrev)} vs prev</span>
              : undefined
          }
        />
        <Kpi
          label="AI share of organic"
          value={pct(shareOrganic)}
          sub={`${fmt(r.ai.visitors)} of ${fmt(r.ai.organicVisitors)} search visitors`}
          delta={
            shareOrganic != null && shareOrganicPrev != null
              ? <span style={{ fontSize: 11, color: shareOrganic >= shareOrganicPrev ? C.green : C.coral }}>{pp(shareOrganic - shareOrganicPrev)} vs prev</span>
              : undefined
          }
        />
      </div>

      {/* ── 2. Search performance ──────────────────────────────────── */}
      <Section title="Search performance" sub="Google Search Console · PostHog · month on month">
        <div className="kpi-strip">
          <Kpi
            label="Organic clicks"
            value={fmtK(r.gsc.totals?.clicks)}
            sub={`prev ${fmtK(r.gscPrev.totals?.clicks)}`}
            delta={<Delta value={change(r.gsc.totals?.clicks ?? 0, r.gscPrev.totals?.clicks ?? 0)} />}
          />
          <Kpi
            label="Organic impressions"
            value={fmtK(r.gsc.totals?.impressions)}
            sub={`prev ${fmtK(r.gscPrev.totals?.impressions)}`}
            delta={<Delta value={change(r.gsc.totals?.impressions ?? 0, r.gscPrev.totals?.impressions ?? 0)} />}
          />
          <Kpi
            label="Organic pageviews"
            value={fmt(months.find((m) => m.month === r.month)?.organicPageviews)}
            sub="PostHog · search referrers"
            delta={<Delta value={change(
              months.find((m) => m.month === r.month)?.organicPageviews ?? 0,
              months.find((m) => m.month === r.previous)?.organicPageviews ?? 0,
            )} />}
          />
          <Kpi
            label="Average position"
            value={r.gsc.totals ? r.gsc.totals.position.toFixed(1) : "—"}
            sub={r.gscPrev.totals ? `prev ${r.gscPrev.totals.position.toFixed(1)}` : "GSC · sitewide"}
          />
        </div>
        {r.gsc.error && <div className="muted" style={{ fontSize: 11 }}>{r.gsc.error}</div>}
      </Section>

      {/* ── 3. Month by month ──────────────────────────────────────── */}
      <Section title="Organic and AI, month by month" sub={`PostHog · Metabase · last ${months.length} months`}>
        <div className="table-scroll">
          <table className="perf-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Organic visitors</th>
                <th>Organic pageviews</th>
                <th>All pageviews</th>
                <th>AI visitors</th>
                <th>AI share of organic</th>
                <th>AI leads</th>
                <th>Organic leads</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} style={m.month === r.month ? { fontWeight: 600 } : undefined}>
                  <td>{monthLabel(m.month)}</td>
                  <td>{fmt(m.organicVisitors)}</td>
                  <td>{fmt(m.organicPageviews)}</td>
                  <td>{fmt(m.allPageviews)}</td>
                  <td>{fmt(m.aiVisitors)}</td>
                  <td>{pct(m.aiShareOfOrganic)}</td>
                  <td>{fmt(m.aiLeads)}</td>
                  <td>{fmt(m.organicLeads)}</td>
                </tr>
              ))}
              {!months.length && (
                <tr><td colSpan={8} className="muted">No monthly traffic returned.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 4. AI channel funnel ───────────────────────────────────── */}
      <Section title="AI channel funnel" sub={`${monthLabel(r.month)} · PostHog → Metabase`}>
        <div className="kpi-strip">
          <Kpi label="Pageviews" value={fmt(r.ai.pageviews)}
            sub={r.ai.sessions ? `${(r.ai.pageviews / r.ai.sessions).toFixed(1)} per session` : undefined} />
          <Kpi label="Sessions" value={fmt(r.ai.sessions)}
            sub={r.ai.visitors ? `${(r.ai.sessions / r.ai.visitors).toFixed(2)} per visitor` : undefined} />
          <Kpi label="Visitors" value={fmt(r.ai.visitors)}
            sub={r.ai.allVisitors ? `${pct(r.ai.visitors / r.ai.allVisitors)} of all site visitors` : undefined} />
          <Kpi label="Leads" value={aiLeads == null ? "…" : fmt(aiLeads)}
            sub={leadRate != null ? `${pct(leadRate)} of AI visitors` : undefined} />
        </div>
      </Section>

      {/* ── 5. Assistant by assistant ──────────────────────────────── */}
      <Section title="Assistant by assistant" sub={`Unique visitors · ${monthLabel(r.month)} vs ${monthLabel(r.previous)}`}>
        <div className="table-scroll">
          <table className="perf-table">
            <thead>
              <tr>
                <th>Assistant</th><th>Visitors</th><th>Share</th><th>Prev</th>
                <th>Sessions</th><th>Pages / visitor</th><th>Top entry pages</th>
              </tr>
            </thead>
            <tbody>
              {assistants.map((a) => {
                const before = r.aiPrev.assistants.find((x) => x.key === a.key)?.visitors ?? 0;
                return (
                  <tr key={a.key}>
                    <td style={{ color: ASSISTANT_COLORS[a.key] ?? C.mid, fontWeight: 600 }}>{a.label}</td>
                    <td>{fmt(a.visitors)}</td>
                    <td style={{ minWidth: 90 }}>
                      <Bar value={a.visitors} max={maxAssistant} color={ASSISTANT_COLORS[a.key] ?? C.blue} />
                      <span className="muted" style={{ fontSize: 10 }}>
                        {r.ai.visitors ? pct(a.visitors / r.ai.visitors) : "—"}
                      </span>
                    </td>
                    <td><Delta value={change(a.visitors, before)} suffix="" /></td>
                    <td>{fmt(a.sessions)}</td>
                    <td>{a.visitors ? (a.pageviews / a.visitors).toFixed(1) : "—"}</td>
                    <td style={{ fontSize: 11 }}>
                      {a.topEntryPages.length
                        ? a.topEntryPages.map((p) => `${p.path} (${p.visitors})`).join(" · ")
                        : <span className="muted">none</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 6. Visitors per assistant, month by month ──────────────── */}
      <Section title="Visitors per assistant, month by month" sub="PostHog · unique people">
        <div className="table-scroll">
          <table className="perf-table">
            <thead>
              <tr>
                <th>Month</th>
                {assistants.map((a) => <th key={a.key}>{a.label}</th>)}
                <th>Total AI</th><th>% of organic</th><th>AI leads</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} style={m.month === r.month ? { fontWeight: 600 } : undefined}>
                  <td>{monthLabel(m.month)}</td>
                  {assistants.map((a) => <td key={a.key}>{fmt(m.byAssistant[a.key] ?? 0)}</td>)}
                  <td>{fmt(m.aiVisitors)}</td>
                  <td>{pct(m.aiShareOfOrganic)}</td>
                  <td>{fmt(m.aiLeads)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 7. Landing pages behind AI traffic ─────────────────────── */}
      <Section
        title="Landing pages behind AI traffic"
        sub={`Entry page of each AI visitor · ${r.ai.distinctEntryPages} distinct pages, ${r.ai.entryPagesSeenOnce} seen once`}
      >
        <div className="table-scroll">
          <table className="perf-table">
            <thead><tr><th>Entry page</th><th>Visitors</th><th>Share</th></tr></thead>
            <tbody>
              {r.ai.entryPages.map((p) => (
                <tr key={p.path}>
                  <td style={{ fontSize: 11 }}>{p.path}</td>
                  <td>{fmt(p.visitors)}</td>
                  <td>{r.ai.visitors ? pct(p.visitors / r.ai.visitors) : "—"}</td>
                </tr>
              ))}
              {!r.ai.entryPages.length && <tr><td colSpan={3} className="muted">No AI arrivals in this month.</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 8. Traffic by page type ────────────────────────────────── */}
      <Section title="Traffic by page type" sub={`The same ${fmt(r.ai.visitors)} visitors, grouped`}>
        <div className="table-scroll">
          <table className="perf-table">
            <thead><tr><th>Page type</th><th>Visitors</th><th>Share</th></tr></thead>
            <tbody>
              {r.ai.pageTypes.map((t) => (
                <tr key={t.label}>
                  <td>{t.label}</td>
                  <td>{fmt(t.value)}</td>
                  <td style={{ minWidth: 120 }}>
                    <Bar value={t.value} max={Math.max(1, ...r.ai.pageTypes.map((x) => x.value))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 9. Most viewed pages + sections ────────────────────────── */}
      <Section title="Most viewed pages" sub={`All channels · ${monthLabel(r.month)} · ${fmt(r.ai.allPageviews)} pageviews sitewide`}>
        <div className="table-scroll">
          <table className="perf-table">
            <thead><tr><th>Page</th><th>Visitors</th><th>Views</th></tr></thead>
            <tbody>
              {r.ai.topPages.slice(0, 15).map((p) => (
                <tr key={p.path}>
                  <td style={{ fontSize: 11 }}>{p.path}</td>
                  <td>{fmt(p.visitors)}</td>
                  <td>{fmt(p.views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="By site section" sub="The same month, grouped · views">
        <div className="table-scroll">
          <table className="perf-table">
            <thead><tr><th>Section</th><th>Views</th><th>Visitors</th><th /></tr></thead>
            <tbody>
              {r.ai.sections.map((s) => (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td>{fmt(s.views)}</td>
                  <td>{fmt(s.visitors)}</td>
                  <td style={{ minWidth: 120 }}>
                    <Bar value={s.views} max={Math.max(1, ...r.ai.sections.map((x) => x.views))} color={C.green} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 9b. Property listings ──────────────────────────────────── */}
      <Section
        title="Property listings by views"
        sub={`All channels · ${r.ai.propertyViews.length} listings with traffic · ` +
          `${r.ai.propertyViews.filter((p) => p.kind === "buy").length} buy · ` +
          `${r.ai.propertyViews.filter((p) => p.kind === "rent").length} rent`}
      >
        <div className="table-scroll">
          <table className="perf-table">
            <thead><tr><th>Listing</th><th>Type</th><th>Views</th><th>Visitors</th></tr></thead>
            <tbody>
              {r.ai.propertyViews.slice(0, 15).map((p) => (
                <tr key={p.path}>
                  <td style={{ fontSize: 11 }}>{p.slug}</td>
                  <td style={{ color: p.kind === "buy" ? C.green : p.kind === "rent" ? C.blue : C.mid }}>
                    {p.kind === "buy" ? "Buy" : p.kind === "rent" ? "Rent" : "—"}
                  </td>
                  <td>{fmt(p.views)}</td>
                  <td>{fmt(p.visitors)}</td>
                </tr>
              ))}
              {!r.ai.propertyViews.length && (
                <tr><td colSpan={4} className="muted">No individual listing pages were viewed this month.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 10. Who the AI audience is ─────────────────────────────── */}
      <Section title="Who the AI audience is" sub={`${monthLabel(r.month)} · ${fmt(r.ai.visitors)} AI visitors`}>
        <div className="kpi-strip">
          {r.ai.devices.map((d) => <Kpi key={d.label} label={d.label} value={fmt(d.value)}
            sub={r.ai.visitors ? pct(d.value / r.ai.visitors) : undefined} />)}
          <Kpi label="First-time" value={fmt(r.ai.newVisitors)} sub="never seen before" />
          <Kpi label="Returning" value={fmt(r.ai.returningVisitors)} sub="been to bhomes.com before" />
        </div>
        <div className="table-scroll" style={{ marginTop: 10 }}>
          <table className="perf-table">
            <thead><tr><th>Country</th><th>Visitors</th><th /></tr></thead>
            <tbody>
              {r.ai.countries.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td>{fmt(c.value)}</td>
                  <td style={{ minWidth: 120 }}>
                    <Bar value={c.value} max={Math.max(1, ...r.ai.countries.map((x) => x.value))} />
                  </td>
                </tr>
              ))}
              {!r.ai.countries.length && <tr><td colSpan={3} className="muted">No geo data.</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 11. What AI visitors do ────────────────────────────────── */}
      <Section
        title="What AI visitors actually do"
        sub={`PostHog events · ${fmt(r.ai.actionEvents)} events from ${fmt(r.ai.peopleActing)} people`}
      >
        <div className="table-scroll">
          <table className="perf-table">
            <thead><tr><th>Action</th><th>People</th><th /></tr></thead>
            <tbody>
              {r.ai.actions.map((a) => (
                <tr key={a.label}>
                  <td>{a.label}</td>
                  <td>{fmt(a.value)}</td>
                  <td style={{ minWidth: 120 }}>
                    <Bar value={a.value} max={Math.max(1, ...r.ai.actions.map((x) => x.value))} color="#7c5cbf" />
                  </td>
                </tr>
              ))}
              {!r.ai.actions.length && <tr><td colSpan={3} className="muted">No events from AI visitors this month.</td></tr>}
            </tbody>
          </table>
        </div>
        {!!r.ai.forms.length && (
          <>
            <div className="chart-sub" style={{ marginTop: 12 }}>Forms submitted</div>
            <div className="table-scroll">
              <table className="perf-table">
                <thead><tr><th>Form</th><th>People</th></tr></thead>
                <tbody>
                  {r.ai.forms.map((f) => (
                    <tr key={f.label}><td>{f.label}</td><td>{fmt(f.value)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {/* ── 12. Target keyword rankings ────────────────────────────── */}
      <Section title="Target keyword rankings" sub={`GSC average position · ${monthLabel(r.previous)} → ${monthLabel(r.month)}`}>
        <div className="table-scroll">
          <table className="perf-table">
            <thead>
              <tr><th>Keyword</th><th>Prev</th><th>Now</th><th>Δ</th><th>Clicks</th><th>Impressions</th></tr>
            </thead>
            <tbody>
              {r.gsc.keywords.map((k) => {
                const before = r.gscPrev.keywords.find((x) => x.keyword === k.keyword)?.position ?? null;
                const delta = before != null && k.position != null ? k.position - before : null;
                return (
                  <tr key={k.keyword}>
                    <td>{k.keyword}</td>
                    <td>{before?.toFixed(1) ?? "—"}</td>
                    <td>{k.position?.toFixed(1) ?? "—"}</td>
                    {/* Lower position is better, so a negative delta is good. */}
                    <td style={{ color: delta == null ? C.mid : delta < 0 ? C.green : delta > 0 ? C.coral : C.mid }}>
                      {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`}
                    </td>
                    <td>{fmt(k.clicks)}</td>
                    <td>{fmt(k.impressions)}</td>
                  </tr>
                );
              })}
              {!r.gsc.keywords.length && <tr><td colSpan={6} className="muted">No Search Console keyword data.</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 13. Leads, stage and status ────────────────────────────── */}
      <Section title="Leads &amp; pipeline" sub={`Metabase · ${monthLabel(r.month)} vs ${monthLabel(r.previous)}`}>
        {leadsError && <div className="empty-state">{leadsError}</div>}
        {!leads && !leadsError && <div className="muted">Loading the CRM figures…</div>}
        {leads && (
          <>
            <div className="kpi-strip">
              <Kpi label="AI leads" value={fmt(leads.current.aiLeads)}
                delta={<Delta value={change(leads.current.aiLeads, leads.previous.aiLeads)} />} />
              <Kpi label="Organic leads" value={fmt(leads.current.organicLeads)}
                sub={`${fmt(leads.current.websiteNoUtm)} website · ${fmt(leads.current.popup)} pop-up`}
                delta={<Delta value={change(leads.current.organicLeads, leads.previous.organicLeads)} />} />
              <Kpi label="Combined" value={fmt(leads.current.aiLeads + leads.current.organicLeads)}
                sub="all at AED 0 cost per lead" />
              <Kpi label="AI share of the two" value={
                leads.current.aiLeads + leads.current.organicLeads > 0
                  ? pct(leads.current.aiLeads / (leads.current.aiLeads + leads.current.organicLeads))
                  : "—"
              } />
            </div>
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table className="perf-table">
                <thead><tr><th>Stage</th><th>AI</th><th>Organic</th></tr></thead>
                <tbody>
                  {[...new Set(leads.current.stage.map((s) => s.stage))].map((stage) => (
                    <tr key={stage}>
                      <td>{stage}</td>
                      <td>{fmt(leads.current.stage.find((s) => s.stage === stage && s.segment === "ai")?.n ?? 0)}</td>
                      <td>{fmt(leads.current.stage.find((s) => s.stage === stage && s.segment === "organic")?.n ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {/* ── 14. AI visibility + content — stored, not live ─────────── */}
      <Section
        title="Semrush AI Visibility"
        sub={`Worldwide · all AI platforms · entered manually, figures as at ${monthLabel(r.manual.aiVisibility.asOf)}`}
      >
        <div className="kpi-strip">
          <Kpi label="Mentions" value={fmtK(r.manual.aiVisibility.mentions)}
            sub="times bhomes.com is named in an AI answer"
            delta={<Delta value={change(r.manual.aiVisibility.mentions, r.manual.aiVisibility.prevMentions)} />} />
          <Kpi label="Citations" value={fmtK(r.manual.aiVisibility.citations)}
            sub="times an AI answer links a bhomes.com URL"
            delta={<Delta value={change(r.manual.aiVisibility.citations, r.manual.aiVisibility.prevCitations)} />} />
          <Kpi label="Cited pages" value={fmtK(r.manual.aiVisibility.citedPages)}
            sub="distinct bhomes.com pages cited"
            delta={<Delta value={change(r.manual.aiVisibility.citedPages, r.manual.aiVisibility.prevCitedPages)} />} />
          <Kpi label="Visibility score" value={r.manual.aiVisibility.visibilityScore?.toString() ?? "—"}
            sub={r.manual.aiVisibility.visibilityRating ?? undefined} />
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Semrush AI Visibility has no report in this app&rsquo;s Semrush connector, so these are entered in
          Settings rather than pulled. Everything above this section is live.
        </div>
        {!!r.manual.aiVisibility.topPrompts.length && (
          <div className="table-scroll" style={{ marginTop: 10 }}>
            <table className="perf-table">
              <thead><tr><th>Prompt</th><th>Platform</th><th>Result</th></tr></thead>
              <tbody>
                {r.manual.aiVisibility.topPrompts.map((p, i) => (
                  <tr key={i}><td style={{ fontSize: 11 }}>{p.prompt}</td><td>{p.platform}</td><td>{p.result}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Content production"
        sub={`ClickUp · entered manually, as at ${monthLabel(r.manual.content.asOf)}`}
      >
        <div className="table-scroll">
          <table className="perf-table">
            <thead><tr><th>Category</th><th>This month</th><th>Previous</th><th>Δ</th></tr></thead>
            <tbody>
              {r.manual.content.categories.map((c) => {
                const d = c.current - c.previous;
                return (
                  <tr key={c.category}>
                    <td>{c.category}</td>
                    <td>{fmt(c.current)}</td>
                    <td>{fmt(c.previous)}</td>
                    <td style={{ color: d > 0 ? C.green : d < 0 ? C.coral : C.mid }}>
                      {d > 0 ? "+" : ""}{d}
                    </td>
                  </tr>
                );
              })}
              <tr style={{ fontWeight: 600 }}>
                <td>Total</td>
                <td>{fmt(r.manual.content.categories.reduce((s, c) => s + c.current, 0))}</td>
                <td>{fmt(r.manual.content.categories.reduce((s, c) => s + c.previous, 0))}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 16, lineHeight: 1.6 }}>
        Sources — PostHog (pageviews, unique people by person id, sessions; AI channel = referrer matching an
        assistant OR utm_source carrying one, bot-filtered) · Metabase (leads and deals; AI = utm source matching
        chatgpt / openai / perplexity / gemini / claude / copilot, organic = website or pop-up enquiries with no
        utm) · Google Search Console (clicks, impressions, average position). Lead counts for a closed month drift
        as attribution backfills. Organic and AI leads carry no media spend.
      </div>
    </>
  );
}
