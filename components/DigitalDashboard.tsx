"use client";

// The Digital tab: the Digital Pipeline Scorecard. Paid media from first
// impression to commission, with paid credited as direct or indirect, laid out
// as the business's scorecard is: filters, nine cards (each picks the figure
// the campaign-by-month grid shows, and opens a trend), the KPI scorecard by
// quarter, paid impact, paid leads by quarter, and the campaigns table, whose
// rows filter the page.
//
// Two sources, both repeatable and clean:
//   - spend, impressions, clicks and platform-reported leads per campaign and
//     day, from Google and Meta through Supermetrics (/api/digital, unchanged);
//   - what the people each campaign brought in went on to do, from the CRM
//     (/api/digital/pipeline, lib/digitalPipeline.ts), asked once per range.
// The scorecard's targets and 2027 plan, its Feeder/Harvest roles and intent
// cohorts, Meta reach and video and engagement figures, and website visits and
// form leads (PostHog) are left out: none of them comes from these two sources.
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import DateRangePicker, { rangeFor } from "@/components/DateRangePicker";
import PausedNotice from "@/components/PausedNotice";
import { useLiveRefresh } from "@/components/useLiveRefresh";
import { DataStatus, Filter, FilterBar, Notes, Notice, PageHeader, Section } from "@/components/ui";
import {
  Bars,
  CampaignTable,
  Heatmap,
  KpiTable,
  QuarterBars,
  TILES,
  Tiles,
  TrendModal,
  monthLabels,
  roiText,
  type BarRow,
  type Ctx,
} from "@/components/ScorecardViews";
import { savePaidConfigAction } from "@/app/actions";
import { liveUrl } from "@/lib/live";
import { ACCOUNT_CATALOG, VERIFIED_BLOCKED, type CatalogAccount } from "@/lib/paidAccounts";
import { PLATFORMS, type PaidData, type PaidPlatform } from "@/lib/paid";
import { add, buildModel, money, n, ordinal, perMonth, quarters, total, ZERO } from "@/lib/scorecard";
import type { PipelineData } from "@/lib/digitalPipeline";
import type { PaidConfig } from "@/lib/data";

const PLATFORM_ORDER: PaidPlatform[] = ["google", "meta", "linkedin"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HEAT_SHOWN = 15;
const CAMPAIGNS_SHOWN = 25;
/** The card the grid opens on: paid leads in the CRM, as the scorecard did. */
const FIRST_TILE = 3;

const fmtDubai = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** A media answer that failed, so the page can say why instead of spinning. */
const failedPaid = (from: string, to: string, error: string): PaidData => ({
  connected: true, label: `${from} → ${to}`, from, to, level: "ad",
  rows: [], truncated: false, byDateFine: [], currencies: [],
  accountsUsed: [], emptyAccounts: [], failures: [], unconfigured: false, error,
});

/** Every campaign name and Meta campaign id in the ad data: what the CRM is asked about. */
function campaignNames(paid: PaidData): string[] {
  const keys = new Set<string>();
  for (const r of paid.rows) {
    keys.add(r.campaign.toLowerCase().trim());
    if (r.campaignId) keys.add(r.campaignId.toLowerCase().trim());
  }
  return [...keys].filter(Boolean).sort();
}

export default function DigitalDashboard({ config }: { config: PaidConfig }) {
  // Worked out when the page opens: a module-level date would keep the day the
  // tab was first visited for as long as the app stays loaded.
  const [opening] = useState(() => rangeFor("this_year"));
  const [today] = useState(() => rangeFor("today").to);
  const [from, setFrom] = useState(opening.from);
  const [to, setTo] = useState(opening.to);
  /** The range on screen, for a reload that finishes after another pick (Ad accounts saved). */
  const shownRange = useRef(opening);
  const [paid, setPaid] = useState<PaidData | null>(null);
  const [pipe, setPipe] = useState<PipelineData | null>(null);
  const [pipeFailed, setPipeFailed] = useState<string | null>(null);

  // Filters, as the scorecard has them, with platform and Engage code in place of role and cohort.
  const [period, setPeriod] = useState("all");
  const [platform, setPlatform] = useState<"all" | PaidPlatform>("all");
  const [code, setCode] = useState("");
  const [campaign, setCampaign] = useState("");
  const [tile, setTile] = useState(FIRST_TILE);
  const [showCost, setShowCost] = useState(false);
  const [trend, setTrend] = useState<{ i: number; gran: "q" | "m"; cum: boolean } | null>(null);
  const [heatAll, setHeatAll] = useState(false);
  const [campsAll, setCampsAll] = useState(false);

  // ── Loading: the ad data, then the CRM about its campaigns ────────────────
  const seq = useRef(0);
  const askCrm = useCallback(async (f: string, t: string, names: string[], live: boolean, mine: number) => {
    try {
      const url = "/api/digital/pipeline";
      const res = await fetch(live ? liveUrl(url) : url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: f, to: t, campaigns: names }),
        cache: "no-store",
      });
      const j = (await res.json()) as Partial<PipelineData> & { error?: string };
      if (mine !== seq.current) return;
      if (!Array.isArray(j.cells)) throw new Error(j.error || `HTTP ${res.status}`);
      const answer = { codes: [], sources: [], ...j } as PipelineData;
      setPipe(answer);
      setPipeFailed(null);
      if (answer.connected !== false && !answer.error) {
        const here = new Set(answer.codes.map((k) => k.code));
        setCode((c) => (!c || here.has(c) ? c : ""));
      }
    } catch (e) {
      // A live ask that fails keeps what is shown, for the next turn to try again.
      if (mine !== seq.current || live) return;
      setPipeFailed(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadAll = useCallback(
    async (f: string, t: string) => {
      const mine = ++seq.current;
      setPaid(null);
      setPipe(null);
      setPipeFailed(null);
      let media: PaidData;
      try {
        const res = await fetch(`/api/digital?from=${f}&to=${t}&level=ad`, { cache: "no-store" });
        const json = await res.json();
        media = res.ok && json && Array.isArray(json.rows) ? (json as PaidData) : failedPaid(f, t, json?.error || `Media request failed (HTTP ${res.status}).`);
      } catch (e) {
        media = failedPaid(f, t, String(e));
      }
      if (mine !== seq.current) return;
      setPaid(media);
      const here = new Set(media.rows.map((r) => `${r.platform}|${r.campaign.toLowerCase().trim()}`));
      setPlatform((p) => (p === "all" || media.rows.some((r) => r.platform === p) ? p : "all"));
      setCampaign((c) => (!c || here.has(c) ? c : ""));
      if (media.connected && !media.paused && !media.unconfigured) await askCrm(media.from, media.to, campaignNames(media), false, mine);
    },
    [askCrm],
  );

  // The ad data loads on arrival, not on the server: Supermetrics can take a
  // while and must never hold the page (app/digital/page.tsx).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll(opening.from, opening.to);
  }, [loadAll, opening]);

  const names = useMemo(() => (paid ? campaignNames(paid) : []), [paid]);
  const updating = useLiveRefresh(pipe?.cachedAt, () => askCrm(paid!.from, paid!.to, names, true, seq.current), !!pipe && !!paid);

  function pickRange(f: string, t: string) {
    shownRange.current = { from: f, to: t };
    setFrom(f);
    setTo(t);
    setPeriod("all");
    void loadAll(f, t);
  }
  function resetFilters() {
    setPeriod("all");
    setPlatform("all");
    setCode("");
    setCampaign("");
  }

  // ── Figures ───────────────────────────────────────────────────────────────
  const range = { from: paid?.from ?? from, to: paid?.to ?? to };
  const model = useMemo(() => (paid ? buildModel(paid, pipe, paid.from, paid.to) : null), [paid, pipe]);
  const qs = useMemo(() => (model ? quarters(model.months, range.from, range.to, today) : []), [model, range.from, range.to, today]);
  const periodIdx = useMemo(() => {
    if (!model) return [];
    const q = qs.find((x) => x.label === period);
    return q ? q.idx : model.months.map((_, i) => i);
  }, [model, qs, period]);

  // Campaign spend over the whole range, to order rows and options by.
  const spendOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of model?.campaigns ?? []) m.set(c.id, (model!.grid.get(c.id) ?? []).reduce((s, f) => s + f.spend, 0));
    return m;
  }, [model]);
  // Each filter applies only while its value is among its options, so a select
  // never reads "All…" while it still narrows the page. Engage codes come from
  // the CRM: until it has answered for this range, or when it failed, a picked
  // code waits (and says so) while the ad half shows.
  const crmOk = !!pipe && pipe.connected !== false && !pipe.error;
  const platformsHere = useMemo(() => PLATFORM_ORDER.filter((p) => model?.campaigns.some((c) => c.platform === p)), [model]);
  const effPlatform = platform !== "all" && platformsHere.includes(platform) ? platform : "all";
  const byPlatform = useMemo(() => (model?.campaigns ?? []).filter((c) => effPlatform === "all" || c.platform === effPlatform), [model, effPlatform]);
  const codeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of byPlatform) for (const k of c.codes) m.set(k.code, (m.get(k.code) ?? 0) + k.leads);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [byPlatform]);
  const codeWaits = !!code && !crmOk;
  const effCode = crmOk && codeOptions.some(([k]) => k === code) ? code : "";
  const byCode = useMemo(() => byPlatform.filter((c) => !effCode || c.codes.some((k) => k.code === effCode)), [byPlatform, effCode]);
  const campaignOptions = useMemo(() => [...byCode].sort((a, b) => (spendOf.get(b.id) ?? 0) - (spendOf.get(a.id) ?? 0) || a.name.localeCompare(b.name)), [byCode, spendOf]);
  const effCampaign = campaign && campaignOptions.some((c) => c.id === campaign) ? campaign : "";
  const selected = useMemo(() => byCode.filter((c) => !effCampaign || c.id === effCampaign), [byCode, effCampaign]);
  const ids = useMemo(() => selected.map((c) => c.id), [selected]);

  const f = useMemo(() => (model ? total(model, ids, periodIdx) : ZERO), [model, ids, periodIdx]);
  const months = useMemo(() => (model ? perMonth(model, ids) : []), [model, ids]);
  const quarterFigs = useMemo(() => qs.map((q) => q.idx.reduce((s, i) => add(s, months[i] ?? ZERO), { ...ZERO })), [qs, months]);

  const currency = paid && paid.currencies.length === 1 ? paid.currencies[0] : paid && paid.currencies.length === 0 ? "AED" : null;
  const ctx: Ctx = {
    cur: currency,
    crm: crmOk,
    wait: pipe || pipeFailed ? "—" : "…",
    monthsInPeriod: monthsCovered(model?.months ?? [], periodIdx, range.from, range.to),
  };

  // ── Page states before there is anything to add up ────────────────────────
  const header = (
    <PageHeader
      title="Digital Pipeline Scorecard"
      sub="Marketing goal: grow pipeline. Paid media for betterhomes from first impression to commission, with paid credited as direct or indirect."
      actions={<AccountPicker config={config} onSaved={() => loadAll(shownRange.current.from, shownRange.current.to)} />}
    />
  );
  const filters = (
    <FilterBar actions={<button type="button" className="filter-btn" onClick={resetFilters}>Reset filters</button>}>
      <Filter label="Range">
        <DateRangePicker initialKey="this_year" initialFrom={from} initialTo={to} onApply={pickRange} />
      </Filter>
      <Filter label="Period" help="Narrows the cards, the paid impact and the campaigns table to one quarter of the range. The KPI table always shows every quarter, with this one marked.">
        <select className="search-box" aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="all">Whole range</option>
          {qs.map((q) => (
            <option key={q.label} value={q.label}>
              {q.label}
            </option>
          ))}
        </select>
      </Filter>
      <Filter label="Platform">
        <select
          className="search-box"
          aria-label="Platform"
          value={effPlatform}
          onChange={(e) => {
            setPlatform(e.target.value as "all" | PaidPlatform);
            setCode("");
            setCampaign("");
          }}
        >
          <option value="all">All platforms</option>
          {platformsHere.map((p) => (
            <option key={p} value={p}>
              {PLATFORMS[p].label}
            </option>
          ))}
        </select>
      </Filter>
      <Filter label="Campaign code" help="The Engage campaign codes the campaigns' paid leads are linked to, each as it is. Picking one keeps the campaigns with leads under it.">
        <select
          className="search-box"
          aria-label="Campaign code"
          value={codeWaits ? code : effCode}
          onChange={(e) => {
            setCode(e.target.value);
            setCampaign("");
          }}
        >
          <option value="">All codes</option>
          {codeWaits ? (
            <option value={code}>
              {code} ({pipe || pipeFailed ? "the CRM is not answering, so it is not applied" : "waiting for the CRM"})
            </option>
          ) : null}
          {codeOptions.map(([k, leads]) => (
            <option key={k} value={k}>
              {k} ({n(leads)})
            </option>
          ))}
        </select>
      </Filter>
      <Filter label="Campaign">
        <select className="search-box" aria-label="Campaign" value={effCampaign} onChange={(e) => setCampaign(e.target.value)}>
          <option value="">All campaigns</option>
          {campaignOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Filter>
    </FilterBar>
  );

  // One shape for every state, so the filters (the range picker above all)
  // stay mounted and keep their choice while a new range loads.
  const shell = (body: ReactNode) => (
    <>
      {header}
      <div className="sc-sticky">{filters}</div>
      {body}
    </>
  );
  if (!paid) {
    return shell(
      <Section>
        <p className="section-sub">Reading the ad accounts…</p>
      </Section>,
    );
  }
  if (!paid.connected || paid.paused || paid.unconfigured) {
    return shell(
      paid.paused ? (
        <PausedNotice note={paid.pausedNote} what="Paid media figures are paused." />
      ) : (
        <Notice tone="warn">
          {!paid.connected
            ? "Supermetrics is not connected: add SUPERMETRICS_API_KEY and its logins to the deployment, then refresh."
            : "No ad accounts are chosen yet. Open Ad accounts above and tick the ones to show."}
        </Notice>
      ),
    );
  }

  const tileDef = TILES[tile];
  const heatRows = selected
    .map((c) => ({ campaign: c, months: model!.grid.get(c.id) ?? model!.months.map(() => ({ ...ZERO })) }))
    .filter((r) => r.months.some((m) => m.spend > 0 || tileDef.grid.value(m) > 0))
    .sort((a, b) => (spendOf.get(b.campaign.id) ?? 0) - (spendOf.get(a.campaign.id) ?? 0));
  const heatShown = heatAll ? heatRows : heatRows.slice(0, HEAT_SHOWN);

  // Paid impact, for the period: each campaign's deals, direct and indirect.
  const perCampaign = selected.map((c) => ({ c, f: total(model!, [c.id], periodIdx) }));
  const dealRows: BarRow[] = perCampaign
    .filter((r) => r.f.deals > 0)
    .sort((a, b) => b.f.deals - a.f.deals || b.f.comm - a.f.comm)
    .map((r) => ({
      key: r.c.id,
      label: r.c.name,
      parts: [
        { v: r.f.directDeals, kind: "direct" },
        { v: r.f.deals - r.f.directDeals, kind: "indirect" },
      ],
      text: `${r.f.directDeals} / ${r.f.deals - r.f.directDeals} · ${money(r.f.comm)} · ROI ${currency === "AED" ? roiText(r.f.comm, r.f.spend) : "—"}`,
    }));
  const inPeriod = new Set(periodIdx);
  const idSet = new Set(ids);
  const sourceTotals = new Map<string, { deals: number; commission: number }>();
  for (const s of model!.sources) {
    if (!idSet.has(s.campaignId) || !inPeriod.has(s.month)) continue;
    const cur = sourceTotals.get(s.source) ?? { deals: 0, commission: 0 };
    cur.deals += s.deals;
    cur.commission += s.commission;
    sourceTotals.set(s.source, cur);
  }
  const sourceRows: BarRow[] = [...sourceTotals]
    .sort((a, b) => b[1].deals - a[1].deals || b[1].commission - a[1].commission)
    .map(([source, s]) => ({ key: source, label: source, parts: [{ v: s.deals, kind: "indirect" }], text: `${n(s.deals)} · ${money(s.commission)}` }));

  const tableRows = perCampaign
    .filter((r) => r.f.spend > 0 || r.f.leads > 0 || r.f.impr > 0 || r.c.id === effCampaign)
    .sort((a, b) => b.f.spend - a.f.spend || b.f.people - a.f.people)
    .map((r) => ({ campaign: r.c, f: r.f, platform: PLATFORMS[r.c.platform].label }));
  const tableShown = campsAll ? tableRows : tableRows.slice(0, CAMPAIGNS_SHOWN);

  const periodCol = period === "all" ? qs.length : qs.findIndex((q) => q.label === period);
  const kpiColumns = [...qs.map((q, i) => ({ label: q.label, f: quarterFigs[i] })), { label: rangeLabel(range.from, range.to, today), f: total(model!, ids, model!.months.map((_, i) => i)) }];
  const activeQuarters = new Set(period === "all" ? qs.map((_, i) => i) : [periodCol]);

  const scope = [
    effCampaign ? selected[0]?.name : "All campaigns",
    effPlatform !== "all" ? PLATFORMS[effPlatform].label : null,
    effCode ? `code ${effCode}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const crmWarning = pipeFailed ?? pipe?.error ?? null;
  const viewedDoneTotal = f.viewedDone;
  const toDay = Number(range.to.slice(8, 10));
  const endsInsideMonth = toDay < new Date(Date.UTC(Number(range.to.slice(0, 4)), Number(range.to.slice(5, 7)), 0)).getUTCDate();
  const pick = (id: string) => {
    setCampaign((cur) => (cur === id ? "" : id));
    // Back to the top, where the cards and the grid now show the campaign.
    if (typeof document !== "undefined") document.getElementById?.("main")?.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  return shell(
    <>
      <DataStatus
        source="Spend, impressions, clicks and platform leads from Google and Meta (Supermetrics); leads to commission from the Engage CRM"
        detail={`${dayText(range.from)} to ${dayText(range.to)}${paid.spendAsOf ? ` · spend as of ${fmtDubai(paid.spendAsOf)}` : ""}`}
        at={pipe?.cachedAt}
        updating={updating}
      />

      {paid.error ? <Notice tone="warn">{paid.error}</Notice> : null}
      {paid.failures.length ? (
        <Notice tone="warn">
          {paid.failures.length} ad account{paid.failures.length === 1 ? "" : "s"} could not be refreshed:{" "}
          {paid.failures.map((x) => `${x.accountName} (${x.reason}${x.cachedTo ? `; figures to ${dayText(x.cachedTo)} are in` : ""})`).join("; ")}.
        </Notice>
      ) : null}
      {crmWarning ? <Notice tone="warn">The CRM half could not be read: {crmWarning}. Spend, impressions, clicks and platform leads are still live.</Notice> : null}
      {pipe?.truncated ? <Notice tone="warn">The CRM sent the most rows it gives (2,000), so the smallest campaign months are missing.</Notice> : null}
      {!currency ? <Notice tone="info">The ad accounts bill in more than one currency, so spend and costs are left out rather than added across currencies.</Notice> : null}

      {!model!.campaigns.length ? (
        <Section>
          <p className="section-sub">No ad activity in this range for the ticked ad accounts.</p>
        </Section>
      ) : !selected.length ? (
        <Section>
          <p className="section-sub">No campaigns match these filters. Reset the filters to see the full view.</p>
        </Section>
      ) : (
        <>
          <Tiles f={f} ctx={ctx} selected={tile} onSelect={(i) => { if (i !== tile) setShowCost(false); setTile(i); }} onTrend={(i) => setTrend({ i, gran: "q", cum: false })} />

          <Section
            title={`${tileDef.grid.costOnly ? tileDef.grid.cost!.label : showCost && tileDef.grid.cost ? tileDef.grid.cost.label : tileDef.grid.label} by month: ${effCampaign ? selected[0]?.name : "each campaign"}`}
            sub={`Select a scorecard to change the figure. A filled month had ad spend or a result; darker means a higher figure for that campaign. People, and what they did, sit in the month of their first paid lead.${endsInsideMonth ? ` ${MONTH_NAMES[Number(range.to.slice(5, 7)) - 1]} runs to the ${ordinal(toDay)}.` : ""}`}
            actions={
              <>
                <select className="search-box" aria-label="Grid campaign" value={effCampaign} onChange={(e) => setCampaign(e.target.value)}>
                  <option value="">Each campaign</option>
                  {campaignOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {tileDef.grid.cost && !tileDef.grid.costOnly ? (
                  <span className="pill-group" role="group" aria-label="Figure or cost">
                    <button type="button" className={`filter-btn${!showCost ? " active" : ""}`} aria-pressed={!showCost} onClick={() => setShowCost(false)}>
                      {tileDef.grid.label}
                    </button>
                    <button type="button" className={`filter-btn${showCost ? " active" : ""}`} aria-pressed={showCost} onClick={() => setShowCost(true)}>
                      {tileDef.grid.cost.label}
                    </button>
                  </span>
                ) : null}
                {heatRows.length > HEAT_SHOWN ? (
                  <button type="button" className="filter-btn" onClick={() => setHeatAll((v) => !v)}>
                    {heatAll ? `Show the top ${HEAT_SHOWN}` : `Show all ${heatRows.length}`}
                  </button>
                ) : null}
              </>
            }
          >
            <div className="sc-scroll">
              <Heatmap tile={tileDef} showCost={showCost} rows={heatShown} total={selected.length > 1 ? months : null} months={model!.months} to={range.to} ctx={ctx} />
            </div>
          </Section>

          <Section title="KPI scorecard" sub="Actuals by quarter for the campaigns selected, and the whole range. The period you pick is marked.">
            <KpiTable columns={kpiColumns} selected={periodCol} ctx={ctx} />
          </Section>

          <Section
            title="Paid impact: direct and indirect"
            sub="Deals and commission come from the CRM. ROI is commission divided by spend."
          >
            <div className="sc-def">
              <div>
                <b>Direct</b>The deal was recorded on the paid lead, or on a listing taken on it.
              </div>
              <div>
                <b>Indirect</b>A paid ad came first. The deal came later on another lead of the same person: another channel, or the client&apos;s own listing.
              </div>
            </div>
            <div className="sc-legend">
              <span><i className="sw direct" />Direct</span>
              <span><i className="sw indirect" />Indirect</span>
            </div>
            <div className="sc-two">
              <div>
                <h3 className="sc-h3">Deals, with commission and ROI</h3>
                {crmOk ? <Bars rows={dealRows} empty="No deals recorded for this selection yet." /> : <p className="section-sub">{ctx.wait === "…" ? "Asking the CRM…" : "—"}</p>}
                {crmOk && f.deals ? (
                  <p className="section-sub">
                    All selected campaigns: {n(f.deals)} deals, {money(f.comm)} commission on {currency ? money(f.spend, currency) : "—"} spend, ROI{" "}
                    {currency === "AED" ? roiText(f.comm, f.spend) : "—"}.
                  </p>
                ) : null}
              </div>
              <div>
                <h3 className="sc-h3">Where indirect deals came through</h3>
                <p className="section-sub" style={{ marginTop: 0 }}>
                  The enquiry source of the later lead each indirect deal sits on.
                </p>
                {crmOk ? <Bars rows={sourceRows} empty="No indirect deals for this selection yet." /> : <p className="section-sub">{ctx.wait === "…" ? "Asking the CRM…" : "—"}</p>}
              </div>
            </div>
          </Section>

          <Section title="Paid leads by quarter" sub="People who came in on a paid lead, by the quarter of their first paid lead. Quarters outside the period you pick are faded.">
            <QuarterBars quarters={qs} values={quarterFigs.map((x) => x.people)} active={activeQuarters} ctx={ctx} />
          </Section>

          <Section
            title="Campaigns"
            sub={`Select a campaign to filter the page to it; select it again to show every campaign. ${tableRows.length} campaign${tableRows.length === 1 ? "" : "s"}${tableRows.length > CAMPAIGNS_SHOWN && !campsAll ? `, the ${CAMPAIGNS_SHOWN} with the most spend shown` : ""}.`}
            actions={
              tableRows.length > CAMPAIGNS_SHOWN ? (
                <button type="button" className="filter-btn" onClick={() => setCampsAll((v) => !v)}>
                  {campsAll ? `Show the top ${CAMPAIGNS_SHOWN}` : `Show all ${tableRows.length}`}
                </button>
              ) : undefined
            }
          >
            <CampaignTable rows={tableShown} ctx={ctx} picked={effCampaign} onPick={pick} />
          </Section>
        </>
      )}

      <Notes>
        <li>
          Paid leads in the CRM are people whose lead carries one of these ad campaigns as its utm_campaign (its name, or its Meta campaign id), created in
          the range, test, staff and internal leads left out. Each person counts once, under the campaign and month of their first paid lead.
        </li>
        <li>
          Viewings, listings, deals and commission are everything those people did from their first paid lead to today, on any of their leads, since agents
          open a new lead for a viewing, a listing or a deal. A viewing counts when it is logged as scheduled or completed and dated up to today
          {crmOk ? ` (${n(viewedDoneTotal)} of ${n(f.viewed)} were marked completed in this view)` : ""}.
        </li>
        <li>
          Deals are reserved, closed or completed, not withdrawn. Commission is gross: the final figure once the CRM has one, the reserved one until then.
          Direct means the deal sits on the paid lead itself or on a listing taken on it.
        </li>
        <li>Spend counts every campaign in the ticked ad accounts, recruitment included. Platform leads are as the ad platforms report them.</li>
        <li>
          Left out of the original scorecard, because neither source has them cleanly: the 2027 target plan and every target, Feeder, Harvest and Tactical
          roles and intent cohorts, Meta reach, video viewers and engagement, and website visits and form leads.
        </li>
      </Notes>

      {trend ? (
        <TrendModal
          tile={TILES[trend.i]}
          labels={trend.gran === "q" ? qs.map((q) => q.label) : monthLabels(model!.months)}
          series={trend.gran === "q" ? quarterFigs : months}
          gran={trend.gran}
          cumulative={trend.cum}
          onGran={(g) => setTrend((t) => (t ? { ...t, gran: g } : t))}
          onCumulative={(c) => setTrend((t) => (t ? { ...t, cum: c } : t))}
          onClose={() => setTrend(null)}
          scope={scope}
          to={range.to}
          ctx={ctx}
        />
      ) : null}
    </>,
  );
}

/** "1 Jan 2026". */
function dayText(d: string): string {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1];
  return `${Number(d.slice(8, 10))} ${m} ${d.slice(0, 4)}`;
}

/** The KPI table's last column: "Year to date" for this year so far, else the range. */
function rangeLabel(from: string, to: string, today: string): string {
  return from.slice(5) === "01-01" && from.slice(0, 4) === to.slice(0, 4) && to >= today ? "Year to date" : "Whole range";
}

/** How many months the period's days make, for "a month" averages: a part month counts as its share. */
function monthsCovered(months: string[], idx: number[], from: string, to: string): number {
  let total = 0;
  for (const i of idx) {
    const m = months[i];
    if (!m) continue;
    const days = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    const first = m === from.slice(0, 7) ? Number(from.slice(8, 10)) : 1;
    const last = m === to.slice(0, 7) ? Number(to.slice(8, 10)) : days;
    total += Math.max(0, last - first + 1) / days;
  }
  return total;
}

// ── Ad accounts: which accounts the page reads ──────────────────────────────
function AccountPicker({ config, onSaved }: { config: PaidConfig; onSaved: () => void }) {
  const initial = useMemo<Record<PaidPlatform, string[]>>(
    () => ({
      google: config.accounts.google.map((a) => a.id),
      meta: config.accounts.meta.map((a) => a.id),
      linkedin: config.accounts.linkedin.map((a) => a.id),
    }),
    [config],
  );
  const nothing = PLATFORM_ORDER.every((p) => (config.accounts[p] ?? []).length === 0);
  const [open, setOpen] = useState(nothing);
  const [sel, setSel] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [showHidden, setShowHidden] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const key = (s: Record<PaidPlatform, string[]>) => PLATFORM_ORDER.map((p) => [...s[p]].sort().join(",")).join("|");
  const dirty = key(sel) !== key(saved);
  const count = PLATFORM_ORDER.reduce((s, p) => s + saved[p].length, 0);

  function toggle(p: PaidPlatform, id: string) {
    setMsg(null);
    setSel((s) => ({ ...s, [p]: s[p].includes(id) ? s[p].filter((x) => x !== id) : [...s[p], id] }));
  }
  function save() {
    setMsg(null);
    startSave(async () => {
      const payload: Record<string, { id: string; name: string }[]> = {};
      for (const p of PLATFORM_ORDER) payload[p] = sel[p].map((id) => ({ id, name: ACCOUNT_CATALOG[p].find((a) => a.id === id)?.name || id }));
      const r = await savePaidConfigAction(payload);
      if (!r.ok) {
        setMsg(r.error || "Could not save.");
        return;
      }
      setSaved(sel);
      setOpen(false);
      onSaved();
    });
  }

  return (
    <div style={{ position: "relative" }}>
      <button type="button" className={`filter-btn${open ? " active" : ""}`} onClick={() => { if (open) setSel(saved); setOpen((v) => !v); }} title="Choose which ad accounts the page reads">
        Ad accounts · {count}
      </button>
      {open ? (
        <div className="chart-card sc-accounts">
          <p className="section-sub" style={{ marginTop: 0 }}>
            Only the ticked accounts are read. Closed, disabled and messaging-integration accounts are hidden unless shown.
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
            <button type="button" className="filter-btn" onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="filter-btn" onClick={() => { setSel(saved); setOpen(false); }} disabled={saving}>
              {dirty ? "Discard changes" : "Close"}
            </button>
            <button type="button" className="filter-btn" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "Hide closed and integration accounts" : "Show all accounts"}
            </button>
            {msg ? <span style={{ color: "var(--coral)", fontSize: 12 }}>{msg}</span> : null}
          </div>
          {PLATFORM_ORDER.map((p) => {
            const visible = showHidden ? ACCOUNT_CATALOG[p] : ACCOUNT_CATALOG[p].filter((a) => !a.disabled && !a.readOnly);
            return (
              <div key={p} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                  {PLATFORMS[p].label} <span className="muted">· {sel[p].length} ticked</span>
                </div>
                <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                  {visible.map((a) => (
                    <AccountRow key={a.id} acct={a} platform={p} checked={sel[p].includes(a.id)} onToggle={() => toggle(p, a.id)} />
                  ))}
                  {!visible.length ? <div className="muted" style={{ fontSize: 12 }}>None.</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AccountRow({ acct, platform, checked, onToggle }: { acct: CatalogAccount; platform: PaidPlatform; checked: boolean; onToggle: () => void }) {
  const blocked = VERIFIED_BLOCKED[platform].includes(acct.id);
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12, cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span style={{ flex: 1 }}>
        {acct.name}
        {acct.disabled ? <span className="muted" style={{ fontSize: 10 }}> · closed</span> : null}
        {acct.readOnly ? <span className="muted" style={{ fontSize: 10 }}> · integration</span> : null}
        {blocked ? (
          <span style={{ fontSize: 10, color: "var(--coral)" }} title="Supermetrics rejects this account as not prioritised on the subscription">
            {" "}· not licensed
          </span>
        ) : null}
      </span>
    </label>
  );
}
