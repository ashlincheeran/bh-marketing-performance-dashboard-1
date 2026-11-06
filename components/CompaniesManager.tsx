"use client";

// The companies the news bot looks for, on PR & Media settings: one card each,
// betterhomes first and then every rival, with the company's searches, the
// ways the press writes it, its own websites and its people. Every change is
// saved for everyone and used from the bot's next step (lib/news/registry.ts
// loadRegistry). It replaces the keyword lists and the spokespeople list that
// sat under Bot Activity on the PR tab.
//
// A current person counts for their company even when the sentence doesn't
// name it; a former one counts only when the article names the company too
// (docs/news-pipeline.md). So when someone moves, marking them former is what
// stops their old company being credited with their quotes. Each current
// person is searched for too, and each card says so.
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addKeywordAction,
  addPersonAction,
  removeKeywordAction,
  removePersonAction,
  setPersonActiveAction,
  updateCompanyAction,
} from "@/app/actions";
import { callAction, notFinished } from "@/lib/actionCall";
import { checkCompanyChange } from "@/lib/news/companyChange";
import { C } from "@/lib/theme";
import type { TrackedKeyword, TrackedPerson } from "@/lib/data";

/**
 * betterhomes' label, as lib/news/registry.ts names it (US.label). Written
 * here rather than imported: that module reads the database.
 */
const US_LABEL = "betterhomes";

type Result = { ok: true } | { ok: false; error: string };

/** A company's name as it is saved: one line, single spaces. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** A rival's label, as the registry reads its row. */
const labelOf = (k: TrackedKeyword) => (k.label || k.query).trim();

/** A name as the list compares it: the same person in any case is one person. */
const nameKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const fieldLabel: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: ".5px", color: C.mid };
const hint: React.CSSProperties = { fontSize: 11, color: C.mid, marginTop: 6, lineHeight: 1.5 };
const errorLine: React.CSSProperties = { fontSize: 11, color: C.red, marginTop: 6 };
const small: React.CSSProperties = { fontSize: 10.5, color: C.mid, marginTop: 2, whiteSpace: "normal" };
const chipRemove: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 700,
  lineHeight: 1,
  padding: 0,
};

/**
 * Saving through a server action: which change is under way, the error to
 * show, and `save` to start one. A saved change looks at the page again, so
 * the card shows what is stored.
 */
function useSave() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function save(tag: string, action: () => Promise<Result>, unfinished: string, done?: () => void) {
    setErr(null);
    setBusy(tag);
    start(async () => {
      const r = await callAction(action, unfinished);
      setBusy(null);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      done?.();
      router.refresh();
    });
  }
  return { err, setErr, busy, pending, save };
}

/** A part of a company's card: a small heading, then what it holds. */
function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={fieldLabel}>{title}</div>
      {children}
    </div>
  );
}

/** Chips, each with × to take it off, or `empty` when there are none. */
function Chips({
  items,
  chipClass,
  disabled,
  onRemove,
  empty,
}: {
  items: { key: string; text: string }[];
  chipClass: string;
  disabled: boolean;
  onRemove: (key: string) => void;
  empty: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
      {items.map((it) => (
        <span key={it.key} className={`tier-badge ${chipClass}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {it.text}
          <button onClick={() => onRemove(it.key)} disabled={disabled} title={`Remove ${it.text}`} style={chipRemove}>
            ×
          </button>
        </span>
      ))}
      {items.length === 0 && <span style={{ fontSize: 12, color: C.mid }}>{empty}</span>}
    </div>
  );
}

/** A field and its + Add button. Enter adds too. */
function AddField({
  label,
  placeholder,
  maxLength,
  value,
  onChange,
  onAdd,
  disabled,
  adding,
  title,
}: {
  label: string;
  placeholder: string;
  maxLength: number;
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  disabled: boolean;
  adding: boolean;
  title: string;
}) {
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8, maxWidth: 460, flexWrap: "wrap" }}>
      <input
        className="search-box"
        style={{ flex: "1 1 200px", minWidth: 160 }}
        placeholder={placeholder}
        aria-label={label}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAdd();
        }}
      />
      <button className="filter-btn" onClick={onAdd} disabled={disabled || !value.trim()} title={title}>
        {adding ? "Adding…" : "+ Add"}
      </button>
    </div>
  );
}

/** betterhomes' Google News searches: the 'pr' keywords, one row each. */
function OurSearches({ items }: { items: TrackedKeyword[] }) {
  const [value, setValue] = useState("");
  const { err, busy, pending, save } = useSave();

  function add() {
    const q = value.trim();
    if (!q) return;
    save("add", () => addKeywordAction("pr", q), notFinished("the search was added"), () => setValue(""));
  }

  return (
    <>
      <Chips
        items={items.map((k) => ({ key: String(k.id), text: k.query }))}
        chipClass="tier-t1local"
        disabled={pending}
        onRemove={(id) => save(`remove:${id}`, () => removeKeywordAction(Number(id)), notFinished("the search was removed"))}
        empty="None of our own. The bot still searches for betterhomes."
      />
      <AddField
        label="Search term"
        placeholder="Add a search, such as betterhomes dubai"
        maxLength={120}
        value={value}
        onChange={setValue}
        onAdd={add}
        disabled={pending}
        adding={busy === "add"}
        title="Add the search"
      />
      <div style={hint}>The AI keeps only the articles about us, whatever a search finds.</div>
      {err && <div style={errorLine}>{err}</div>}
    </>
  );
}

/**
 * A company's other spellings or its websites, as chips with × and a field to
 * add one. Each change saves the whole list (updateCompanyAction), checked
 * here first the way the server checks it, so a mistake is said at once. The
 * list as last saved is kept here: a second change made before the page has
 * looked again then builds on the first. The card is mounted afresh whenever
 * the stored list changes (see `key` where it is used).
 */
function CompanyList({
  rowId,
  kind,
  field,
  company,
  items,
}: {
  /** The company's tracked_keywords row. */
  rowId: number;
  kind: "competitor" | "us";
  field: "aliases" | "sites";
  company: string;
  items: string[];
}) {
  const [list, setList] = useState(items);
  const [value, setValue] = useState("");
  const { err, setErr, busy, pending, save } = useSave();
  const spellings = field === "aliases";
  const noun = spellings ? "spelling" : "website";

  /** `xs` as the server would store it, or why it would refuse it. */
  function clean(xs: string[]): { ok: true; list: string[] } | { ok: false; error: string } {
    const checked = checkCompanyChange(spellings ? { aliases: xs } : { sites: xs }, kind);
    return checked.ok ? { ok: true, list: (spellings ? checked.patch.aliases : checked.patch.sites) ?? [] } : checked;
  }

  /** `next` cleaned as the server cleans it, and saved; or why it can't be. */
  function change(next: string[], tag: string, unfinished: string, done?: () => void) {
    const checked = clean(next);
    if (!checked.ok) {
      setErr(checked.error);
      return;
    }
    // Nothing new once cleaned: the same spelling in another case, or the same
    // website written another way. Measured against the stored list cleaned the
    // same way, which may hold two spellings that differ only in case.
    const before = clean(list);
    if (tag === "add" && before.ok && checked.list.length === before.list.length) {
      setErr(`That ${noun} is listed already.`);
      return;
    }
    const cleaned = checked.list;
    save(tag, () => updateCompanyAction(rowId, spellings ? { aliases: cleaned } : { sites: cleaned }), unfinished, () => {
      setList(cleaned);
      done?.();
    });
  }

  function add() {
    const v = value.trim();
    if (!v) return;
    // A rival with no other spellings is known by its name alone. Once it has
    // any, the bot looks for those alone, so the name is kept beside the first.
    const next = spellings && list.length === 0 ? [company, v] : [...list, v];
    change(next, "add", notFinished(`the ${noun} was added`), () => setValue(""));
  }

  return (
    <>
      <Chips
        items={list.map((x) => ({ key: x, text: x }))}
        chipClass={spellings ? "tier-t2" : "tier-t1local"}
        disabled={pending}
        onRemove={(x) => change(list.filter((y) => y !== x), `remove:${x}`, notFinished(`the ${noun} was removed`))}
        empty={spellings ? "None, so the bot looks for its name alone." : "None yet."}
      />
      <AddField
        label={spellings ? `Other spelling of ${company}` : `Website of ${company}`}
        placeholder={spellings ? "Add a spelling, as the press writes it" : "Add a website, such as knightfrank.ae"}
        maxLength={spellings ? 60 : 200}
        value={value}
        onChange={(v) => {
          setValue(v);
          setErr(null);
        }}
        onAdd={add}
        disabled={pending}
        adding={busy === "add"}
        title={`Add the ${noun} to ${company}`}
      />
      {/* Under the field while something is typed in it, which is when the mistake can be made: not in every card at once. */}
      {value.trim() && (
        <div style={hint}>
          {spellings
            ? "Full company names only: a common word alone, such as Metropolitan or White, would catch unrelated stories."
            : "Websites like allsoppandallsopp.com, or knightfrank.* for every country. A story on a company's own website never counts for it."}
        </div>
      )}
      {err && <div style={errorLine}>{err}</div>}
    </>
  );
}

/** The people at one company: current first, each to mark former or current, or remove, and a row to add one. */
function People({
  company,
  people,
  currentAt,
  unread = false,
  canAdd = true,
}: {
  company: string;
  people: TrackedPerson[];
  /** Where each name is current, by nameKey: someone current at two companies is a move recorded halfway. */
  currentAt: Map<string, string[]>;
  /** The list could not be read, so `people` is empty for that reason, not because nobody is on it. */
  unread?: boolean;
  /** False for people at companies no longer tracked: there is no company to add them at. */
  canAdd?: boolean;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const { err, setErr, busy, pending, save } = useSave();
  const unfinished = notFinished("the change to the list was saved");
  const sorted = [...people].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  function add() {
    const n = name.trim();
    if (n.length < 2) {
      setErr("Give the person's name, 2 to 80 characters.");
      return;
    }
    save("add", () => addPersonAction({ name: n, company, role: role.trim() }), unfinished, () => {
      setName("");
      setRole("");
    });
  }

  function remove(p: TrackedPerson) {
    const sure = window.confirm(
      `Take ${p.name} (${p.company}) off the list? If they have moved, mark them former instead: they then still count for ${p.company} in articles that name it.`,
    );
    if (sure) save(`remove:${p.id}`, () => removePersonAction(p.id), unfinished);
  }

  return (
    <>
      {unread ? (
        <div style={{ fontSize: 12, color: C.red, marginTop: 6 }}>
          The people could not be read just now. Reload the page to try again.
        </div>
      ) : (
        sorted.length === 0 && (
          <div style={{ fontSize: 12, color: C.mid, marginTop: 6 }}>Nobody yet. Add the CEO and the heads the press quotes.</div>
        )
      )}
      {sorted.map((p) => {
        const alsoCurrent = p.active ? (currentAt.get(nameKey(p.name)) ?? []).filter((c) => c !== p.company) : [];
        return (
          <div
            key={p.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 10,
              flexWrap: "wrap",
              padding: "8px 0",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ fontSize: 12.5, flex: "1 1 200px" }}>
              <span style={{ fontWeight: 600 }}>{p.name}</span>
              {!p.active && (
                <span className="sent-badge sent-none" style={{ marginLeft: 6 }}>
                  Former
                </span>
              )}
              {!canAdd && <span style={{ color: C.mid }}> at {p.company}</span>}
              {p.role && <div style={{ fontSize: 11.5, color: C.mid, marginTop: 2 }}>{p.role}</div>}
              {p.note && <div style={small}>{p.note}</div>}
              {alsoCurrent.length > 0 && (
                <div style={{ ...small, color: C.amber }}>Also current at {alsoCurrent.join(", ")}. Mark one of them former.</div>
              )}
            </div>
            <div style={{ whiteSpace: "nowrap" }}>
              <button
                className="filter-btn"
                disabled={pending}
                onClick={() => save(`active:${p.id}`, () => setPersonActiveAction(p.id, !p.active), unfinished)}
              >
                {busy === `active:${p.id}` ? "Saving…" : p.active ? "Mark former" : "Mark current"}
              </button>
              <button className="filter-btn" disabled={pending} onClick={() => remove(p)} style={{ marginLeft: 6 }}>
                {busy === `remove:${p.id}` ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        );
      })}
      {canAdd && (
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="search-box"
            style={{ flex: "1 1 160px", minWidth: 140 }}
            placeholder="Name"
            aria-label={`Name of a new person at ${company}`}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <input
            className="search-box"
            style={{ flex: "1 1 180px", minWidth: 140 }}
            placeholder="Role, such as CEO"
            aria-label={`Role of the new person at ${company}`}
            maxLength={120}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button
            className="filter-btn"
            onClick={add}
            disabled={pending || name.trim().length < 2}
            title={`Add the person at ${company}`}
          >
            {busy === "add" ? "Adding…" : "+ Add"}
          </button>
        </div>
      )}
      {err && <div style={errorLine}>{err}</div>}
    </>
  );
}

/**
 * What the bot searches Google News for on the company's behalf: its own
 * searches, then `"<name>" dubai` for each current person, so the people can
 * be seen to be searched for too.
 */
function Searched({ searches, peopleUnread }: { searches: string[]; peopleUnread: boolean }) {
  return (
    <div style={{ fontSize: 11.5, color: C.mid, lineHeight: 1.6, marginTop: 16, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
      <span style={{ fontWeight: 600 }}>Searched every morning:</span> {searches.length ? searches.join(" · ") : "nothing yet"}
      {peopleUnread && <div>The people&apos;s own searches can&apos;t be listed until the people can be read.</div>}
    </div>
  );
}

const cardTitle: React.CSSProperties = { fontSize: 15, marginBottom: 2 };

/** betterhomes' card. Its spellings are the bot's own strict rules (lib/match.ts), so they are said, not edited. */
function OurCard({
  us,
  prKeywords,
  people,
  currentAt,
  searches,
  peopleUnread,
}: {
  us: TrackedKeyword | null;
  prKeywords: TrackedKeyword[];
  people: TrackedPerson[];
  currentAt: Map<string, string[]>;
  searches: string[];
  peopleUnread: boolean;
}) {
  return (
    <div className="chart-card">
      <div className="chart-title" style={cardTitle}>
        {US_LABEL}
      </div>
      <Part title="Spellings">
        <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
          betterhomes, bhomes and Better Homes used as a company name; Better Homes &amp; Gardens and BetterHome Group
          never count.
        </div>
      </Part>
      <Part title="Searches">
        <OurSearches items={prKeywords} />
      </Part>
      <Part title="Websites">
        {us ? (
          <CompanyList key={us.sites.join("\n")} rowId={us.id} kind="us" field="sites" company={US_LABEL} items={us.sites} />
        ) : (
          <div style={{ ...hint, color: C.red }}>
            betterhomes&apos; own row is missing from tracked_keywords, so its websites can&apos;t be shown or saved. Migration
            0024 adds it.
          </div>
        )}
      </Part>
      <Part title="People">
        <People company={US_LABEL} people={people} currentAt={currentAt} unread={peopleUnread} />
      </Part>
      <Searched searches={searches} peopleUnread={peopleUnread} />
    </div>
  );
}

/** A rival's card, with Remove rival. */
function RivalCard({
  rival,
  people,
  currentAt,
  searches,
  peopleUnread,
}: {
  rival: TrackedKeyword;
  people: TrackedPerson[];
  currentAt: Map<string, string[]>;
  searches: string[];
  peopleUnread: boolean;
}) {
  const label = labelOf(rival);
  const { err, busy, pending, save } = useSave();

  function remove() {
    const sure = window.confirm(
      `Stop tracking ${label}? The bot stops searching for it, and its stories stop counting on the PR tab. Its people stay on the list, but are not counted.`,
    );
    if (sure) save("remove", () => removeKeywordAction(rival.id), notFinished("the rival was removed"));
  }

  return (
    <div className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div className="chart-title" style={cardTitle}>
            {label}
          </div>
          <div style={{ fontSize: 11.5, color: C.mid }}>Google News search: {rival.query}</div>
        </div>
        <button className="filter-btn" onClick={remove} disabled={pending} title={`Stop tracking ${label}`}>
          {busy === "remove" ? "Removing…" : "Remove rival"}
        </button>
      </div>
      {err && <div style={errorLine}>{err}</div>}
      <Part title="Other spellings">
        <CompanyList key={rival.aliases.join("\n")} rowId={rival.id} kind="competitor" field="aliases" company={label} items={rival.aliases} />
      </Part>
      <Part title="Websites">
        <CompanyList key={rival.sites.join("\n")} rowId={rival.id} kind="competitor" field="sites" company={label} items={rival.sites} />
      </Part>
      <Part title="People">
        <People company={label} people={people} currentAt={currentAt} unread={peopleUnread} />
      </Part>
      <Searched searches={searches} peopleUnread={peopleUnread} />
    </div>
  );
}

/**
 * A new rival: its company name and its Google News search. The name is how
 * the bot, the AI and the PR tab know it, and is never made from the search
 * ("haus and haus dubai" is not a company's name).
 */
function AddRival() {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const { err, setErr, busy, pending, save } = useSave();
  const label = oneLine(name);
  const ready = !!query.trim() && label.length >= 2 && label.length <= 60;

  function add() {
    const q = query.trim();
    if (!q) {
      // Enter in the name box with no search yet: say what is missing rather than do nothing.
      if (label) setErr("Give the Google News search for it as well.");
      return;
    }
    if (label.length < 2 || label.length > 60) {
      setErr("Give the rival's company name, 2 to 60 characters, as well as its search.");
      return;
    }
    save("add", () => addKeywordAction("competitor", q, label), notFinished("the rival was added"), () => {
      setName("");
      setQuery("");
    });
  }

  return (
    <div className="chart-card" style={{ marginTop: 20, marginBottom: 20 }}>
      <div className="chart-title">Add a rival</div>
      <div className="chart-sub">
        Its company name, as the PR tab shows it, and the Google News search for it. Its other spellings, websites and
        people go in its card once it is added.
      </div>
      <div style={{ display: "flex", gap: 6, maxWidth: 820, flexWrap: "wrap" }}>
        <input
          className="search-box"
          style={{ flex: "1 1 260px", minWidth: 160 }}
          placeholder="Company name, such as Knight Frank"
          aria-label="Rival's company name"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <input
          className="search-box"
          style={{ flex: "1 1 320px", minWidth: 160 }}
          placeholder="Google News search, such as knight frank dubai"
          aria-label="Google News search for the rival"
          maxLength={120}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button className="filter-btn" onClick={add} disabled={pending || !ready}>
          {busy === "add" ? "Adding…" : "+ Add rival"}
        </button>
      </div>
      {err && <div style={errorLine}>{err}</div>}
    </div>
  );
}

export default function CompaniesManager({
  us,
  prKeywords,
  rivals,
  people,
  searches,
  error = null,
}: {
  /** betterhomes' own row (kind 'us'), which holds its websites, or null when there is none. */
  us: TrackedKeyword | null;
  /** betterhomes' searches (kind 'pr'). */
  prKeywords: TrackedKeyword[];
  /** The tracked rivals (kind 'competitor'), in the order the bot tracks them. */
  rivals: TrackedKeyword[];
  /** Everyone on the list (tracked_people), or null when it could not be read. */
  people: TrackedPerson[] | null;
  /** Each company's searches, by its label, as lib/news/search.ts searchesByCompany lists them. */
  searches: { company: string; searches: string[] }[];
  /** Why the companies could not be read: nothing is then shown to change. */
  error?: string | null;
}) {
  // Someone current at two companies is counted for both, which is almost
  // always a move recorded only halfway.
  const currentAt = useMemo(() => {
    const at = new Map<string, string[]>();
    for (const p of people ?? []) if (p.active) at.set(nameKey(p.name), [...(at.get(nameKey(p.name)) ?? []), p.company]);
    return at;
  }, [people]);

  if (error) {
    // Not the built-in lists: the bot searches with what the table holds, so showing them would mislead.
    return (
      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">Companies</div>
        <div style={{ fontSize: 12, color: C.red, lineHeight: 1.6 }}>
          The companies could not be read just now, so they can&apos;t be shown or changed. Reload the page to try again.
          <br />
          <span style={{ color: C.mid }}>Reason: {error}</span>
        </div>
      </div>
    );
  }

  const peopleUnread = people === null;
  const at = (company: string) => (people ?? []).filter((p) => p.company === company);
  const searched = (company: string) => searches.find((s) => s.company === company)?.searches ?? [];
  // People whose company is no longer tracked: not counted at all, so they can only be removed.
  const tracked = new Set([US_LABEL, ...rivals.map(labelOf)]);
  const others = (people ?? []).filter((p) => !tracked.has(p.company));

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(440px, 100%), 1fr))",
          gap: 20,
          alignItems: "start",
        }}
      >
        <OurCard
          us={us}
          prKeywords={prKeywords}
          people={at(US_LABEL)}
          currentAt={currentAt}
          searches={searched(US_LABEL)}
          peopleUnread={peopleUnread}
        />
        {rivals.map((r) => (
          <RivalCard
            key={r.id}
            rival={r}
            people={at(labelOf(r))}
            currentAt={currentAt}
            searches={searched(labelOf(r))}
            peopleUnread={peopleUnread}
          />
        ))}
      </div>
      {others.length > 0 && (
        <div className="chart-card" style={{ marginTop: 20 }}>
          <div className="chart-title">People at companies no longer tracked</div>
          <div className="chart-sub">They are not counted. Remove them, or add their company again as a rival.</div>
          <People company="" people={others} currentAt={currentAt} canAdd={false} />
        </div>
      )}
      <AddRival />
    </>
  );
}
