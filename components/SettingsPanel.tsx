"use client";

// Admin settings. Everything here is deployment-wide, not per-browser — that is
// the whole reason it sits behind its own PIN.
import { useState, useTransition } from "react";
import Link from "next/link";
import { setSupermetricsEnabledAction } from "@/app/actions";
import { C } from "@/lib/theme";
import type { SettingsInfo } from "@/lib/settingsInfo";
import type { AppSettings } from "@/lib/appSettings";
import DiagnosticsConsole from "@/components/DiagnosticsConsole";

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n || 0));
const fmtAED = (n: number) =>
  n >= 1e6 ? `AED ${(n / 1e6).toFixed(2)}M` : `AED ${new Intl.NumberFormat("en-US").format(Math.round(n))}`;

export default function SettingsPanel({ info, settings }: { info: SettingsInfo; settings: AppSettings }) {
  const [on, setOn] = useState(settings.supermetricsEnabled);
  const [note, setNote] = useState(settings.note);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(next: boolean) {
    setMsg(null);
    start(async () => {
      const r = await setSupermetricsEnabledAction(next, note);
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
    { label: "News and competitor keywords", href: "/bot", what: "What the news bot searches for.", count: `${info.counts.prKeywords} news · ${info.counts.competitorKeywords} competitor` },
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
              Affects the <strong>Digital Performance</strong> tab and the Search Console figures on{" "}
              <strong>SEO</strong>. Company Performance, Portals, Website, PR and People Sentiment are unaffected —
              they do not use Supermetrics.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: on ? C.green : C.red, marginBottom: 8 }}>
              {on ? "ON" : "OFF"}
            </div>
            <button
              className="filter-btn"
              onClick={() => save(!on)}
              disabled={pending}
              style={{ borderColor: on ? C.red : C.green, color: on ? C.red : C.green }}
            >
              {pending ? "Saving…" : on ? "Turn OFF for everyone" : "Turn ON for everyone"}
            </button>
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
      <div className="chart-card">
        <h3 style={{ marginBottom: 4 }}>News bot</h3>
        <p style={{ fontSize: 12, color: C.mid, margin: 0, lineHeight: 1.6 }}>
          Runs daily at 08:00 Dubai via Vercel cron.{" "}
          {info.lastIngest ? (
            <span suppressHydrationWarning>
              Last run {new Date(info.lastIngest.ranAt).toLocaleString()} ({info.lastIngest.trigger}),{" "}
              {info.lastIngest.ok ? "ok" : "failed"}, {info.lastIngest.inserted} new.
            </span>
          ) : (
            "No runs recorded yet."
          )}
          <br />
          PINs: app {info.pinsFromEnv.app ? "set via DASHBOARD_PIN" : "using the built-in default"} · settings{" "}
          {info.pinsFromEnv.settings ? "set via SETTINGS_PIN" : "using the built-in default"}.
        </p>
      </div>
    </>
  );
}
