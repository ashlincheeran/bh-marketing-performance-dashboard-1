"use client";

// Bot Activity, at the foot of the PR & Media tab: what the news bot did this
// morning, every article it has stored with what happened to it and why, the
// possible moves it noticed, and the lists it searches with. A person's Keep
// or Reject here stands over the bot's (docs/news-pipeline.md, rule 6).
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  addKeywordAction,
  keepArticleAction,
  rejectArticleAction,
  removeKeywordAction,
  runNewsBotAction,
  setMentionStatusAction,
} from "@/app/actions";
import NewsBotPeople from "@/components/NewsBotPeople";
import { C } from "@/lib/theme";
import type {
  BotActivityItem,
  NewsArticleItem,
  NewsGroup,
  NewsQueue,
  NewsRunToday,
  PossibleMove,
  TrackedKeyword,
  TrackedPerson,
} from "@/lib/data";
import type { MentionRole } from "@/lib/news/types";

/** The bot's reason in a sentence a reader can act on. */
function dropReason(reason: string | null): string {
  if (!reason) return "—";
  if (reason.startsWith("pending re-read")) return "The article could not be read, so it does not count until it is";
  const r = reason.replace(/^fact check: /, "");
  return r.charAt(0).toUpperCase() + r.slice(1);
}

const fmtInt = (n: number) => new Intl.NumberFormat("en-GB").format(n);

/** Dubai time of day, "08:14": fixed to Dubai rather than the viewer's zone, so the server and the browser agree. */
const dubaiTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

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

/** A rival's company name as it is saved: one line, single spaces. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// Editable keyword list: add via the inputs, remove via the × on each chip.
//
// A rival is a company, so it needs its name as well as its search: the name
// is how the bot, the AI and Share of Voice know it, and is never made from
// the search ("haus and haus dubai" is not a company's name).
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
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const rival = kind === "competitor";
  const label = oneLine(name);
  const ready = !!val.trim() && (!rival || (label.length >= 2 && label.length <= 60));

  function add() {
    const q = val.trim();
    if (!q) {
      // Enter in the name box with no search yet: say what is missing rather than do nothing.
      if (rival && label) setErr("Give the Google News search for it as well.");
      return;
    }
    if (rival && (label.length < 2 || label.length > 60)) {
      setErr("Give the rival's company name, 2 to 60 characters, as well as its search.");
      return;
    }
    startTransition(async () => {
      const r = await addKeywordAction(kind, q, rival ? label : undefined);
      if (!r.ok) setErr(r.error);
      else { setErr(null); setVal(""); setName(""); router.refresh(); }
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
      <div style={{ fontSize: 12, color: "var(--mid)", marginBottom: 8 }}>{title}: <span style={{ opacity: 0.8 }}>{hint}</span></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {items.map((k) => (
          <span
            key={`${k.id}-${k.query}`}
            className={`tier-badge ${chipClass}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            title={rival && k.label ? `Searched as "${k.query}"` : undefined}
          >
            {k.label || k.query}
            <button
              onClick={() => remove(k.id)}
              disabled={pending}
              title="Remove"
              style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontWeight: 700, lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </span>
        ))}
        {items.length === 0 && <span style={{ fontSize: 12, color: C.mid }}>None yet.</span>}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 10, maxWidth: rival ? 620 : 460, flexWrap: "wrap" }}>
        {rival && (
          <input
            className="search-box"
            style={{ flex: "1 1 180px", minWidth: 160 }}
            placeholder="Company name, such as Knight Frank"
            aria-label="Rival's company name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          />
        )}
        <input
          className="search-box"
          style={{ flex: "1 1 200px", minWidth: 160 }}
          placeholder={rival ? "Google News search, such as knight frank dubai" : "Add a search term…"}
          aria-label={rival ? "Google News search for the rival" : "Search term"}
          maxLength={120}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <button className="filter-btn" onClick={add} disabled={pending || !ready}>+ Add</button>
      </div>
      {err && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>{err}</div>}
    </div>
  );
}

/** How often Bot Activity looks again while a run is working. */
const WATCH_EVERY_MS = 20_000;

/** "1 article", "12 articles". */
const articlesWord = (n: number) => `${fmtInt(n)} ${n === 1 ? "article" : "articles"}`;

/**
 * What the queue holds now, in plain words. Held articles are told here only
 * while counting is on, as a publish still to finish: in test mode the banner
 * at the top says how many are held.
 */
function queueWords(q: NewsQueue, countOnPrTab: boolean): string[] {
  const out: string[] = [];
  const toRead = q.queued + q.reading;
  const forAi = q.read + q.checking;
  if (toRead || forAi) out.push(`Still waiting: ${fmtInt(toRead)} to be read and ${fmtInt(forAi)} for the AI.`);
  if (q.unreadable) {
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
 * Test mode, said at the top of Bot Activity: with counting on the PR tab
 * switched off, the bot sorts as usual but holds its decisions, so the bot can
 * be tried on the preview without changing the live tab (production and the
 * preview share one database).
 */
function TestModeBanner({ held }: { held: number | null }) {
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
        Turning counting on in <Link href="/settings">Settings</Link> publishes everything held to the PR tab. Keep and
        Reject are a person&apos;s decisions, so they still apply straight away.
      </div>
    </div>
  );
}

/** This morning's run in numbers, with Run now. */
function RunSummary({ run, queue, countOnPrTab }: { run: NewsRunToday | null; queue: NewsQueue | null; countOnPrTab: boolean }) {
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
      const r = await runNewsBotAction();
      if (r.ok) {
        setStartedAt(Date.now());
        setMsg({ ok: true, text: "Started. The numbers below fill in as it works, which takes a few minutes." });
      } else {
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
  else if (!run.steps) sub = "The bot has not run yet today. It runs every day at 08:00 Dubai.";
  else
    sub = (
      <>
        Today in Dubai so far.{run.running ? " Working now." : ""}
        {run.lastStepAt && <span suppressHydrationWarning> Last step at {dubaiTime(run.lastStepAt)}.</span>}
      </>
    );

  const problem = run?.problem ?? null;
  const searchFailures = c.queryFailures ?? 0;

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
          style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600, color: problem.kind === "articles" ? C.amber : C.red }}
          title={problem.detail}
        >
          {sentence(problem.text)}
          {problem.kind === "ai" ? " Articles wait, and nothing new counts until it answers." : ""}
        </div>
      )}
      {queue && queueWords(queue, countOnPrTab).length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.mid, lineHeight: 1.6 }}>{queueWords(queue, countOnPrTab).join(" ")}</div>
      )}
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
function PossibleMoves({ moves, people }: { moves: PossibleMove[] | null; people: TrackedPerson[] | null }) {
  if (!moves?.length) return null;
  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <div className="chart-title">Possible moves ({moves.length})</div>
      <div className="chart-sub">
        People on the spokespeople list whom an article from the last 60 days describes at another company. If someone
        has moved, mark them former in the list below and add them at their new company.
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
                {onFile.length
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

/** Every stored article, newest first, with what happened to it and Keep or Reject. */
function ArticleList({ articles }: { articles: NewsArticleItem[] | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NewsGroup | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const counts = useMemo(() => {
    const n: Record<NewsGroup, number> = { ours: 0, rivals: 0, held: 0, rejected: 0, waiting: 0, duplicate: 0 };
    for (const a of articles ?? []) n[a.group]++;
    return n;
  }, [articles]);

  if (!articles) {
    return (
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">Articles the bot found</div>
        <div style={{ fontSize: 12, color: C.red }}>The list could not be read just now.</div>
      </div>
    );
  }

  const rows = filter === "all" ? articles : articles.filter((a) => a.group === filter);

  function act(id: string, what: "keep" | "reject") {
    setErr(null);
    setBusy(`${what}:${id}`);
    start(async () => {
      const r = what === "keep" ? await keepArticleAction(id) : await rejectArticleAction(id);
      setBusy(null);
      if (r.ok) router.refresh();
      else setErr(r.error);
    });
  }

  return (
    <div className="chart-card" style={{ marginBottom: 20 }}>
      <button onClick={() => setOpen((v) => !v)} style={toggleStyle}>
        <div className="chart-title" style={{ marginBottom: open ? 12 : 0 }}>
          {open ? "▾" : "▸"} Articles the bot found ({articles.length}) · {counts.ours} ours, {counts.rivals} rivals only,{" "}
          {counts.held ? `${counts.held} held, ` : ""}
          {counts.rejected} rejected, {counts.waiting} waiting · click to {open ? "collapse" : "expand"}
        </div>
      </button>
      {open && (
        <>
          <div className="table-controls">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className={`filter-btn${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>
                All ({articles.length})
              </button>
              {GROUPS.filter((g) => counts[g.key] > 0).map((g) => (
                <button key={g.key} className={`filter-btn${filter === g.key ? " active" : ""}`} onClick={() => setFilter(g.key)}>
                  {g.label} ({counts[g.key]})
                </button>
              ))}
            </div>
          </div>
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
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted" style={{ padding: 16 }}>
                        {articles.length ? "No articles here." : "The bot hasn't stored any articles yet. Press Run now above to start it."}
                      </td>
                    </tr>
                  )}
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{a.date || "—"}</td>
                      <td>{a.outlet ?? "—"}</td>
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
                          <span className="muted">—</span>
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
                        {!a.canKeep && !a.canReject && <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {err && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{err}</div>}
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

export default function BotActivity({
  articles,
  run,
  queue,
  moves,
  people,
  companies,
  drops,
  prKeywords,
  competitorKeywords,
  keywordsError = null,
  countOnPrTab = true,
}: {
  articles: NewsArticleItem[] | null;
  run: NewsRunToday | null;
  queue: NewsQueue | null;
  moves: PossibleMove[] | null;
  people: TrackedPerson[] | null;
  /** betterhomes and the tracked rivals' labels: the companies a spokesperson can be added at. */
  companies: string[];
  drops: BotActivityItem[];
  prKeywords: TrackedKeyword[];
  competitorKeywords: TrackedKeyword[];
  /** Why the keyword lists could not be read: the editor then says so rather than showing empty lists. */
  keywordsError?: string | null;
  /** Settings' "Count on the PR tab". Off is test mode: the bot's decisions are held, not counted. */
  countOnPrTab?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [dropsOpen, setDropsOpen] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const router = useRouter();

  function keepDrop(id: string) {
    setDropErr(null);
    startTransition(async () => {
      const r = await setMentionStatusAction(id, "reviewed");
      if (r.ok) router.refresh();
      else setDropErr(r.error);
    });
  }

  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Bot Activity</div>
          <div className="page-sub">
            Every article the news bot found on Google News, what it decided and why, so you can check it yourself.
          </div>
        </div>
        <span className="verified-badge">Google News + Claude</span>
      </div>

      {!countOnPrTab && <TestModeBanner held={queue ? queue.held : null} />}
      <RunSummary run={run} queue={queue} countOnPrTab={countOnPrTab} />
      <PossibleMoves moves={moves} people={people} />
      <ArticleList articles={articles} />

      {drops.length > 0 && (
        <div className="chart-card" style={{ marginBottom: 20 }}>
          <button onClick={() => setDropsOpen((v) => !v)} style={toggleStyle}>
            <div className="chart-title" style={{ marginBottom: dropsOpen ? 12 : 0 }}>
              {dropsOpen ? "▾" : "▸"} Dropped by the fact check ({drops.length}) · click to {dropsOpen ? "collapse" : "expand"}
            </div>
          </button>
          {dropsOpen && (
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
                          <td>{it.published_on ?? "—"}</td>
                          <td>{it.outlet_name ?? "—"}</td>
                          <td>{it.title ?? "—"}</td>
                          <td style={{ whiteSpace: "normal" }}>{dropReason(it.reason)}</td>
                          <td>
                            {it.url && it.url.startsWith("http")
                              ? <a className="link-btn" href={it.url} target="_blank" rel="noopener noreferrer">↗</a>
                              : <span className="muted">—</span>}
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
              {dropErr && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{dropErr}</div>}
              <div style={{ fontSize: 11, color: "var(--mid)", marginTop: 8 }}>
                Stories the bot had counted that the fact check could not prove are about us: no sentence in the article names us, or the article could not be read. If one is ours, &ldquo;Keep&rdquo; counts it again.
              </div>
            </>
          )}
        </div>
      )}

      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">Monitored keywords</div>
        <div className="chart-sub">Edit the lists here. Run now and the daily run use them straight away.</div>
        {keywordsError ? (
          // Not the built-in lists: the bot searches with what the table holds, so showing them would mislead.
          <div style={{ fontSize: 12, color: C.red, marginTop: 10, lineHeight: 1.6 }}>
            The keyword lists could not be read just now, so they can&apos;t be shown or changed. Reload the page to try
            again.
            <br />
            <span style={{ color: C.mid }}>Reason: {keywordsError}</span>
          </div>
        ) : (
          <>
            <KeywordManager
              title="betterhomes"
              hint="searched every morning, and the AI keeps only the articles about us"
              kind="pr"
              chipClass="tier-t1local"
              items={prKeywords}
            />
            <KeywordManager
              title="Rivals"
              hint="each one is a rival company: its name, as the PR tab shows it, and the Google News search for it, run every morning for Share of Voice and the competitor feed. Add their spokespeople to the list below, not here"
              kind="competitor"
              chipClass="tier-t2"
              items={competitorKeywords}
            />
          </>
        )}
      </div>

      <NewsBotPeople people={people} companies={companies} companiesError={keywordsError} />
    </>
  );
}
