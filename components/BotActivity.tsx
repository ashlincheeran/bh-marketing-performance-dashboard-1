"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMentionStatusAction } from "@/app/actions";
import type { BotActivityItem } from "@/lib/data";

function verdict(status: string) {
  if (status === "rejected") return <span className="sent-badge sent-negative">AI rejected</span>;
  if (status === "reviewed") return <span className="sent-badge sent-positive">approved</span>;
  return <span className="sent-badge sent-neutral">kept · new</span>;
}

export default function BotActivity({ items, keywords }: { items: BotActivityItem[]; keywords: string[] }) {
  const [pending, startTransition] = useTransition();
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
        <div className="chart-sub">Searched daily on Google News (configurable via PR_QUERIES)</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {keywords.map((k) => (
            <span key={k} className="tier-badge tier-t2">{k}</span>
          ))}
        </div>
      </div>

      <div className="chart-card">
        <div className="chart-title" style={{ marginBottom: 12 }}>
          Found articles ({items.length}) · {kept} kept, {items.length - kept} rejected — click ↗ to read the source
        </div>
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
      </div>
    </>
  );
}
