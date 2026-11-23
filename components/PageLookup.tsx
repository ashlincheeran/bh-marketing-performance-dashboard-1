"use client";

// Section 02 of the Website tab: any one bhomes.com page, looked up live in
// PostHog over the last 7, 30 or 90 days (lib/websiteGrowth.ts getPageLookup,
// through /api/website?path=…&days=…): its traffic, how long people stayed,
// the buttons they clicked, the forms they opened and sent, and where they
// went next.
import { useState, type FormEvent } from "react";
import { BarList } from "@/components/ui";
import * as ch from "@/components/report/charts";
import { Card, Plot, Waiting, cx } from "@/components/report/Report";
import { getJson } from "@/components/report/usePeriodReport";
import s from "@/components/report/report.module.css";
import { num, sectionName, share } from "@/lib/growthMath";
import { LOOKUP_DAYS, VISIT_CHANNELS, lookupPath } from "@/lib/website";
import type { PageLookup as Lookup } from "@/lib/websiteGrowth";

/** Pages offered to try, as the site's own main sections. */
const EXAMPLES = ["/en", "/en/buy", "/en/rent", "/en/blog", "/en/property-management"];

const channelName = (k: string) => VISIT_CHANNELS.find((c) => c.key === k)?.label ?? (k === "direct" ? "Direct" : k);

/** A part PostHog did not answer for: said so in its card, never drawn as nothing. */
const missing = <Waiting text="PostHog did not answer for this part. Search again in a minute." />;

export default function PageLookup() {
  const [text, setText] = useState("");
  const [days, setDays] = useState<number>(30);
  const [state, setState] = useState<{ status: "idle" | "busy" | "done" | "error"; message: string; data?: Lookup }>({
    status: "idle",
    message: "Enter a page link and press Search.",
  });

  const look = async (raw: string) => {
    const path = lookupPath(raw);
    if (path == null) {
      setState({ status: "error", message: "Enter a bhomes.com link or a path such as /en/buy." });
      return;
    }
    const name = path || "/";
    setState({ status: "busy", message: `Looking up ${name} in PostHog…` });
    try {
      const d = await getJson<Lookup>(`/api/website?path=${encodeURIComponent(path)}&days=${days}`);
      if (!d.connected) setState({ status: "error", message: "PostHog is not connected (no API key)." });
      else if (!d.overview) setState({ status: "error", message: "PostHog did not answer. Try again in a minute." });
      else if (!d.overview.views) setState({ status: "error", message: `No page views for ${name} in the last ${days} days. Check the link, or try a longer period.` });
      else setState({ status: "done", message: `Showing ${name} · last ${days} days · ${num(d.overview.views)} page views.`, data: d });
    } catch (e) {
      setState({ status: "error", message: `PostHog could not be asked: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void look(text);
  };

  const d = state.status === "done" ? state.data : undefined;
  const o = d?.overview, en = d?.entrances;
  const tiles: [string, string, string][] = o
    ? [
        ["Page views", num(o.views), ""],
        ["Visitors", num(o.visitors), "unique people"],
        ["Entrances", en ? num(en.visits) : "—", "visits that began here"],
        ["Bounce rate", en?.bounce != null && en.visits ? `${en.bounce}%` : "—", "of entrances, one page only"],
        ["Time on page", o.seconds != null ? `${Math.round(o.seconds)}s` : "—", "average, when they left it"],
        ["Scroll depth", o.scroll != null ? `${Math.round(o.scroll)}%` : "—", "average, of the page"],
        ["Button clicks", num(o.clicks), `${num(o.clickers)} people`],
        ["Click-through", o.visitors ? share(o.clickers / o.visitors, 0) : "—", "of visitors clicked"],
        ["Form opens", num(o.openers), "people"],
        ["Forms sent", num(o.senders), o.visitors ? `${share(o.senders / o.visitors)} of visitors` : ""],
      ]
    : [];
  const trendLabels = (d?.trend ?? []).map((t) => t.day.slice(5));

  return (
    <Card title="Look up a page" tag="PostHog · live">
      <form className={s.lkForm} onSubmit={submit} autoComplete="off">
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="https://www.bhomes.com/en/buy or /en/buy" aria-label="Page link" />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Look-up period">
          {LOOKUP_DAYS.map((n) => <option key={n} value={n}>Last {n} days</option>)}
        </select>
        <button type="submit" disabled={state.status === "busy"} onClick={(e) => { e.preventDefault?.(); void look(text); }}>Search</button>
      </form>
      <div className={s.lkChips}>
        Try:
        {EXAMPLES.map((p) => (
          <button key={p} type="button" onClick={() => { setText(p); void look(p); }}>{p}</button>
        ))}
      </div>
      <p className={cx(s.lkStatus, state.status === "error" && s.err)} role="status">{state.message}</p>

      {d && o && (
        <>
          <div className={s.lkKpis}>
            {tiles.map(([label, value, sub]) => (
              <div key={label} className={s.lkKpi}><p>{label}</p><b>{value}</b><span>{sub}</span></div>
            ))}
          </div>
          <div className={s.grid} style={{ marginTop: 14 }}>
            <Card className={s.span2} title="Views and visitors per day" tag={`last ${d.days} days`}>
              {d.trend
                ? <Plot spec={ch.lines(trendLabels, d.trend.map((t) => t.day), [
                    { label: "Page views", data: d.trend.map((t) => t.views), color: ch.CHANNEL_COLOURS.organic },
                    { label: "Visitors", data: d.trend.map((t) => t.visitors), color: ch.CHANNEL_COLOURS.ai },
                  ])} />
                : missing}
            </Card>
            <Card title="Where visitors came from" tag="visitors">
              {d.sources
                ? <BarList rows={d.sources.slice(0, 8).map((x) => ({
                    name: channelName(x.channel), value: x.visitors, shown: num(x.visitors),
                    color: ch.CHANNEL_COLOURS[x.channel] ?? ch.C.pr, title: `${channelName(x.channel)}: ${num(x.visitors)} visitors`,
                  }))} />
                : missing}
            </Card>
            <Card className={s.span2} title="Buttons and links clicked" tag="clicks · top 12"
              note={d.clicks?.length ? "Hover a bar to see where the button leads and how many people clicked it." : undefined}>
              {!d.clicks ? missing : d.clicks.length
                ? <Plot spec={ch.namedBars(
                    d.clicks.map((c) => `${c.button.slice(0, 40)}${c.place ? `  ·  ${c.place}` : ""}`),
                    [{ label: "Clicks", data: d.clicks.map((c) => c.clicks), color: ch.CHANNEL_COLOURS.organic }],
                    { sideways: true, after: (i) => [`${num(d.clicks?.[i]?.people)} people`, d.clicks?.[i]?.target ? `Goes to: ${d.clicks[i].target}` : ""].filter(Boolean).join("\n") },
                  )} height={Math.max(220, d.clicks.length * 28)} />
                : <Waiting text="No tracked button clicks on this page in this period." />}
            </Card>
            <Card title="Where they went next" tag="page views">
              {!d.next ? missing : d.next.length
                ? <BarList rows={d.next.map((x) => ({
                    name: x.page.slice(0, 45), value: x.views, shown: num(x.views),
                    color: x.page.startsWith("(") ? ch.C.prSoft : ch.CHANNEL_COLOURS.organic, title: `${x.page}: ${num(x.views)}`,
                  }))} />
                : <Waiting text="No next pages recorded." />}
            </Card>
            <Card className={s.span2} title="Forms on this page" tag="people · opened and sent"
              note={d.forms?.length ? "Opened counts form pop-ups; sent counts submissions. A form on the page itself is sent without a tracked open." : undefined}>
              {!d.forms ? missing : d.forms.length
                ? <Plot spec={ch.namedBars(d.forms.map((f) => sectionName(f.form)), [
                    { label: "Opened", data: d.forms.map((f) => f.opened), color: ch.C.prSoft },
                    { label: "Sent", data: d.forms.map((f) => f.sent), color: ch.C.biz },
                  ], { sideways: true })} height={Math.max(200, d.forms.length * 44)} />
                : <Waiting text="No forms were opened or sent on this page in this period." />}
            </Card>
            <Card title="Device" tag="visitors">
              {d.devices
                ? <BarList rows={d.devices.map((x) => ({
                    name: x.device, value: x.visitors, shown: num(x.visitors),
                    share: o.visitors ? share(x.visitors / o.visitors, 0) : undefined,
                    color: ch.CHANNEL_COLOURS.organic, title: `${x.device}: ${num(x.visitors)} visitors`,
                  }))} />
                : missing}
            </Card>
          </div>
        </>
      )}
    </Card>
  );
}
