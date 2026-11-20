"use client";

// Refresh everything, at the top of Settings: one button that starts every bot
// the schedules run (app/api/refresh), after a confirm, since each one uses a
// paid service. Each job's last run is listed, so it is plain when the numbers
// were last brought up to date.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ago } from "@/lib/format";
import { C } from "@/lib/theme";
import type { JobRun, RefreshStatus } from "@/lib/data";

/** "2 hours ago", "failed 3 days ago: <why>", or "not run yet". */
function lastRun(run: JobRun | null | undefined): { text: string; failed: boolean } {
  if (!run) return { text: "Not run yet", failed: false };
  if (!run.ok) return { text: `Failed ${ago(run.at)}${run.error ? `: ${run.error}` : ""}`, failed: true };
  // A run that paused or stopped short says what happened, without calling it a failure.
  return { text: `Last ran ${ago(run.at)}${run.error ? `. ${run.error}` : ""}`, failed: false };
}

export default function RefreshEverything({ status }: { status: RefreshStatus }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [started, setStarted] = useState(false);

  const jobs: { name: string; what: string; last: { text: string; failed: boolean } }[] = [
    {
      name: "News bot",
      what: "Searches Google News, reads the new articles and has the AI check them, as the 08:00 run does",
      last: status.newsWorking ? { text: "Working now", failed: false } : lastRun(status.news),
    },
    {
      name: "Ads data",
      what: "Brings Digital Performance's last 90 days up to date from Supermetrics",
      last: status.ads ? { text: `Last synced ${ago(status.ads)}`, failed: false } : { text: "Not synced yet", failed: false },
    },
    {
      name: "People sentiment",
      what: "Reads the platforms switched on in People sentiment through Apify, and scores the tone",
      last: lastRun(status.people),
    },
    {
      name: "Socials benchmark",
      what: "Reads betterhomes' and the rivals' social accounts through Apify",
      last: lastRun(status.socials),
    },
  ];

  async function run() {
    setConfirming(false);
    setSending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (res.status === 401) {
        setMsg({ ok: false, text: "The settings PIN has timed out. Reload the page, enter it again and press Refresh everything." });
        return;
      }
      const body = (await res.json().catch(() => null)) as { news?: { started: boolean; note: string } } | null;
      if (!res.ok || !body) {
        setMsg({ ok: false, text: `Refresh everything did not start (HTTP ${res.status}). Try again in a minute.` });
        return;
      }
      setStarted(true);
      const news = body.news?.started ? "The news bot has started." : `The news bot: ${body.news?.note ?? "not started."}`;
      setMsg({
        ok: true,
        text: `${news} The ads data, People sentiment and the Socials benchmark are running too. It all takes up to about 15 minutes; each tab shows the new numbers as they land.`,
      });
      router.refresh();
    } catch {
      setMsg({ ok: false, text: "The request did not finish, so it is not known whether everything started. Look at the times above in a few minutes before pressing it again." });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ maxWidth: 680 }}>
          <div className="chart-title">Refresh everything</div>
          <div className="chart-sub" style={{ marginBottom: 0 }}>
            Runs every bot now, instead of waiting for its schedule, so every tab shows the latest numbers. The weekly
            email is not sent. Each run uses Apify, Supermetrics or Claude, as the scheduled runs do.
          </div>
        </div>
        {!confirming ? (
          <button className="filter-btn" onClick={() => setConfirming(true)} disabled={sending || started}>
            {sending ? "Starting…" : started ? "Started" : "Refresh everything"}
          </button>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: C.mid }}>Run all four now?</span>
            <button className="filter-btn active" onClick={run}>
              Yes, run them
            </button>
            <button className="filter-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
      {msg && <div style={{ marginTop: 10, fontSize: 12, color: msg.ok ? C.green : C.red, lineHeight: 1.5 }}>{msg.text}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 14 }}>
        {jobs.map((j) => (
          <div key={j.name} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.dark }}>{j.name}</div>
            <div style={{ fontSize: 11.5, color: C.mid, marginTop: 3, lineHeight: 1.45 }}>{j.what}</div>
            <div style={{ fontSize: 11.5, marginTop: 6, color: j.last.failed ? C.red : C.mid }} suppressHydrationWarning>
              {j.last.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
