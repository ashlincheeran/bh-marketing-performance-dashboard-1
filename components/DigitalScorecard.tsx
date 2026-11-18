"use client";

// The pipeline scorecard on the Digital tab: what the people the paid campaigns
// brought in went on to do, from the CRM (lib/digitalPipeline.ts), against what
// the campaigns cost, from the ad platforms through Supermetrics.
//
// It follows the tab's range and campaign filters (platform, campaign_code,
// utm_campaign, search). The CRM is asked once per range, about every ad
// campaign in it; the filters only choose which campaigns are added up. Each
// campaign keeps its own Engage codes, listed beside it one by one.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kpi, KpiGrid, Notice, Pills, Section } from "@/components/ui";
import UpdatedAgo from "@/components/UpdatedAgo";
import { useLiveRefresh } from "@/components/useLiveRefresh";
import { fmt, monthLabel } from "@/lib/format";
import { liveUrl } from "@/lib/live";
import type { PipelineCell, PipelineData } from "@/lib/digitalPipeline";

/** One ad campaign the tab's filters leave, with what it cost. */
export interface ScorecardCampaign {
  name: string;
  /** Its platform's name, e.g. "Meta Ads". */
  platform: string;
  /** What CRM leads carry as utm_campaign for it, in lower case: its name and, on Meta, its campaign id. */
  keys: string[];
  spend: number;
  impressions: number;
  clicks: number;
  /** Its Engage campaign codes, each as it is, the one with the most of its leads first. */
  codes: string[];
}

type Figures = Omit<PipelineCell, "campaign" | "month">;
const NONE: Figures = { leads: 0, people: 0, viewed: 0, listings: 0, deals: 0, directDeals: 0, commission: 0, directCommission: 0, reservedCommission: 0, dealValue: 0 };
const add = (a: Figures, b: Figures): Figures => {
  const out = { ...a };
  for (const k of Object.keys(NONE) as (keyof Figures)[]) out[k] += b[k];
  return out;
};

/** "AED 857K", "AED 1.25M", "AED 192". */
function money(n: number | null, cur: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `${cur} ${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${cur} ${Math.round(n / 1e3)}K`;
  return `${cur} ${new Intl.NumberFormat("en-US").format(Math.round(n))}`;
}
const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : fmt(n));
const pct = (n: number | null) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`);
const per = (cost: number | null, n: number) => (cost != null && n > 0 ? cost / n : null);

/** Every month from `from` to `to`, as YYYY-MM. */
function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    if (k > last) break;
    out.push(k);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
const quarterOf = (ym: string) => `Q${Math.ceil(Number(ym.slice(5, 7)) / 3)} ${ym.slice(0, 4)}`;

const CAMPAIGNS_SHOWN = 20;
/** Codes named beside a campaign; the rest are counted, and listed on hover. */
const CODES_SHOWN = 3;

export default function DigitalScorecard({
  from,
  to,
  allKeys,
  campaigns,
  spendByMonth,
  currency,
}: {
  from: string;
  to: string;
  /** Every ad campaign's name and Meta id in the range: what the CRM is asked about, whatever the filters. */
  allKeys: string[];
  /** The campaigns the tab's filters leave. */
  campaigns: ScorecardCampaign[];
  /** Their spend by month (YYYY-MM). */
  spendByMonth: Record<string, number>;
  /** The one currency spend is in, or null when the accounts bill in several. */
  currency: string | null;
}) {
  const [data, setData] = useState<PipelineData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [by, setBy] = useState<"month" | "quarter">("month");
  const [allShown, setAllShown] = useState(false);
  const latest = useRef(0);

  /** Ask the CRM. A live ask is quiet: a failure keeps what is shown, for the next turn to try again. */
  const load = useCallback(
    async (live = false) => {
      const id = ++latest.current;
      try {
        const res = await fetch(live ? liveUrl("/api/digital/pipeline") : "/api/digital/pipeline", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from, to, campaigns: allKeys }),
          cache: "no-store",
        });
        const j = (await res.json()) as Partial<PipelineData> & { error?: string };
        if (id !== latest.current) return;
        if (!Array.isArray(j.cells)) throw new Error(j.error || `HTTP ${res.status}`);
        setData(j as PipelineData);
        setFailed(null);
      } catch (e) {
        if (id !== latest.current || live) return;
        setFailed(e instanceof Error ? e.message : String(e));
      }
    },
    [from, to, allKeys],
  );

  // The tab mounts this once its ad data is in, and again for each new range.
  // State is set only when the CRM answers, never during the effect itself.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  const updating = useLiveRefresh(data?.cachedAt, () => load(true), !!data);

  // Which campaign each CRM key belongs to, among those the filters leave.
  const owner = useMemo(() => {
    const m = new Map<string, number>();
    campaigns.forEach((c, i) => c.keys.forEach((k) => m.set(k, i)));
    return m;
  }, [campaigns]);

  const sums = useMemo(() => {
    const byCampaign = campaigns.map(() => ({ ...NONE }));
    const byMonth = new Map<string, Figures>();
    let total = { ...NONE };
    for (const c of data?.cells ?? []) {
      const i = owner.get(c.campaign);
      if (i == null) continue;
      byCampaign[i] = add(byCampaign[i], c);
      byMonth.set(c.month, add(byMonth.get(c.month) ?? NONE, c));
      total = add(total, c);
    }
    const sources = new Map<string, { deals: number; commission: number }>();
    for (const s of data?.sources ?? []) {
      if (!owner.has(s.campaign)) continue;
      const cur = sources.get(s.source) ?? { deals: 0, commission: 0 };
      cur.deals += s.deals;
      cur.commission += s.commission;
      sources.set(s.source, cur);
    }
    return { byCampaign, byMonth, total, sources: [...sources].sort((a, b) => b[1].deals - a[1].deals || b[1].commission - a[1].commission) };
  }, [data, owner, campaigns]);

  const spendTotal = currency ? campaigns.reduce((s, c) => s + c.spend, 0) : null;
  const impressions = campaigns.reduce((s, c) => s + c.impressions, 0);
  const clicks = campaigns.reduce((s, c) => s + c.clicks, 0);
  const cur = currency ?? "";
  // Commission is in AED (every deal in the CRM is); set against spend only when spend is too.
  const comparable = currency === "AED";
  const t = sums.total;
  /** The CRM answered in full. Until it does a CRM figure reads "…", and "—" if it failed: never a zero. */
  const ok = !!data && !data.error;
  const wait = data || failed ? "—" : "…";
  const crm = (n: number) => (ok ? fmt(n) : wait);

  // Months, or quarters, from the range: spend by when it was spent, leads by when
  // they came in, and people with what they did by the month of their first paid lead.
  const periods = useMemo(() => {
    const rows = new Map<string, { spend: number; f: Figures }>();
    for (const m of monthsIn(from, to)) {
      const k = by === "month" ? m : quarterOf(m);
      const row = rows.get(k) ?? { spend: 0, f: { ...NONE } };
      row.spend += spendByMonth[m] ?? 0;
      row.f = add(row.f, sums.byMonth.get(m) ?? NONE);
      rows.set(k, row);
    }
    return [...rows].map(([k, v]) => ({ label: by === "month" ? monthLabel(k) : k, ...v }));
  }, [from, to, by, spendByMonth, sums.byMonth]);

  const ranked = useMemo(
    () => campaigns.map((c, i) => ({ c, f: sums.byCampaign[i] })).sort((a, b) => b.c.spend - a.c.spend || b.f.leads - a.f.leads),
    [campaigns, sums.byCampaign],
  );
  const shownCampaigns = allShown ? ranked : ranked.slice(0, CAMPAIGNS_SHOWN);

  const error = failed ?? data?.error ?? null;
  const indirect = t.deals - t.directDeals;

  return (
    <>
      <Section
        title="Pipeline scorecard"
        help="What the people the paid campaigns brought in went on to do, from the CRM, against what the campaigns cost, from the ad platforms. It follows the platform, campaign_code, utm_campaign and search filters above; the lead stage and the other utm filters do not apply here."
        sub={
          <>
            Each person counts once, under the campaign of their first paid lead in the range. Their viewings, listings and deals count up to
            today, on any of their leads.
            {data ? <UpdatedAgo at={data.cachedAt} updating={updating} /> : null}
          </>
        }
      >
        {error ? <Notice tone="warn">The CRM half of the scorecard could not be read: {error}. Spend, impressions and clicks are still live.</Notice> : null}
        {data?.truncated ? <Notice tone="warn">The CRM sent the most rows it gives (2,000), so the smallest campaign months are missing from these figures.</Notice> : null}
        {!currency && campaigns.length ? <Notice tone="info">The accounts bill in more than one currency, so the costs per step are left out.</Notice> : null}
        <KpiGrid cols={5}>
          <Kpi label="Spend" help="What the campaigns cost in the range, from the ad platforms through Supermetrics." value={money(spendTotal, cur)} sub={`${fmt(campaigns.length)} campaign${campaigns.length === 1 ? "" : "s"}`} />
          <Kpi label="Impressions" help="Times the ads were shown." value={short(impressions)} sub={`${money(per(spendTotal, impressions / 1000), cur)} per 1,000`} />
          <Kpi label="Clicks" help="Clicks on the ads. Meta counts link clicks." value={fmt(clicks)} sub={`${money(per(spendTotal, clicks), cur)} a click · ${pct(impressions ? clicks / impressions : null)} of impressions`} />
          <Kpi
            label="Leads"
            help="CRM leads created in the range whose utm_campaign is one of these campaigns (its name, or its Meta campaign id), test and staff leads left out."
            value={crm(t.leads)}
            sub={ok ? `${money(per(spendTotal, t.leads), cur)} a lead` : undefined}
          />
          <Kpi
            label="People"
            help="The people behind those leads, each once: a person who enquired three times is one person."
            value={crm(t.people)}
            sub={ok ? `${money(per(spendTotal, t.people), cur)} a person` : undefined}
          />
          <Kpi
            label="Had a viewing"
            help="People with a completed viewing in the CRM after their first paid lead, on any of their leads."
            value={crm(t.viewed)}
            sub={ok ? `${pct(t.people ? t.viewed / t.people : null)} of people · ${money(per(spendTotal, t.viewed), cur)} each` : undefined}
          />
          <Kpi
            label="Listings"
            help="Listings taken from these people after their first paid lead: the seller and landlord side's result."
            value={crm(t.listings)}
            sub={ok ? `${money(per(spendTotal, t.listings), cur)} a listing` : undefined}
          />
          <Kpi
            label="Deals"
            help="Deals reserved, closed or completed (not withdrawn) on these people's leads, or on a listing taken from them, after their first paid lead."
            value={crm(t.deals)}
            sub={ok ? `${fmt(t.directDeals)} on the paid lead, ${fmt(indirect)} on a later one · ${money(per(spendTotal, t.deals), cur)} a deal` : undefined}
          />
          <Kpi
            label="Commission"
            help="Gross commission on those deals: the final figure once the CRM has one, the reserved one until then."
            value={ok ? money(t.commission, "AED") : wait}
            sub={ok && t.reservedCommission ? `${money(t.reservedCommission, "AED")} still at Reserved` : undefined}
          />
          <Kpi
            label="Return on spend"
            help="Commission divided by spend. Below 1× the campaigns cost more than the commission they have brought so far; deals can still come."
            value={!ok ? wait : comparable && spendTotal ? `${(t.commission / spendTotal).toFixed(2)}×` : "—"}
            sub={ok && comparable && t.commission ? `spend is ${pct(per(spendTotal, t.commission))} of commission` : undefined}
          />
        </KpiGrid>
      </Section>

      <Section
        title={by === "month" ? "By month" : "By quarter"}
        help="Spend by when it was spent and leads by when they came in. People, and what they went on to do, sit in the month of their first paid lead, so a month's deals keep growing after it ends."
        actions={<Pills label="Group by" options={[["month", "Months"], ["quarter", "Quarters"]] as const} value={by} onChange={setBy} />}
      >
        <div className="table-scroll">
          <table className="perf-table">
            <thead>
              <tr>
                <th>{by === "month" ? "Month" : "Quarter"}</th>
                <th style={{ textAlign: "right" }}>Spend</th>
                <th style={{ textAlign: "right" }}>Leads</th>
                <th style={{ textAlign: "right" }}>Cost / lead</th>
                <th style={{ textAlign: "right" }}>People</th>
                <th style={{ textAlign: "right" }}>Had a viewing</th>
                <th style={{ textAlign: "right" }}>Listings</th>
                <th style={{ textAlign: "right" }}>Deals</th>
                <th style={{ textAlign: "right" }}>Commission</th>
                <th style={{ textAlign: "right" }}>Return</th>
              </tr>
            </thead>
            <tbody>
              {[...periods, { label: "Total", spend: spendTotal ?? 0, f: t }].map((p) => (
                <tr key={p.label} style={p.label === "Total" ? { fontWeight: 600 } : undefined}>
                  <td>{p.label}</td>
                  <td style={{ textAlign: "right" }}>{currency ? money(p.spend, cur) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{crm(p.f.leads)}</td>
                  <td style={{ textAlign: "right" }}>{ok && currency ? money(per(p.spend, p.f.leads), cur) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{crm(p.f.people)}</td>
                  <td style={{ textAlign: "right" }}>{crm(p.f.viewed)}</td>
                  <td style={{ textAlign: "right" }}>{crm(p.f.listings)}</td>
                  <td style={{ textAlign: "right" }}>{crm(p.f.deals)}</td>
                  <td style={{ textAlign: "right" }}>{ok ? money(p.f.commission, "AED") : wait}</td>
                  <td style={{ textAlign: "right" }}>{ok && comparable && p.spend > 0 ? `${(p.f.commission / p.spend).toFixed(2)}×` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Where the deals came through"
        help="A deal on the paid lead itself, or on a listing taken on it, is direct. The rest sit on a later lead of the same person, which agents open for a viewing, a listing or a deal, or which came in through another channel; its enquiry source is shown."
      >
        {ok ? (
          t.deals ? (
            <div className="table-scroll">
              <table className="perf-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th style={{ textAlign: "right" }}>Deals</th>
                    <th style={{ textAlign: "right" }}>Commission</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>On the paid lead</td>
                    <td style={{ textAlign: "right" }}>{fmt(t.directDeals)}</td>
                    <td style={{ textAlign: "right" }}>{money(t.directCommission, "AED")}</td>
                  </tr>
                  {sums.sources.map(([source, s]) => (
                    <tr key={source}>
                      <td>Later lead · {source}</td>
                      <td style={{ textAlign: "right" }}>{fmt(s.deals)}</td>
                      <td style={{ textAlign: "right" }}>{money(s.commission, "AED")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="section-sub">No deals yet from the people these campaigns brought in.</p>
          )
        ) : (
          <p className="section-sub">{error ? "—" : "Asking the CRM…"}</p>
        )}
      </Section>

      <Section
        title="Campaigns"
        help="One row per ad campaign, by spend. Beside it, the Engage campaign codes its leads are linked to, each as it is, the code with the most of its leads first; hover for the full list. A Meta campaign's leads can carry its name or its id; both count here."
        sub={`${fmt(ranked.length)} campaign${ranked.length === 1 ? "" : "s"}${ranked.length > CAMPAIGNS_SHOWN && !allShown ? `, the ${CAMPAIGNS_SHOWN} with the most spend shown` : ""}`}
        actions={
          ranked.length > CAMPAIGNS_SHOWN ? (
            <button type="button" className="filter-btn" onClick={() => setAllShown((v) => !v)}>
              {allShown ? `Show the top ${CAMPAIGNS_SHOWN}` : `Show all ${fmt(ranked.length)}`}
            </button>
          ) : undefined
        }
      >
        <div className="table-scroll">
          <table className="perf-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th style={{ textAlign: "right" }}>Spend</th>
                <th style={{ textAlign: "right" }}>Leads</th>
                <th style={{ textAlign: "right" }}>Cost / lead</th>
                <th style={{ textAlign: "right" }}>People</th>
                <th style={{ textAlign: "right" }}>Had a viewing</th>
                <th style={{ textAlign: "right" }}>Listings</th>
                <th style={{ textAlign: "right" }}>Deals</th>
                <th style={{ textAlign: "right" }}>Commission</th>
              </tr>
            </thead>
            <tbody>
              {shownCampaigns.map(({ c, f }) => (
                <tr key={`${c.platform}|${c.name}`}>
                  <td style={{ maxWidth: 380 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>
                      {c.name}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }} title={c.codes.length > CODES_SHOWN ? c.codes.join("\n") : undefined}>
                      {c.platform}
                      {c.codes.length ? ` · ${c.codes.slice(0, CODES_SHOWN).join(" · ")}` : " · no Engage code"}
                      {c.codes.length > CODES_SHOWN ? ` · +${c.codes.length - CODES_SHOWN} more` : ""}
                    </div>
                  </td>
                  <td style={{ textAlign: "right" }}>{currency ? money(c.spend, cur) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{crm(f.leads)}</td>
                  <td style={{ textAlign: "right" }}>{ok && currency ? money(per(c.spend, f.leads), cur) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{crm(f.people)}</td>
                  <td style={{ textAlign: "right" }}>{crm(f.viewed)}</td>
                  <td style={{ textAlign: "right" }}>{crm(f.listings)}</td>
                  <td style={{ textAlign: "right" }}>{crm(f.deals)}</td>
                  <td style={{ textAlign: "right" }}>{ok ? money(f.commission, "AED") : wait}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
