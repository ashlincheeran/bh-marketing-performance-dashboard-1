"use client";

// The weekly email, set up from Settings: who gets it and how, which page is
// photographed, which day, on or off. Saving stores the list; Preview and Send
// now call /api/report, which takes the picture on the server.
import { useState, useTransition } from "react";
import { saveReportSettingsAction } from "@/app/actions";
import { C } from "@/lib/theme";
import {
  DEFAULT_REPORT_SETTINGS,
  MAX_RECIPIENTS,
  REPORT_PAGES,
  ROLES,
  WEEKDAYS,
  isEmail,
  type RecipientRole,
  type ReportSettings,
} from "@/lib/reportTypes";

const ROLE_LABEL: Record<RecipientRole, string> = { to: "To", cc: "Cc", bcc: "Bcc", paused: "Paused" };

const label: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", color: C.mid };

/** What the form edits, without the send history the server owns. */
const editable = (s: ReportSettings) =>
  JSON.stringify({ ...s, lastSentAt: null, lastResult: null });

export default function WeeklyEmailSettings({
  initial,
  sender,
  baseUrl,
}: {
  initial: ReportSettings | null;
  sender: string | null;
  baseUrl: string | null;
}) {
  const [s, setS] = useState<ReportSettings>(initial ?? DEFAULT_REPORT_SETTINGS);
  const [saved, setSaved] = useState<ReportSettings>(initial ?? DEFAULT_REPORT_SETTINGS);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RecipientRole>("to");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<null | "preview" | "send">(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const dirty = editable(s) !== editable(saved);
  const count = (r: RecipientRole) => s.recipients.filter((x) => x.role === r).length;
  const sending = s.recipients.filter((x) => x.role !== "paused").length;

  function update(patch: Partial<ReportSettings>) {
    setS((prev) => ({ ...prev, ...patch }));
    setMsg(null);
    setConfirmSend(false);
  }

  function addRecipient() {
    const address = email.trim().toLowerCase();
    if (!isEmail(address)) return setMsg({ ok: false, text: `"${email}" isn't an email address.` });
    if (s.recipients.some((r) => r.email === address)) return setMsg({ ok: false, text: `${address} is already on the list.` });
    if (s.recipients.length >= MAX_RECIPIENTS) return setMsg({ ok: false, text: `The list holds up to ${MAX_RECIPIENTS} people.` });
    update({ recipients: [...s.recipients, { email: address, name: name.trim().slice(0, 80), role }] });
    setName("");
    setEmail("");
  }

  function save(next: ReportSettings) {
    start(async () => {
      const r = await saveReportSettingsAction(next);
      if (r.ok && r.settings) {
        setS(r.settings);
        setSaved(r.settings);
        setMsg({ ok: true, text: r.settings.enabled ? "Saved. The weekly email is on." : "Saved. The weekly email is off." });
      } else {
        setMsg({ ok: false, text: r.ok ? "Saved, but the settings could not be read back." : r.error });
      }
    });
  }

  async function call(action: "preview" | "send") {
    setBusy(action);
    setMsg(null);
    setConfirmSend(false);
    try {
      const res = await fetch(`/api/report?action=${action}&page=${encodeURIComponent(s.page)}`, { method: "POST" });
      if (action === "preview" && res.ok) {
        const blob = await res.blob();
        if (preview) URL.revokeObjectURL(preview);
        setPreview(URL.createObjectURL(blob));
        const partial = res.headers.get("x-report-loaded") === "false" ? " Some figures were still loading." : "";
        setMsg({ ok: true, text: `Picture taken in ${res.headers.get("x-report-seconds")}s.${partial}` });
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: string; error?: string };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setMsg({ ok: true, text: j.result ?? "Sent." });
      setSaved((prev) => ({ ...prev, lastSentAt: new Date().toISOString(), lastResult: j.result ?? null }));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="chart-card" style={{ marginBottom: 20, borderColor: s.enabled ? C.sage : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <h3 style={{ margin: "0 0 6px" }}>Weekly email</h3>
          <p style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.6, margin: 0 }}>
            Every week at 09:00 Dubai, the server opens the page below, waits for every figure to load, and emails
            a picture of it with the full page attached as a PDF. {" "}
            {sender ? (
              <>Sends from <strong>{sender}</strong>.</>
            ) : (
              <span style={{ color: C.red }}>
                No email account yet: add SMTP_USER and SMTP_PASS in Vercel. A Gmail address with an app password
                works. Preview works without it.
              </span>
            )}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: saved.enabled ? C.green : C.mid, marginBottom: 8 }}>
            {saved.enabled ? "ON" : "OFF"}
          </div>
          <button
            className="filter-btn"
            disabled={pending}
            onClick={() => save({ ...s, enabled: !saved.enabled })}
            style={{ borderColor: saved.enabled ? C.red : C.green, color: saved.enabled ? C.red : C.green }}
          >
            {pending ? "Saving…" : saved.enabled ? "Turn off" : "Save and turn on"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 16 }}>
        <div>
          <label style={label} htmlFor="report-day">Day</label>
          <select id="report-day" className="search-box" style={{ width: "100%", marginTop: 6 }}
            value={s.weekday} onChange={(e) => update({ weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}, 09:00 Dubai</option>)}
          </select>
        </div>
        <div>
          <label style={label} htmlFor="report-page">Page to send</label>
          <select id="report-page" className="search-box" style={{ width: "100%", marginTop: 6 }}
            value={s.page} onChange={(e) => update({ page: e.target.value })}>
            {REPORT_PAGES.map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label style={label} htmlFor="report-subject">Subject</label>
          <input id="report-subject" className="search-box" style={{ width: "100%", marginTop: 6 }}
            value={s.subject} maxLength={150} onChange={(e) => update({ subject: e.target.value })} />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label style={label} htmlFor="report-intro">Line above the picture (optional)</label>
        <textarea id="report-intro" className="search-box" rows={2} maxLength={600}
          style={{ width: "100%", marginTop: 6, resize: "vertical", fontFamily: "inherit" }}
          placeholder="e.g. Morning all, here is where marketing stands this week."
          value={s.intro} onChange={(e) => update({ intro: e.target.value })} />
      </div>

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>Recipients</strong>
          <span style={{ fontSize: 11, color: C.mid }}>
            {count("to")} To · {count("cc")} Cc · {count("bcc")} Bcc · {count("paused")} paused
          </span>
        </div>
        {s.recipients.length > 0 ? (
          <div className="table-scroll">
            <table className="mentions-table">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Gets it as</th><th /></tr>
              </thead>
              <tbody>
                {s.recipients.map((r) => (
                  <tr key={r.email} style={{ opacity: r.role === "paused" ? 0.55 : 1 }}>
                    <td>{r.name || <span className="muted">—</span>}</td>
                    <td>{r.email}</td>
                    <td>
                      <select className="search-box" aria-label={`How ${r.email} gets it`} value={r.role}
                        onChange={(e) => update({
                          recipients: s.recipients.map((x) => x.email === r.email ? { ...x, role: e.target.value as RecipientRole } : x),
                        })}>
                        {ROLES.map((o) => <option key={o} value={o}>{ROLE_LABEL[o]}</option>)}
                      </select>
                    </td>
                    <td>
                      <button className="filter-btn" aria-label={`Remove ${r.email}`}
                        onClick={() => update({ recipients: s.recipients.filter((x) => x.email !== r.email) })}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.mid }}>Nobody yet. Add the first person below.</div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <input className="search-box" aria-label="Name" placeholder="Name" value={name}
            onChange={(e) => setName(e.target.value)} style={{ flex: "1 1 140px" }} />
          <input className="search-box" aria-label="Email" placeholder="name@bhomes.com" value={email}
            onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addRecipient()}
            style={{ flex: "2 1 220px" }} />
          <select className="search-box" aria-label="Gets it as" value={role}
            onChange={(e) => setRole(e.target.value as RecipientRole)}>
            {ROLES.map((o) => <option key={o} value={o}>{ROLE_LABEL[o]}</option>)}
          </select>
          <button className="filter-btn" onClick={addRecipient} disabled={!email.trim()}>Add</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <button className="filter-btn" disabled={pending || !dirty} onClick={() => save(s)}
          style={dirty ? { borderColor: C.green, color: C.green } : undefined}>
          {pending ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        <button className="filter-btn" disabled={busy !== null} onClick={() => call("preview")}>
          {busy === "preview" ? "Taking the picture…" : "Preview the picture"}
        </button>
        <button className="filter-btn" disabled={busy !== null || dirty || !sender || count("to") === 0}
          title={dirty ? "Save your changes first" : !sender ? "Set up the email account first" : count("to") === 0 ? "Put someone on To first" : undefined}
          onClick={() => (confirmSend ? call("send") : setConfirmSend(true))}
          style={confirmSend ? { borderColor: C.red, color: C.red } : undefined}>
          {busy === "send" ? "Sending…" : confirmSend ? `Send to ${sending} now?` : "Send now"}
        </button>
        {busy && <span style={{ fontSize: 11, color: C.mid }}>This takes up to two minutes while the page loads.</span>}
      </div>

      {msg && <div style={{ fontSize: 12, marginTop: 10, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
      <div style={{ fontSize: 11, color: C.mid, marginTop: 8, lineHeight: 1.6 }} suppressHydrationWarning>
        {baseUrl ? <>Photographs {baseUrl}{s.page === "/" ? "" : s.page}. </> : <span style={{ color: C.red }}>No dashboard address: set REPORT_BASE_URL in Vercel. </span>}
        {saved.lastSentAt ? <>Last sent {new Date(saved.lastSentAt).toLocaleString()}. </> : "Not sent yet. "}
        {saved.lastResult && <>Last attempt: {saved.lastResult}</>}
      </div>

      {preview && (
        <div style={{ marginTop: 12, maxHeight: 520, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL from the preview call, not a static asset */}
          <img src={preview} alt="Preview of the weekly email picture" style={{ width: "100%", display: "block" }} />
        </div>
      )}
    </div>
  );
}
