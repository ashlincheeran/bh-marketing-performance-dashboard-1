"use client";

// The SEO tab: the Organic Growth Report. SEO and AI search month by month,
// for a period picked in the header (lib/growthPeriod.ts, by default the last
// 3 months) set against the months just before, in the design the report was
// drawn in (components/report: shared with the Website tab). Every figure and
// sentence is worked out from the live series (lib/organicGrowth.ts,
// lib/growthMath.ts); the page holds none of its own.
//
// Visitors and searches arrive with the page. The CRM half is asked for once
// the page is open, and both keep themselves current (useLiveRefresh).
import type { ReactNode } from "react";
import ChartBox from "@/components/Chart";
import { PageHeader } from "@/components/ui";
import * as ch from "@/components/report/charts";
import { Card, Funnel, Kpi, PeriodPicker, Plot, Section, Waiting, cx, glanceTitle, type Series } from "@/components/report/Report";
import { useCrmHalf, usePeriodReport } from "@/components/report/usePeriodReport";
import { SEO_SECTIONS, useSectionInView } from "@/components/report/sections";
import s from "@/components/report/report.module.css";
import {
  addCounts, aed, assistantName, change, cumulative, monLong, monShort, monthFrame, moved, num, pctText, ranked,
  sectionName, share, total, weightedPosition,
} from "@/lib/growthMath";
import type { GrowthCrmMonth, ServiceLine } from "@/lib/metabase";
import type { GrowthCrmReport, GrowthReport } from "@/lib/organicGrowth";


/** Sections the AI landing chart names; the rest are added up as one bar. */
const LANDING_SHOWN = 8;
/** Assistants the monthly chart stacks by name; the rest share one band. */
const ASSISTANTS_SHOWN = 3;
export default function SeoDashboard({ initial }: { initial: GrowthReport }) {
  const { report, choice, setChoice, loading, loadError, updating } = usePeriodReport(initial, "/api/seo/growth", "/seo");
  const { crm, failed: crmFailed, updating: crmUpdating } = useCrmHalf<GrowthCrmReport>("/api/seo/growth", report.period, !loading);

  // The sidebar lists this page's sections: tell it which is in view, and open on the one a link named.
  useSectionInView(SEO_SECTIONS);

  // ── months ────────────────────────────────────────────────────────────────
  const r = report;
  const P = r.period;
  /** Every series below runs over these: the comparison, the period and the charts' months, ending with the period. */
  const M = r.months;
  const F = monthFrame(P, M);
  const { iFrom, iTo, cFrom, cTo, per, tr, labels, full, span, spanBefore } = F;
  const nMonths = F.count;
  const MT = F.trendMonths;
  const L6 = labels.slice(-6), F6 = full.slice(-6);

  // ── visitors (PostHog) ───────────────────────────────────────────────────
  const T = r.traffic;
  const seo: Series = T.map((t) => t.seo);
  const ai: Series = T.map((t) => t.ai);
  const organic: Series = T.map((t) => (t.seo == null || t.ai == null ? null : t.seo + t.ai));
  const aiShare: Series = T.map((t) => (t.seo == null || t.ai == null || !(t.seo + t.ai) ? null : +((t.ai / (t.seo + t.ai)) * 100).toFixed(1)));
  const qOrganic = per(organic), qAi = per(ai);

  const order = ranked(tr(T).map((t) => t.byAssistant));
  const shown = order.slice(0, ASSISTANTS_SHOWN).map((o) => o.key);
  const others = order.slice(ASSISTANTS_SHOWN).map((o) => o.key);
  const nameOf = (k: string) => assistantName(k, r.assistantNames[k]);
  const perAssistant = (keys: string[]): Series => T.map((t) => (t.byAssistant ? keys.reduce((n, k) => n + (t.byAssistant?.[k] ?? 0), 0) : null));
  const assistantSets = [
    ...shown.map((k, i) => ({ label: nameOf(k), data: perAssistant([k]), color: ch.ASSISTANT_COLOURS[i] })),
    ...(others.length ? [{ label: others.length === 1 ? nameOf(others[0]) : "Others", data: perAssistant(others), color: ch.ASSISTANT_COLOURS[3] }] : []),
  ];
  const topKey = shown[0];
  const topInPeriod = topKey ? per(perAssistant([topKey])).now : null;
  const topShare = topInPeriod != null && qAi.now ? topInPeriod / qAi.now : null;

  const landingMonths = T.slice(iFrom, iTo + 1).map((t) => t.aiLanding);
  const landing = Object.entries(addCounts(landingMonths)).sort((a, b) => b[1] - a[1]);
  const landingRest = landing.slice(LANDING_SHOWN).reduce((n, [, v]) => n + v, 0);
  const landingLabels = [...landing.slice(0, LANDING_SHOWN).map(([k]) => sectionName(k)), ...(landingRest ? ["Other sections"] : [])];
  const landingValues = [...landing.slice(0, LANDING_SHOWN).map(([, v]) => v), ...(landingRest ? [landingRest] : [])];

  const newsPeople: Series = T.map((t) => t.newsPeople);
  const newsTotal = per(newsPeople).now;
  const newsSites = Object.entries(addCounts(T.slice(iFrom, iTo + 1).map((t) => t.news))).sort((a, b) => b[1] - a[1]);

  // ── search (Search Console) ──────────────────────────────────────────────
  const S = r.search;
  const clicks: Series = S.map((x) => x?.clicks ?? null);
  const impressions: Series = S.map((x) => x?.impressions ?? null);
  const positions: Series = S.map((x) => x?.position ?? null);
  const brandClicks: Series = S.map((x) => x?.brandClicks ?? null);
  const brandImpressions: Series = S.map((x) => x?.brandImpressions ?? null);
  const otherClicks: Series = S.map((x) => (x && x.brandClicks != null ? x.clicks - x.brandClicks : null));
  const hasBrand = brandClicks.some((v) => v != null);
  const posNow = weightedPosition(S.slice(iFrom, iTo + 1)), posBefore = weightedPosition(S.slice(cFrom, cTo + 1));
  const qClicks = per(clicks), qImpressions = per(impressions), qBrand = per(brandClicks);

  // ── the CRM half ─────────────────────────────────────────────────────────
  const R = crm?.crm ?? null;
  const crmError = crmFailed ?? crm?.error ?? (crm && !crm.connected ? "Metabase is not connected" : null);
  // Answered. A month before the CRM's records begin is null within it: unknown, so a comparison
  // reaching back that far reads "no comparison" rather than holding the cards on "…".
  const crmReady = !!R && !crmError;
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
  const qLeads = per(leads), qAiLeads = per(aiLeads), qListed = per(listed), qReserved = per(reserved), qCompleted = per(completed);
  const qCommission = per(commission);
  const qCommCompleted = total([...commCompletedSale.slice(iFrom, iTo + 1), ...commCompletedRent.slice(iFrom, iTo + 1)]);
  const qAwaiting = total(commAwaiting.slice(iFrom, iTo + 1));
  const otherLine = lineLeads("other");
  const per100 = (a: Series): Series => a.map((v, i) => (v == null || !leads[i] ? null : +((v / (leads[i] as number)) * 100).toFixed(1)));
  /** What a CRM figure shows while the CRM half is on its way, or when it failed. */
  const crmWait = crmError ? "CRM unavailable" : "Loading the CRM…";
  const crmValue = (v: number | null, f: (n: number) => string = num) => (crmReady && v != null ? f(v) : crmError ? "—" : "…");

  // ── takeaways, from the figures ─────────────────────────────────────────
  // A change needs both periods recorded; where the months before come ahead of a source's records,
  // each sentence says what the period holds instead of reading "with nothing to compare" mid-way.
  const listedChange = change(qListed.now, qListed.before), aiChange = change(qAi.now, qAi.before), organicChange = change(qOrganic.now, qOrganic.before);
  const lag = crmReady && qReserved.now && qCompleted.now != null && qCompleted.now < qReserved.now / 2 ? ` Completions lag: most ${span} deals are still reserved.` : "";
  const glance =
    aiChange == null && (crmReady ? listedChange == null : organicChange == null) ? (
      <><b>{num(qOrganic.now)} organic visitors</b>{crmReady ? <> and <b>{num(qListed.now)} properties listed with us</b></> : null} in {span}.
        {" "}{spanBefore} comes before the records begin, so there is nothing to set them against.{lag}</>
    ) : crmReady ? (
      <>Properties listed with us <b>{moved(listedChange)}</b> and AI visitors <b>{moved(aiChange)}</b> on {spanBefore}.{lag}</>
    ) : (
      <>Organic visitors <b>{moved(organicChange)}</b> and AI visitors <b>{moved(aiChange)}</b> on {spanBefore}.</>
    );

  const seoT = tr(seo), shareT = tr(aiShare);
  const lastSeo = seoT[seoT.length - 1];
  const higherBefore = lastSeo == null ? -1 : seoT.slice(0, -1).map((v, i) => ({ v, i })).filter((x) => x.v != null && (x.v as number) > lastSeo).pop()?.i ?? -1;
  const firstShare = shareT.find((v) => v != null), lastShare = shareT[shareT.length - 1];
  const firstShareMonth = MT[shareT.findIndex((v) => v != null)];
  const lastMonth = MT[MT.length - 1];
  const reachLine =
    lastSeo == null ? <>PostHog has not answered for {monLong(lastMonth)} yet.</> : (
      <>
        {higherBefore === -1
          ? <>{monLong(lastMonth)} was the strongest SEO month of the {MT.length} shown at <b>{num(lastSeo)} visitors</b></>
          : higherBefore < MT.length - 2
            ? <>{monLong(lastMonth)} was the strongest SEO month since {monLong(MT[higherBefore])} {MT[higherBefore].slice(0, 4)} at <b>{num(lastSeo)} visitors</b></>
            : <>SEO brought <b>{num(lastSeo)} visitors</b> in {monLong(lastMonth)}</>}
        {lastShare != null && firstShare != null
          ? <>; AI assistants now bring about <b>{Math.round(lastShare)}%</b> of organic visitors, {lastShare >= firstShare ? "up" : "down"} from {Math.round(firstShare)}% in {monLong(firstShareMonth)} {firstShareMonth.slice(0, 4)}.</>
          : "."}
      </>
    );
  const reachTitle = organicChange == null ? "Who is finding us" : organicChange >= 0 ? "More people are finding us" : "Fewer people are finding us";

  // Positions as the page shows them, to one decimal: 14.1 against 14.1 has not moved.
  const posMove = posNow == null || posBefore == null ? 0 : Math.sign(+posNow.toFixed(1) - +posBefore.toFixed(1));
  const clicksChange = change(qClicks.now, qClicks.before);
  const visibilityLine =
    posNow == null ? <>Search Console has not answered for {span} yet.</> : (
      <>
        {posBefore == null
          ? <>Average Google position <b>{posNow.toFixed(1)}</b> in {span}</>
          : posMove === 0
            ? <>Average Google position held at <b>{posNow.toFixed(1)}</b></>
            : <>Average Google position {posMove < 0 ? "improved" : "slipped"} from <b>{posBefore.toFixed(1)}</b> to <b>{posNow.toFixed(1)}</b></>}
        {clicksChange == null
          ? <>, from <b>{num(qClicks.now)} clicks</b>.</>
          : <>, with clicks <b>{moved(clicksChange)}</b> and impressions {moved(change(qImpressions.now, qImpressions.before))}, against {spanBefore}.</>}
      </>
    );
  const visibilityTitle = posBefore == null ? "Where we rank" : posMove > 0 ? "Slipping in the rankings" : posMove < 0 ? "Climbing the rankings" : "Holding our rankings";

  const aiLine = (
    <>{topKey ? <>{nameOf(topKey)} brings <b>{share(topShare, 0)}</b> of AI visitors</> : "No AI visitors yet"}
      {!crmReady ? "."
        : change(qAiLeads.now, qAiLeads.before) == null ? <>; <b>{num(qAiLeads.now)}</b> enquiries from AI assistants in {span}.</>
        : <>; enquiries from AI assistants <b>{moved(change(qAiLeads.now, qAiLeads.before))}</b> to <b>{num(qAiLeads.now)}</b> in {span}.</>}</>
  );

  const brandAvg = qBrand.now == null ? null : qBrand.now / nMonths;
  const prLine = (
    <>{hasBrand && brandAvg != null
        ? <>Branded search averaged <b>{num(brandAvg)} clicks a month</b>{change(qBrand.now, qBrand.before) == null ? "" : ` (${moved(change(qBrand.now, qBrand.before))} on ${spanBefore})`}; </>
        : null}
      news and media sites sent <b>{newsTotal == null ? "—" : num(newsTotal)}</b> visitor{newsTotal === 1 ? "" : "s"} in {span}.</>
  );

  const impactLine = crmReady ? (
    <><b>{num(qListed.now)} properties listed with us</b>, {num(qReserved.now)} reservations and {num(qCompleted.now)} completed deals from organic
      visitors in {span}, with <b>{aed(qAwaiting)}</b> reserved and awaiting completion.</>
  ) : <>{crmWait}</>;

  const saleListed = change(per(listedSale).now, per(listedSale).before), rentListed = change(per(listedRent).now, per(listedRent).before);
  const biggest = Math.abs(rentListed ?? 0) >= Math.abs(saleListed ?? 0) ? { name: "Rent", c: rentListed } : { name: "Sale", c: saleListed };
  const linesLine = crmReady ? (
    <>{biggest.c == null
        ? <>{num(per(listedSale).now)} sale and <b>{num(per(listedRent).now)} rent</b> listings</>
        : <>{biggest.name} listings <b>{moved(biggest.c)}</b></>}
      ; property management brought <b>{num(per(lineLeads("pm")).now)}</b> enquiries and off-plan{" "}
      {num(per(lineLeads("offplan")).now)} in {span}.</>
  ) : <>{crmWait}</>;

  // ── page ─────────────────────────────────────────────────────────────────
  const problems = r.sources.filter((x) => x.state !== "ok");
  const updatedAt = r.cachedAt ?? r.generatedAt;

  return (
    <div className={s.report}>
      <PageHeader
        title="Organic Growth Report: SEO and AI search"
        sub="bhomes.com · all service lines · organic search and AI assistants"
        actions={
          <>
            <PeriodPicker choice={choice} period={P} onChoose={setChoice} loading={loading} updatedAt={updatedAt} updating={updating || crmUpdating} />
          </>
        }
      />

      <div className={cx(s.main, loading && s.dim)}>
        {loadError && <div className={s.alert}><b>Couldn&apos;t load that period</b>: {loadError}</div>}
        {problems.map((x) => <div key={x.name} className={s.alert}><b>{x.name}</b>: {x.detail}</div>)}
        {crmError && <div className={s.alert}><b>CRM</b>: {crmError}</div>}
        <div className={s.legend}>
          <span><i style={{ background: ch.C.seo }} />SEO (organic search)</span>
          <span><i style={{ background: ch.C.ai }} />AI assistants</span>
          <span><i style={{ background: ch.C.pr }} />Brand and PR</span>
          <span><i style={{ background: ch.C.biz }} />Business outcomes</span>
        </div>

        {/* ── 01 Growth at a glance ───────────────────────────────────── */}
        <Section id="glance" n="01" eyebrow="Growth at a glance" title={glanceTitle(P.preset)} takeaway={glance} src="All sources">
          <div className={s.kpis}>
            <Kpi label="Organic visitors" value={num(qOrganic.now)} q={qOrganic} sub="SEO + AI · careers excluded" spark={tr(organic)} color={ch.C.seo} />
            <Kpi label="AI visitors" value={num(qAi.now)} q={qAi} sub={order.slice(0, 5).map((o) => nameOf(o.key)).join(", ") || "PostHog's AI channel"} spark={tr(ai)} color={ch.C.ai} />
            <Kpi label="Organic leads" value={crmValue(qLeads.now)} q={crmReady ? qLeads : null} sub={crmReady ? `People · ${num(qAiLeads.now)} from AI` : crmWait} spark={tr(leads)} color={ch.C.biz} />
            <Kpi label="Listed with us" value={crmValue(qListed.now)} q={crmReady ? qListed : null} sub={crmReady ? `${num(per(listedSale).now)} sale · ${num(per(listedRent).now)} rent` : crmWait} spark={tr(listed)} color={ch.C.biz} />
            <Kpi label="Reservations" value={crmValue(qReserved.now)} q={crmReady ? qReserved : null} sub={crmReady ? `${num(per(reservedSale).now)} sale · ${num(per(reservedRent).now)} rent` : crmWait} spark={tr(reserved)} color={ch.C.biz} />
            <Kpi label="Deals completed" value={crmValue(qCompleted.now)} q={crmReady ? qCompleted : null} sub={crmReady ? `${num(per(completedSale).now)} sale · ${num(per(completedRent).now)} rent` : crmWait} spark={tr(completed)} color={ch.C.biz} />
            <Kpi label="Commission" value={crmValue(qCommission.now, aed)} q={crmReady ? qCommission : null} sub={crmReady ? `${aed(qCommCompleted)} completed · ${aed(qAwaiting)} reserved` : crmWait} spark={tr(commission)} color={ch.C.biz} />
          </div>
        </Section>

        {/* ── 02 Organic reach ────────────────────────────────────────── */}
        <Section id="reach" n="02" eyebrow="Organic reach" title={reachTitle} takeaway={reachLine} src="PostHog">
          <div className={s.grid}>
            <Card className={cx(s.feature, s.span2)} title="SEO and AI visitors by month" tag="unique visitors"
              note="People arriving from search engines or AI assistants, as PostHog files their visit. Careers pages and bots left out. Tracking starts 10 Oct 2025.">
              <Plot spec={ch.reach(labels, full, tr(seo), tr(ai))} tall />
            </Card>
            <Card title="AI share of organic" tag="%">
              <Plot spec={ch.percentLine(labels, full, "AI share of organic", tr(aiShare), ch.C.ai)} tall />
            </Card>
          </div>
        </Section>

        {/* ── 03 Search visibility ────────────────────────────────────── */}
        <Section id="visibility" n="03" eyebrow="Search visibility" title={visibilityTitle} takeaway={visibilityLine} src="Google Search Console">
          <div className={s.grid}>
            <Card title="Clicks and impressions" tag="monthly">
              <Plot spec={ch.twoLines(labels, full, { label: "Clicks", data: tr(clicks), color: ch.C.seo }, { label: "Impressions", data: tr(impressions), color: ch.C.seoSoft })} />
            </Card>
            <Card title="Average position" tag="lower is better">
              <Plot spec={ch.position(labels, full, tr(positions))} />
            </Card>
            <Card title="Branded and non-branded clicks" tag="monthly"
              note={hasBrand ? undefined : "The brand split needs Search Console read directly: Settings, SEO source."}>
              {hasBrand
                ? <Plot spec={ch.stackedBars(labels, full, [{ label: "Non-branded", data: tr(otherClicks), color: ch.C.seo }, { label: "Branded", data: tr(brandClicks), color: ch.C.seoSoft }])} />
                : <Waiting text="Not available from this source." />}
            </Card>
            <Card className={s.span3} title="Top searches" tag={`avg position · ${spanBefore} → ${span}`}
              note={`The ${r.keywords.length} top searches by clicks in ${span}, brand searches left out. ${
                r.searchFrom && P.compareFrom < r.searchFrom
                  ? `Search Console keeps 16 months, so there are no positions from ${spanBefore} to set them against.`
                  : `Blue rose or held, red fell; a missing grey bar means the search did not appear in ${spanBefore}.`
              }`}>
              {r.keywords.length
                ? <Plot spec={ch.keywords(r.keywords, spanBefore, span)} height={Math.max(240, r.keywords.length * 30)} />
                : <Waiting text={`Search Console returned no searches for ${span}.`} />}
            </Card>
          </div>
        </Section>

        {/* ── 04 AI search ────────────────────────────────────────────── */}
        <Section id="ai" n="04" eyebrow="AI search" title="Showing up in AI answers" takeaway={aiLine} src="PostHog · Engage CRM">
          <div className={s.grid}>
            <Card title="Visitors by assistant" tag="monthly"
              note={others.length > 1 ? `Others: ${others.map(nameOf).join(", ")}.` : undefined}>
              <Plot spec={ch.stackedBars(labels, full, assistantSets.map((a) => ({ ...a, data: tr(a.data) })))} />
            </Card>
            <Card title="Enquiries from AI assistants" tag="CRM · people per month">
              {crmReady ? <Plot spec={ch.bars(labels, full, "People enquiring from AI assistants", tr(aiLeads), ch.C.ai)} /> : <Waiting text={crmWait} />}
            </Card>
            <Card title="Where AI visitors land" tag={`${span} · careers excluded`}
              note="The section of the first page each AI visitor read, by the site's own folders.">
              {landingMonths.every(Boolean)
                ? <Plot spec={ch.sideways(landingLabels, landingValues, ch.C.ai, "AI visitors")} />
                : <Waiting text={`PostHog did not answer for every month of ${span}.`} />}
            </Card>
          </div>
        </Section>

        {/* ── 05 Digital PR ───────────────────────────────────────────── */}
        <Section id="pr" n="05" eyebrow="Digital PR" title="Brand demand" takeaway={prLine} src="Google Search Console · PostHog">
          <div className={s.grid}>
            <Card className={s.span2} title="Branded search demand" tag="searches for betterhomes · monthly">
              {hasBrand
                ? <Plot spec={ch.twoLines(labels, full, { label: "Branded clicks", data: tr(brandClicks), color: ch.C.pr }, { label: "Branded impressions", data: tr(brandImpressions), color: ch.C.prSoft })} />
                : <Waiting text="The brand split needs Search Console read directly: Settings, SEO source." />}
            </Card>
            <Card title="Visitors from news and media" tag={span}>
              <div className={s.stat}>{newsTotal == null ? "—" : num(newsTotal)}</div>
              <p className={s.note} style={{ marginTop: 0 }}>
                {newsTotal == null ? "PostHog or the press bot's coverage did not answer." : `visitor${newsTotal === 1 ? "" : "s"} in ${span}${newsSites.length ? `, mostly from ${newsSites.slice(0, 2).map(([k]) => k).join(" and ")}` : ""}.`}
              </p>
              <div className={s.chart} style={{ height: 150 }}>
                <ChartBox {...ch.bars(labels, full, "Visitors from news and media", tr(newsPeople), ch.C.prSoft)} />
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
              {crmReady ? <Plot spec={ch.perHundred(labels, full, tr(per100(listed)), tr(per100(reserved)))} /> : <Waiting text={crmWait} />}
            </Card>
            <Card title="Leads by service line" tag="people per month">
              {crmReady
                ? <Plot spec={ch.stackedBars(labels, full, [
                    { label: "Sale", data: tr(lineLeads("sale")), color: ch.C.biz },
                    { label: "Rent", data: tr(lineLeads("rent")), color: ch.C.bizMid },
                    { label: "Off-plan", data: tr(lineLeads("offplan")), color: ch.C.biz2 },
                    { label: "Property management", data: tr(lineLeads("pm")), color: ch.C.biz3 },
                    ...(tr(otherLine).some((v) => v) ? [{ label: "Type not set", data: tr(otherLine), color: ch.C.before }] : []),
                  ])} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card title="Listed with us" tag="monthly and cumulative">
              {crmReady
                ? <Plot spec={ch.barsAndLine(labels, full, [{ label: "Sale", data: tr(listedSale), color: ch.C.biz }, { label: "Rent", data: tr(listedRent), color: ch.C.biz2 }],
                    { label: "Cumulative", data: cumulative(tr(listed)), color: ch.C.bizDark }, { stacked: true })} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card title="Reservations and completed deals" tag="sale and rent">
              {crmReady
                ? <Plot spec={ch.dealBars(labels, full, { sale: tr(reservedSale), rent: tr(reservedRent) }, { sale: tr(completedSale), rent: tr(completedRent) })} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card className={s.span3} title="Commission" tag="AED gross · completed and reserved · cumulative line"
              note="Deals are dated by the month they were recorded, at reservation. Recent months look light on completions because most of those deals have not completed yet; the reserved bar shows what is waiting.">
              {crmReady
                ? <Plot spec={ch.barsAndLine(labels, full, [
                    { label: "Completed · sale", data: tr(commCompletedSale), color: ch.C.biz },
                    { label: "Completed · rent", data: tr(commCompletedRent), color: ch.C.biz2 },
                    { label: "Reserved, not yet completed", data: tr(commAwaiting), color: ch.C.biz3 },
                  ], { label: "Cumulative", data: cumulative(tr(commission)), color: ch.C.bizDark }, { stacked: true, money: true })} />
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
                    { label: "Leads", ...miniOf(per(lead), crmReady) },
                    { label: "Listed with us", ...miniOf(per(list), crmReady) },
                    { label: "Reservations", ...miniOf(per(res), crmReady) },
                    { label: "Completed", ...miniOf(per(done), crmReady) },
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
              const qe = per(enquiries), qv = per(visitors);
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
                      delta: crmReady && rateBefore != null ? `${share(rateBefore)} before` : crmReady && firstSeen > 0 ? `tracked from ${monShort(M[firstSeen])}` : "", cls: s.flat },
                    { label: "From AI", value: crmValue(per(fromAi).now), delta: crmReady ? `of ${num(qe.now)}` : "", cls: s.flat },
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

interface Mini { label: string; value: string; delta: string; cls: string }

/** A service line's figure for the period and how it moved: "7 before" when it fell to nothing, "new" when it rose from it. */
function miniOf(q: { now: number | null; before: number | null }, ready: boolean): Omit<Mini, "label"> {
  if (!ready || q.now == null) return { value: ready ? "—" : "…", delta: "", cls: s.flat };
  const value = num(q.now);
  if (q.before == null) return { value, delta: "", cls: s.flat };
  if (q.before === 0) return { value, delta: q.now === 0 ? "none before" : "new", cls: q.now === 0 ? s.flat : "" };
  if (q.now === 0) return { value, delta: `${num(q.before)} before`, cls: s.down };
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
