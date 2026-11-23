"use client";

// The SEO tab: the Organic Growth Report. SEO and AI search month by month for
// a year, the last three months set against the three before, in the design
// the report was drawn in (components/seo/growth.module.css). Every figure and
// sentence is worked out from the live series (lib/organicGrowth.ts,
// lib/growthMath.ts); the page holds none of its own.
//
// Visitors and searches arrive with the page. The CRM half is asked for once
// the page is open, and both keep themselves current (useLiveRefresh).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import ChartBox from "@/components/Chart";
import { useLiveRefresh } from "@/components/useLiveRefresh";
import * as ch from "@/components/seo/charts";
import { SEO_SECTION_EVENT, SEO_SECTION_IDS } from "@/components/seo/sections";
import s from "@/components/seo/growth.module.css";
import { ago } from "@/lib/format";
import {
  addCounts, aed, assistantName, change, cumulative, monLong, monShort, monthSpan, moved, num, pctText, ranked,
  sectionName, share, total, weightedPosition, type Num,
} from "@/lib/growthMath";
import { liveUrl } from "@/lib/live";
import type { GrowthCrmMonth, ServiceLine } from "@/lib/metabase";
import type { GrowthCrmReport, GrowthReport } from "@/lib/organicGrowth";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
type Series = (number | null)[];

/** Sections the AI landing chart names; the rest are added up as one bar. */
const LANDING_SHOWN = 8;
/** Assistants the monthly chart stacks by name; the rest share one band. */
const ASSISTANTS_SHOWN = 3;

/** The quarter's total and the three months before it, from a twelve-month series. */
const quarter = (xs: Num[]) => ({ now: total(xs.slice(-3)), before: total(xs.slice(-6, -3)) });

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const d = await res.json().catch(() => null);
  if (!res.ok || !d) throw new Error(d?.error ?? `HTTP ${res.status}`);
  return d as T;
}

export default function SeoDashboard({ initial }: { initial: GrowthReport }) {
  const [report, setReport] = useState<GrowthReport>(initial);
  const [crm, setCrm] = useState<GrowthCrmReport | null>(null);
  const [crmFailed, setCrmFailed] = useState<string | null>(null);

  const refreshReport = useCallback(async () => {
    setReport(await getJson<GrowthReport>(liveUrl("/api/seo/growth")));
  }, []);
  const refreshCrm = useCallback(async () => {
    try {
      setCrm(await getJson<GrowthCrmReport>(liveUrl("/api/seo/growth?part=crm")));
      setCrmFailed(null);
    } catch (e) {
      // The kept figures stay on screen; the CRM line says what went wrong.
      setCrmFailed(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    getJson<GrowthCrmReport>("/api/seo/growth?part=crm")
      .then((d) => {
        if (!alive) return;
        setCrm(d);
        setCrmFailed(null);
      })
      .catch((e) => alive && setCrmFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);
  const updating = useLiveRefresh(report.cachedAt, refreshReport);
  const crmUpdating = useLiveRefresh(crm?.cachedAt, refreshCrm, !!crm);

  // The sidebar lists this page's sections: tell it which is in view, and open on the one a link named.
  useEffect(() => {
    const root = document.getElementById("main");
    const els = SEO_SECTION_IDS.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const inView = new Map<string, boolean>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) inView.set(e.target.id, e.isIntersecting);
        const current = [...SEO_SECTION_IDS].reverse().find((id) => inView.get(id));
        if (current) window.dispatchEvent(new CustomEvent(SEO_SECTION_EVENT, { detail: current }));
      },
      { root, rootMargin: "0px 0px -65% 0px" },
    );
    els.forEach((el) => obs.observe(el));
    const asked = window.location.hash.slice(1);
    if (asked) document.getElementById(asked)?.scrollIntoView();
    return () => obs.disconnect();
  }, []);

  // ── months ────────────────────────────────────────────────────────────────
  const r = report;
  const M = r.months;
  const labels = M.map(monShort);
  const full = M.map((m) => `${monLong(m)} ${m.slice(0, 4)}`);
  const now3 = M.slice(-3), before3 = M.slice(-6, -3);
  const span = monthSpan(now3[0], now3[2]), spanBefore = monthSpan(before3[0], before3[2]);
  const L6 = labels.slice(-6), F6 = full.slice(-6);

  // ── visitors (PostHog) ───────────────────────────────────────────────────
  const T = r.traffic;
  const seo: Series = T.map((t) => t.seo);
  const ai: Series = T.map((t) => t.ai);
  const organic: Series = T.map((t) => (t.seo == null || t.ai == null ? null : t.seo + t.ai));
  const aiShare: Series = T.map((t) => (t.seo == null || t.ai == null || !(t.seo + t.ai) ? null : +((t.ai / (t.seo + t.ai)) * 100).toFixed(1)));
  const qOrganic = quarter(organic), qAi = quarter(ai);

  const order = ranked(T.map((t) => t.byAssistant));
  const shown = order.slice(0, ASSISTANTS_SHOWN).map((o) => o.key);
  const others = order.slice(ASSISTANTS_SHOWN).map((o) => o.key);
  const nameOf = (k: string) => assistantName(k, r.assistantNames[k]);
  const perAssistant = (keys: string[]): Series => T.map((t) => (t.byAssistant ? keys.reduce((n, k) => n + (t.byAssistant?.[k] ?? 0), 0) : null));
  const assistantSets = [
    ...shown.map((k, i) => ({ label: nameOf(k), data: perAssistant([k]), color: ch.ASSISTANT_COLOURS[i] })),
    ...(others.length ? [{ label: others.length === 1 ? nameOf(others[0]) : "Others", data: perAssistant(others), color: ch.ASSISTANT_COLOURS[3] }] : []),
  ];
  const topKey = shown[0];
  const topQuarter = topKey ? total(perAssistant([topKey]).slice(-3)) : null;
  const topShare = topQuarter != null && qAi.now ? topQuarter / qAi.now : null;

  const landingMonths = T.slice(-3).map((t) => t.aiLanding);
  const landing = Object.entries(addCounts(landingMonths)).sort((a, b) => b[1] - a[1]);
  const landingRest = landing.slice(LANDING_SHOWN).reduce((n, [, v]) => n + v, 0);
  const landingLabels = [...landing.slice(0, LANDING_SHOWN).map(([k]) => sectionName(k)), ...(landingRest ? ["Other sections"] : [])];
  const landingValues = [...landing.slice(0, LANDING_SHOWN).map(([, v]) => v), ...(landingRest ? [landingRest] : [])];

  const news6: Series = T.slice(-6).map((t) => t.newsPeople);
  const newsTotal = total(news6);
  const newsSites = Object.entries(addCounts(T.slice(-6).map((t) => t.news))).sort((a, b) => b[1] - a[1]);

  // ── search (Search Console) ──────────────────────────────────────────────
  const S = r.search;
  const clicks: Series = S.map((x) => x?.clicks ?? null);
  const impressions: Series = S.map((x) => x?.impressions ?? null);
  const positions: Series = S.map((x) => x?.position ?? null);
  const brandClicks: Series = S.map((x) => x?.brandClicks ?? null);
  const brandImpressions: Series = S.map((x) => x?.brandImpressions ?? null);
  const otherClicks: Series = S.map((x) => (x && x.brandClicks != null ? x.clicks - x.brandClicks : null));
  const hasBrand = brandClicks.some((v) => v != null);
  const posNow = weightedPosition(S.slice(-3)), posBefore = weightedPosition(S.slice(-6, -3));
  const qClicks = quarter(clicks), qImpressions = quarter(impressions), qBrand = quarter(brandClicks);

  // ── the CRM half ─────────────────────────────────────────────────────────
  const R = crm?.crm ?? null;
  const crmError = crmFailed ?? crm?.error ?? (crm && !crm.connected ? "Metabase is not connected" : null);
  const crmReady = !!R && R.every(Boolean) && !crmError;
  const pick = (f: (m: GrowthCrmMonth) => number): Series => M.map((_, i) => (crmReady && R?.[i] ? f(R[i] as GrowthCrmMonth) : null));
  const leads = pick((m) => m.leads.total), aiLeads = pick((m) => m.aiLeads.total);
  const lineLeads = (k: ServiceLine) => pick((m) => m.leads[k]);
  const lineAi = (k: ServiceLine) => pick((m) => m.aiLeads[k]);
  const listedSale = pick((m) => m.listed.sale), listedRent = pick((m) => m.listed.rent);
  const listed = pick((m) => m.listed.sale + m.listed.rent);
  const reservedSale = pick((m) => m.reserved.sale), reservedRent = pick((m) => m.reserved.rent);
  const reserved = pick((m) => m.reserved.sale + m.reserved.rent);
  const completedSale = pick((m) => m.completed.sale), completedRent = pick((m) => m.completed.rent);
  const completed = pick((m) => m.completed.sale + m.completed.rent);
  const commCompletedSale = pick((m) => m.commission.completedSale), commCompletedRent = pick((m) => m.commission.completedRent);
  const commAwaiting = pick((m) => m.commission.awaiting);
  const commission = pick((m) => m.commission.completedSale + m.commission.completedRent + m.commission.awaiting);
  const qLeads = quarter(leads), qAiLeads = quarter(aiLeads), qListed = quarter(listed), qReserved = quarter(reserved), qCompleted = quarter(completed);
  const qCommission = quarter(commission);
  const qCommCompleted = total([...commCompletedSale.slice(-3), ...commCompletedRent.slice(-3)]);
  const qAwaiting = total(commAwaiting.slice(-3));
  const otherLine = lineLeads("other");
  const per100 = (a: Series): Series => a.map((v, i) => (v == null || !leads[i] ? null : +((v / (leads[i] as number)) * 100).toFixed(1)));
  /** What a CRM figure shows while the CRM half is on its way, or when it failed. */
  const crmWait = crmError ? "CRM unavailable" : "Loading the CRM…";
  const crmValue = (v: number | null, f: (n: number) => string = num) => (crmReady && v != null ? f(v) : crmError ? "—" : "…");

  // ── takeaways, from the figures ─────────────────────────────────────────
  const listedChange = change(qListed.now, qListed.before);
  const glance = crmReady ? (
    <>Properties listed with us <b>{moved(listedChange)}</b> and AI visitors <b>{moved(change(qAi.now, qAi.before))}</b> on {spanBefore}.
      {qReserved.now && qCompleted.now != null && qCompleted.now < qReserved.now / 2 ? ` Completions lag: most ${span} deals are still reserved.` : ""}</>
  ) : (
    <>Organic visitors <b>{moved(change(qOrganic.now, qOrganic.before))}</b> and AI visitors <b>{moved(change(qAi.now, qAi.before))}</b> on {spanBefore}.</>
  );

  const lastSeo = seo[seo.length - 1];
  const higherBefore = lastSeo == null ? -1 : seo.slice(0, -1).map((v, i) => ({ v, i })).filter((x) => x.v != null && (x.v as number) > lastSeo).pop()?.i ?? -1;
  const firstShare = aiShare.find((v) => v != null), lastShare = aiShare[aiShare.length - 1];
  const firstShareMonth = M[aiShare.findIndex((v) => v != null)];
  const reachLine =
    lastSeo == null ? <>PostHog has not answered for {monLong(M[M.length - 1])} yet.</> : (
      <>
        {higherBefore === -1
          ? <>{monLong(M[M.length - 1])} was the strongest SEO month of the twelve at <b>{num(lastSeo)} visitors</b></>
          : higherBefore < M.length - 2
            ? <>{monLong(M[M.length - 1])} was the strongest SEO month since {monLong(M[higherBefore])} at <b>{num(lastSeo)} visitors</b></>
            : <>SEO brought <b>{num(lastSeo)} visitors</b> in {monLong(M[M.length - 1])}</>}
        {lastShare != null && firstShare != null
          ? <>; AI assistants now bring about <b>{Math.round(lastShare)}%</b> of organic visitors, {lastShare >= firstShare ? "up" : "down"} from {Math.round(firstShare)}% in {monLong(firstShareMonth)} {firstShareMonth.slice(0, 4)}.</>
          : "."}
      </>
    );
  const reachTitle = (qOrganic.now ?? 0) >= (qOrganic.before ?? 0) ? "More people are finding us" : "Fewer people are finding us";

  // Positions as the page shows them, to one decimal: 14.1 against 14.1 has not moved.
  const posMove = posNow == null || posBefore == null ? 0 : Math.sign(+posNow.toFixed(1) - +posBefore.toFixed(1));
  const visibilityLine =
    posNow == null ? <>Search Console has not answered for {span} yet.</> : (
      <>
        {posBefore == null || posMove === 0
          ? <>Average Google position held at <b>{posNow.toFixed(1)}</b></>
          : <>Average Google position {posMove < 0 ? "improved" : "slipped"} from <b>{posBefore.toFixed(1)}</b> to <b>{posNow.toFixed(1)}</b></>}
        , with clicks <b>{moved(change(qClicks.now, qClicks.before))}</b> and impressions {moved(change(qImpressions.now, qImpressions.before))}, against {spanBefore}.
      </>
    );
  const visibilityTitle = posMove > 0 ? "Slipping in the rankings" : posMove < 0 ? "Climbing the rankings" : "Holding our rankings";

  const aiLine = (
    <>{topKey ? <>{nameOf(topKey)} brings <b>{share(topShare, 0)}</b> of AI visitors</> : "No AI visitors yet"}
      {crmReady ? <>; enquiries from AI assistants <b>{moved(change(qAiLeads.now, qAiLeads.before))}</b> to <b>{num(qAiLeads.now)}</b> this quarter.</> : "."}</>
  );

  const brandAvg = qBrand.now == null ? null : qBrand.now / 3;
  const prLine = (
    <>{hasBrand && brandAvg != null
        ? <>Branded search averaged <b>{num(brandAvg)} clicks a month</b> ({moved(change(qBrand.now, qBrand.before))} on {spanBefore}); </>
        : null}
      news and media sites sent <b>{newsTotal == null ? "—" : num(newsTotal)}</b> visitor{newsTotal === 1 ? "" : "s"} in six months.</>
  );

  const impactLine = crmReady ? (
    <><b>{num(qListed.now)} properties listed with us</b>, {num(qReserved.now)} reservations and {num(qCompleted.now)} completed deals from organic
      visitors this quarter, with <b>{aed(qAwaiting)}</b> reserved and awaiting completion.</>
  ) : <>{crmWait}</>;

  const saleListed = change(quarter(listedSale).now, quarter(listedSale).before), rentListed = change(quarter(listedRent).now, quarter(listedRent).before);
  const biggest = Math.abs(rentListed ?? 0) >= Math.abs(saleListed ?? 0) ? { name: "Rent", c: rentListed } : { name: "Sale", c: saleListed };
  const linesLine = crmReady ? (
    <>{biggest.name} listings <b>{moved(biggest.c)}</b>; property management brought <b>{num(quarter(lineLeads("pm")).now)}</b> enquiries and off-plan{" "}
      {num(quarter(lineLeads("offplan")).now)} this quarter.</>
  ) : <>{crmWait}</>;

  // ── page ─────────────────────────────────────────────────────────────────
  const problems = r.sources.filter((x) => x.state !== "ok");
  const updatedAt = r.cachedAt ?? r.generatedAt;

  return (
    <div className={s.report}>
      <header className={s.top}>
        <div>
          <h1>Organic Growth Report: SEO and AI search</h1>
          <p>bhomes.com · all service lines · organic search and AI assistants</p>
        </div>
        <div className={s.controls}>
          <span className={s.chip}>Last three months: {span}</span>
          <span className={s.chip}>vs {spanBefore}</span>
          <span className={s.chip} suppressHydrationWarning title={`Worked out ${new Date(updatedAt).toLocaleString("en-GB")}`}>
            Updated {ago(updatedAt)}{updating || crmUpdating ? " · getting the latest" : ""}
          </span>
        </div>
      </header>

      <div className={s.main}>
        {problems.map((x) => <div key={x.name} className={s.alert}><b>{x.name}</b>: {x.detail}</div>)}
        {crmError && <div className={s.alert}><b>CRM</b>: {crmError}</div>}
        <div className={s.legend}>
          <span><i style={{ background: ch.C.seo }} />SEO (organic search)</span>
          <span><i style={{ background: ch.C.ai }} />AI assistants</span>
          <span><i style={{ background: ch.C.pr }} />Brand and PR</span>
          <span><i style={{ background: ch.C.biz }} />Business outcomes</span>
        </div>

        {/* ── 01 Growth at a glance ───────────────────────────────────── */}
        <Section id="glance" n="01" eyebrow="Growth at a glance" title="The quarter in seven numbers" takeaway={glance} src="All sources">
          <div className={s.kpis}>
            <Kpi label="Organic visitors" value={num(qOrganic.now)} q={qOrganic} sub="SEO + AI · careers excluded" spark={organic} color={ch.C.seo} />
            <Kpi label="AI visitors" value={num(qAi.now)} q={qAi} sub={order.slice(0, 5).map((o) => nameOf(o.key)).join(", ") || "PostHog's AI channel"} spark={ai} color={ch.C.ai} />
            <Kpi label="Organic leads" value={crmValue(qLeads.now)} q={crmReady ? qLeads : null} sub={crmReady ? `People · ${num(qAiLeads.now)} from AI` : crmWait} spark={leads} color={ch.C.biz} />
            <Kpi label="Listed with us" value={crmValue(qListed.now)} q={crmReady ? qListed : null} sub={crmReady ? `${num(quarter(listedSale).now)} sale · ${num(quarter(listedRent).now)} rent` : crmWait} spark={listed} color={ch.C.biz} />
            <Kpi label="Reservations" value={crmValue(qReserved.now)} q={crmReady ? qReserved : null} sub={crmReady ? `${num(quarter(reservedSale).now)} sale · ${num(quarter(reservedRent).now)} rent` : crmWait} spark={reserved} color={ch.C.biz} />
            <Kpi label="Deals completed" value={crmValue(qCompleted.now)} q={crmReady ? qCompleted : null} sub={crmReady ? `${num(quarter(completedSale).now)} sale · ${num(quarter(completedRent).now)} rent` : crmWait} spark={completed} color={ch.C.biz} />
            <Kpi label="Commission" value={crmValue(qCommission.now, aed)} q={crmReady ? qCommission : null} sub={crmReady ? `${aed(qCommCompleted)} completed · ${aed(qAwaiting)} reserved` : crmWait} spark={commission} color={ch.C.biz} />
          </div>
        </Section>

        {/* ── 02 Organic reach ────────────────────────────────────────── */}
        <Section id="reach" n="02" eyebrow="Organic reach" title={reachTitle} takeaway={reachLine} src="PostHog">
          <div className={s.grid}>
            <Card className={cx(s.feature, s.span2)} title="SEO and AI visitors by month" tag="unique visitors"
              note="People arriving from search engines or AI assistants, as PostHog files their visit. Careers pages and bots left out. Tracking starts 10 Oct 2025.">
              <Plot spec={ch.reach(labels, full, seo, ai)} tall />
            </Card>
            <Card title="AI share of organic" tag="%">
              <Plot spec={ch.percentLine(labels, full, "AI share of organic", aiShare, ch.C.ai)} tall />
            </Card>
          </div>
        </Section>

        {/* ── 03 Search visibility ────────────────────────────────────── */}
        <Section id="visibility" n="03" eyebrow="Search visibility" title={visibilityTitle} takeaway={visibilityLine} src="Google Search Console">
          <div className={s.grid}>
            <Card title="Clicks and impressions" tag="monthly">
              <Plot spec={ch.twoLines(labels, full, { label: "Clicks", data: clicks, color: ch.C.seo }, { label: "Impressions", data: impressions, color: ch.C.seoSoft })} />
            </Card>
            <Card title="Average position" tag="lower is better">
              <Plot spec={ch.position(labels, full, positions)} />
            </Card>
            <Card title="Branded and non-branded clicks" tag="monthly"
              note={hasBrand ? undefined : "The brand split needs Search Console read directly: Settings, SEO source."}>
              {hasBrand
                ? <Plot spec={ch.stackedBars(labels, full, [{ label: "Non-branded", data: otherClicks, color: ch.C.seo }, { label: "Branded", data: brandClicks, color: ch.C.seoSoft }])} />
                : <Waiting text="Not available from this source." />}
            </Card>
            <Card className={s.span3} title="Top searches" tag={`avg position · ${spanBefore} → ${span}`}
              note={`The quarter's ${r.keywords.length} top searches by clicks, brand searches left out. Blue rose or held, red fell; a missing grey bar means the search did not appear in ${spanBefore}.`}>
              {r.keywords.length
                ? <Plot spec={ch.keywords(r.keywords, spanBefore, span)} height={Math.max(240, r.keywords.length * 30)} />
                : <Waiting text="Search Console returned no searches for this quarter." />}
            </Card>
          </div>
        </Section>

        {/* ── 04 AI search ────────────────────────────────────────────── */}
        <Section id="ai" n="04" eyebrow="AI search" title="Showing up in AI answers" takeaway={aiLine} src="PostHog · Engage CRM">
          <div className={s.grid}>
            <Card title="Visitors by assistant" tag="monthly"
              note={others.length > 1 ? `Others: ${others.map(nameOf).join(", ")}.` : undefined}>
              <Plot spec={ch.stackedBars(labels, full, assistantSets)} />
            </Card>
            <Card title="Enquiries from AI assistants" tag="CRM · people per month">
              {crmReady ? <Plot spec={ch.bars(labels, full, "People enquiring from AI assistants", aiLeads, ch.C.ai)} /> : <Waiting text={crmWait} />}
            </Card>
            <Card title="Where AI visitors land" tag={`${span} · careers excluded`}
              note="The section of the first page each AI visitor read, by the site's own folders.">
              {landingMonths.every(Boolean)
                ? <Plot spec={ch.sideways(landingLabels, landingValues, ch.C.ai, "AI visitors")} />
                : <Waiting text="PostHog did not answer for every month of the quarter." />}
            </Card>
          </div>
        </Section>

        {/* ── 05 Digital PR ───────────────────────────────────────────── */}
        <Section id="pr" n="05" eyebrow="Digital PR" title="Brand demand" takeaway={prLine} src="Google Search Console · PostHog">
          <div className={s.grid}>
            <Card className={s.span2} title="Branded search demand" tag="searches for betterhomes · monthly">
              {hasBrand
                ? <Plot spec={ch.twoLines(labels, full, { label: "Branded clicks", data: brandClicks, color: ch.C.pr }, { label: "Branded impressions", data: brandImpressions, color: ch.C.prSoft })} />
                : <Waiting text="The brand split needs Search Console read directly: Settings, SEO source." />}
            </Card>
            <Card title="Visitors from news and media" tag={monthSpan(M[M.length - 6], M[M.length - 1])}>
              <div className={s.stat}>{newsTotal == null ? "—" : num(newsTotal)}</div>
              <p className={s.note} style={{ marginTop: 0 }}>
                {newsTotal == null ? "PostHog or the press bot's coverage did not answer." : newsTotal === 0 ? "visitors in six months." : `visitors in six months${newsSites.length ? `, mostly ${newsSites.slice(0, 2).map(([k]) => k).join(" and ")}` : ""}.`}
              </p>
              <div className={s.chart} style={{ height: 150 }}>
                <ChartBox {...ch.bars(L6, F6, "Visitors from news and media", news6, ch.C.prSoft)} />
              </div>
              <p className={s.note}>
                Counted from the {r.newsSites == null ? "" : `${num(r.newsSites)} `}sites the press bot has found covering betterhomes, so a publication joins
                as soon as it writes about us.
              </p>
            </Card>
          </div>
        </Section>

        {/* ── 06 Business impact ──────────────────────────────────────── */}
        <Section id="impact" n="06" eyebrow="Business impact" title="From visitors to commission" takeaway={impactLine} src="Engage CRM">
          <div className={s.grid}>
            <Card className={cx(s.feature, s.span2)} title="Organic funnel" tag={`${span} · share of previous stage`}
              note="Visitors and leads are each month's people added up. Listings, reservations and completions are counted for those people from their first organic enquiry on.">
              <Funnel steps={[
                ["Organic visitors", qOrganic.now],
                ["Leads (people)", crmReady ? qLeads.now : null],
                ["Listed with us", crmReady ? qListed.now : null],
                ["Reservations", crmReady ? qReserved.now : null],
                ["Completed", crmReady ? qCompleted.now : null],
              ]} />
            </Card>
            <Card title="Conversion per 100 leads" tag="monthly">
              {crmReady ? <Plot spec={ch.perHundred(labels, full, per100(listed), per100(reserved))} /> : <Waiting text={crmWait} />}
            </Card>
            <Card title="Leads by service line" tag="people per month">
              {crmReady
                ? <Plot spec={ch.stackedBars(labels, full, [
                    { label: "Sale", data: lineLeads("sale"), color: ch.C.biz },
                    { label: "Rent", data: lineLeads("rent"), color: ch.C.bizMid },
                    { label: "Off-plan", data: lineLeads("offplan"), color: ch.C.biz2 },
                    { label: "Property management", data: lineLeads("pm"), color: ch.C.biz3 },
                    ...(otherLine.some((v) => v) ? [{ label: "Type not set", data: otherLine, color: ch.C.before }] : []),
                  ])} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card title="Listed with us" tag="monthly and cumulative">
              {crmReady
                ? <Plot spec={ch.barsAndLine(labels, full, [{ label: "Sale", data: listedSale, color: ch.C.biz }, { label: "Rent", data: listedRent, color: ch.C.biz2 }],
                    { label: "Cumulative", data: cumulative(listed), color: ch.C.bizDark }, { stacked: true })} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card title="Reservations and completed deals" tag="sale and rent">
              {crmReady
                ? <Plot spec={ch.dealBars(labels, full, { sale: reservedSale, rent: reservedRent }, { sale: completedSale, rent: completedRent })} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card className={s.span3} title="Commission" tag="AED gross · completed and reserved · cumulative line"
              note="Deals are dated by the month they were recorded, at reservation. Recent months look light on completions because most of those deals have not completed yet; the reserved bar shows what is waiting.">
              {crmReady
                ? <Plot spec={ch.barsAndLine(labels, full, [
                    { label: "Completed · sale", data: commCompletedSale, color: ch.C.biz },
                    { label: "Completed · rent", data: commCompletedRent, color: ch.C.biz2 },
                    { label: "Reserved, not yet completed", data: commAwaiting, color: ch.C.biz3 },
                  ], { label: "Cumulative", data: cumulative(commission), color: ch.C.bizDark }, { stacked: true, money: true })} />
                : <Waiting text={crmWait} />}
            </Card>
          </div>
        </Section>

        {/* ── 07 Service lines ────────────────────────────────────────── */}
        <Section id="lines" n="07" eyebrow="Service lines" title="Growth by service line" takeaway={linesLine} src="PostHog · Engage CRM">
          <div className={cx(s.grid, s.two)}>
            {(["sale", "rent"] as const).map((side) => {
              const lead = lineLeads(side);
              const list = side === "sale" ? listedSale : listedRent;
              const res = side === "sale" ? reservedSale : reservedRent;
              const done = side === "sale" ? completedSale : completedRent;
              return (
                <ServiceCard key={side} id={`line-${side}`} icon={side === "sale" ? "S" : "R"} name={side === "sale" ? "Sale" : "Rent"}
                  goal={`Goal: properties listed with us and completed ${side === "sale" ? "sales" : "rentals"}`}
                  minis={[
                    { label: "Leads", ...miniOf(quarter(lead), crmReady) },
                    { label: "Listed with us", ...miniOf(quarter(list), crmReady) },
                    { label: "Reservations", ...miniOf(quarter(res), crmReady) },
                    { label: "Completed", ...miniOf(quarter(done), crmReady) },
                  ]}>
                  {crmReady
                    ? <Plot small spec={ch.barsAndLine(L6, F6, [
                        { label: "Listed with us", data: list.slice(-6), color: ch.C.biz2 },
                        { label: "Reservations", data: res.slice(-6), color: ch.C.biz3 },
                        { label: "Completed", data: done.slice(-6), color: ch.C.biz },
                      ], { label: "Leads", data: lead.slice(-6), color: ch.C.seo }, { axisTitles: ["Count", "Leads"] })} />
                    : <Waiting text={crmWait} />}
                </ServiceCard>
              );
            })}
            {(["offplan", "pm"] as const).map((k) => {
              const enquiries = lineLeads(k), fromAi = lineAi(k);
              const visitors: Series = T.map((t) => (k === "offplan" ? t.offPlan : t.propertyManagement));
              const qe = quarter(enquiries), qv = quarter(visitors);
              const rateNow = qe.now != null && qv.now ? qe.now / qv.now : null;
              const rateBefore = qe.before != null && qv.before ? qe.before / qv.before : null;
              const firstSeen = enquiries.findIndex((v) => (v ?? 0) > 0);
              return (
                <ServiceCard key={k} id={k === "offplan" ? "line-offplan" : "line-pm"} icon={k === "offplan" ? "O" : "P"}
                  name={k === "offplan" ? "Off-plan" : "Property management"} goal="Goal: enquiry forms filled"
                  minis={[
                    { label: "Enquiries", ...miniOf(qe, crmReady) },
                    { label: "Visitors", ...miniOf(qv, true) },
                    { label: "Enquiry rate", value: crmReady ? share(rateNow) : crmValue(null),
                      delta: crmReady && rateBefore != null ? `${share(rateBefore)} last qtr` : crmReady && firstSeen > 0 ? `tracked from ${monShort(M[firstSeen])}` : "", cls: s.flat },
                    { label: "From AI", value: crmValue(quarter(fromAi).now), delta: crmReady ? `of ${num(qe.now)}` : "", cls: s.flat },
                  ]}>
                  <Plot small spec={ch.barsAndLine(L6, F6, [{ label: "Organic visitors to section", data: visitors.slice(-6), color: ch.C.seoSoft }],
                    { label: "Enquiries", data: enquiries.slice(-6), color: ch.C.biz })} />
                </ServiceCard>
              );
            })}
          </div>
        </Section>

        <footer className={s.foot}>
          <dl>
            <dt>Organic visitors</dt>
            <dd>People in visits PostHog files under Organic Search or AI, counted within each month and added up across months. Careers pages and bots are left out.</dd>
            <dt>Search</dt>
            <dd>Google Search Console, web search{r.searchSource === "supermetrics" ? ", through Supermetrics" : ""}. Brand searches are those naming betterhomes, better homes or bhomes.</dd>
            <dt>Leads</dt>
            <dd>
              People with a website enquiry carrying no campaign source, a website pop-up, or an enquiry an AI assistant sent, in the Engage CRM: each person
              once a month and service line. Sale and rent follow the lead&apos;s type; off-plan is an enquiry about an off-plan listing; property management
              comes from the site&apos;s property management form.
            </dd>
            <dt>Listings and deals</dt>
            <dd>
              For those people from their first organic or AI enquiry on: listings they placed with us, and reserved or completed deals on their enquiries or
              their listings, dated by the month the deal was recorded. Commission is gross.
            </dd>
            <dt>News and media</dt>
            <dd>Visitors whose visit began with a link on a site the press bot has found covering betterhomes. Ads and social posts are left out.</dd>
            <dt>Off-plan and property management visitors</dt>
            <dd>Organic visitors who read the site&apos;s off-plan, developers and project search pages, or its property management pages.</dd>
          </dl>
        </footer>
      </div>
    </div>
  );
}

// ── parts ─────────────────────────────────────────────────────────────────

function Section({ id, n, eyebrow, title, takeaway, src, children }: {
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

function Card({ title, tag, note, className, children }: { title: string; tag?: string; note?: string; className?: string; children: ReactNode }) {
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

function Plot({ spec, tall, small, height }: { spec: ch.ChartSpec; tall?: boolean; small?: boolean; height?: number }) {
  return (
    <div className={cx(s.chart, tall && s.tall, small && s.small)} style={height ? { height } : undefined}>
      <ChartBox type={spec.type} data={spec.data} options={spec.options} />
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return <div className={s.waiting}>{text}</div>;
}

function Kpi({ label, value, q, sub, spark, color }: {
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

function Funnel({ steps }: { steps: [string, number | null][] }) {
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

interface Mini { label: string; value: string; delta: string; cls: string }

/** A service line's quarter figure and how it moved: "7 last qtr" when it fell to nothing, "new" when it rose from it. */
function miniOf(q: { now: number | null; before: number | null }, ready: boolean): Omit<Mini, "label"> {
  if (!ready || q.now == null) return { value: ready ? "—" : "…", delta: "", cls: s.flat };
  const value = num(q.now);
  if (q.before == null) return { value, delta: "", cls: s.flat };
  if (q.before === 0) return { value, delta: q.now === 0 ? "none last qtr" : "new", cls: q.now === 0 ? s.flat : "" };
  if (q.now === 0) return { value, delta: `${num(q.before)} last qtr`, cls: s.down };
  const c = change(q.now, q.before);
  return { value, delta: pctText(c), cls: c != null && c < 0 ? s.down : c === 0 ? s.flat : "" };
}

function ServiceCard({ id, icon, name, goal, minis, children }: { id: string; icon: string; name: string; goal: string; minis: Mini[]; children: ReactNode }) {
  return (
    <div id={id} className={s.card} style={{ scrollMarginTop: 16 }}>
      <div className={s.lineHead}>
        <div className={s.lineIcon}>{icon}</div>
        <div>
          <h3>{name}</h3>
          <p className={s.goal}>{goal}</p>
        </div>
      </div>
      <div className={s.minis}>
        {minis.map((m) => (
          <div key={m.label} className={s.mini}>
            <p>{m.label}</p>
            <b>{m.value}</b>
            <span className={m.cls}>{m.delta}</span>
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}
