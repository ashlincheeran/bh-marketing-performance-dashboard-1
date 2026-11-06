"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { C } from "@/lib/theme";
import { dayLabel, monthLabel } from "@/lib/format";
import { plural } from "@/lib/pr";
import { peopleLine, pressInRange, pressRangeNotes, type PressCompany, type PressMention } from "@/lib/pressMentions";

// Press mentions: the PR tab's one list of coverage, betterhomes' and the
// tracked rivals' side by side, one row per article (lib/pressMentions.ts),
// with the tracked people each one names under its headline. It took the
// place of the tab's own mentions table and of the competitor stories below
// it, and keeps the look of the second.
//
// `items` come from the rows the tab's figures count, so the list and the
// numbers agree, and it shows the tab's date range (from, to), as the figures
// do: November only lists, and counts, November's stories for each company.
// Two notes say when a range can't be compared like for like: our stories
// that only the PR agency's clippings hold, which the rivals have no archive
// of, and the months no rival story is stored for.
//
// `rivalsError` is set when the rivals' stories could not be read: only ours
// are listed then, and the section says so rather than reading as rivals with
// no coverage. `peopleError` is set when the people could not be read: the
// stories are listed without them, and that is said.

/** betterhomes' badge, in the brand's accent; a rival's is the sage of the competitor stories. */
const OUR_BADGE: React.CSSProperties = { background: C.coral, color: "#fff" };

/** A read that failed, said in the section with its reason. */
function Failed({ what, reason }: { what: string; reason: string }) {
  return (
    <div style={{ fontSize: 12.5, color: C.red, lineHeight: 1.6, marginTop: 10 }}>
      {what} Reload the page to try again.
      <br />
      <span style={{ color: C.mid }}>Reason: {reason}</span>
    </div>
  );
}

export default function PressMentions({
  items: all,
  companies: allCompanies,
  from,
  to,
  allTime,
  rivalsError = null,
  peopleError = null,
}: {
  /** Every story on record, newest first, undated last. */
  items: PressMention[];
  /** The filter: betterhomes, then each rival with an article. */
  companies: PressCompany[];
  /** The tab's date range, "YYYY-MM", both months included. */
  from: string;
  to: string;
  /** The range is every month on file (All time), so undated stories are listed too, as the figures count them. */
  allTime: boolean;
  rivalsError?: string | null;
  peopleError?: string | null;
}) {
  const [company, setCompany] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const view = useMemo(() => pressInRange({ items: all, companies: allCompanies }, from, to, allTime), [all, allCompanies, from, to, allTime]);
  const { items, companies } = view;
  const notes = pressRangeNotes(view, from);
  // Said up front: "153 stories" read as a live feed while the newest was
  // four months old. The list is newest first, so the first date is the latest.
  const latest = items.find((m) => m.date)?.date ?? null;
  const span = allTime ? "on record" : from === to ? `in ${monthLabel(from)}` : `from ${monthLabel(from)} to ${monthLabel(to)}`;
  const rows = company === null ? items : items.filter((m) => m.companies.some((c) => c.label === company));

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Press mentions</div>
          <div className="page-sub">
            The stories in the date range above for betterhomes and the tracked rivals, with the people each one names.
          </div>
        </div>
      </div>

      <div className="chart-card">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, width: "100%", textAlign: "left" }}
        >
          <div className="chart-title" style={{ marginBottom: 0 }}>
            {open ? "▾" : "▸"} {plural(items.length, "press mention")} {span}
            {latest ? `, latest from ${dayLabel(latest)}` : ""}. Click to {open ? "collapse" : "expand"}.
          </div>
        </button>
        {rivalsError && (
          <Failed what="The competitor stories could not be read just now, so only betterhomes' are listed." reason={rivalsError} />
        )}
        {peopleError && (
          <Failed what="The people named in each story could not be read just now, so none are shown." reason={peopleError} />
        )}

        {open && (
          <div style={{ marginTop: 12 }}>
            <div className="table-controls">
              <div style={{ fontSize: 13, color: C.mid }}>Filter by company</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className={`filter-btn${company === null ? " active" : ""}`} onClick={() => setCompany(null)}>
                  All ({items.length})
                </button>
                {companies.map((c) => (
                  <button
                    key={c.label}
                    className={`filter-btn${company === c.label ? " active" : ""}`}
                    onClick={() => setCompany(c.label)}
                  >
                    {c.label} ({c.count})
                  </button>
                ))}
              </div>
            </div>
            {notes.length > 0 && (
              <div style={{ fontSize: 11.5, color: C.mid, lineHeight: 1.6, margin: "0 0 10px" }}>
                {notes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            )}

            <div className="table-wrapper">
              <div className="table-scroll">
                <table className="mentions-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Source</th>
                      <th style={{ minWidth: 300 }}>Headline</th>
                      <th>Companies</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted" style={{ padding: 16 }}>
                          {allTime ? "No press mentions stored." : "No press mentions in this date range."}
                        </td>
                      </tr>
                    )}
                    {rows.map((m) => (
                      <tr key={m.key}>
                        <td style={{ whiteSpace: "nowrap" }}>{m.date ?? <span className="muted">Undated</span>}</td>
                        <td>{m.outlet ?? <span className="muted">Not given</span>}</td>
                        <td>
                          {m.url && m.url.startsWith("http") ? (
                            <a href={m.url} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                              {m.title ?? "No headline"} <span style={{ color: C.coral }}>↗</span>
                            </a>
                          ) : (
                            (m.title ?? <span className="muted">No headline</span>)
                          )}
                          {m.people.length > 0 && (
                            <div style={{ fontSize: 11, color: C.mid, marginTop: 4 }}>People: {peopleLine(m.people)}</div>
                          )}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {m.companies.map((c) => (
                              <span key={c.label} className={c.isUs ? "tier-badge" : "tier-badge tier-t2"} style={c.isUs ? OUR_BADGE : undefined}>
                                {c.label}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.mid, marginTop: 8 }}>
              Companies come from{" "}
              <Link href="/pr/settings" className="link-btn" style={{ fontSize: 11 }}>
                PR &amp; Media settings
              </Link>
              . A story stored twice, under the outlet&apos;s name and its web address, is listed once.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
