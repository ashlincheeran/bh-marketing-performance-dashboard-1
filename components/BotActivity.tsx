"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMentionStatusAction, addKeywordAction, removeKeywordAction } from "@/app/actions";
import type { BotActivityItem, TrackedKeyword } from "@/lib/data";

function verdict(status: string) {
  if (status === "rejected") return <span className="sent-badge sent-negative">AI rejected</span>;
  if (status === "reviewed") return <span className="sent-badge sent-positive">approved</span>;
  return <span className="sent-badge sent-neutral">kept · new</span>;
}

// Editable keyword list — add via the input, remove via the × on each chip.
// Chips with id===null come from code defaults (table not created yet) → not removable.
function KeywordManager({
  title,
  hint,
  kind,
  chipClass,
  items,
}: {
  title: string;
  hint: string;
  kind: "pr" | "competitor";
  chipClass: string;
  items: TrackedKeyword[];
}) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function add() {
    const q = val.trim();
    if (!q) return;
    startTransition(async () => {
      const r = await addKeywordAction(kind, q);
      if (!r.ok) setErr(r.error);
      else { setErr(null); setVal(""); router.refresh(); }
    });
  }
  function remove(id: number) {
    startTransition(async () => {
      const r = await removeKeywordAction(id);
      if (!r.ok) setErr(r.error);
      else { setErr(null); router.refresh(); }
    });
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, color: "var(--mid)", marginBottom: 8 }}>{title} — <span style={{ opacity: 0.8 }}>{hint}</span></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {items.map((k) => (
          <span key={`${k.id}-${k.query}`} className={`tier-badge ${chipClass}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {k.label || k.query}
            {k.id != null && (
              <button
                onClick={() => remove(k.id!)}
                disabled={pending}
                title="Remove"
                style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontWeight: 700, lineHeight: 1, padding: 0 }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 10, maxWidth: 460 }}>
        <input
          className="search-box"
          style={{ flex: 1 }}
          placeholder={kind === "pr" ? "Add a search term…" : "Add a competitor or CEO name…"}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <button className="filter-btn" onClick={add} disabled={pending || !val.trim()}>+ Add</button>
      </div>
      {err && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>{err}</div>}
    </div>
  );
}

export default function BotActivity({
  items,
  prKeywords,
  competitorKeywords,
}: {
  items: BotActivityItem[];
  prKeywords: TrackedKeyword[];
  competitorKeywords: TrackedKeyword[];
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const router = useRouter();

  function setStatus(id: string, status: "new" | "reviewed" | "rejected") {
    startTransition(async () => {
      await setMentionStatusAction(id, status);
      router.refresh();
    });
  }

  const kept = items.filter((i) => i.status !== "rejected").length;

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Bot Activity</div>
          <div className="page-sub">
            Every article the news bot found on Google News — kept and rejected — so you can verify it yourself.
          </div>
        </div>
        <span className="verified-badge">🤖 Google News + Gemini</span>
      </div>

      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">Monitored keywords</div>
        <div className="chart-sub">Edit the list here — “Run now” and the daily run use it immediately</div>
        <KeywordManager
          title="betterhomes"
          hint="saved as press mentions (Gemini keeps only ones about us)"
          kind="pr"
          chipClass="tier-t1local"
          items={prKeywords}
        />
        <KeywordManager
          title="Competitors"
          hint="tracked for Share of Voice + the competitor feed (add their CEOs here too)"
          kind="competitor"
          chipClass="tier-t2"
          items={competitorKeywords}
        />
      </div>

      <div className="chart-card">
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, width: "100%", textAlign: "left" }}
        >
          <div className="chart-title" style={{ marginBottom: open ? 12 : 0 }}>
            {open ? "▾" : "▸"} Found articles ({items.length}) · {kept} kept, {items.length - kept} rejected — click to {open ? "collapse" : "expand"}
          </div>
        </button>
        {open && (
          <>
            <div className="table-wrapper">
              <div className="table-scroll">
                <table className="mentions-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Source</th>
                      <th style={{ minWidth: 300 }}>Headline</th>
                      <th>Verdict</th>
                      <th>Tone</th>
                      <th>Link</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 && (
                      <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>The bot hasn&apos;t found anything yet — run it from the PR page.</td></tr>
                    )}
                    {items.map((it) => (
                      <tr key={it.id}>
                        <td>{it.published_on ?? "—"}</td>
                        <td>{it.outlet_name ?? "—"}</td>
                        <td>{it.title ?? "—"}</td>
                        <td>{verdict(it.status)}</td>
                        <td>
                          {it.sentiment
                            ? <span className={`sent-badge sent-${it.sentiment}`}>{it.sentiment}</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          {it.url && it.url.startsWith("http")
                            ? <a className="link-btn" href={it.url} target="_blank" rel="noopener noreferrer">↗</a>
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          {it.status === "rejected"
                            ? <button className="filter-btn" disabled={pending} onClick={() => setStatus(it.id, "reviewed")}>Keep</button>
                            : <button className="filter-btn" disabled={pending} onClick={() => setStatus(it.id, "rejected")}>Reject</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--mid)", marginTop: 8 }}>
              Links open the article on its source (via Google News). &ldquo;Keep&rdquo; moves a rejected item back into the dashboard; &ldquo;Reject&rdquo; removes it.
            </div>
          </>
        )}
      </div>
    </>
  );
}
