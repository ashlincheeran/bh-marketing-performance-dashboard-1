"use client";

// Check by hand, on PR & Media settings (app/pr/settings/page.tsx): the
// articles the news bot could not read that a search for betterhomes, a rival
// or a person found (lib/data.ts handCheckList). Their sites turn away cloud
// servers or sit behind a paywall, so a person opens each one in their own
// browser and decides: count it for a company its searches were for, or set it
// aside. Either is a person's word, which the bot never changes
// (docs/news-pipeline.md, rule 6), and either ends the bot's tries to read it.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { keepArticleAction, rejectArticleAction } from "@/app/actions";
import { callAction, notFinished } from "@/lib/actionCall";
import { C } from "@/lib/theme";
import type { HandCheckItem } from "@/lib/data";

/** What a button press is about to save: a Count for `company`, or, with no company, Not about them. */
type Choice = { id: string; company: string | null };

const sameChoice = (a: Choice | null, b: Choice) => !!a && a.id === b.id && a.company === b.company;

export default function HandCheck({ items }: { items: HandCheckItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Choice | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (!items.length) return null;

  function act(choice: Choice) {
    setErr(null);
    setBusy(choice);
    const { id, company } = choice;
    start(async () => {
      const r = await callAction(
        () => (company ? keepArticleAction(id, company) : rejectArticleAction(id)),
        notFinished(company ? `it was counted for ${company}` : "it was set aside as not about them"),
      );
      setBusy(null);
      // Decided, it leaves the list once the page has looked again.
      if (r.ok) router.refresh();
      else setErr({ id, text: r.error });
    });
  }

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
                  <td style={{ whiteSpace: "normal" }}>{a.companies.join(", ")}</td>
                  <td style={{ whiteSpace: "normal" }}>{a.why}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {a.companies.map((company) => (
                        <button
                          key={company}
                          className="filter-btn"
                          disabled={pending}
                          onClick={() => act({ id: a.id, company })}
                          title={`Count it as coverage of ${company}`}
                        >
                          {sameChoice(busy, { id: a.id, company }) ? "Saving…" : `Count for ${company}`}
                        </button>
                      ))}
                      <button
                        className="filter-btn"
                        disabled={pending}
                        onClick={() => act({ id: a.id, company: null })}
                        title="It is about none of them: take it out of the count"
                      >
                        {sameChoice(busy, { id: a.id, company: null }) ? "Saving…" : "Not about them"}
                      </button>
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
        takes it out of the count for every company. Either way the bot stops trying to read it, and it leaves this
        list.
      </div>
    </div>
  );
}
