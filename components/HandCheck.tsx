"use client";

// Check by hand, on PR & Media settings (app/pr/settings/page.tsx): the
// articles the news bot could not read that a search for betterhomes, a rival
// or a person found (lib/data.ts handCheckList). Their sites turn away cloud
// servers or sit behind a paywall, so a person opens each one in their own
// browser and decides, company by company: count it for a company its
// searches were for, or say it is not about them. Each is a person's word,
// which the bot never changes (docs/news-pipeline.md, rule 6), and each ends
// the bot's tries to read it. An article stays until each of its companies is
// decided, so one about two companies can be counted for both.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { keepArticleAction, rejectArticleAction } from "@/app/actions";
import { callAction, notFinished } from "@/lib/actionCall";
import { C } from "@/lib/theme";
import type { HandCheckItem } from "@/lib/data";

/**
 * What a button press is about to save: a Count for `company`, Not about
 * `company`, or, with no company, Not about them, the article's Reject.
 */
type Choice = { id: string; count: boolean; company: string | null };

const sameChoice = (a: Choice | null, b: Choice) => !!a && a.id === b.id && a.count === b.count && a.company === b.company;

/** "Knight Frank", "betterhomes and Knight Frank", "Haus & Haus, Knight Frank and Metropolitan". */
const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? ""));

export default function HandCheck({ items }: { items: HandCheckItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Choice | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (!items.length) return null;

  function act(choice: Choice) {
    setErr(null);
    setBusy(choice);
    const { id, count, company } = choice;
    start(async () => {
      const r = await callAction(
        () => (count && company ? keepArticleAction(id, company) : company ? rejectArticleAction(id, company) : rejectArticleAction(id)),
        notFinished(count ? `it was counted for ${company}` : `it was set aside as not about ${company ?? "them"}`),
      );
      setBusy(null);
      // Decided, it leaves the list once the page has looked again, or, with a
      // company still to decide, stays with that company's buttons.
      if (r.ok) router.refresh();
      else setErr({ id, text: r.error });
    });
  }

  const button = (choice: Choice, label: string, title: string) => (
    <button
      key={`${choice.count ? "count" : "not"}:${choice.company ?? ""}`}
      className="filter-btn"
      disabled={pending}
      onClick={() => act(choice)}
      title={title}
    >
      {sameChoice(busy, choice) ? "Saving…" : label}
    </button>
  );

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div className="chart-title">Check by hand</div>
      <div className="chart-sub">
        The bot could not read these, and they came from a search for betterhomes, a rival or a person. Their websites
        block automated readers or sit behind a paywall, so open each one in your own browser and decide. Nothing here
        counts until you say so.
      </div>
      <div className="table-wrapper">
        <div className="table-scroll">
          <table className="mentions-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Outlet</th>
                <th style={{ minWidth: 260 }}>Headline</th>
                <th>Searched for</th>
                <th style={{ minWidth: 160 }}>Why</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{a.date || <span className="muted">Undated</span>}</td>
                  <td>{a.outlet ?? <span className="muted">Not given</span>}</td>
                  <td style={{ whiteSpace: "normal" }}>
                    {a.link?.startsWith("http") ? (
                      <a className="link-btn" href={a.link} target="_blank" rel="noopener noreferrer" title="Open the article in a new tab">
                        {a.title}
                      </a>
                    ) : (
                      <>
                        {a.title} <span className="muted">(no link to open)</span>
                      </>
                    )}
                  </td>
                  <td style={{ whiteSpace: "normal" }}>
                    {a.companies.join(", ")}
                    {a.counted.length > 0 && (
                      <div style={{ fontSize: 11.5, color: C.mid, marginTop: 4 }}>Already counts for {andList(a.counted)}.</div>
                    )}
                  </td>
                  <td style={{ whiteSpace: "normal" }}>{a.why}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {a.companies.map((company) =>
                        button({ id: a.id, count: true, company }, `Count for ${company}`, `Count it as coverage of ${company}`),
                      )}
                      {/* Once part of it counts, the whole article's Reject would take that away too. */}
                      {a.counted.length === 0
                        ? button({ id: a.id, count: false, company: null }, "Not about them", "It is about none of them: take it out of the count")
                        : a.companies.map((company) =>
                            button(
                              { id: a.id, count: false, company },
                              `Not about ${company}`,
                              `It is not about ${company}. What counts for ${andList(a.counted)} stays as it is.`,
                            ),
                          )}
                    </div>
                    {err?.id === a.id && <div style={{ fontSize: 11.5, color: C.red, marginTop: 6, whiteSpace: "normal" }}>{err.text}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--mid)", marginTop: 8, lineHeight: 1.6 }}>
        A Count puts it on the PR tab for that company as your decision, which the bot never changes. Not about them
        takes it out of the count for every company. Where it already counts for a company, Not about goes one company
        at a time and leaves that count as it is. Whatever you choose, the bot stops trying to read it, and an article
        leaves this list once each of its companies is decided.
      </div>
    </div>
  );
}
