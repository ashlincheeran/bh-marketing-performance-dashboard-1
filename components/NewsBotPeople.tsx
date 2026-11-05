"use client";

// The spokespeople the news bot looks for (tracked_people), editable from Bot
// Activity. A current person counts for their company even when the sentence
// doesn't name it; a former one counts only when the article names the
// company too (docs/news-pipeline.md). So when someone moves, marking them
// former is what stops their old company being credited with their quotes.
import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addPersonAction, removePersonAction, setPersonActiveAction } from "@/app/actions";
import { C } from "@/lib/theme";
import type { TrackedPerson } from "@/lib/data";

/** A name as the list compares it: the same person in any case is one person. */
const nameKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const small: React.CSSProperties = { fontSize: 10.5, color: C.mid, marginTop: 2, whiteSpace: "normal" };

export default function NewsBotPeople({ people, companies }: { people: TrackedPerson[] | null; companies: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState(companies[0] ?? "betterhomes");
  const [role, setRole] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // betterhomes first, then the rivals in the order the bot tracks them. A
  // company no longer tracked comes last: its people are not counted at all.
  const groups = useMemo(() => {
    const byCompany = new Map<string, TrackedPerson[]>();
    for (const p of people ?? []) byCompany.set(p.company, [...(byCompany.get(p.company) ?? []), p]);
    const untracked = [...byCompany.keys()].filter((c) => !companies.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...companies.filter((c) => byCompany.has(c)), ...untracked].map((c) => ({
      company: c,
      tracked: companies.includes(c),
      people: (byCompany.get(c) ?? []).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
    }));
  }, [people, companies]);

  // Someone current at two companies is counted for both, which is almost
  // always a move recorded only halfway.
  const currentAt = useMemo(() => {
    const at = new Map<string, string[]>();
    for (const p of people ?? []) if (p.active) at.set(nameKey(p.name), [...(at.get(nameKey(p.name)) ?? []), p.company]);
    return at;
  }, [people]);

  function act(tag: string, action: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: () => void) {
    setErr(null);
    setBusy(tag);
    start(async () => {
      const r = await action();
      setBusy(null);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      done?.();
      router.refresh();
    });
  }

  function add() {
    const n = name.trim();
    if (n.length < 2) {
      setErr("Give the person's name, 2 to 80 characters.");
      return;
    }
    act("add", () => addPersonAction({ name: n, company, role: role.trim() }), () => {
      setName("");
      setRole("");
    });
  }

  function remove(p: TrackedPerson) {
    const sure = window.confirm(
      `Take ${p.name} (${p.company}) off the list? If they have moved, mark them former instead: they then still count for ${p.company} in articles that name it.`,
    );
    if (sure) act(`remove:${p.id}`, () => removePersonAction(p.id));
  }

  const current = (people ?? []).filter((p) => p.active).length;
  const former = (people ?? []).length - current;

  return (
    <div className="chart-card">
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, width: "100%", textAlign: "left" }}
      >
        <div className="chart-title" style={{ marginBottom: open ? 4 : 0 }}>
          {open ? "▾" : "▸"} Spokespeople the bot looks for{people ? ` (${current} current, ${former} former)` : ""} · click to{" "}
          {open ? "collapse" : "expand"}
        </div>
      </button>

      {open && (
        <>
          <div className="chart-sub">
            A current person counts for their company even when the sentence doesn&apos;t name it. A former one counts
            only when the article names the company too. When someone moves, mark them former and add them at their new
            company. Each current person is also searched for every morning.
          </div>

          {people === null ? (
            <div style={{ fontSize: 12, color: C.red }}>The spokespeople list could not be read just now.</div>
          ) : (
            <div className="table-wrapper">
              <div className="table-scroll">
                <table className="mentions-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 200 }}>Name</th>
                      <th style={{ minWidth: 220 }}>Role</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.length === 0 && (
                      <tr>
                        <td colSpan={3} style={{ padding: 16, color: C.mid }}>
                          Nobody is on the list yet.
                        </td>
                      </tr>
                    )}
                    {groups.map((g) => (
                      <Fragment key={g.company}>
                        <tr>
                          <td colSpan={3} style={{ background: "var(--warm-white)", fontWeight: 600 }}>
                            {g.company}{" "}
                            <span style={{ fontWeight: 400, color: C.mid }}>
                              · {g.people.length}
                              {g.tracked ? "" : " · no longer a tracked rival, so not counted"}
                            </span>
                          </td>
                        </tr>
                        {g.people.map((p) => {
                          const alsoCurrent = p.active ? (currentAt.get(nameKey(p.name)) ?? []).filter((c) => c !== p.company) : [];
                          return (
                            <tr key={p.id}>
                              <td style={{ whiteSpace: "normal" }}>
                                {p.name}
                                {!p.active && (
                                  <span className="sent-badge sent-none" style={{ marginLeft: 6 }}>
                                    Former
                                  </span>
                                )}
                                {p.note && <div style={small}>{p.note}</div>}
                                {alsoCurrent.length > 0 && (
                                  <div style={{ ...small, color: C.amber }}>
                                    Also current at {alsoCurrent.join(", ")}. Mark one of them former.
                                  </div>
                                )}
                              </td>
                              <td style={{ whiteSpace: "normal" }}>{p.role ?? <span className="muted">—</span>}</td>
                              <td style={{ whiteSpace: "nowrap" }}>
                                <button
                                  className="filter-btn"
                                  disabled={pending}
                                  onClick={() => act(`active:${p.id}`, () => setPersonActiveAction(p.id, !p.active))}
                                >
                                  {busy === `active:${p.id}` ? "Saving…" : p.active ? "Mark former" : "Mark current"}
                                </button>
                                <button className="filter-btn" disabled={pending} onClick={() => remove(p)} style={{ marginLeft: 6 }}>
                                  {busy === `remove:${p.id}` ? "Removing…" : "Remove"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="search-box"
              style={{ flex: "1 1 180px", minWidth: 160 }}
              placeholder="Name"
              aria-label="Name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <select
              className="search-box"
              style={{ flex: "0 1 200px", minWidth: 160 }}
              aria-label="Company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            >
              {companies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              className="search-box"
              style={{ flex: "1 1 200px", minWidth: 160 }}
              placeholder="Role, such as Head of Research"
              aria-label="Role"
              maxLength={120}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <button className="filter-btn" onClick={add} disabled={pending || name.trim().length < 2}>
              {busy === "add" ? "Adding…" : "+ Add"}
            </button>
          </div>
          {err && <div style={{ fontSize: 11, color: C.red, marginTop: 6 }}>{err}</div>}
        </>
      )}
    </div>
  );
}
