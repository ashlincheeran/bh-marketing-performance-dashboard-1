"use client";

// The news bot's panels on PR & Media settings (app/pr/settings/page.tsx),
// once Bot Activity at the foot of the PR tab: the bot's own settings, what it
// did this morning, every article it has stored with what happened to it and
// why, the stories the fact check dropped, and the possible moves it noticed.
// A person's Keep or Reject here stands over the bot's (docs/news-pipeline.md,
// rule 6). The companies and people it looks for are CompaniesManager's.
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  keepArticleAction,
  rejectArticleAction,
  runNewsBotAction,
  setMentionStatusAction,
  setNewsSettingsAction,
} from "@/app/actions";
import { callAction, notFinished } from "@/lib/actionCall";
import { C } from "@/lib/theme";
import type {
  BotActivityItem,
  IngestRun,
  NewsArticleItem,
  NewsGroup,
  NewsQueue,
  NewsRunToday,
  PossibleMove,
  TrackedPerson,
} from "@/lib/data";
import type { MentionRole, NewsSettings } from "@/lib/news/types";

/** The bot's reason in a sentence a reader can act on. */
function dropReason(reason: string | null): string {
  if (!reason) return "No reason given";
  if (reason.startsWith("pending re-read")) return "The article could not be read, so it does not count until it is";
  const r = reason.replace(/^fact check: /, "");
  return r.charAt(0).toUpperCase() + r.slice(1);
}

const fmtInt = (n: number) => new Intl.NumberFormat("en-GB").format(n);

/** Dubai time of day, "08:14": fixed to Dubai rather than the viewer's zone, so the server and the browser agree. */
const dubaiTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Dubai date and time, "6 Nov 2026, 08:00", fixed to Dubai for the same reason. */
const dubaiDateTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

/** A sentence ends with a full stop, whatever the bot's message ended with. */
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

const toggleStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  padding: 0,
  width: "100%",
  textAlign: "left",
};

const smallNote: React.CSSProperties = { fontSize: 10.5, color: C.mid, marginTop: 4, whiteSpace: "normal" };

/** How often the page looks again while a run is working. */
const WATCH_EVERY_MS = 20_000;

/** "1 article", "12 articles". */
const articlesWord = (n: number) => `${fmtInt(n)} ${n === 1 ? "article" : "articles"}`;

/**
 * The articles the bot could not read, split as Check by hand splits them
 * (lib/data.ts handCheckList): `named`, the ones it lists, which a search for
 * betterhomes, a rival or a person found; `counted`, the ones with nothing
 * left to decide that are still counted on the PR tab from the old bot; and
 * `general`, the ones only general market searches found. Those a person has
 * decided are in none of them.
 */
export interface UnreadableSplit {
  named: number;
  counted: number;
  general: number;
}

/**
 * The unreadable articles in plain words: the named ones to check by hand,
 * then the counted ones, then the general ones, each after the first said as
 * "more".
 */
function unreadableWords({ named, counted, general }: UnreadableSplit): string[] {
  const out: string[] = [];
  const are = (n: number) => (n === 1 ? "is" : "are");
  if (named > 0) {
    out.push(
      `${articlesWord(named)} from searches for betterhomes, a rival or a person could not be read. Check ${named === 1 ? "it" : "them"} by hand below.`,
    );
  }
  if (counted > 0) {
    out.push(
      out.length
        ? `${fmtInt(counted)} more ${are(counted)} still counted on the PR tab from the old bot.`
        : `${articlesWord(counted)} that could not be read ${are(counted)} still counted on the PR tab from the old bot.`,
    );
  }
  if (general > 0) {
    out.push(
      out.length
        ? `${fmtInt(general)} more came from general market searches and ${are(general)} rarely about anyone we track.`
        : `${articlesWord(general)} from general market searches could not be read. ${general === 1 ? "It is" : "They are"} rarely about anyone we track.`,
    );
  }
  return out;
}

/**
 * What the queue holds now, in plain words. Held articles are told here only
 * while counting is on, as a publish still to finish: in test mode the banner
 * at the top says how many are held.
 *
 * The articles that could not be read are told by `unreadable`, the split
 * Check by hand is made from. When that could not be read, only how many
 * there are is said, from the queue.
 */
export function queueWords(q: NewsQueue, countOnPrTab: boolean, unreadable: UnreadableSplit | null = null): string[] {
  const out: string[] = [];
  const toRead = q.queued + q.reading;
  const forAi = q.read + q.checking;
  if (toRead || forAi) out.push(`Still waiting: ${fmtInt(toRead)} to be read and ${fmtInt(forAi)} for the AI.`);
  if (unreadable) {
    out.push(...unreadableWords(unreadable));
  } else if (q.unreadable) {
    out.push(`${articlesWord(q.unreadable)} could not be read. Those with tries left are tried again on a later morning.`);
  }
  if (q.failed) {
    out.push(
      `${articlesWord(q.failed)} failed: the AI could not answer after three tries, so a person needs to decide. ${q.failed === 1 ? "It is" : "They are"} under Waiting below.`,
    );
  }
  if (q.held && countOnPrTab) {
    out.push(
      `${articlesWord(q.held)} sorted while counting was switched off ${q.held === 1 ? "is" : "are"} still waiting to be published to the PR tab.`,
    );
  }
  return out;
}

/**
 * Test mode, said at the top of PR & Media settings, above the switch: with
 * counting on the PR tab switched off, the bot sorts as usual but holds its
 * decisions, so the bot can be tried on the preview without changing the live
 * tab (production and the preview share one database).
 */
export function TestModeBanner({ held }: { held: number | null }) {
  return (
    <div className="chart-card" style={{ marginBottom: 20, borderColor: C.amber, background: "#fffdf7" }}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <strong>Test mode: counting on the PR tab is switched off.</strong> The bot still finds, reads and sorts
        articles, but its decisions are held for review here and none of them counts on the PR tab.{" "}
        {held === null
          ? "How many are held could not be read just now."
          : held === 1
            ? "1 article is held."
            : `${fmtInt(held)} articles are held.`}{" "}
        Keep and Reject are a person&apos;s decisions, so they still apply straight away. To publish everything held
        to the PR tab, turn counting on below.
      </div>
    </div>
  );
}

/** What Run now says when its call did not finish: the run may be under way all the same. */
const RUN_UNFINISHED =
  "The request did not finish, so it is not known whether the run started. This page looks again for the next two minutes, and its numbers fill in if it did. Press Run now again only if nothing shows by then.";

/** This morning's run in numbers, with Run now. */
export function RunSummary({
  run,
  queue,
  countOnPrTab,
  scheduled,
  unreadable = null,
}: {
  run: NewsRunToday | null;
  queue: NewsQueue | null;
  countOnPrTab: boolean;
  scheduled: boolean;
  /** The unreadable articles split as Check by hand splits them, or null when it could not be read. */
  unreadable?: UnreadableSplit | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // While a run works, look again every 20 seconds so its numbers fill in.
  // One step hands over to the next a moment after it finishes, so a step
  // that ended in the last minute, or a run started from here in the last two
  // minutes, still counts as working. Otherwise the page stays still.
  useEffect(() => {
    const now = Date.now();
    const lastStep = run?.lastStepAt ? Date.parse(run.lastStepAt) : 0;
    const working = !!run?.running || now - lastStep < 60_000 || (startedAt !== null && now - startedAt < 120_000);
    if (!working) return;
    const timer = setTimeout(() => router.refresh(), WATCH_EVERY_MS);
    return () => clearTimeout(timer);
  }, [run, startedAt, router]);

  function runNow() {
    setMsg(null);
    start(async () => {
      const r = await callAction(() => runNewsBotAction(), RUN_UNFINISHED);
      if (r.ok) {
        setStartedAt(Date.now());
        setMsg({ ok: true, text: "Started. The numbers below fill in as it works, which takes a few minutes." });
      } else {
        // A call that did not finish may have started the run, so the page watches as if it had.
        if ("unfinished" in r) setStartedAt(Date.now());
        setMsg({ ok: false, text: r.error });
      }
      // Even when it can't say so for sure, the run may be under way: a fresh
      // look shows whether a step is working, and the page keeps watching if so.
      router.refresh();
    });
  }

  const c = run?.counts ?? {};
  const known = run !== null;
  const count = (n: number | undefined) => (known ? (n ?? 0) : null);
  const tiles: { label: string; value: number | null; hint: string }[] = [
    { label: "Found", value: count(c.found), hint: "Results the searches returned, repeats included" },
    { label: "New", value: count(c.fresh), hint: "Not seen before, so stored to be read" },
    { label: "Read, names found", value: count(c.read), hint: "Read, and a tracked company or person is named: these go to the AI" },
    { label: "Unreadable", value: count(c.unreadable), hint: "The page could not be read and the headline names nobody: tried again later" },
    { label: "No names", value: count(c.noNames), hint: "Read in full, and nobody the bot tracks is named" },
    { label: "Checked by the AI", value: count(c.checked), hint: "Articles the AI sorted" },
    { label: "Ours", value: count(c.ours), hint: "Rows now counting for betterhomes" },
    { label: "Rivals", value: count(c.rivals), hint: "Rows now counting for a rival: an article naming two rivals counts twice" },
    { label: "Rejected", value: count(c.rejected), hint: "The AI found no tracked company in them" },
    // Only when they say something: held while counting is off, published when it is turned back on.
    ...(!countOnPrTab || (c.held ?? 0) > 0
      ? [{ label: "Held", value: count(c.held), hint: "Sorted while counting is switched off: held back from the PR tab until published" }]
      : []),
    ...((c.published ?? 0) > 0
      ? [{ label: "Published", value: count(c.published), hint: "Held decisions written to the PR tab once counting was turned on" }]
      : []),
    {
      label: "Still waiting",
      value: queue ? queue.queued + queue.reading + queue.read + queue.checking : null,
      hint: "Right now: to be read, or waiting for the AI",
    },
  ];

  let sub: React.ReactNode;
  if (!run) sub = "The run log could not be read just now.";
  // Vercel runs the morning cron in production only, so a preview runs when someone starts it.
  else if (!run.steps)
    sub = scheduled
      ? "The bot has not run yet today. It runs every day at 08:00 Dubai."
      : "The bot has not run yet today. On this preview it runs only when someone presses Run now. The daily run at 08:00 Dubai happens in production.";
  else
    sub = (
      <>
        Today in Dubai so far.{run.running ? " Working now." : ""}
        {run.lastStepAt && <span suppressHydrationWarning> Last step at {dubaiTime(run.lastStepAt)}.</span>}
      </>
    );

  const problem = run?.problem ?? null;
  const searchFailures = c.queryFailures ?? 0;
  const waiting = queue ? queueWords(queue, countOnPrTab, unreadable) : [];

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="chart-title">This morning&apos;s run</div>
          <div className="chart-sub" style={{ marginBottom: 0 }}>{sub}</div>
        </div>
        <button
          className="filter-btn"
          onClick={runNow}
          disabled={pending || !!run?.running}
          title={run?.running ? "A run is working now" : "Search, read and check now, as the morning run does"}
        >
          {pending ? "Starting…" : run?.running ? "Running…" : "Run now"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 8, marginTop: 14 }}>
        {tiles.map((t) => (
          <div key={t.label} title={t.hint} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: C.dark }}>{t.value === null ? "n/a" : fmtInt(t.value)}</div>
            <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>{t.label}</div>
          </div>
        ))}
      </div>

      {problem && (
        <div
          style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600, color: problem.kind === "articles" || problem.kind === "preview" || problem.kind === "limit" ? C.amber : C.red }}
          title={problem.detail}
        >
          {sentence(problem.text)}
          {problem.kind === "ai" ? " Articles wait, and nothing new counts until it answers." : ""}
        </div>
      )}
      {waiting.length > 0 && <div style={{ marginTop: 10, fontSize: 12, color: C.mid, lineHeight: 1.6 }}>{waiting.join(" ")}</div>}
      {(searchFailures > 0 || (c.apifyReads ?? 0) > 0) && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: C.mid }}>
          {searchFailures > 0 ? `${fmtInt(searchFailures)} of ${fmtInt(c.queries ?? 0)} searches failed today. ` : ""}
          {(c.apifyReads ?? 0) > 0 ? `Apify read ${fmtInt(c.apifyReads ?? 0)} ${c.apifyReads === 1 ? "page" : "pages"} today.` : ""}
        </div>
      )}
      {msg && <div style={{ marginTop: 10, fontSize: 12, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </div>
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** People on the list whom recent articles describe at another company. */
export function PossibleMoves({ moves, people }: { moves: PossibleMove[] | null; people: TrackedPerson[] | null }) {
  if (!moves?.length) return null;
  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div className="chart-title">Possible moves ({moves.length})</div>
      <div className="chart-sub">
        People on the list whom an article from the last 60 days describes at another company. If someone has moved,
        mark them former in their company&apos;s card above and add them at their new company.
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {moves.map((m) => {
          const onFile = (people ?? []).filter((p) => sameName(p.name, m.person));
          const settled = onFile.some((p) => p.active && sameName(p.company, m.companyInArticle));
          return (
            <div key={`${m.person}|${m.companyInArticle}`} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div style={{ fontSize: 13 }}>
                <strong>{m.person}</strong>, described at <strong>{m.companyInArticle}</strong>
                {settled && (
                  <span className="sent-badge sent-positive" style={{ marginLeft: 8 }}>
                    On the list there now
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: C.mid, marginTop: 3 }}>
                On the list:{" "}
                {/* Only a list that was read can say someone is off it. */}
                {people === null
                  ? "could not be read just now"
                  : onFile.length
                    ? onFile.map((p) => `${p.company} (${p.active ? "current" : "former"})`).join(", ")
                    : "not any more"}
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                {m.articles.slice(0, 3).map((a) => (
                  <li key={a.id}>
                    {a.date || "Undated"} · {a.outlet ?? "Unknown outlet"} ·{" "}
                    {a.link?.startsWith("http") ? (
                      <a className="link-btn" style={{ fontSize: 12 }} href={a.link} target="_blank" rel="noopener noreferrer">
                        {a.title}
                      </a>
                    ) : (
                      a.title
                    )}
                  </li>
                ))}
                {m.articles.length > 3 && <li style={{ color: C.mid }}>and {m.articles.length - 3} more</li>}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** How each way of being mentioned reads beside its quote. */
const ROLE_LABEL: Record<MentionRole, string> = {
  spokesperson: "spokesperson quoted",
  data: "its data",
  news: "its own news",
  passing: "named in passing",
};

const GROUPS: { key: NewsGroup; label: string }[] = [
  { key: "ours", label: "Ours" },
  { key: "rivals", label: "Rivals only" },
  { key: "held", label: "Held" },
  { key: "rejected", label: "Rejected" },
  { key: "waiting", label: "Waiting" },
  { key: "duplicate", label: "Duplicates" },
];

/** A quote cut to a readable length at a word; the whole of it is in the tooltip. */
const clip = (s: string, max = 240) => (s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, "")}…` : s);

/**
 * Every stored article, newest first, with what happened to it and Keep or
 * Reject. What counts, waits for the AI, failed or a person decided is listed
 * by default. The stories the program ruled out by itself (NewsArticleItem's
 * ruledOut) are most of what the plain "betterhomes" search finds, Better
 * Homes & Gardens above all, so they sit under one collapsed line instead,
 * where Keep still works.
 */
export function ArticleList({ articles }: { articles: NewsArticleItem[] | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ruledOutOpen, setRuledOutOpen] = useState(false);
  const [filter, setFilter] = useState<NewsGroup | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const { listed, ruledOut, counts } = useMemo(() => {
    const listed = (articles ?? []).filter((a) => !a.ruledOut);
    const n: Record<NewsGroup, number> = { ours: 0, rivals: 0, held: 0, rejected: 0, waiting: 0, duplicate: 0 };
    for (const a of listed) n[a.group]++;
    return { listed, ruledOut: (articles ?? []).filter((a) => a.ruledOut), counts: n };
  }, [articles]);

  if (!articles) {
    return (
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">Articles the bot found</div>
        <div style={{ fontSize: 12, color: C.red }}>The list could not be read just now.</div>
      </div>
    );
  }

  const rows = filter === "all" ? listed : listed.filter((a) => a.group === filter);

  function act(id: string, what: "keep" | "reject") {
    setErr(null);
    setBusy(`${what}:${id}`);
    start(async () => {
      const r = await callAction(
        () => (what === "keep" ? keepArticleAction(id) : rejectArticleAction(id)),
        notFinished(what === "keep" ? "the Keep was saved" : "the Reject was saved"),
      );
      setBusy(null);
      if (r.ok) router.refresh();
      else setErr(r.error);
    });
  }

  /** The articles as a table: the same columns and buttons for the listed ones and the ruled-out ones. */
  const table = (shown: NewsArticleItem[], empty: string) => (
    <div className="table-wrapper">
      <div className="table-scroll">
        <table className="mentions-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Outlet</th>
              <th style={{ minWidth: 260 }}>Headline</th>
              <th>Result</th>
              <th style={{ minWidth: 280 }}>Why</th>
              <th>Link</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 16 }}>
                  {empty}
                </td>
              </tr>
            )}
            {shown.map((a) => (
              <tr key={a.id}>
                <td style={{ whiteSpace: "nowrap" }}>{a.date || <span className="muted">Undated</span>}</td>
                <td>{a.outlet ?? <span className="muted">Not given</span>}</td>
                <td style={{ whiteSpace: "normal" }}>{a.title}</td>
                <td>
                  <span className={`sent-badge sent-${a.tone}`}>{a.result}</span>
                  {a.person && <div style={smallNote}>{a.person === "kept" ? "Kept by a person" : "Rejected by a person"}</div>}
                  {a.countNote && <div style={smallNote}>{a.countNote}</div>}
                </td>
                <td style={{ whiteSpace: "normal" }}>
                  {a.quotes.map((q) => (
                    <div key={q.company} style={{ fontSize: 11.5, marginBottom: 4 }} title={q.quote}>
                      <span style={{ fontWeight: 600 }}>
                        {q.isUs ? "betterhomes" : q.company}, {ROLE_LABEL[q.role] ?? "named"}:
                      </span>{" "}
                      <span style={{ fontStyle: "italic" }}>“{clip(q.quote)}”</span>
                    </div>
                  ))}
                  {a.reason && <div style={{ fontSize: 11.5 }}>{a.reason}</div>}
                  {a.refused.length > 0 && (
                    <div style={{ fontSize: 11, color: C.mid, marginTop: 4 }}>Refused: {a.refused.join(" ")}</div>
                  )}
                </td>
                <td>
                  {a.link?.startsWith("http") ? (
                    <a className="link-btn" href={a.link} target="_blank" rel="noopener noreferrer" title="Open the article">
                      ↗
                    </a>
                  ) : (
                    <span className="muted">No link</span>
                  )}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {a.canKeep && (
                    <button className="filter-btn" disabled={pending} onClick={() => act(a.id, "keep")} title="Count it as ours">
                      {busy === `keep:${a.id}` ? "Saving…" : "Keep"}
                    </button>
                  )}
                  {a.canReject && (
                    <button
                      className="filter-btn"
                      disabled={pending}
                      onClick={() => act(a.id, "reject")}
                      title="Take it out of the count"
                      style={{ marginLeft: a.canKeep ? 6 : 0 }}
                    >
                      {busy === `reject:${a.id}` ? "Saving…" : "Reject"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <button onClick={() => setOpen((v) => !v)} style={toggleStyle}>
        <div className="chart-title" style={{ marginBottom: open ? 12 : 0 }}>
          {open ? "▾" : "▸"} Articles the bot found ({articles.length}) · {counts.ours} ours, {counts.rivals} rivals only,{" "}
          {counts.held ? `${counts.held} held, ` : ""}
          {counts.rejected} rejected, {counts.waiting} waiting
          {ruledOut.length ? `, ${fmtInt(ruledOut.length)} ruled out automatically` : ""} · click to{" "}
          {open ? "collapse" : "expand"}
        </div>
      </button>
      {open && (
        <>
          <div className="table-controls">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className={`filter-btn${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
                All ({listed.length})
              </button>
              {GROUPS.filter((g) => counts[g.key] > 0).map((g) => (
                <button key={g.key} className={`filter-btn${filter === g.key ? " active" : ""}`} onClick={() => setFilter(g.key)}>
                  {g.label} ({counts[g.key]})
                </button>
              ))}
            </div>
          </div>
          {err && <div style={{ fontSize: 12, color: C.red, margin: "0 0 8px" }}>{err}</div>}
          {table(rows, articles.length ? "No articles here." : "The bot hasn't stored any articles yet. Press Run now above to start it.")}
          {ruledOut.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <button onClick={() => setRuledOutOpen((v) => !v)} style={toggleStyle}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.dark, marginBottom: ruledOutOpen ? 10 : 0 }}>
                  {ruledOutOpen ? "▾" : "▸"} {fmtInt(ruledOut.length)} {ruledOut.length === 1 ? "story" : "stories"} ruled out
                  automatically: look-alike names such as Better Homes &amp; Gardens, pages naming no tracked company, and
                  companies&apos; own websites
                </div>
              </button>
              {ruledOutOpen && table(ruledOut, "")}
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--mid)", marginTop: 8, lineHeight: 1.6 }}>
            Keep counts the article as ours, whatever the bot decided. Reject takes all of it out of the count, ours and
            the rivals&apos;, and stops a held article being published. The bot never changes either. Links open the
            publisher&apos;s page, or Google News when the bot could not find it.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Stories the bot had counted that the fact check could not prove are about
 * us, with Keep to count one again. Nothing is shown when there are none.
 */
export function FactCheckDrops({ drops }: { drops: BotActivityItem[] }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  function keepDrop(id: string) {
    setErr(null);
    startTransition(async () => {
      const r = await callAction(() => setMentionStatusAction(id, "reviewed"), notFinished("the Keep was saved"));
      if (r.ok) router.refresh();
      else setErr(r.error);
    });
  }

  if (!drops.length) return null;
  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <button onClick={() => setOpen((v) => !v)} style={toggleStyle}>
        <div className="chart-title" style={{ marginBottom: open ? 12 : 0 }}>
          {open ? "▾" : "▸"} Dropped by the fact check ({drops.length}) · click to {open ? "collapse" : "expand"}
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
                    <th style={{ minWidth: 220 }}>Why</th>
                    <th>Link</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {drops.map((it) => (
                    <tr key={it.id}>
                      <td>{it.published_on ?? <span className="muted">Undated</span>}</td>
                      <td>{it.outlet_name ?? <span className="muted">Not given</span>}</td>
                      <td>{it.title ?? <span className="muted">No headline</span>}</td>
                      <td style={{ whiteSpace: "normal" }}>{dropReason(it.reason)}</td>
                      <td>
                        {it.url && it.url.startsWith("http")
                          ? <a className="link-btn" href={it.url} target="_blank" rel="noopener noreferrer">↗</a>
                          : <span className="muted">No link</span>}
                      </td>
                      <td>
                        <button className="filter-btn" disabled={pending} onClick={() => keepDrop(it.id)}>Keep</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {err && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{err}</div>}
          <div style={{ fontSize: 11, color: "var(--mid)", marginTop: 8 }}>
            Stories the bot had counted that the fact check could not prove are about us: no sentence in the article names us, or the article could not be read. If one is ours, &ldquo;Keep&rdquo; counts it again.
          </div>
        </>
      )}
    </div>
  );
}

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
      text: "Saved. Counting is on, and everything held is being published to the PR tab now. This morning's run below shows it as it goes.",
    };
  }
  if (publish.uncertain || /did not confirm/i.test(publish.error ?? "")) {
    return {
      ok: false,
      text: "Saved, and counting is on. The news bot did not confirm that publishing started, but it may well be running. Look at this morning's run below in a few minutes. Only if no publish step shows there, switch counting off and save, then on and save.",
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
 * and used from the next run. Moved here from the main Settings page.
 *
 * `initial` is null when the saved settings could not be read. The card then
 * says so and offers nothing to save: the form would show the defaults, whose
 * counting is on, and saving them would end test mode and publish everything
 * held.
 */
export function NewsBotSettings({
  initial,
  readError,
  scheduled,
  claudeKeySet,
  apifyConfigured,
  lastRun,
  heldCount,
}: {
  initial: NewsSettings | null;
  /** Why the settings could not be read. */
  readError: string | null;
  /** True in production, where the morning run is scheduled. */
  scheduled: boolean;
  /** Whether ANTHROPIC_API_KEY is set on the server. Only that: the key itself never reaches the browser. */
  claudeKeySet: boolean;
  /** Whether APIFY_TOKEN is set on the server. */
  apifyConfigured: boolean;
  /** The last run's summary (ingest_runs), or null when none is recorded. */
  lastRun: Pick<IngestRun, "ran_at" | "trigger" | "ok" | "inserted"> | null;
  /** Decisions held while counting was off, or null when they could not be counted. */
  heldCount: number | null;
}) {
  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div className="chart-title">News bot</div>
      <p style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.6, margin: "0 0 12px" }}>
        {/* Vercel runs the morning cron in production only, so a preview runs when someone starts it. */}
        {scheduled
          ? "Every morning at 08:00 Dubai the bot searches Google News, reads each new article, and asks Claude to sort the ones that name a tracked company or person."
          : "On this preview the bot runs only when someone presses Run now below. The daily run at 08:00 Dubai happens in production. Each run searches Google News, reads each new article, and asks Claude to sort the ones that name a tracked company or person."}{" "}
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
        {lastRun ? (
          <span>
            Last news run {dubaiDateTime(lastRun.ran_at)} Dubai time ({lastRun.trigger}), {lastRun.ok ? "ok" : "failed"},{" "}
            {lastRun.inserted} counted.
          </span>
        ) : (
          "No news runs recorded yet."
        )}
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
        ? "The request did not finish, so it is not known whether the settings were saved, or whether publishing what was held started. Reload the page to see what was saved, and look at this morning's run before saving again."
        : notFinished("the settings were saved");
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
            text: "Saved. Test mode is on: from the next run the bot holds its decisions for review on this page, and the PR tab stays as it is.",
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
          Off is test mode: the bot still finds and sorts articles, but holds its decisions for review on this page,
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
