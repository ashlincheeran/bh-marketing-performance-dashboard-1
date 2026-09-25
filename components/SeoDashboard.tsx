"use client";

import { useEffect, useMemo, useState } from "react";
import s from "@/components/seo/report.module.css";
import {
  cx, fmt, fmtK, pct, signed, pctDelta, ppDelta, Section, Kpi, Card, Bar, Tot, Tag, DeltaTag, PctTag, Spark, Donut,
} from "@/components/seo/parts";
import type { SeoReport, SeoReportLeads, MonthPoint } from "@/lib/seoReport";
import type { LeadsData } from "@/lib/metabase";

/**
 * The SEO tab, laid out as the SEO & AI Channel report.
 *
 * Section for section, card for card, in the report's own design system (see
 * report.module.css) — so the monthly report and the live tab read as the same
 * document. The difference is that every figure here is live, and the month is
 * a control rather than a print date.
 *
 * The cards the report outlines carry `highlight`: a gold edge and a warm
 * tint rather than a label. Remove the prop to retire it.
 */

// ── labels ─────────────────────────────────────────────────────────────────

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const mi = (m: string) => Number(m.slice(5, 7)) - 1;
const monShort = (m: string) => MON[mi(m)];
const monLong = (m: string) => MONTH[mi(m)];
const monYear = (m: string) => `${MONTH[mi(m)]} ${m.slice(0, 4)}`;
/** The month before a YYYY-MM. Local, because lib/seoReport is server-side. */
const prevOf = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
};

const DOMAINS: Record<string, string> = {
  chatgpt: "chatgpt.com · openai.com",
  gemini: "gemini.google.com",
  perplexity: "perplexity.ai",
  claude: "claude.ai",
  copilot: "copilot.microsoft.com",
};
const DONUT = ["#1d3d58", "#2c537a", "#4d7497", "#7ba0b2", "#bccfd9"];

/** What each tracked event means, in the report's words. */
const EVENT_LABELS: Record<string, string> = {
  click_open_form: "opened a form",
  lead_join_our_team: "careers application",
  lead_contact_us: "contact form",
  click_apply_now: "apply-now button",
  lead_pdf_download: "downloaded a PDF",
  pdf_doc_click: "opened a PDF",
  lead_list_your_property: "list-your-property",
  click_call: "tapped call",
  lead_blog_form: "blog form",
};
const FORM_LABELS: Record<string, string> = {
  "careers-schedule-call": "Book a call about a job",
  "market-reports-blog-post": "Market report download",
  contact_us: "General contact",
  "city-tower-register-your-interest": "City Tower interest",
  "notify-me": "Notify me",
  "property-lead-form": "Property enquiry",
  "property-valuation": "Property valuation",
};
const formLabel = (f: string) =>
  FORM_LABELS[f] ?? (f.includes("list") && f.includes("propert") ? "List your property" : humanise(f));

/** Words a slug lower-cases that the page itself would not. */
const CASED: Record<string, string> = {
  uae: "UAE", uk: "UK", usa: "USA", aed: "AED", ai: "AI", dld: "DLD", rera: "RERA", roi: "ROI",
  q1: "Q1", q2: "Q2", q3: "Q3", q4: "Q4", dubai: "Dubai", dubais: "Dubai's", abu: "Abu", dhabi: "Dhabi",
};

function humanise(slug: string): string {
  const t = slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => CASED[w.toLowerCase()] ?? w.replace(/^aed(\d)/i, "AED $1"))
    .join(" ");
  return t ? t[0].toUpperCase() + t.slice(1) : slug;
}

/** A readable name for an entry path, with the path kept beneath it. */
function pageName(path: string): { main: string; sub: string } {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  if (path === "/en" || path === "/en/" || path === "/") return { main: "/en", sub: "Home page" };
  if (path === "/en/join-our-team") return { main: path, sub: "Careers hub" };
  if (path.startsWith("/en/join-our-team/")) return { main: path, sub: `Careers · ${humanise(last)}` };
  if (path.startsWith("/en/blog/")) {
    const kind = path.split("/")[3] ?? "";
    return { main: `${kind === "webinar" ? "Webinar" : "Blog"} · ${humanise(last)}`, sub: `/en/blog/${kind}/…` };
  }
  if (path.startsWith("/en/property/")) return { main: path, sub: "Single property listing" };
  if (path.startsWith("/en/area-guides/")) return { main: path, sub: `Area guide · ${humanise(last)}` };
  return { main: path, sub: humanise(last) };
}

/**
 * The shortest name that still identifies a page, for the assistant cards'
 * one-line rows: the home page says so, and a post is its title — the
 * "Blog ·" prefix the tables carry would leave no room for it.
 */
function shortPage(path: string): string {
  if (path === "/en" || path === "/en/" || path === "/") return "/en (home)";
  if (path.startsWith("/en/blog/")) return humanise(path.split("/").filter(Boolean).pop() ?? path);
  return path;
}

/** Which assistant a CRM source string belongs to. */
function assistantOf(source: string): string | null {
  const t = source.toLowerCase();
  if (t.includes("chatgpt") || t.includes("openai")) return "chatgpt";
  if (t.includes("gemini")) return "gemini";
  if (t.includes("perplexity")) return "perplexity";
  if (t.includes("claude")) return "claude";
  if (t.includes("copilot")) return "copilot";
  return null;
}

/** How many months running a series has moved one way, ending at the last. */
function streak(values: number[], dir: 1 | -1): number {
  let n = 0;
  for (let i = values.length - 1; i > 0; i--) {
    if (Math.sign(values[i] - values[i - 1]) === dir) n++;
    else break;
  }
  return n;
}

// ── page ───────────────────────────────────────────────────────────────────

type LeadsPair = SeoReportLeads;

export default function SeoDashboard({ initial }: { initial: SeoReport }) {
  /**
   * The month is switched by FETCHING, not by navigating: router.push was
   * served from the client router cache (staleTimes.dynamic is 120) and simply
   * did not change the page. Keeping the loaded month IN the state is what
   * makes `loading` derivable, and keeps the previous figures on screen,
   * dimmed, rather than emptying the page while the next month loads.
   */
  const [month, setMonth] = useState(initial.month);
  const [loaded, setLoaded] = useState<{ month: string; report: SeoReport }>({ month: initial.month, report: initial });
  const [loadError, setLoadError] = useState<string | null>(null);
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
          setMonth(loaded.month);
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

  /** Opt-in auto-refresh of the month on screen — never switches months under the reader. */
  const [liveOn, setLiveOn] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!liveOn) return;
    const id = setInterval(() => setTick((n) => n + 1), 120_000);
    return () => clearInterval(id);
  }, [liveOn]);
  useEffect(() => {
    if (!tick) return;
    let alive = true;
    fetch(`/api/seo?month=${encodeURIComponent(loaded.month)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((d: SeoReport & { error?: string }) => { if (alive && !d?.error) setLoaded({ month: d.month, report: d }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [tick, loaded.month]);

  /** The CRM half: slow and unindexed, so fetched after render, tagged with its month. */
  const [leadsState, setLeadsState] = useState<{ month: string; data?: LeadsPair; error?: string } | null>(null);
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

  const monthOptions = useMemo(() => {
    const out: string[] = [];
    const [y, m] = initial.month.split("-").map(Number);
    for (let i = 0; i < 18; i++) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    return out;
    // Anchored to the month the page loaded with, so picking one never shifts the list.
  }, [initial.month]);

  // ── derived ──────────────────────────────────────────────────────────────
  const cur = r.month, prev = r.previous;
  const vs = monShort(prev);
  const ai = r.ai, aiP = r.aiPrev;

  /** Year to date, as the report reads: January of the month's year up to it. */
  const ytd: MonthPoint[] = r.months.filter((m) => m.month.slice(0, 4) === cur.slice(0, 4) && m.month <= cur);
  const mCur = ytd.find((m) => m.month === cur);
  const mPrev = r.months.find((m) => m.month === prev);
  const rangeLabel = ytd.length ? `${MONTH[mi(ytd[0].month)]} – ${monYear(cur)}` : monYear(cur);

  const L = leads?.current, LP = leads?.previous;
  const aiLeads = L?.aiLeads ?? null;
  const aiLeadsPrev = LP?.aiLeads ?? null;
  const rate = aiLeads != null && ai.visitors ? aiLeads / ai.visitors : null;
  const rateP = aiLeadsPrev != null && aiP.visitors ? aiLeadsPrev / aiP.visitors : null;
  const share = ai.organicVisitors ? ai.visitors / ai.organicVisitors : null;
  const shareP = aiP.organicVisitors ? aiP.visitors / aiP.organicVisitors : null;

  const leadsByAssistant = new Map<string, number>();
  for (const x of L?.aiBySource ?? []) {
    const k = assistantOf(x.source);
    if (k) leadsByAssistant.set(k, (leadsByAssistant.get(k) ?? 0) + x.n);
  }
  const sourceLine = [...leadsByAssistant.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${ai.assistants.find((a) => a.key === k)?.label ?? k} ${n}`)
    .join(" · ");

  const stageN = (d: LeadsData | undefined, seg: string, stage: string) =>
    d?.stage.find((x) => x.segment === seg && x.stage === stage)?.n ?? 0;
  const statusN = (d: LeadsData | undefined, seg: string, st: string) =>
    d?.status.find((x) => x.segment === seg && x.status === st)?.n ?? 0;
  const segTotal = (d: LeadsData | undefined, seg: string) =>
    (d?.stage ?? []).filter((x) => x.segment === seg).reduce((a, x) => a + x.n, 0);

  const gsc = r.gsc.totals, gscP = r.gscPrev.totals;
  const kw = r.gsc.keywords.map((k) => {
    const before = r.gscPrev.keywords.find((x) => x.keyword === k.keyword)?.position ?? null;
    const delta = before != null && k.position != null ? k.position - before : null;
    return { ...k, before, delta };
  });
  const improved = kw.filter((k) => k.delta != null && k.delta < 0).length;
  const declined = kw.filter((k) => k.delta != null && k.delta > 0).length;
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const aggNow = avg(kw.map((k) => k.position));
  const aggBefore = avg(kw.map((k) => k.before));

  const sectionsMax = Math.max(1, ...ai.sections.map((x) => x.views));
  const careers = ai.sections.find((x) => x.key === "careers");
  const careersRank = careers ? ai.sections.indexOf(careers) + 1 : 0;
  const ord = (n: number) => (n === 1 ? "largest" : n === 2 ? "second-largest" : n === 3 ? "third-largest" : `${n}th-largest`);

  const typesMax = Math.max(1, ...ai.pageTypes.map((x) => x.value));
  const careersType = ai.pageTypes.find((x) => x.label === "Careers");
  const countriesMax = Math.max(1, ...ai.countries.map((x) => x.value));
  const devicesMax = Math.max(1, ...ai.devices.map((x) => x.value));
  const mobile = ai.devices.find((d) => d.label.toLowerCase() === "mobile")?.value ?? 0;
  const actionsMax = Math.max(1, ...ai.actions.map((x) => x.value));
  const formsOpenedMax = Math.max(1, ...ai.forms.map((x) => x.opened || x.value));
  const topForm = ai.forms[0];

  const orgPv = ytd.map((m) => m.organicPageviews);
  const aiVis = ytd.map((m) => m.aiVisitors);
  const orgChange = orgPv.length > 1 && orgPv[0] ? (orgPv[orgPv.length - 1] - orgPv[0]) / orgPv[0] : null;
  /** "have fallen every month since June", in the report's words, from the run the series is on. */
  const trend = (values: number[], subject: string, has: string) => {
    for (const [dir, verb, past] of [[-1, "fallen", "fell"], [1, "risen", "rose"]] as const) {
      const n = streak(values, dir);
      if (n === 1) return `${subject} ${past} in ${monLong(cur)}`;
      if (n > 1) return `${subject} ${has} ${verb} every month since ${monLong(ytd[ytd.length - 1 - n].month)}`;
    }
    return `${subject} held level in ${monLong(cur)}`;
  };

  /** Each assistant's CRM leads, January to this month — from the fast half, so it needs no wait. */
  const metabaseOk = r.sources.find((x) => x.name === "Metabase")?.state === "ok";
  const ytdLeadsFor = (key: string) =>
    ytd.reduce((n, m) => n + m.aiLeadsBySource.filter((x) => assistantOf(x.source) === key).reduce((a, x) => a + x.n, 0), 0);

  const vis = r.manual.aiVisibility, content = r.manual.content;
  const contentTotal = content.categories.reduce((a, c) => a + c.current, 0);
  const contentPrev = content.categories.reduce((a, c) => a + c.previous, 0);
  const biggestShift = [...content.categories].sort((a, b) => (b.current - b.previous) - (a.current - a.previous))[0];

  const okAll = r.sources.every((x) => x.state === "ok");
  const anyDown = r.sources.some((x) => x.state === "down" || x.state === "off");

  return (
    <div className={s.report}>
      <div className={s.wrap}>
        {/* ── brand bar ───────────────────────────────────────────── */}
        <header className={s.brandbar}>
          <div className={s.left}>
            <span className={s.wordmark}>betterhomes</span>
            <span className={s.est}>Est 1986</span>
            <span className={s.divider} />
            <span className={s.doctitle}>SEO &amp; AI Channel Report</span>
          </div>
          <div className={s.pills}>
            <span className={s.hpill} title={r.sources.map((x) => `${x.name}: ${x.detail}`).join("\n")}>
              <span className={s.dot} style={{ background: okAll ? undefined : anyDown ? "#b85542" : "#d9b9a0" }} />
              {rangeLabel}
            </span>
            <label className={s.hpill}>
              {loading ? <span className={s.spin} /> : null}
              <select value={month} disabled={loading} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
                {monthOptions.map((m) => <option key={m} value={m}>{monYear(m)}</option>)}
              </select>
            </label>
            <button type="button" className={cx("hpill", liveOn && "on")} onClick={() => setLiveOn((v) => !v)}>
              {liveOn ? "● Live · 2 min" : "Live off"}
            </button>
            <span className={s.hpill} suppressHydrationWarning>
              {new Date(r.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        </header>

        {loadError && <div className={s.alert}>Could not load that month: {loadError}</div>}
        {/* Sources state their own condition: a zero from a dead source reads exactly like a quiet month. */}
        {r.sources.filter((x) => x.state !== "ok").map((x) => (
          <div key={x.name} className={s.alert}><b>{x.name}</b> — {x.detail}</div>
        ))}

        <div className={loading ? s.dim : undefined}>
          {/* ── Summary ─────────────────────────────────────────────── */}
          <Section title="Summary" note={`${monYear(cur)} vs ${monYear(prev)}`}>
            <div className={s.kpis}>
              <Kpi
                label="AI referral leads"
                value={aiLeads == null ? (leadsError ? "—" : "…") : fmt(aiLeads)}
                pending={aiLeads == null}
                sub={leadsError ? "CRM unavailable" : `Metabase${sourceLine ? ` · ${sourceLine}` : ""}`}
                delta={aiLeads != null && aiLeadsPrev != null ? pctDelta(aiLeads, aiLeadsPrev, vs) : null}
              />
              <Kpi
                label="AI visitors"
                value={fmt(ai.visitors)}
                sub={`PostHog · ${ai.assistants.filter((a) => a.visitors > 0).length} assistants · unique people`}
                delta={pctDelta(ai.visitors, aiP.visitors, vs)}
              />
              <Kpi
                label="AI sessions"
                value={fmt(ai.sessions)}
                sub={`PostHog · ${fmt(ai.pageviews)} pageviews`}
                delta={pctDelta(ai.sessions, aiP.sessions, vs)}
              />
              {/* Green although flat, as the report marks it: a CPL of zero is as good as it gets. */}
              <Kpi
                mark="up"
                label="AI CPL"
                value="AED 0"
                sub={`${aiLeads == null ? "…" : fmt(aiLeads)} AI leads · zero media spend`}
                delta={{ text: `flat vs ${vs}`, dir: "flat" }}
              />
              <Kpi
                label="Visitor → lead rate"
                value={pct(rate)}
                pending={rate == null}
                sub={`${vs} ${pct(rateP)} · AI visitors to enquiries`}
                delta={ppDelta(rate, rateP, vs)}
              />
              <Kpi
                label="AI share of organic"
                value={pct(share)}
                sub={`${fmt(ai.visitors)} of ${fmt(ai.organicVisitors)} search visitors`}
                delta={ppDelta(share, shareP, vs)}
              />
            </div>
          </Section>

          {/* ── Search performance ──────────────────────────────────── */}
          <Section
            title="Search performance"
            note={`Google Search Console${r.gsc.source === "direct" ? " (web)" : ""} · PostHog · ${monLong(cur)} vs ${monLong(prev)} ${cur.slice(0, 4)}`}
          >
            <div className={s.stack}>
              <div className={s.kpis}>
                <Kpi
                  highlight
                  label="Organic clicks"
                  value={fmtK(gsc?.clicks)}
                  sub={`GSC · bhomes.com · ${vs} ${fmtK(gscP?.clicks)}`}
                  delta={gsc && gscP ? pctDelta(gsc.clicks, gscP.clicks, vs) : null}
                />
                <Kpi
                  highlight
                  label="Organic impressions"
                  value={fmtK(gsc?.impressions)}
                  sub={`GSC · bhomes.com · ${vs} ${fmtK(gscP?.impressions)}`}
                  delta={gsc && gscP ? pctDelta(gsc.impressions, gscP.impressions, vs) : null}
                />
                <Kpi
                  highlight
                  label="Organic pageviews"
                  value={fmt(mCur?.organicPageviews)}
                  sub={`PostHog · search referrers · ${vs} ${fmt(mPrev?.organicPageviews)}`}
                  delta={mCur && mPrev ? pctDelta(mCur.organicPageviews, mPrev.organicPageviews, vs) : null}
                />
              </div>

              <Card highlight title="Organic month by month" cap={`PostHog · search referrers · ${rangeLabel}`}>
                <div className={s.scroll}>
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th><th className={s.r}>Organic visitors</th><th className={s.r}>Organic pageviews</th>
                        <th className={s.r}>All pageviews</th><th className={s.r}>AI visitors</th><th className={s.r}>AI share of organic</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ytd.map((m) => (
                        <tr key={m.month} className={m.month === cur ? s.emph : undefined}>
                          <td className={s.b}>{monShort(m.month)}</td>
                          <td className={s.r}>{fmt(m.organicVisitors)}</td>
                          <td className={s.r}>{fmt(m.organicPageviews)}</td>
                          <td className={s.r}>{fmt(m.allPageviews)}</td>
                          <td className={s.r}>{fmt(m.aiVisitors)}</td>
                          <td className={s.r}>{pct(m.aiShareOfOrganic)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Tot
                  label={`${trend(orgPv, "Organic pageviews", "have")} · ${trend(aiVis, "AI", "has")}`}
                  value={orgChange == null ? "—" : `${signed(orgChange * 100)}%`}
                />
              </Card>
            </div>
          </Section>

          {/* ── AI channel funnel ───────────────────────────────────── */}
          <Section title="AI channel funnel" note={`${monYear(cur)} · PostHog → Metabase`}>
            <div className={s.funnel}>
              <div className={s.stage}>
                <span className={`${s.top} ${s.tTan}`} />
                <div className={s.slbl}>Pageviews</div>
                <div className={s.sval}>{fmt(ai.pageviews)}</div>
                <div className={s.sof}>from AI assistants</div>
                <div className={s.sstep}>{ai.sessions ? (ai.pageviews / ai.sessions).toFixed(1) : "—"} per session</div>
                <div className={s.sdesc}>vs {fmt(aiP.pageviews)} in {monLong(prev)}</div>
              </div>
              <div className={s.stage}>
                <span className={`${s.top} ${s.tTan}`} />
                <div className={s.slbl}>Sessions</div>
                <div className={s.sval}>{fmt(ai.sessions)}</div>
                <div className={s.sof}>{aiP.sessions ? `${signed(((ai.sessions - aiP.sessions) / aiP.sessions) * 100)}% MoM` : "—"}</div>
                <div className={s.sstep}>{ai.visitors ? (ai.sessions / ai.visitors).toFixed(2) : "—"} per visitor</div>
                <div className={s.sdesc}>vs {fmt(aiP.sessions)} in {monLong(prev)}</div>
              </div>
              <div className={s.stage}>
                <span className={`${s.top} ${s.tGreen}`} />
                <div className={s.slbl}>Visitors</div>
                <div className={s.sval}>{fmt(ai.visitors)}</div>
                <div className={s.sof}>{ai.allVisitors ? `${pct(ai.visitors / ai.allVisitors)} of all site visitors` : "—"}</div>
                <div className={s.sstep}>{pct(share)} of organic</div>
                <div className={s.sdesc}>vs {fmt(aiP.visitors)} in {monLong(prev)}</div>
              </div>
              <div className={s.stage}>
                <span className={`${s.top} ${s.tGreen}`} />
                <div className={s.slbl}>Leads</div>
                <div className={s.sval}>{aiLeads == null ? "…" : fmt(aiLeads)}</div>
                <div className={s.sof}>{pct(rate)} of AI visitors</div>
                <div className={s.sstep}>AED 0 CPL</div>
                <div className={s.sdesc}>vs {aiLeadsPrev == null ? "…" : fmt(aiLeadsPrev)} in {monLong(prev)}</div>
              </div>
              <div className={s.stage}>
                <span className={`${s.top} ${s.tOrange}`} />
                <div className={s.slbl}>Qualified → Deals</div>
                <div className={s.sval}>{L ? `${stageN(L, "ai", "Qualified")} → ${L.deals.ai}` : "…"}</div>
                <div className={s.sof}>{L ? `${stageN(L, "ai", "Qualified")} qualified · ${L.deals.ai} deals` : "—"}</div>
                <div className={s.sstep}>
                  {!L ? "…"
                    : leads?.ytdDeals && !cur.endsWith("-01")
                      ? `${leads.ytdDeals.ai} AI deal${leads.ytdDeals.ai === 1 ? "" : "s"} since January`
                      : `${L.deals.ai} AI deal${L.deals.ai === 1 ? "" : "s"} this month`}
                </div>
                <div className={s.sdesc}>{LP ? `${vs}: ${stageN(LP, "ai", "Qualified")} qualified · ${LP.deals.ai} deals` : ""}</div>
              </div>
            </div>
          </Section>

          {/* ── Assistant by assistant ──────────────────────────────── */}
          <Section title="Assistant by assistant" note={`${monYear(cur)} vs ${monShort(prev)} · top entry pages below each`}>
            <div className={s.grid5}>
              {ai.assistants.map((a) => {
                const before = aiP.assistants.find((x) => x.key === a.key)?.visitors ?? 0;
                const d = pctDelta(a.visitors, before, `${vs} (${fmt(before)})`);
                const series = ytd.map((m) => m.byAssistant[a.key] ?? 0);
                const peak = Math.max(0, ...series);
                const leadsN = leadsByAssistant.get(a.key) ?? 0;
                const noneThisYear = metabaseOk && ytdLeadsFor(a.key) === 0;
                return (
                  <div key={a.key} className={s.chcard}>
                    <div className={s.nm}>{a.label}</div>
                    <div className={s.dom}>{DOMAINS[a.key] ?? ""}</div>
                    <div className={s.big}>{fmt(a.visitors)}</div>
                    <div className={s.u}>visitors in {monLong(cur)}</div>
                    {/* Always one line, so the five cards line up even when a month has no baseline. */}
                    <div className={cx("delta", d ? d.dir : "flat")} style={{ marginTop: 6 }}>
                      {d ? d.text : `new — none in ${monShort(prev)}`}
                    </div>
                    <Spark values={series} />
                    <div className={s.u}>{ytd.length ? `${monShort(ytd[0].month)}–${monShort(cur)}` : ""} visitors · peak {fmt(peak)}</div>
                    <div className={s.mini}>
                      {noneThisYear
                        ? <><b>0</b> leads in {ytd.length} month{ytd.length === 1 ? "" : "s"}</>
                        : <><b>{L ? fmt(leadsN) : "…"}</b> lead{L && leadsN === 1 ? "" : "s"}</>}
                      {" · "}{fmt(a.sessions)} sessions · {a.visitors ? (a.pageviews / a.visitors).toFixed(1) : "—"} pages/visitor
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {a.topEntryPages.length ? a.topEntryPages.map((p) => (
                        <div key={p.path} className={s.pageRow}>
                          <span title={p.path}>{shortPage(p.path)}</span>
                          <b>{fmt(p.visitors)}</b>
                        </div>
                      )) : <div className={s.empty}>No arrivals this month.</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          {/* ── Traffic by assistant ────────────────────────────────── */}
          <Section title="Traffic by assistant" note="PostHog · unique visitors">
            <div className={s.grid2}>
              <Card title={`${monLong(cur)} share of the AI channel`} cap={`Visitors · ${monYear(cur)}`}>
                <div className={s.donutRow}>
                  <Donut
                    parts={ai.assistants.map((a, i) => ({ value: a.visitors, color: DONUT[i] ?? "#ccc" }))}
                    centre={ai.visitors ? `${Math.round(((ai.assistants[0]?.visitors ?? 0) / ai.visitors) * 100)}%` : "—"}
                    centreSub={(ai.assistants[0]?.label ?? "").toUpperCase()}
                  />
                  <div className={s.legendList}>
                    {ai.assistants.map((a, i) => (
                      <div key={a.key} className={s.legendRow}>
                        <span className={s.sq} style={{ background: DONUT[i] }} />
                        <span className={s.lname}>{a.label}</span>
                        <b>{fmt(a.visitors)}</b>
                        <small>{ai.visitors ? pct(a.visitors / ai.visitors) : "—"}</small>
                      </div>
                    ))}
                  </div>
                </div>
                <Tot label={`Total AI visitors · ${vs} ${fmt(aiP.visitors)}`} value={fmt(ai.visitors)} />
              </Card>
              <Card title="Month by month" cap={`Visitors per assistant · ${rangeLabel}`}>
                <div className={s.scroll}>
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th>
                        {ai.assistants.map((a) => <th key={a.key} className={s.r}>{a.label}</th>)}
                        <th className={s.r}>Total AI</th><th className={s.r}>% of organic</th><th className={s.r}>AI leads</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ytd.map((m) => (
                        <tr key={m.month} className={m.month === cur ? s.emph : undefined}>
                          <td className={s.b}>{monShort(m.month)}</td>
                          {ai.assistants.map((a) => <td key={a.key} className={s.r}>{fmt(m.byAssistant[a.key] ?? 0)}</td>)}
                          <td className={s.r}>{fmt(m.aiVisitors)}</td>
                          <td className={s.r}>{pct(m.aiShareOfOrganic)}</td>
                          <td className={s.r}>{fmt(m.aiLeads)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </Section>

          {/* ── Top pages by views ──────────────────────────────────── */}
          <Section title="Top pages by views" note={`PostHog · all traffic · ${monYear(cur)}`}>
            <div className={s.stack}>
              <div className={s.grid2}>
                <Card highlight title="Most viewed pages" cap={`All channels · ${monYear(cur)}`}>
                  <table>
                    <thead><tr><th>Page</th><th className={s.r}>Visitors</th><th className={s.r}>Views</th></tr></thead>
                    <tbody>
                      {ai.topPages.slice(0, 12).map((p) => (
                        <tr key={p.path}>
                          <td>{pageName(p.path).main === p.path ? p.path : pageName(p.path).main}</td>
                          <td className={s.r}>{fmt(p.visitors)}</td>
                          <td className={`${s.r} ${s.b}`}>{fmt(p.views)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Tot label={`All pageviews, all channels, ${monLong(cur)} · bots excluded`} value={fmt(ai.allPageviews)} />
                </Card>
                <Card highlight title="By site section" cap="The same month, grouped · views">
                  {ai.sections.map((x) => (
                    <Bar
                      key={x.key}
                      name={x.label}
                      value={x.views}
                      max={sectionsMax}
                      color={x.key === "careers" ? "green" : "navy"}
                      right={<>{fmt(x.views)}<small>{fmt(x.visitors)} vis</small></>}
                    />
                  ))}
                  {careers && (
                    <>
                      <Tot label={`Careers is the ${ord(careersRank)} section of the whole site`} value={fmt(careers.views)} />
                      <p className={s.note}>
                        Careers pages drew {fmt(careers.views)} views in {monLong(cur)} — the same pattern the AI channel shows, but sitewide.
                      </p>
                    </>
                  )}
                </Card>
              </div>
              <Card title="Property listings by views" cap={`All channels · ${ai.propertyViews.length} listings with traffic · ${ai.propertyViews.filter((p) => p.kind === "buy").length} buy · ${ai.propertyViews.filter((p) => p.kind === "rent").length} rent`}>
                <table>
                  <thead><tr><th>Listing</th><th>Type</th><th className={s.r}>Visitors</th><th className={s.r}>Views</th></tr></thead>
                  <tbody>
                    {ai.propertyViews.slice(0, 10).map((p) => (
                      <tr key={p.path}>
                        <td>{p.slug}</td>
                        <td>{p.kind === "buy" ? <Tag kind="up">Buy</Tag> : p.kind === "rent" ? <Tag kind="b">Rent</Tag> : "—"}</td>
                        <td className={s.r}>{fmt(p.visitors)}</td>
                        <td className={`${s.r} ${s.b}`}>{fmt(p.views)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!ai.propertyViews.length && <div className={s.empty}>No individual listing pages viewed this month.</div>}
              </Card>
            </div>
          </Section>

          {/* ── Target keyword rankings ─────────────────────────────── */}
          <Section
            title="Target keyword rankings"
            note={`GSC average position · ${monLong(prev)} → ${monYear(cur)} · ${kw.length} keywords`}
          >
            <Card highlight>
              <div className={s.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th>Keyword</th><th className={s.r}>{vs}</th><th className={s.r}>{monShort(cur)}</th><th className={s.r}>Δ</th>
                      <th className={s.r}>Clicks</th><th className={s.r}>Impressions</th><th>Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...kw].sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0)).map((k) => (
                      <tr key={k.keyword}>
                        <td>
                          {k.keyword}
                          {k.delta != null && k.delta > 0 && <Tag kind="focus">next month focus</Tag>}
                        </td>
                        <td className={s.r}>{k.before?.toFixed(1) ?? "—"}</td>
                        <td className={`${s.r} ${s.b}`}>{k.position?.toFixed(1) ?? "—"}</td>
                        <td className={s.r}>{k.delta == null ? "—" : `${k.delta > 0 ? "+" : ""}${k.delta.toFixed(1)}`}</td>
                        <td className={s.r}>{k.clicks ? fmt(k.clicks) : "—"}</td>
                        <td className={s.r}>{k.impressions ? fmt(k.impressions) : "—"}</td>
                        <td>
                          {k.delta == null ? <Tag kind="flat">no data</Tag>
                            : k.delta < 0 ? <Tag kind="up">improved</Tag>
                            : k.delta > 0 ? <Tag kind="down">declined</Tag>
                            : <Tag kind="flat">flat</Tag>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Tot
                label={`${improved} improved · ${declined} declined · aggregate target position ${aggBefore?.toFixed(1) ?? "—"} → ${aggNow?.toFixed(1) ?? "—"} · overall site position ${gscP ? gscP.position.toFixed(1) : "—"} → ${gsc ? gsc.position.toFixed(1) : "—"}`}
                value={aggNow?.toFixed(1) ?? "—"}
              />
              {r.gsc.error && <p className={s.note}>{r.gsc.error}</p>}
            </Card>
          </Section>

          {/* ── AI leads in detail ──────────────────────────────────── */}
          <Section title="AI leads in detail" note="Metabase · betterhomes DB 14 · live">
            <div className={s.stack}>
              <div className={s.grid2}>
                <Card title="Leads & cost per lead" cap={`AI vs organic · ${rangeLabel}`}>
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th><th className={s.r}>AI leads</th><th className={s.r}>Organic leads</th>
                        <th className={s.r}>Combined</th><th className={s.r}>AI share</th><th className={s.r}>CPL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ytd.map((m) => {
                        const comb = m.aiLeads + m.organicLeads;
                        return (
                          <tr key={m.month} className={m.month === cur ? s.emph : undefined}>
                            <td className={s.b}>{monShort(m.month)}</td>
                            <td className={s.r}>{fmt(m.aiLeads)}</td>
                            <td className={s.r}>{fmt(m.organicLeads)}</td>
                            <td className={s.r}>{fmt(comb)}</td>
                            <td className={s.r}>{comb ? pct(m.aiLeads / comb) : "—"}</td>
                            <td className={s.r}>AED 0</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <Tot label={`${monLong(cur)} combined organic + AI · all at 0 CPL`} value={mCur ? fmt(mCur.aiLeads + mCur.organicLeads) : "—"} />
                </Card>

                <Card highlight title="Leads & deals" cap={`Segments · ${monLong(cur)} vs ${monLong(prev)} ${cur.slice(0, 4)}`}>
                  {leadsError && <div className={s.empty}>CRM unavailable: {leadsError}</div>}
                  {!L && !leadsError && <div className={s.empty}>Loading the CRM figures…</div>}
                  {L && LP && (
                    <>
                      <table>
                        <thead><tr><th>Segment</th><th className={s.r}>{monShort(cur)}</th><th className={s.r}>{vs}</th><th className={s.r}>Δ</th></tr></thead>
                        <tbody>
                          <tr><td className={s.b}>AI referral leads</td><td className={`${s.r} ${s.b}`}>{fmt(L.aiLeads)}</td><td className={s.r}>{fmt(LP.aiLeads)}</td><td className={s.r}><PctTag now={L.aiLeads} before={LP.aiLeads} /></td></tr>
                          <tr><td>Organic leads (website / pop-up, no UTM)</td><td className={s.r}>{fmt(L.organicLeads)}</td><td className={s.r}>{fmt(LP.organicLeads)}</td><td className={s.r}><PctTag now={L.organicLeads} before={LP.organicLeads} /></td></tr>
                          <tr><td className={s.indent}>Website enquiries · no UTM</td><td className={s.r}>{fmt(L.websiteNoUtm)}</td><td className={s.r}>{fmt(LP.websiteNoUtm)}</td><td className={s.r}><PctTag now={L.websiteNoUtm} before={LP.websiteNoUtm} /></td></tr>
                          <tr><td className={s.indent}>Website pop-up</td><td className={s.r}>{fmt(L.popup)}</td><td className={s.r}>{fmt(LP.popup)}</td><td className={s.r}><PctTag now={L.popup} before={LP.popup} /></td></tr>
                          <tr><td>Organic deals created</td><td className={s.r}>{fmt(L.deals.organic)}</td><td className={s.r}>{fmt(LP.deals.organic)}</td><td className={s.r}><DeltaTag now={L.deals.organic} before={LP.deals.organic} /></td></tr>
                          <tr><td>AI deals created</td><td className={s.r}>{fmt(L.deals.ai)}</td><td className={s.r}>{fmt(LP.deals.ai)}</td><td className={s.r}><DeltaTag now={L.deals.ai} before={LP.deals.ai} /></td></tr>
                        </tbody>
                      </table>
                      <Tot label="All organic and AI leads at AED 0 CPL" value={fmt(L.aiLeads + L.organicLeads)} />
                      <p className={s.note}>
                        Deals are attributed to the channel of the lead behind them. Organic counts website enquiries and pop-ups with no UTM source.
                      </p>
                    </>
                  )}
                </Card>
              </div>

              <div className={s.grid2}>
                <Card title="Landing pages behind AI traffic" cap={`PostHog · entry page of each AI visitor · ${monYear(cur)}`}>
                  <table>
                    <thead><tr><th>Entry page</th><th className={s.r}>Visitors</th><th className={s.r}>Share</th></tr></thead>
                    <tbody>
                      {ai.entryPages.slice(0, 12).map((p) => {
                        const n = pageName(p.path);
                        return (
                          <tr key={p.path}>
                            <td>{n.main}<small>{n.sub}</small></td>
                            <td className={`${s.r} ${s.b}`}>{fmt(p.visitors)}</td>
                            <td className={s.r}>{ai.visitors ? pct(p.visitors / ai.visitors) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <Tot label={`${fmt(ai.distinctEntryPages)} distinct entry pages · ${fmt(ai.entryPagesSeenOnce)} of them seen just once`} value={fmt(ai.visitors)} />
                </Card>
                <Card title="Traffic by page type" cap={`The same ${fmt(ai.visitors)} visitors, grouped · ${monYear(cur)}`}>
                  {ai.pageTypes.map((t) => (
                    <Bar
                      key={t.label}
                      name={t.label}
                      value={t.value}
                      max={typesMax}
                      color={t.label === "Careers" ? "green" : "navy"}
                      right={<>{fmt(t.value)}<small>{ai.visitors ? `${Math.round((t.value / ai.visitors) * 100)}%` : ""}</small></>}
                    />
                  ))}
                  {!ai.pageTypes.length && <div className={s.empty}>No AI arrivals this month.</div>}
                  {careersType && (
                    <Tot label={`Careers pages · ${ai.visitors ? Math.round((careersType.value / ai.visitors) * 100) : 0}% of all AI arrivals`} value={fmt(careersType.value)} />
                  )}
                </Card>
              </div>

              {/* A full-width card closing this section, as in the report — not a section of its own. */}
              <Card title="Who the AI audience is" cap={`${monYear(cur)} · ${fmt(ai.visitors)} AI visitors · PostHog`}>
                <div className={s.grid2}>
                  <div>
                    {ai.countries.slice(0, 6).map((c, i) => (
                      <Bar
                        key={c.label}
                        name={c.label === "United Arab Emirates" ? "UAE" : c.label}
                        sub={i === 0 ? "Home market" : i === 1 ? "Largest overseas market" : undefined}
                        value={c.value}
                        max={countriesMax}
                      />
                    ))}
                  </div>
                  <div>
                    {ai.devices.map((d) => (
                      <Bar key={d.label} name={d.label} sub={d.label.toLowerCase() === "mobile" ? "ChatGPT app on a phone" : undefined} value={d.value} max={devicesMax} color="tan" />
                    ))}
                    <p className={s.note}>
                      {ai.visitors && mobile ? `${mobile >= ai.visitors / 2 ? "Mobile-led" : "Desktop-led"} — ${pct(mobile / ai.visitors, 0)} of AI visitors on a phone. ` : ""}
                      {fmt(ai.newVisitors)} of them were first-time visitors; {fmt(ai.returningVisitors)} had been to bhomes.com before.
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          </Section>

          {/* ── What AI visitors actually do ────────────────────────── */}
          <Section title="What AI visitors actually do" note={`PostHog events · ${monYear(cur)} · ${fmt(ai.peopleActing)} people took an action`}>
            <div className={s.grid2}>
              <Card title="Actions taken" cap={`People firing each event · ${fmt(ai.actionEvents)} events from ${fmt(ai.peopleActing)} people`}>
                {ai.actions.slice(0, 9).map((a) => (
                  <Bar key={a.label} name={<code>{a.label}</code>} sub={EVENT_LABELS[a.label]} value={a.value} max={actionsMax} />
                ))}
                {!ai.actions.length && <div className={s.empty}>No events from AI visitors this month.</div>}
                {ai.actions.length > 9 && <Tot label={`${ai.actions.length - 9} further events`} value={fmt(ai.peopleActing)} />}
              </Card>
              <Card title="Forms opened and submitted" cap={`form_name · people who opened each form, and how many sent it`}>
                {ai.forms.map((f, i) => (
                  <Bar
                    key={f.label}
                    name={formLabel(f.label)}
                    sub={f.label}
                    value={f.opened || f.value}
                    max={formsOpenedMax}
                    color={i === 0 ? "green" : "tan"}
                    // Inline forms (the contact page) never fire click_open_form, so
                    // "8 of 0" would read as an impossibility. Show what is known.
                    right={f.opened > 0 ? <>{fmt(f.value)}<small>of {fmt(f.opened)}</small></> : <>{fmt(f.value)}<small>sent</small></>}
                  />
                ))}
                {!ai.forms.length && <div className={s.empty}>No forms opened by AI visitors this month.</div>}
                {topForm && topForm.opened > 0 && (
                  <Tot
                    label={`${formLabel(topForm.label)} · ${fmt(topForm.value)} of ${fmt(topForm.opened)} who opened it submitted`}
                    value={pct(topForm.value / topForm.opened, 0)}
                  />
                )}
                <p className={s.note}>
                  Bars are form opens; the figure is submissions. The monthly report&rsquo;s &ldquo;forms submitted&rdquo; counted opens.
                </p>
              </Card>
            </div>
          </Section>

          {/* ── AI visibility (stored, not live) ────────────────────── */}
          <Section title="AI visibility" note={`Semrush AI Visibility · worldwide · entered manually · as at ${monYear(vis.asOf)}`}>
            <div className={s.stack}>
              <div className={s.grid2}>
                <Card title="Semrush AI Visibility" cap={`Worldwide · all AI platforms · ${monYear(vis.asOf)}`}>
                  <table>
                    <thead><tr><th>Metric</th><th className={s.r}>{monShort(vis.asOf)}</th><th className={s.r}>{monShort(prevOf(vis.asOf))}</th><th className={s.r}>MoM</th></tr></thead>
                    <tbody>
                      {([
                        ["Mentions", "times bhomes.com is named in an AI answer", vis.mentions, vis.prevMentions],
                        ["Citations", "times an AI answer links a bhomes.com URL", vis.citations, vis.prevCitations],
                        ["Cited pages", "distinct bhomes.com pages cited", vis.citedPages, vis.prevCitedPages],
                      ] as const).map(([name, sub, now, before]) => (
                        <tr key={name}>
                          <td><b>{name}</b><small>{sub}</small></td>
                          <td className={s.r} style={{ fontFamily: "Georgia, serif", fontSize: 17, color: "#16323d" }}>{fmtK(now, 1e3)}</td>
                          <td className={s.r}>{fmtK(before, 1e3)}</td>
                          <td className={s.r}><PctTag now={now} before={before} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className={s.subhead}>Mentions, month by month</div>
                  <div className={s.note} style={{ marginTop: 2 }}>
                    {vis.mentionsByMonth.map((m) => `${monShort(m.month)} ${fmt(m.mentions)}`).join(" · ")}
                  </div>
                  <Tot label={`Visibility score ${vis.visibilityScore ?? "—"}${vis.visibilityRating ? ` · rated ${vis.visibilityRating}` : ""}`} value={fmt(vis.mentions)} />
                </Card>
                <Card title="Reading the visibility trend" cap={vis.mentions < vis.prevMentions && vis.citations > vis.prevCitations ? "Fewer mentions, but far more of the site being cited" : "Mentions and citations, month on month"}>
                  <div className={s.findings}>
                    <div className={s.finding}>
                      <span className={cx("mk", vis.mentions < vis.prevMentions && "down")} />
                      <div className={s.ft}>
                        <b>Mentions {vis.mentions < vis.prevMentions ? "fell" : "rose"} {Math.abs(Math.round(((vis.mentions - vis.prevMentions) / (vis.prevMentions || 1)) * 100))}%.</b>{" "}
                        {fmt(vis.mentions)} against {fmt(vis.prevMentions)} the month before
                        {vis.mentionsByMonth.length ? `, and a ${fmt(Math.max(...vis.mentionsByMonth.map((m) => m.mentions)))} peak since tracking began` : ""}.
                      </div>
                    </div>
                    <div className={s.finding}>
                      <span className={cx("mk", vis.citations < vis.prevCitations && "down")} />
                      <div className={s.ft}>
                        <b>Citations {fmtK(vis.prevCitations, 1e3)} → {fmtK(vis.citations, 1e3)}, cited pages {fmt(vis.prevCitedPages)} → {fmt(vis.citedPages)}.</b>{" "}
                        AI answers are linking {vis.citedPages >= vis.prevCitedPages ? "more" : "less"} of the site, across {Math.abs(Math.round(((vis.citedPages - vis.prevCitedPages) / (vis.prevCitedPages || 1)) * 100))}% {vis.citedPages >= vis.prevCitedPages ? "more" : "fewer"} distinct pages.
                      </div>
                    </div>
                    {vis.mentions < vis.prevMentions && vis.citations > vis.prevCitations && (
                      <div className={s.finding}>
                        <span className={s.mk} />
                        <div className={s.ft}>
                          <b>That divergence is the story to work on.</b> Being cited without being mentioned wins the click but not the brand — the pages being cited need the brand stated plainly in the answer-shaped sentences AI lifts.
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
              </div>
              <Card title={`Top performing prompts · ${monYear(vis.asOf)}`} cap={`Semrush AI Visibility · ${fmtK(vis.promptsTracked, 1e3)} prompts tracked · ${fmt(vis.promptsMentioned)} mentioned · ${fmtK(vis.promptsCited, 1e3)} cited`}>
                <table>
                  <thead><tr><th>Prompt</th><th>Platform</th><th className={s.r}>bhomes.com</th></tr></thead>
                  <tbody>
                    {vis.topPrompts.map((p, i) => (
                      <tr key={i}>
                        <td>{p.prompt}</td>
                        <td>{p.platform}</td>
                        <td className={s.r}><Tag kind={/mention/i.test(p.result) && /cite/i.test(p.result) ? "up" : "b"}>{p.result}</Tag></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Tot label={`${fmt(vis.promptsMentioned)} mentioned · ${fmtK(vis.promptsCited, 1e3)} cited`} value={fmtK(vis.promptsTracked, 1e3)} />
              </Card>
            </div>
          </Section>

          {/* ── Stage & status ──────────────────────────────────────── */}
          <Section title="Stage & status" note={`CRM lead status · organic vs AI · ${monLong(cur)} vs ${monLong(prev)} ${cur.slice(0, 4)}`}>
            <div className={s.grid2}>
              {(["ai", "organic"] as const).map((seg) => {
                const stages = [...new Set([...(L?.stage ?? []), ...(LP?.stage ?? [])].filter((x) => x.segment === seg).map((x) => x.stage))];
                const types = [...new Set([...(L?.leadType ?? []), ...(LP?.leadType ?? [])].filter((x) => x.segment === seg).map((x) => x.type))];
                const typeN = (d: LeadsData | undefined, t: string) => d?.leadType.find((x) => x.segment === seg && x.type === t)?.n ?? 0;
                return (
                  <Card key={seg} highlight title={seg === "ai" ? "AI leads" : "Organic leads"} cap={`Pipeline stage · ${monLong(cur)} vs ${monLong(prev)}`}>
                    {!L && <div className={s.empty}>{leadsError ? `CRM unavailable: ${leadsError}` : "Loading the CRM figures…"}</div>}
                    {L && (
                      <>
                        <table>
                          <thead><tr><th>Stage</th><th className={s.r}>{monShort(cur)}</th><th className={s.r}>{vs}</th><th className={s.r}>Δ</th></tr></thead>
                          <tbody>
                            {stages.map((st) => (
                              <tr key={st}>
                                <td>{st}</td>
                                <td className={s.r}>{fmt(stageN(L, seg, st))}</td>
                                <td className={s.r}>{fmt(stageN(LP, seg, st))}</td>
                                <td className={s.r}><DeltaTag now={stageN(L, seg, st)} before={stageN(LP, seg, st)} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {seg === "ai" && types.length > 0 && (
                          <>
                            <div className={s.subhead}>Lead type</div>
                            <table>
                              <thead><tr><th>Type</th><th className={s.r}>{monShort(cur)}</th><th className={s.r}>{vs}</th><th className={s.r}>Δ</th></tr></thead>
                              <tbody>
                                {types.map((t) => (
                                  <tr key={t}>
                                    <td>{t}</td>
                                    <td className={s.r}>{fmt(typeN(L, t))}</td>
                                    <td className={s.r}>{fmt(typeN(LP, t))}</td>
                                    <td className={s.r}><DeltaTag now={typeN(L, t)} before={typeN(LP, t)} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </>
                        )}
                        <Tot
                          label={`${fmt(statusN(L, seg, "Open"))} open · ${fmt(statusN(L, seg, "Closed"))} closed (${vs}: ${fmt(statusN(LP, seg, "Open"))} open · ${fmt(statusN(LP, seg, "Closed"))} closed) · ${fmt(seg === "ai" ? L.deals.ai : L.deals.organic)} deals`}
                          value={fmt(segTotal(L, seg))}
                        />
                      </>
                    )}
                  </Card>
                );
              })}
            </div>
          </Section>

          {/* ── Content production (stored, not live) ───────────────── */}
          <Section title="Content production" note={`ClickUp SEO & AIO · entered manually · as at ${monYear(content.asOf)}`}>
            <Card highlight>
              <table>
                <thead><tr><th>Category</th><th className={s.r}>{monShort(content.asOf)}</th><th className={s.r}>{monShort(prevOf(content.asOf))}</th><th className={s.r}>Δ</th><th>Trend</th></tr></thead>
                <tbody>
                  {content.categories.map((c) => {
                    const d = c.current - c.previous;
                    return (
                      <tr key={c.category}>
                        <td>{c.category}</td>
                        <td className={`${s.r} ${s.b}`}>{fmt(c.current)}</td>
                        <td className={s.r}>{fmt(c.previous)}</td>
                        <td className={s.r}>{d > 0 ? `+${d}` : d}</td>
                        <td>{d > 0 ? <Tag kind="up">improved</Tag> : d < 0 ? <Tag kind="down">declined</Tag> : <Tag kind="flat">flat</Tag>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Tot
                label={`Total completed · ${monShort(prevOf(content.asOf))} ${fmt(contentPrev)}${contentPrev ? ` · ${signed(((contentTotal - contentPrev) / contentPrev) * 100)}% MoM` : ""}${content.author ? ` · all ${fmt(contentTotal)} by ${content.author}` : ""}`}
                value={fmt(contentTotal)}
              />
              {biggestShift && biggestShift.current !== biggestShift.previous && (
                <p className={s.note}>
                  {biggestShift.category} went from {biggestShift.previous} to {biggestShift.current} — the largest single shift in the mix.
                </p>
              )}
            </Card>
          </Section>

          {/* ── legend + sources ────────────────────────────────────── */}
          <section className={s.section}>
            <div className={s.legend}>
              <span><i className={s.sw} style={{ background: "#2c537a" }} />Volume</span>
              <span><i className={s.sw} style={{ background: "#6f9b7d" }} />Growth / conversion</span>
              <span><i className={s.sw} style={{ background: "#b85542" }} />Decline</span>
              <span><i className={s.sw} style={{ background: "#f3e6c0" }} />Pending input</span>
            </div>
            <p className={s.foot}>
              Sources: PostHog (pageviews, unique persons by person_id, sessions; AI channel = referring domain matching an
              assistant OR utm_source carrying one; bots excluded) · Metabase betterhomes DB 14 (leads and deals; AI = utm source
              matching chatgpt / openai / perplexity / gemini / claude / copilot; organic = website or pop-up enquiries with no UTM
              source) · Google Search Console ({r.gsc.source === "direct" ? "direct API, web search" : "via Supermetrics, all search types"}).
              AI visibility and content production are entered manually in Settings. Lead counts for a closed month drift as
              attribution backfills. Organic and AI leads carry no media spend — AED 0 CPL throughout.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
