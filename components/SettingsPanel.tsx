"use client";

// Admin settings. Everything here is deployment-wide, not per-browser — that is
// the whole reason it sits behind its own PIN.
import { useState, useTransition } from "react";
import Link from "next/link";
import { setNewsSettingsAction, setSeoSourceAction, setSupermetricsEnabledAction } from "@/app/actions";
import { callAction, notFinished } from "@/lib/actionCall";
import { C } from "@/lib/theme";
import type { SettingsInfo } from "@/lib/settingsInfo";
import type { AppSettings, SeoSource } from "@/lib/appSettings";
import type { NewsSettings } from "@/lib/news/types";
import DiagnosticsConsole from "@/components/DiagnosticsConsole";

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
const fmtAED = (n: number) =>
  n >= 1e6 ? `AED ${(n / 1e6).toFixed(2)}M` : `AED ${new Intl.NumberFormat("en-US").format(Math.round(n))}`;

const fieldLabel: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", color: C.mid };

/**
 * The models the news bot can sort with, and what each costs at our volume.
 * The list matches NEWS_MODELS in lib/appSettings.ts, which is server-only, so
 * it is repeated here rather than imported.
 */
const NEWS_MODEL_CHOICES: { key: NewsSettings["model"]; title: string; cost: string; note?: string }[] = [
  {
    key: "claude-haiku-5-5",
    title: "Claude Haiku 5.5",
    cost: "Under $0.25 a month",
    note: "Recommended. The program has already found the names, so what is left is a short sorting job.",
  },
  { key: "claude-sonnet-5-5", title: "Claude Sonnet 5.5", cost: "About $2.50 a month" },
  { key: "claude-opus-5-5", title: "Claude Opus 5.5", cost: "About $5 a month" },
];

const SEARCH_WINDOWS: { key: NewsSettings["searchWindow"]; label: string }[] = [
  { key: "", label: "No limit" },
  { key: "1d", label: "1 day" },
  { key: "2d", label: "2 days" },
  { key: "7d", label: "7 days" },
];

/** A cap the form can save: a whole number of reads from 0 to 500, as cleanNewsSettings accepts. */
const capFrom = (text: string): number | null => {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 500 ? n : null;
};

/**
 * What the card says once a save turned counting back on, from whether the
 * publish step started.
 *
 * A start that got no answer in time may be running all the same:
 * startNewsStep says it "did not confirm" that it started, and `uncertain`
 * says so outright where the action passes it on. Calling that "did not
 * start" and advising a retry would start a second publish over the same
 * held articles while the first may still be working through them.
 */
export function publishMessage(publish: { started: boolean; uncertain?: boolean; error?: string }): { ok: boolean; text: string } {
  if (publish.started) {
    return {
      ok: true,
      text: "Saved. Counting is on, and everything held is being published to the PR tab now. Bot Activity shows it as it goes.",
    };
  }
  if (publish.uncertain || /did not confirm/i.test(publish.error ?? "")) {
    return {
      ok: false,
      text: "Saved, and counting is on. The news bot did not confirm that publishing started, but it may well be running. Look at Bot Activity in a few minutes. Only if no publish step shows there, switch counting off and save, then on and save.",
    };
  }
  // The reason is a sentence of its own, so its full stop goes before the advice is added.
  const why = (publish.error ?? "").replace(/[\s.!?]+$/, "") || "no reason was given";
  return {
    ok: false,
    text: `Saved, and counting is on, but publishing what was held did not start: ${why}. To try again, switch counting off and save, then switch it on and save.`,
  };
}

/**
 * The news bot's settings: whether its decisions count on the PR tab, which
 * Claude model sorts the articles, how far back the searches look, and whether
 * Apify may read pages that block a plain read. Saved together, for everyone,
 * and used from the next run.
 *
 * `initial` is null when the saved settings could not be read. The card then
 * says so and offers nothing to save: the form would show the defaults, whose
 * counting is on, and saving them would end test mode and publish everything
 * held.
 */
function NewsBotSettings({
  initial,
  readError,
  scheduled,
  claudeKeySet,
  apifyConfigured,
  lastIngest,
  pinsFromEnv,
  heldCount,
}: {
  initial: NewsSettings | null;
  /** Why the settings could not be read. */
  readError: string | null;
  /** True in production, where the morning run is scheduled. */
  scheduled: boolean;
  claudeKeySet: boolean;
  apifyConfigured: boolean;
  lastIngest: SettingsInfo["lastIngest"];
  pinsFromEnv: SettingsInfo["pinsFromEnv"];
  /** Decisions held while counting was off, or null when they could not be counted. */
  heldCount: number | null;
}) {
  return (
    <div className="chart-card">
      <h3 style={{ margin: "0 0 6px" }}>News bot</h3>
      <p style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.6, margin: "0 0 12px" }}>
        {/* Vercel runs the morning cron in production only, so a preview runs when someone starts it. */}
        {scheduled
          ? "Every morning at 08:00 Dubai the bot searches Google News, reads each new article, and asks Claude to sort the ones that name a tracked company or person."
          : "On this preview the bot runs only when someone presses Run now on Bot Activity. The daily run at 08:00 Dubai happens in production. Each run searches Google News, reads each new article, and asks Claude to sort the ones that name a tracked company or person."}{" "}
        What it keeps counts on the PR &amp; Media tab, unless counting is switched off below. These settings apply to
        everyone, from the next run.
      </p>

      <div style={{ fontSize: 12.5, marginBottom: 16 }}>
        Claude key (ANTHROPIC_API_KEY):{" "}
        <strong style={{ color: claudeKeySet ? C.green : C.red }}>{claudeKeySet ? "Set" : "Not set"}</strong>
        {!claudeKeySet && (
          <span style={{ color: C.red }}>
            {" "}
            Add it in Vercel. Until then the bot finds and reads articles, but none is checked and nothing new counts.
          </span>
        )}
      </div>

      {initial ? (
        <NewsBotForm initial={initial} apifyConfigured={apifyConfigured} heldCount={heldCount} />
      ) : (
        <div style={{ fontSize: 12.5, color: C.red, lineHeight: 1.6 }}>
          The news bot&apos;s settings could not be read just now, so they are not shown and can&apos;t be saved: a save
          now could switch test mode off by mistake. Reload the page to try again.
          {readError && (
            <>
              <br />
              <span style={{ color: C.mid }}>Reason: {readError}</span>
            </>
          )}
        </div>
      )}

      <p
        style={{
          fontSize: 12,
          color: C.mid,
          margin: "16px 0 0",
          paddingTop: 12,
          borderTop: "1px solid var(--border)",
          lineHeight: 1.6,
        }}
      >
        People Sentiment and Socials Performance refresh weekly, Mondays at 09:00 and 09:40 Dubai.{" "}
        {lastIngest ? (
          <span suppressHydrationWarning>
            Last news run {new Date(lastIngest.ranAt).toLocaleString()} ({lastIngest.trigger}),{" "}
            {lastIngest.ok ? "ok" : "failed"}, {lastIngest.inserted} counted.
          </span>
        ) : (
          "No news runs recorded yet."
        )}
        <br />
        PINs: app {pinsFromEnv.app ? "set via DASHBOARD_PIN" : "using the built-in default"} · settings{" "}
        {pinsFromEnv.settings ? "set via SETTINGS_PIN" : "using the built-in default"}.
      </p>
    </div>
  );
}

/** The news bot's settings as saved, to change and save: shown only once they were read. */
function NewsBotForm({
  initial,
  apifyConfigured,
  heldCount,
}: {
  initial: NewsSettings;
  apifyConfigured: boolean;
  /** Decisions held while counting was off, or null when they could not be counted. */
  heldCount: number | null;
}) {
  const [s, setS] = useState<NewsSettings>(initial);
  const [saved, setSaved] = useState<NewsSettings>(initial);
  const [capText, setCapText] = useState(String(initial.apifyMonthlyCap));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const cap = capFrom(capText);
  const dirty = cap === null || JSON.stringify({ ...s, apifyMonthlyCap: cap }) !== JSON.stringify(saved);

  function update(patch: Partial<NewsSettings>) {
    setS((prev) => ({ ...prev, ...patch }));
    setMsg(null);
  }

  function save() {
    if (cap === null) {
      setMsg({ ok: false, text: "The monthly cap must be a whole number from 0 to 500." });
      return;
    }
    const next = { ...s, apifyMonthlyCap: cap };
    const wasCounting = saved.countOnPrTab;
    // A save that turns counting on starts the publish, so a call that did not finish may have done either.
    const failed =
      !wasCounting && next.countOnPrTab
        ? "The request did not finish, so it is not known whether the settings were saved, or whether publishing what was held started. Reload Settings to see what was saved, and look at Bot Activity before saving again."
        : notFinished("the settings were saved", "Settings");
    start(async () => {
      const r = await callAction(() => setNewsSettingsAction(next, wasCounting), failed);
      if (r.ok) {
        setS(r.settings);
        setSaved(r.settings);
        setCapText(String(r.settings.apifyMonthlyCap));
        // Turning counting on starts the publish; the action says whether it did.
        if (r.publish) {
          setMsg(publishMessage(r.publish));
        } else if (wasCounting && !r.settings.countOnPrTab) {
          setMsg({
            ok: true,
            text: "Saved. Test mode is on: from the next run the bot holds its decisions for review on Bot Activity, and the PR tab stays as it is.",
          });
        } else {
          setMsg({ ok: true, text: "Saved. The next run uses these settings." });
        }
      } else {
        setMsg({ ok: false, text: r.error });
      }
    });
  }

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <div style={fieldLabel}>Count on the PR tab</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
          <button
            type="button"
            className={`filter-btn${s.countOnPrTab ? " active" : ""}`}
            aria-pressed={s.countOnPrTab}
            onClick={() => update({ countOnPrTab: true })}
          >
            On
          </button>
          <button
            type="button"
            className={`filter-btn${!s.countOnPrTab ? " active" : ""}`}
            aria-pressed={!s.countOnPrTab}
            onClick={() => update({ countOnPrTab: false })}
          >
            Off (test mode)
          </button>
          <span style={{ fontSize: 11.5, color: saved.countOnPrTab ? C.mid : C.amber, marginLeft: 4 }}>
            {saved.countOnPrTab ? "On now." : "Off now: test mode."}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: C.mid, marginTop: 6, lineHeight: 1.5 }}>
          Off is test mode: the bot still finds and sorts articles, but holds its decisions for review on Bot Activity,
          and the live PR tab stays as it is. Turning counting back on publishes everything held to the PR tab.
        </div>
        {!saved.countOnPrTab && s.countOnPrTab && (
          <div style={{ fontSize: 11.5, color: C.amber, marginTop: 4 }}>
            Saving publishes{" "}
            {heldCount == null
              ? "every held decision"
              : heldCount === 1
                ? "the 1 held decision"
                : `the ${fmtInt(heldCount)} held decisions`}{" "}
            to the PR tab.
          </div>
        )}
      </div>

      <div style={fieldLabel}>AI that sorts the articles</div>
      <div style={{ fontSize: 11.5, color: C.mid, margin: "4px 0 8px" }}>What each costs a month at our volume.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {NEWS_MODEL_CHOICES.map((m) => {
          const chosen = s.model === m.key;
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={chosen}
              onClick={() => update({ model: m.key })}
              style={{
                textAlign: "left",
                font: "inherit",
                color: "inherit",
                cursor: "pointer",
                border: `1.5px solid ${chosen ? C.green : "var(--border)"}`,
                borderRadius: 10,
                padding: 14,
                background: chosen ? "rgba(46, 125, 50, 0.04)" : "#fff",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{m.title}</strong>
                {saved.model === m.key && <span style={{ fontSize: 11, fontWeight: 600, color: C.green }}>In use</span>}
              </div>
              <div style={{ fontSize: 12, marginTop: 4 }}>{m.cost}</div>
              {m.note && <div style={{ fontSize: 11.5, color: C.mid, marginTop: 6, lineHeight: 1.5 }}>{m.note}</div>}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 18 }}>
        <div style={fieldLabel}>Google News time window</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {SEARCH_WINDOWS.map((w) => (
            <button
              key={w.key || "none"}
              type="button"
              className={`filter-btn${s.searchWindow === w.key ? " active" : ""}`}
              aria-pressed={s.searchWindow === w.key}
              onClick={() => update({ searchWindow: w.key })}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: C.mid, marginTop: 6, lineHeight: 1.5 }}>
          How far back each search looks. Two days means a morning the run fails is still covered by the next one. With
          no limit, Google News returns stories of any age, and the ones already stored are dropped as repeats.
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <div style={fieldLabel}>Apify backup</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
          <button
            type="button"
            className={`filter-btn${!s.apifyBackup ? " active" : ""}`}
            aria-pressed={!s.apifyBackup}
            onClick={() => update({ apifyBackup: false })}
          >
            Off
          </button>
          <button
            type="button"
            className={`filter-btn${s.apifyBackup ? " active" : ""}`}
            aria-pressed={s.apifyBackup}
            onClick={() => update({ apifyBackup: true })}
          >
            On
          </button>
          <label htmlFor="news-apify-cap" style={{ fontSize: 12, color: C.mid, marginLeft: 10 }}>
            Up to
          </label>
          <input
            id="news-apify-cap"
            className="search-box"
            type="number"
            min={0}
            max={500}
            step={1}
            inputMode="numeric"
            style={{ width: 90, minWidth: 0 }}
            value={capText}
            onChange={(e) => {
              setCapText(e.target.value);
              setMsg(null);
            }}
          />
          <span style={{ fontSize: 12, color: C.mid }}>reads a month</span>
        </div>
        <div style={{ fontSize: 11.5, color: C.mid, marginTop: 6, lineHeight: 1.5 }}>
          When a page blocks a plain read, Apify reads it instead, up to the cap each calendar month. Off by default: a
          plain read covers most sites, and each Apify read uses the monthly Apify allowance.
        </div>
        {s.apifyBackup && !apifyConfigured && (
          <div style={{ fontSize: 11.5, color: C.red, marginTop: 4 }}>
            APIFY_TOKEN is not set, so the backup cannot read anything until it is added in Vercel.
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 18 }}>
        <button
          className="filter-btn"
          onClick={save}
          disabled={pending || !dirty}
          style={{ borderColor: C.green, color: C.green }}
        >
          {pending ? "Saving…" : "Save news bot settings"}
        </button>
        {dirty && !pending && <span style={{ fontSize: 11.5, color: C.mid }}>Not saved yet.</span>}
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 10, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </>
  );
}

export default function SettingsPanel({
  info,
  settings,
  news,
  newsError = null,
  settingsError = null,
  scheduled,
  claudeKeySet,
  newsHeld = null,
}: {
  info: SettingsInfo;
  /**
   * The deployment-wide switches. Not the news bot's settings: getAppSettings
   * gives the defaults when its read fails, and those are passed as `news`
   * from a strict read instead.
   */
  settings: Omit<AppSettings, "news">;
  /** The news bot's saved settings, or null when they could not be read: the card then offers nothing to save. */
  news: NewsSettings | null;
  /** Why the news bot's settings could not be read. */
  newsError?: string | null;
  /** Why the app settings could not be read, when they couldn't: the Supermetrics and SEO cards then save nothing. */
  settingsError?: string | null;
  /** True in production, where the news bot's morning run is scheduled. A preview has no cron. */
  scheduled: boolean;
  /** Whether ANTHROPIC_API_KEY is set on the server. Only that: the key itself never reaches the browser. */
  claudeKeySet: boolean;
  /** How many of the news bot's decisions are held (test mode), or null when they could not be counted. */
  newsHeld?: number | null;
}) {
  const [on, setOn] = useState(settings.supermetricsEnabled);
  const [note, setNote] = useState(settings.note);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const [seoSource, setSeoSource] = useState<SeoSource>(settings.seoSource);
  const [seoMsg, setSeoMsg] = useState<string | null>(null);
  const smConfigured = info.connections.find((c) => c.name === "Supermetrics")?.configured ?? false;
  const directConfigured = info.connections.find((c) => c.name === "Search Console (direct)")?.configured ?? false;

  function saveSeoSource(next: SeoSource) {
    if (next === seoSource) return;
    setSeoMsg(null);
    start(async () => {
      const r = await callAction(() => setSeoSourceAction(next), notFinished("the SEO source was changed", "Settings"));
      if (r.ok) {
        setSeoSource(next);
        setSeoMsg(next === "direct"
          ? "SEO now reads Search Console directly — no Supermetrics rows."
          : "SEO now reads Search Console through Supermetrics.");
      } else {
        setSeoMsg(r.error);
      }
    });
  }

  function save(next: boolean) {
    setMsg(null);
    start(async () => {
      const r = await callAction(
        () => setSupermetricsEnabledAction(next, note),
        notFinished("the Supermetrics switch was changed", "Settings"),
      );
      if (r.ok) {
        setOn(next);
        setMsg(next ? "Supermetrics is ON for everyone." : "Supermetrics is OFF for everyone.");
      } else {
        setMsg(r.error);
      }
    });
  }

  const editors = [
    { label: "Ad accounts (Google, Meta, LinkedIn)", href: "/digital", what: "Which accounts the Digital tab queries. The main quota lever.", count: `${info.counts.paidAccounts} selected` },
    { label: "SEO keywords", href: "/seo", what: "Terms tracked for rankings.", count: `${info.counts.seoKeywords} tracked` },
    {
      label: "News and competitor keywords",
      href: "/bot",
      what: "What the news bot searches for.",
      // Null when the lists could not be read: not "0 news".
      count:
        info.counts.prKeywords == null || info.counts.competitorKeywords == null
          ? "could not be read just now"
          : `${info.counts.prKeywords} news · ${info.counts.competitorKeywords} competitor`,
    },
    { label: "Benchmark brands and handles", href: "/socials", what: "Competitors compared on social, and their Apify actors.", count: `${info.counts.benchmarkBrands} brands` },
  ];

  return (
    <>
      {/* ── the global switch ────────────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20, borderColor: on ? C.sage : C.red }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px" }}>
            <h3 style={{ margin: "0 0 6px" }}>Supermetrics API</h3>
            <p style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.6, margin: 0 }}>
              Turns every Supermetrics call off for <strong>everyone</strong>, not just this browser. While off, no
              rows are spent at all: the check happens on the server before any request is made.
              <br />
              Affects the <strong>Digital Performance</strong> tab, and <strong>SEO</strong>&rsquo;s Search
              Console figures while the SEO source below is set to Supermetrics. Company Performance, Portals,
              Website, PR and People Sentiment are unaffected — they do not use Supermetrics.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: on ? C.green : C.red, marginBottom: 8 }}>
              {on ? "ON" : "OFF"}
            </div>
            <button
              className="filter-btn"
              onClick={() => save(!on)}
              disabled={pending || !!settingsError}
              title={settingsError ? "Settings could not be read just now: reload before changing this." : undefined}
              style={{ borderColor: on ? C.red : C.green, color: on ? C.red : C.green }}
            >
              {pending ? "Saving…" : on ? "Turn OFF for everyone" : "Turn ON for everyone"}
            </button>
            {settingsError && (
              <div style={{ fontSize: 11, color: C.red, marginTop: 6, maxWidth: 260 }}>
                Settings could not be read just now ({settingsError}), so this shows the default. Reload before changing it.
              </div>
            )}
          </div>
        </div>

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <label style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", color: C.mid }}>
            Reason shown to viewers while off
          </label>
          <input
            className="search-box"
            style={{ width: "100%", marginTop: 6 }}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 200))}
            placeholder="e.g. Monthly row quota spent — back on 1 September"
          />
          <div style={{ fontSize: 11, color: C.mid, marginTop: 6 }}>
            Saved with the switch. Leave it blank and viewers just see that it is off.
          </div>
        </div>

        {msg && <div style={{ fontSize: 12, marginTop: 10, color: msg.startsWith("Supermetrics") ? C.green : C.red }}>{msg}</div>}
        {settings.updatedAt && (
          <div style={{ fontSize: 11, color: C.mid, marginTop: 8 }} suppressHydrationWarning>
            Last changed {new Date(settings.updatedAt).toLocaleString()}
          </div>
        )}
      </div>

      {/* ── SEO: where Search Console figures come from ─────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 6px" }}>SEO — Search Console source</h3>
        <p style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.6, margin: "0 0 14px" }}>
          Where the SEO tab gets clicks, impressions and keyword positions. Both read the same Search Console
          property, but they <strong>count differently</strong>: the Google API counts web search only, which is
          what Search Console&rsquo;s own Performance report and the monthly SEO report use. Supermetrics adds image,
          video, news and Discover on top, so it reads about 3% higher on clicks and 12% higher on impressions —
          almost all of it image search. Applies to everyone.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {(
            [
              {
                key: "supermetrics" as const,
                title: "Supermetrics",
                cost: "All search types combined. Spends the shared monthly row quota — the keyword query can return 5,000 rows per call.",
                ready: smConfigured,
                missing: "SUPERMETRICS_API_KEY is not set.",
              },
              {
                key: "direct" as const,
                title: "Google Search Console API",
                cost: "Web search only, matching Search Console and the monthly report. Free — no Supermetrics rows at all.",
                ready: directConfigured,
                missing: "Add GSC_CLIENT_EMAIL and GSC_PRIVATE_KEY in Vercel, and add that service account as a user on the Search Console property.",
              },
            ]
          ).map((opt) => {
            const active = seoSource === opt.key;
            return (
              <div
                key={opt.key}
                style={{
                  border: `1.5px solid ${active ? C.green : "var(--border)"}`,
                  borderRadius: 10,
                  padding: 14,
                  background: active ? "rgba(46, 125, 50, 0.04)" : undefined,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <strong style={{ fontSize: 13 }}>{opt.title}</strong>
                  <span style={{ fontSize: 11, color: opt.ready ? C.green : C.red }}>
                    {opt.ready ? "● Configured" : "● Not configured"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: C.mid, lineHeight: 1.5, marginBottom: 10 }}>{opt.cost}</div>
                {!opt.ready && (
                  <div style={{ fontSize: 11, color: C.red, lineHeight: 1.5, marginBottom: 10 }}>{opt.missing}</div>
                )}
                {active ? (
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.green }}>In use</span>
                ) : (
                  <button
                    className="filter-btn"
                    onClick={() => saveSeoSource(opt.key)}
                    disabled={pending || !opt.ready || !!settingsError}
                    title={settingsError ? "Settings could not be read just now: reload before changing this." : opt.ready ? undefined : opt.missing}
                  >
                    {pending ? "Saving…" : `Use ${opt.title}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/*
          The one interaction between the two controls, stated where it applies:
          with the global switch off, a Supermetrics SEO source cannot call
          Supermetrics, so it reads Search Console directly instead.
        */}
        {seoSource === "supermetrics" && !on && (
          <div style={{ fontSize: 11.5, color: C.mid, marginTop: 12, lineHeight: 1.5 }}>
            Supermetrics is switched off above, so SEO is currently reading Search Console directly
            {directConfigured ? "." : " — and the direct API is not configured, so SEO has no Search Console figures right now."}
          </div>
        )}

        {seoMsg && (
          <div style={{ fontSize: 12, marginTop: 10, color: seoMsg.startsWith("SEO now") ? C.green : C.red }}>
            {seoMsg}
          </div>
        )}
      </div>

      {/* ── the Supermetrics cache ──────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Supermetrics cache</h3>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10, lineHeight: 1.6 }}>
          Daily rows are stored in Supabase, so a day costs API rows once rather than once per viewer. The last{" "}
          {info.paidCache.restateDays} days are re-checked at most twice a day, because ad platforms restate recent
          spend and conversions; older days are settled and never re-fetched. A day that has never synced is always
          fetched, even if the days around it are present.
        </p>
        <table className="perf-table" style={{ minWidth: 320 }}>
          <tbody>
            <tr><td>Days cached</td><td>{fmtInt(info.paidCache.days)}</td></tr>
            <tr><td>Rows stored</td><td>{fmtInt(info.paidCache.rows)}</td></tr>
            <tr>
              <td>Covers</td>
              <td>{info.paidCache.oldest && info.paidCache.newest ? `${info.paidCache.oldest} → ${info.paidCache.newest}` : "nothing yet"}</td>
            </tr>
            <tr>
              <td>Last synced</td>
              <td suppressHydrationWarning>
                {info.paidCache.lastSyncedAt ? new Date(info.paidCache.lastSyncedAt).toLocaleString() : "never"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── connections ──────────────────────────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Connections</h3>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
          Whether each credential is present. Values are never shown, only whether they are set.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="perf-table" style={{ minWidth: 620 }}>
            <thead>
              <tr><th>Source</th><th>Status</th><th>Powers</th><th>Environment variables</th></tr>
            </thead>
            <tbody>
              {info.connections.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td style={{ color: c.configured ? C.green : C.red }}>{c.configured ? "Set" : "Missing"}</td>
                  <td style={{ textAlign: "left", color: C.mid }}>{c.powers}</td>
                  <td style={{ textAlign: "left", fontSize: 11, color: C.mid }}>{c.vars.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── portal spend, read only for now ──────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Portal spend</h3>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
          Feeds cost per lead and cost per deal on Portals and the Dashboard. Currently held in code
          (<code>lib/portalSpend.ts</code>), from {info.portalSpendSource} — not yet editable here.
        </p>
        <table className="perf-table" style={{ minWidth: 320 }}>
          <thead><tr><th>Portal</th><th>Average per month</th></tr></thead>
          <tbody>
            {info.portalSpend.map((p) => (
              <tr key={p.portal}><td>{p.portal}</td><td>{fmtAED(p.monthly)}</td></tr>
            ))}
            <tr style={{ fontWeight: 600, borderTop: "2px solid var(--border)" }}>
              <td>Total</td><td>{fmtAED(info.portalSpendTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── config that lives on its own tab ─────────────────────── */}
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Configured elsewhere</h3>
        <p style={{ fontSize: 11, color: C.mid, marginBottom: 10 }}>
          These are edited where they are used, so there is only ever one place holding each value.
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          {editors.map((e) => (
            <Link
              key={e.href}
              href={e.href}
              className="chart-card"
              style={{ display: "block", textDecoration: "none", color: "inherit", padding: 12, margin: 0 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>{e.label}</strong>
                <span style={{ fontSize: 11, color: C.mid }}>{e.count}</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.mid, marginTop: 3 }}>{e.what}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* ── diagnostics ──────────────────────────────────────────── */}
      <DiagnosticsConsole />

      {/* ── news bot ─────────────────────────────────────────────── */}
      <NewsBotSettings
        initial={news}
        readError={newsError}
        scheduled={scheduled}
        claudeKeySet={claudeKeySet}
        apifyConfigured={info.connections.find((c) => c.name === "Apify")?.configured ?? false}
        lastIngest={info.lastIngest}
        pinsFromEnv={info.pinsFromEnv}
        heldCount={newsHeld}
      />
    </>
  );
}
