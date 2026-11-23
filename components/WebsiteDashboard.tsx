"use client";

// The Website tab: bhomes.com month by month (lib/websiteGrowth.ts), for a
// period picked in the header (lib/growthPeriod.ts, by default the last 3
// months) set against the months just before, in the report design the SEO tab
// set (components/report). Every figure and sentence is worked out from the
// live series; the page holds none of its own.
//
// Visits arrive with the page. The CRM half is asked for once the page is open,
// and both keep themselves current (components/report/usePeriodReport.ts).
import { BarList, Notice, PageHeader } from "@/components/ui";
import PageLookup from "@/components/PageLookup";
import * as ch from "@/components/report/charts";
import { Card, Kpi, PeriodPicker, Plot, Section, Waiting, cx, glanceTitle, type Series } from "@/components/report/Report";
import { WEBSITE_SECTIONS, useSectionInView } from "@/components/report/sections";
import { useCrmHalf, usePeriodReport } from "@/components/report/usePeriodReport";
import s from "@/components/report/report.module.css";
import { addCounts, aed, change, compact, monLong, monthFrame, moved, num, sectionName, share, total, type Num } from "@/lib/growthMath";
import { ENQUIRY_CHANNELS, MATCHED_CHANNELS, VISIT_CHANNELS, formName, type EnquiryChannel, type VisitChannel } from "@/lib/website";
import type { VisitDetail, WebsiteCrmMonth, WebsiteCrmReport, WebsiteReport } from "@/lib/websiteGrowth";

/** Countries, sections and forms each chart names; the rest are left out and said so. */
const COUNTRIES_SHOWN = 8;
const SECTIONS_SHOWN = 12;
const FORMS_SHOWN = 8;
/** A channel needs this many sessions in the months before to be called growing or shrinking: below it, a percentage says nothing. */
const GROWTH_FLOOR = 300;
/** A form needs this many people opening it before its completion rate is compared. */
const FORM_FLOOR = 30;

const visitName = (k: VisitChannel) => (k === "direct" ? "Direct" : VISIT_CHANNELS.find((c) => c.key === k)?.label ?? k);
const enquiryName = (k: EnquiryChannel) => ENQUIRY_CHANNELS.find((c) => c.key === k)?.label ?? k;
const sumOf = (rec: Record<string, number>) => Object.values(rec).reduce((a, b) => a + b, 0);
/** "up 20% to 90", "held at 90", or "came to 90" when there is nothing to compare. */
function movedTo(c: number | null, n: Num) {
  const how = moved(c);
  return c == null ? <>came to <b>{num(n)}</b></> : how === "level" ? <>held at <b>{num(n)}</b></> : <>{how} to <b>{num(n)}</b></>;
}
/** A period's months of one part, or null when PostHog left any month of it unanswered. */
function whole<K extends Exclude<keyof VisitDetail, "month">>(detail: VisitDetail[], k: K): NonNullable<VisitDetail[K]>[] | null {
  return detail.length && detail.every((d) => d[k] != null) ? detail.map((d) => d[k] as NonNullable<VisitDetail[K]>) : null;
}
/** Rows added up across months by name. */
function mergeRows<T extends object>(months: T[][], key: (r: T) => string, add: (a: T, b: T) => T): T[] {
  const acc = new Map<string, T>();
  for (const rows of months) for (const r of rows) acc.set(key(r), acc.has(key(r)) ? add(acc.get(key(r)) as T, r) : r);
  return [...acc.values()];
}

export default function WebsiteDashboard({ initial }: { initial: WebsiteReport }) {
  const { report: r, choice, setChoice, loading, loadError, updating } = usePeriodReport(initial, "/api/website", "/website");
  const { crm, failed: crmFailed, updating: crmUpdating } = useCrmHalf<WebsiteCrmReport>("/api/website", r.period, !loading);
  useSectionInView(WEBSITE_SECTIONS);

  // ── months ────────────────────────────────────────────────────────────────
  const P = r.period;
  const M = r.months;
  const F = monthFrame(P, M);
  const { per, tr, labels, full, span, spanBefore } = F;
  const MT = F.trendMonths;
  const lastMonth = MT[MT.length - 1];

  // ── visits (PostHog) ─────────────────────────────────────────────────────
  const V = r.visits;
  const sessions = (k: VisitChannel, part: "site" | "careers" = "site"): Series => V.map((v) => (v ? v.channels[k][part] : null));
  const across = (part: "site" | "careers"): Series => V.map((v) => (v ? VISIT_CHANNELS.reduce((t, c) => t + v.channels[c.key][part], 0) : null));
  const commercial = across("site"), careersMarketing = across("careers");
  const direct = sessions("direct");
  const directShort: Series = V.map((v) => (v ? v.directShort : null));
  const qCommercial = per(commercial);
  const channelPer = VISIT_CHANNELS.map((c) => ({ ...c, q: per(sessions(c.key)) }));
  const mix = channelPer.filter((c) => (c.q.now ?? 0) > 0).sort((a, b) => (b.q.now ?? 0) - (a.q.now ?? 0));
  const growing = channelPer
    .filter((c) => c.key !== "other" && (c.q.before ?? 0) >= GROWTH_FLOOR)
    .map((c) => ({ ...c, c: change(c.q.now, c.q.before) as number }))
    .filter((c) => c.c != null)
    .sort((a, b) => b.c - a.c);

  // The period's own breakdowns, each month added up.
  const D = r.detail;
  const countryMonths = whole(D, "countries");
  const countries = countryMonths
    ? mergeRows(countryMonths, (x) => x.country, (a, b) => ({ country: a.country, visitors: a.visitors + b.visitors, automated: a.automated + b.automated })).sort((a, b) => b.visitors - a.visitors)
    : null;
  const deviceMonths = whole(D, "devices");
  const devices = deviceMonths ? Object.entries(addCounts(deviceMonths)).sort((a, b) => b[1] - a[1]) : null;
  const sectionMonths = whole(D, "sections");
  const sections = sectionMonths ? Object.entries(addCounts(sectionMonths)).sort((a, b) => b[1] - a[1]) : null;
  const formMonths = whole(D, "forms");
  const forms = formMonths ? mergeRows(formMonths, (x) => x.form, (a, b) => ({ form: a.form, opened: a.opened + b.opened, sent: a.sent + b.sent })) : null;
  const actionMonths = whole(D, "actions");
  const actions = actionMonths
    ? actionMonths.reduce((a, b) => ({ clicked: a.clicked + b.clicked, opened: a.opened + b.opened, searched: a.searched + b.searched, gallery: a.gallery + b.gallery, sent: a.sent + b.sent }))
    : null;
  const senderMonths = whole(D, "senders");
  const senders = senderMonths ? (addCounts(senderMonths) as Partial<Record<VisitChannel, number>>) : null;

  // ── the CRM half ─────────────────────────────────────────────────────────
  const R = crm?.crm ?? null;
  const crmError = crmFailed ?? crm?.error ?? (crm && !crm.connected ? "Metabase is not connected" : null);
  const crmReady = !!R && !crmError;
  const pick = (f: (m: WebsiteCrmMonth) => number): Series => M.map((_, i) => (crmReady && R?.[i] ? f(R[i] as WebsiteCrmMonth) : null));
  const enquirers = pick((m) => m.enquirers), jobs = pick((m) => m.jobs);
  const listed = pick((m) => sumOf(m.listed)), reserved = pick((m) => sumOf(m.reserved)), completed = pick((m) => sumOf(m.completed));
  const awaiting = pick((m) => m.awaiting);
  const commCompleted = pick((m) => m.commission.completed), commAwaiting = pick((m) => m.commission.awaiting);
  const commission = pick((m) => m.commission.completed + m.commission.awaiting);
  const qEnquirers = per(enquirers), qJobs = per(jobs), qListed = per(listed), qReserved = per(reserved), qCompleted = per(completed), qCommission = per(commission);
  const byEnquiry = (part: "enquiries" | "listed" | "reserved" | "completed") =>
    ENQUIRY_CHANNELS.map((c) => ({ ...c, data: pick((m) => m[part][c.key]), color: ch.CHANNEL_COLOURS[c.key] }));
  const enquiriesBy = byEnquiry("enquiries"), listedBy = byEnquiry("listed"), reservedBy = byEnquiry("reserved"), completedBy = byEnquiry("completed");
  const crmWait = crmError ? "CRM unavailable" : "Loading the CRM…";
  const crmValue = (v: number | null, f: (n: number) => string = num) => (crmReady && v != null ? f(v) : crmError ? "—" : "…");
  /** A channel's sets that hold anything in the months the charts draw. */
  const shown = <T extends { data: Series }>(sets: T[]) => sets.filter((x) => tr(x.data).some((v) => (v ?? 0) > 0));

  // ── takeaways, from the figures ─────────────────────────────────────────
  const glance = (
    <>Commercial sessions <b>{moved(change(qCommercial.now, qCommercial.before))}</b>
      {crmReady
        ? <> and properties listed with us <b>{moved(change(qListed.now, qListed.before))}</b> on {spanBefore}. Website enquiries {moved(change(qEnquirers.now, qEnquirers.before))}
          {qJobs.now ? <>, and <b>{num(qJobs.now)}</b> people applied for jobs in {span}.</> : "."}</>
        : <> on {spanBefore}.</>}
    </>
  );

  const top = mix[0];
  const trafficLine = top ? (
    <>{top.label} is the largest channel at <b>{compact(top.q.now)} sessions</b> in {span}
      {growing.length && growing[0].c > 0
        ? <>; {growing.filter((g) => g.c > 0).slice(0, 2).map((g, i) => <span key={g.key}>{i ? " and " : ""}{g.label.toLowerCase()} grew <b>{Math.round(g.c * 100)}%</b></span>)}.</>
        : "."}</>
  ) : <>PostHog has not answered for {span} yet.</>;

  const directT = tr(direct), shortT = tr(directShort);
  const known = directT.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v != null);
  const peak = known.length ? known.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const low = known.length ? known.reduce((a, b) => (b.v < a.v ? b : a)) : null;
  const shortShare = (i: number) => (directT[i] ? (shortT[i] ?? 0) / (directT[i] as number) : null);
  const topCountries = countries?.slice(0, COUNTRIES_SHOWN) ?? null;
  const worstCountry = countries?.slice(0, COUNTRIES_SHOWN).filter((c) => c.visitors >= 500).sort((a, b) => b.automated / b.visitors - a.automated / a.visitors)[0];
  const steady = !!peak && !!low && compact(peak.v) === compact(low.v);
  const qualityLine = peak && low ? (
    <>{steady
        ? <>Direct traffic held at about {compact(peak.v)} sessions a month; in {monLong(lastMonth)},{" "}
            <b>{share(shortShare(MT.length - 1), 0)}</b> of them lasted under 5 seconds.</>
        : <>Direct traffic ran from {compact(low.v)} to {compact(peak.v)} sessions a month. In {monLong(MT[peak.i])}, its busiest month,{" "}
            <b>{share(shortShare(peak.i), 0)}</b> of direct sessions lasted under 5 seconds
            {peak.i !== MT.length - 1 ? <>; in {monLong(lastMonth)}, {share(shortShare(MT.length - 1), 0)}</> : null}.</>}
      {worstCountry && worstCountry.automated / worstCountry.visitors >= 0.5
        ? <> {share(worstCountry.automated / worstCountry.visitors, 0)} of visitors from {worstCountry.country} were automated.</>
        : null}</>
  ) : <>PostHog has not answered for {span} yet.</>;

  const qCareers = per(careersMarketing);
  const lastJobs = jobs[F.iTo], lastEnquirers = enquirers[F.iTo];
  const careersLine = (
    <>Careers pages drew <b>{compact(qCareers.now)} sessions</b> from marketing channels in {span}, against {compact(qCareers.before)} in {spanBefore}.
      {crmReady && lastJobs != null
        ? <> In {monLong(P.to)} the CRM logged <b>{num(lastJobs)}</b> job applications against {num(lastEnquirers)} people enquiring about property.</>
        : null}</>
  );

  const periodEnquiries = enquiriesBy.map((c) => ({ ...c, now: total(F.inPeriod(c.data)) ?? 0, q: per(c.data) }));
  const enquiryTotal = periodEnquiries.reduce((t, c) => t + c.now, 0);
  const untaggedShare = enquiryTotal ? (periodEnquiries.find((c) => c.key === "untagged")?.now ?? 0) / enquiryTotal : null;
  const aiQ = periodEnquiries.find((c) => c.key === "ai")?.q;
  const biggestTagged = periodEnquiries.filter((c) => c.key !== "untagged" && c.key !== "other").sort((a, b) => b.now - a.now)[0];
  const leadsLine = crmReady ? (
    <><b>{share(untaggedShare, 0)}</b> of website enquiries in {span} carried no tracking tag. Enquiries from AI assistants {movedTo(change(aiQ?.now, aiQ?.before), aiQ?.now)}
      {biggestTagged && biggestTagged.key !== "ai" && biggestTagged.now ? <>, and {biggestTagged.label.toLowerCase()} brought <b>{num(biggestTagged.now)}</b></> : null}.</>
  ) : <>{crmWait}</>;
  // Enquiries per 100 sessions, where the CRM and PostHog see the same channel.
  const rates = MATCHED_CHANNELS.map((m) => {
    const enq = periodEnquiries.find((c) => c.key === m.enquiry)?.now ?? 0;
    const ses = per(sessions(m.visit)).now;
    return { key: m.visit, label: visitName(m.visit), rate: crmReady && ses ? +((enq / ses) * 100).toFixed(1) : null };
  });
  const senderRows = senders
    ? (Object.entries(senders) as [VisitChannel, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    : null;

  const opened = forms?.filter((f) => f.opened > 0).sort((a, b) => b.opened - a.opened) ?? null;
  const compared = opened?.filter((f) => f.opened >= FORM_FLOOR && f.sent > 0).map((f) => ({ ...f, rate: Math.min(1, f.sent / f.opened) })).sort((a, b) => b.rate - a.rate) ?? [];
  const unsent = opened?.filter((f) => f.opened >= FORM_FLOOR && f.sent === 0) ?? [];
  const inline = forms?.filter((f) => f.opened === 0 && f.sent > 0).sort((a, b) => b.sent - a.sent) ?? [];
  const formsLine = compared.length >= 2 ? (
    <>{formName(compared[0].form)} completes best (<b>{share(compared[0].rate, 0)}</b> of the people who open it send it);{" "}
      {formName(compared[compared.length - 1].form).toLowerCase()} completes least (<b>{share(compared[compared.length - 1].rate, 0)}</b>).</>
  ) : forms ? <>Too few people opened the site&apos;s forms in {span} to compare them.</> : <>PostHog has not answered for every month of {span}.</>;

  const qUntaggedListed = per(listedBy.find((c) => c.key === "untagged")?.data ?? []);
  const outcomesLine = crmReady ? (
    <><b>{num(qListed.now)} properties listed with us</b> and <b>{aed(qCommission.now)}</b> in commission in {span}
      {qListed.now ? <>; {share((qUntaggedListed.now ?? 0) / (qListed.now as number), 0)} of the listings came from untagged organic and direct enquirers.</> : "."}</>
  ) : <>{crmWait}</>;

  const visitorsAll = devices?.reduce((t, [, v]) => t + v, 0) ?? 0;
  const mobile = devices?.find(([k]) => k.toLowerCase() === "mobile")?.[1];
  const experienceLine = sections?.length ? (
    <>{sectionName(sections[0][0])}{sections[1] ? <> and {sectionName(sections[1][0]).toLowerCase()}</> : null} pages get the most views
      {mobile != null && visitorsAll ? <>; <b>{share(mobile / visitorsAll, 0)}</b> of visitors are on mobile.</> : "."}</>
  ) : <>PostHog has not answered for every month of {span}.</>;

  // ── page ─────────────────────────────────────────────────────────────────
  const problems = r.sources.filter((x) => x.state !== "ok");
  const updatedAt = r.cachedAt ?? r.generatedAt;
  const notAnswered = (what: string) => <Waiting text={`PostHog did not answer for every month of ${span}${what ? ` (${what})` : ""}. Reload to try again.`} />;
  const sumAll = (xs: Num[]) => xs.reduce<number>((t, x) => t + (x ?? 0), 0);

  return (
    // Busy until the CRM half has answered or failed: the weekly email waits for it (lib/reportCapture.ts).
    <div className={s.report} aria-busy={loading || (!crm && !crmFailed) ? true : undefined}>
      <PageHeader
        title="Website Growth"
        sub="bhomes.com · traffic, enquiries, careers and what the website earned"
        actions={<PeriodPicker choice={choice} period={P} onChoose={setChoice} loading={loading} updatedAt={updatedAt} updating={updating || crmUpdating} />}
      />

      <div className={cx(s.main, loading && s.dim)}>
        {loadError && <div className={s.alert}><b>Couldn&apos;t load that period</b>: {loadError}</div>}
        {problems.map((x) => <div key={x.name} className={s.alert}><b>{x.name}</b>: {x.detail}</div>)}
        {crmError && <div className={s.alert}><b>CRM</b>: {crmError}</div>}
        <Notice>
          Live from PostHog and the Engage CRM. Trends run {monLong(MT[0])} {MT[0].slice(0, 4)} to {monLong(lastMonth)} {lastMonth.slice(0, 4)}.
          Sessions are counted by the channel they arrived from, automated ones included; direct traffic is shown on its own because much of it is not people (section 04).
        </Notice>

        {/* ── 01 Website at a glance ─────────────────────────────────── */}
        <Section id="glance" n="01" eyebrow="Website at a glance" title={glanceTitle(P.preset)} takeaway={glance} src="PostHog · Engage CRM">
          <div className={s.kpis}>
            <Kpi label="Commercial sessions" value={num(qCommercial.now)} q={qCommercial} sub="every channel but direct · careers excluded" spark={tr(commercial)} color={ch.CHANNEL_COLOURS.organic} />
            <Kpi label="Website enquiries" value={crmValue(qEnquirers.now)} q={crmReady ? qEnquirers : null} sub={crmReady ? "people · property enquiries" : crmWait} spark={tr(enquirers)} color={ch.C.biz} />
            <Kpi label="Job applications" value={crmValue(qJobs.now)} q={crmReady ? qJobs : null} sub={crmReady ? "people · careers form" : crmWait} spark={tr(jobs)} color={ch.CAREERS} />
            <Kpi label="Listed with us" value={crmValue(qListed.now)} q={crmReady ? qListed : null} sub={crmReady ? "by website enquirers" : crmWait} spark={tr(listed)} color={ch.C.biz} />
            <Kpi label="Reservations" value={crmValue(qReserved.now)} q={crmReady ? qReserved : null} sub={crmReady ? "sale and rent" : crmWait} spark={tr(reserved)} color={ch.C.biz} />
            <Kpi label="Deals completed" value={crmValue(qCompleted.now)} q={crmReady ? qCompleted : null} sub={crmReady ? `${num(per(awaiting).now)} still reserved` : crmWait} spark={tr(completed)} color={ch.C.biz} />
            <Kpi label="Commission" value={crmValue(qCommission.now, aed)} q={crmReady ? qCommission : null} sub={crmReady ? "completed + reserved, gross" : crmWait} spark={tr(commission)} color={ch.C.biz} />
          </div>
        </Section>

        {/* ── 02 Page lookup ──────────────────────────────────────────── */}
        <Section id="lookup" n="02" eyebrow="Page lookup" title="Check any page"
          takeaway="Paste a bhomes.com link to see its traffic, engagement, button clicks, forms and where visitors go next, live from PostHog." src="PostHog · live">
          <PageLookup />
        </Section>

        {/* ── 03 Traffic by channel ───────────────────────────────────── */}
        <Section id="traffic" n="03" eyebrow="Traffic by channel" title="Where visitors come from" takeaway={trafficLine} src="PostHog">
          <div className={s.grid}>
            <Card className={cx(s.feature, s.span2)} title="Sessions by channel" tag="monthly · careers and direct left out">
              <Plot spec={ch.stackedBars(labels, full, VISIT_CHANNELS.map((c) => ({ label: c.label, data: tr(sessions(c.key)), color: ch.CHANNEL_COLOURS[c.key] })))} tall />
            </Card>
            <Card title="Channel mix" tag={`${span} · sessions`}>
              {mix.length
                ? <BarList compact rows={mix.map((c) => ({
                    name: c.label, value: c.q.now ?? 0, shown: compact(c.q.now), share: share((c.q.now ?? 0) / (qCommercial.now || 1), 0),
                    color: ch.CHANNEL_COLOURS[c.key], title: `${c.label}: ${num(c.q.now)} sessions`,
                  }))} />
                : notAnswered("")}
            </Card>
            <Card className={s.span3} title="Growth by channel" tag={`sessions · ${spanBefore} vs ${span}`}>
              <Plot spec={ch.namedBars(VISIT_CHANNELS.map((c) => c.label), [
                { label: spanBefore, data: channelPer.map((c) => c.q.before), color: ch.C.before },
                { label: span, data: channelPer.map((c) => c.q.now), color: VISIT_CHANNELS.map((c) => ch.CHANNEL_COLOURS[c.key]) },
              ], { after: (i) => { const c = change(channelPer[i].q.now, channelPer[i].q.before); return c == null ? "" : `Change: ${c > 0 ? "+" : ""}${Math.round(c * 100)}%`; } })} />
            </Card>
          </div>
        </Section>

        {/* ── 04 Traffic quality ──────────────────────────────────────── */}
        <Section id="quality" n="04" eyebrow="Traffic quality" title="Separating real visitors from noise" takeaway={qualityLine} src="PostHog">
          <div className={s.grid}>
            <Card className={s.span2} title="Direct sessions and the share under 5 seconds" tag="monthly · careers left out"
              note="A session under 5 seconds is mostly automated traffic. Every total that includes direct counts these sessions too.">
              <Plot spec={ch.stackedBars(labels, full, [
                { label: "Under 5 seconds", data: shortT, color: ch.C.bad },
                { label: "5 seconds or longer", data: directT.map((v, i) => (v == null ? null : v - (shortT[i] ?? 0))), color: ch.CHANNEL_COLOURS.direct },
              ], (i) => (directT[i] ? `${share(shortShare(i), 0)} under 5 seconds` : ""))} />
            </Card>
            <Card title="Visitors by country" tag={`${span} · top ${COUNTRIES_SHOWN}`}
              note="Automated: PostHog flags the visitor as a bot, or they run desktop Linux, as data centres do. Each month's visitors added up.">
              {topCountries
                ? <Plot spec={ch.namedBars(topCountries.map((c) => c.country), [
                    { label: "Automated", data: topCountries.map((c) => c.automated), color: ch.C.bad },
                    { label: "People", data: topCountries.map((c) => c.visitors - c.automated), color: ch.CHANNEL_COLOURS.organic },
                  ], { sideways: true, stacked: true, after: (i) => (topCountries[i]?.visitors ? `${share(topCountries[i].automated / topCountries[i].visitors, 0)} automated` : "") })}
                    height={Math.max(220, topCountries.length * 30 + 40)} />
                : notAnswered("countries")}
            </Card>
          </div>
        </Section>

        {/* ── 05 Careers vs commercial ────────────────────────────────── */}
        <Section id="careers" n="05" eyebrow="Careers vs commercial" title="Two websites in one" takeaway={careersLine} src="PostHog · Engage CRM">
          <div className={s.grid}>
            <Card title="Paid social: careers vs property" tag="sessions · monthly">
              <Plot spec={ch.stackedBars(labels, full, [
                { label: "Careers pages", data: tr(sessions("paidSocial", "careers")), color: ch.CAREERS },
                { label: "Property pages", data: tr(sessions("paidSocial")), color: ch.PROPERTY },
              ])} />
            </Card>
            <Card className={s.span2} title="Job applications vs property enquiries" tag="CRM · people per month"
              note="Job applications come through the careers form, which the CRM files as buyer leads. They are counted here and left out of every enquiry and outcome figure on this tab.">
              {crmReady
                ? <Plot spec={ch.lines(labels, full, [
                    { label: "Job applications", data: tr(jobs), color: ch.CAREERS },
                    { label: "Property enquiries", data: tr(enquirers), color: ch.PROPERTY },
                  ])} />
                : <Waiting text={crmWait} />}
            </Card>
          </div>
        </Section>

        {/* ── 06 Enquiries by channel ─────────────────────────────────── */}
        <Section id="leads" n="06" eyebrow="Enquiries by channel" title="Who turns into an enquiry" takeaway={leadsLine} src="Engage CRM · PostHog">
          <div className={s.grid}>
            <Card className={s.span2} title="Website enquiries by channel" tag="CRM · people per month · careers excluded"
              note="Every enquiry the CRM files under the website, an AI assistant or a pop-up, sent through a form or logged by an agent. Untagged covers organic search and direct visitors; the CRM cannot tell them apart.">
              {crmReady
                ? <Plot spec={ch.stackedBars(labels, full, shown(enquiriesBy).map((c) => ({ label: c.label, data: tr(c.data), color: c.color })))} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card title="Enquiries per 100 sessions" tag={`${span} · careers excluded`}
              note="Only where the CRM and PostHog see the same channel: organic search and direct both reach the CRM untagged.">
              {crmReady
                ? <Plot spec={ch.namedBars(rates.map((x) => x.label), [{ label: "Enquiries per 100 sessions", data: rates.map((x) => x.rate), color: rates.map((x) => ch.CHANNEL_COLOURS[x.key]) }], { sideways: true })} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card className={s.span3} title="Form senders by channel" tag={`PostHog · people · ${span} · careers excluded`}
              note={senders?.organic ? `PostHog sees how a visit arrived even when the CRM gets no tag: organic search sent ${num(senders.organic)} people who sent a form in ${span}.` : undefined}>
              {senderRows
                ? <Plot spec={ch.namedBars(senderRows.map(([k]) => visitName(k)), [{ label: "People who sent a form", data: senderRows.map(([, v]) => v), color: senderRows.map(([k]) => ch.CHANNEL_COLOURS[k]) }])} />
                : notAnswered("forms")}
            </Card>
          </div>
        </Section>

        {/* ── 07 Forms ────────────────────────────────────────────────── */}
        <Section id="forms" n="07" eyebrow="Forms" title="Opened vs sent" takeaway={formsLine} src="PostHog">
          <div className={s.grid}>
            <Card className={s.span2} title="People who opened and sent each form" tag={`${span} · careers excluded`}
              note={[
                ...unsent.map((f) => `${formName(f.form)}: ${num(f.opened)} people opened it, but no send is tracked, so its completions are unknown.`),
                inline.length ? `Forms on the page itself are sent without an open: ${inline.slice(0, 3).map((f) => `${formName(f.form).toLowerCase()} ${num(f.sent)}`).join(", ")}.` : "",
              ].filter(Boolean).join(" ") || undefined}>
              {opened
                ? opened.length
                  ? <Plot spec={ch.namedBars(opened.slice(0, FORMS_SHOWN).map((f) => formName(f.form)), [
                      { label: "Opened", data: opened.slice(0, FORMS_SHOWN).map((f) => f.opened), color: ch.C.prSoft },
                      { label: "Sent", data: opened.slice(0, FORMS_SHOWN).map((f) => f.sent), color: ch.C.biz },
                    ], { sideways: true, after: (i) => { const f = opened[i]; return f && f.sent ? `Completion: ${share(Math.min(1, f.sent / f.opened), 0)}` : "No sends tracked"; } })}
                      height={Math.max(240, Math.min(FORMS_SHOWN, opened.length) * 44)} />
                  : <Waiting text={`No forms were opened in ${span}.`} />
                : notAnswered("forms")}
            </Card>
            <Card title="On-site actions" tag={`people · ${span}`} note="Each month's people added up; careers pages left out.">
              {actions
                ? <Plot spec={ch.namedBars(["Clicked a call to action", "Opened a form", "Searched", "Viewed a gallery", "Sent a form"], [{
                    label: "People",
                    data: [actions.clicked, actions.opened, actions.searched, actions.gallery, actions.sent],
                    color: [ch.CHANNEL_COLOURS.organic, ch.CHANNEL_COLOURS.organic, ch.CHANNEL_COLOURS.organic, ch.CHANNEL_COLOURS.organic, ch.C.biz],
                  }], { sideways: true })} />
                : notAnswered("actions")}
            </Card>
          </div>
        </Section>

        {/* ── 08 Business outcomes ────────────────────────────────────── */}
        <Section id="outcomes" n="08" eyebrow="Business outcomes" title="What the website earned" takeaway={outcomesLine} src="Engage CRM">
          <div className={s.grid}>
            <Card className={s.span2} title="Listed with us" tag="monthly · by first enquiry channel"
              note="Listings placed by people whose first website enquiry came before them, by the channel that enquiry carried.">
              {crmReady
                ? <Plot spec={ch.stackedBars(labels, full, shown(listedBy).map((c) => ({ label: c.label, data: tr(c.data), color: c.color })))} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card title="Outcomes by channel" tag={span}>
              {crmReady
                ? <Plot spec={ch.namedBars(["Listed with us", "Reservations", "Completed"],
                    ENQUIRY_CHANNELS.map((c) => ({
                      label: enquiryName(c.key),
                      data: [listedBy, reservedBy, completedBy].map((set) => total(F.inPeriod(set.find((x) => x.key === c.key)?.data ?? [])) ?? 0),
                      color: ch.CHANNEL_COLOURS[c.key],
                    })).filter((x) => sumAll(x.data) > 0),
                    { stacked: true })} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card className={s.span2} title="Reservations and completions" tag="monthly · by the month reserved"
              note="Deals are dated by the month they were reserved; recent ones are still completing.">
              {crmReady
                ? <Plot spec={ch.namedBars(labels, [
                    { label: "Reservations", data: tr(reserved), color: ch.C.biz2 },
                    { label: "Completed", data: tr(completed), color: ch.C.biz },
                  ])} />
                : <Waiting text={crmWait} />}
            </Card>
            <Card title="Commission" tag="monthly · AED gross">
              {crmReady
                ? <Plot spec={ch.moneyBars(labels, full, [
                    { label: "Completed", data: tr(commCompleted), color: ch.C.biz },
                    { label: "Reserved, awaiting completion", data: tr(commAwaiting), color: ch.C.biz3 },
                  ])} />
                : <Waiting text={crmWait} />}
            </Card>
          </div>
        </Section>

        {/* ── 09 Site experience ──────────────────────────────────────── */}
        <Section id="experience" n="09" eyebrow="Site experience" title="What visitors see" takeaway={experienceLine} src="PostHog">
          <div className={s.grid}>
            <Card className={s.span2} title="Page views by section" tag={`${span} · every visit`}
              note={sections && sections.length > SECTIONS_SHOWN ? `The ${SECTIONS_SHOWN} busiest of ${sections.length} sections, by the site's own folders.` : "By the site's own folders."}>
              {sections
                ? <Plot spec={ch.namedBars(sections.slice(0, SECTIONS_SHOWN).map(([k]) => sectionName(k)), [{
                    label: "Page views",
                    data: sections.slice(0, SECTIONS_SHOWN).map(([, v]) => v),
                    color: sections.slice(0, SECTIONS_SHOWN).map(([k]) => (k === "join-our-team" ? ch.CAREERS : ch.CHANNEL_COLOURS.organic)),
                  }], { sideways: true })} height={Math.max(260, Math.min(SECTIONS_SHOWN, sections.length) * 26)} />
                : notAnswered("sections")}
            </Card>
            <Card title="Device" tag={`visitors · ${span}`}>
              {devices
                ? <BarList compact rows={devices.map(([k, v]) => ({
                    name: k, value: v, shown: compact(v), share: visitorsAll ? share(v / visitorsAll, 0) : undefined,
                    color: ch.CHANNEL_COLOURS.organic, title: `${k}: ${num(v)} visitors`,
                  }))} />
                : notAnswered("devices")}
            </Card>
          </div>
        </Section>
      </div>
    </div>
  );
}
