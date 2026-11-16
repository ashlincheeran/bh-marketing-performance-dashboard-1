"use client";

// Check by hand, on PR & Media settings (app/pr/settings/page.tsx): the
// articles the news bot could not read that a search for betterhomes, a rival
// or a person found (lib/data.ts handCheckList). Their sites turn away cloud
// servers or sit behind a paywall, so a person opens each one in their own
// browser and decides, company by company: count it for a company its
// searches were for, or say it is not about them. The list can be narrowed to
// betterhomes, the rivals or the people its searches were for, and by why the
// bot could not read it. Each is a person's word,
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

/** Whom the articles shown were searched for: everyone, betterhomes, the rivals, or the tracked people. */
type Group = "all" | "us" | "rivals" | "people";

/** How many of `list` each name is on, most first, then by name. */
function tally(list: HandCheckItem[], names: (a: HandCheckItem) => string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const a of list) for (const name of new Set(names(a))) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
}

/** "Knight Frank", "betterhomes and Knight Frank", "Haus & Haus, Knight Frank and Metropolitan". */
const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? ""));

export default function HandCheck({ items, us = "betterhomes" }: { items: HandCheckItem[]; us?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Choice | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const [pending, start] = useTransition();
  // The filter: a group, then one rival or person in it, and a reason.
  const [group, setGroup] = useState<Group>("all");
  const [pick, setPick] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);

  if (!items.length) return null;

  const rivalsOf = (a: HandCheckItem) => a.companies.filter((c) => c !== us);
  const inGroup = (a: HandCheckItem, g: Group) =>
    g === "all" || (g === "us" ? a.companies.includes(us) : g === "rivals" ? rivalsOf(a).length > 0 : a.people.length > 0);
  const groupCount = (g: Group) => items.filter((a) => inGroup(a, g)).length;
  // A choice left with nothing to show, once its articles are decided, falls back to all of them.
  const shownGroup: Group = groupCount(group) ? group : "all";
  const namesIn = (a: HandCheckItem) => (shownGroup === "rivals" ? rivalsOf(a) : shownGroup === "people" ? a.people : []);
  const picks = tally(items.filter((a) => inGroup(a, shownGroup)), namesIn);
  const shownPick = pick !== null && picks.some(([name]) => name === pick) ? pick : null;
  const byWhom = items.filter((a) => inGroup(a, shownGroup) && (shownPick === null || namesIn(a).includes(shownPick)));
  const reasons = tally(byWhom, (a) => [a.why]);
  const shownWhy = why !== null && reasons.some(([reason]) => reason === why) ? why : null;
  const shown = byWhom.filter((a) => shownWhy === null || a.why === shownWhy);
  const showAll = () => {
    setGroup("all");
    setPick(null);
    setWhy(null);
  };
  const chip = (active: boolean, label: string, onClick: () => void) => (
    <button key={label} className={`filter-btn${active ? " active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
  const groups: [Group, string][] = [
    ["all", "All"],
    ["us", us],
    ["rivals", "Rivals"],
    ["people", "People"],
  ];

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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {groups
            .filter(([g]) => g === "all" || groupCount(g) > 0)
            .map(([g, label]) =>
              chip(shownGroup === g, `${label} (${groupCount(g)})`, () => {
                setGroup(g);
                setPick(null);
              }),
            )}
        </div>
        <select
          className="search-box"
          style={{ width: 230, marginLeft: "auto" }}
          value={shownWhy ?? ""}
          onChange={(e) => setWhy(e.target.value || null)}
          aria-label="Why the bot could not read it"
        >
          <option value="">Any reason ({byWhom.length})</option>
          {reasons.map(([reason, n]) => (
            <option key={reason} value={reason}>
              {reason} ({n})
            </option>
          ))}
        </select>
      </div>
      {(shownGroup === "rivals" || shownGroup === "people") && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {chip(shownPick === null, `${shownGroup === "rivals" ? "All rivals" : "All people"} (${groupCount(shownGroup)})`, () => setPick(null))}
          {picks.map(([name, n]) => chip(shownPick === name, `${name} (${n})`, () => setPick(name)))}
        </div>
      )}
      {shown.length !== items.length && (
        <div style={{ fontSize: 11.5, color: C.mid, marginBottom: 8 }}>
          Showing {shown.length} of {items.length}.{" "}
          <button className="link-btn" style={{ fontSize: 11.5 }} onClick={showAll}>
            Show all
          </button>
        </div>
      )}
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
              {!shown.length && (
                <tr>
                  <td colSpan={6} style={{ whiteSpace: "normal", color: C.mid }}>
                    No articles match this filter.
                  </td>
                </tr>
              )}
              {shown.map((a) => (
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
