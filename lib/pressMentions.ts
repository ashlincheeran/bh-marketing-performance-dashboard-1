// Press mentions on the PR tab (components/PressMentions.tsx): every story on
// record that counts for betterhomes or a tracked rival, one row per article,
// with the companies it counts for and the tracked people it names.
//
// It is built from exactly the rows the tab's figures count (lib/data.ts
// getPressMentions): our mentions as getMentions returns them, one per
// placement, and the rivals' stories as getCompetitorNews returns them, so
// the list and the numbers agree. Pure and free of the database, so it can be
// tested, and the browser can use its types.
import { nameKey } from "@/lib/match";

/** One counted row: one of our mentions, or a rival's story. */
export interface PressRow {
  /** The mentions row's id. */
  id: string;
  /** betterhomes, or the rival's label. */
  company: string;
  isUs: boolean;
  date: string | null;
  outlet: string | null;
  title: string | null;
  url: string | null;
  /** The news bot's article the row says it belongs to (metadata.articleId), if it says. */
  articleId: string | null;
  /**
   * The ids an article imported from the old bot may name this row by
   * (legacy_mention_id): its own when a bot wrote it, and the bot's rows folded
   * into it. None for a clip only the PR agency's history has.
   */
  legacyIds: string[];
}

/** What the list reads of a news_articles row. */
export interface PressArticle {
  id: string;
  status: string | null;
  /** The old bot's row an imported article was made from. */
  legacy_mention_id: string | null;
  /** For a duplicate, the article it is a copy of. */
  dup_of: string | null;
  /** The sentences that name a tracked company or person (Candidate[]), as stored. */
  candidates: unknown;
}

/** A person on the tracked list (tracked_people), as the list reads them. */
export interface PressPersonRecord {
  name: string;
  company: string;
  role: string | null;
  /** False: no longer speaks for `company`. */
  active: boolean;
}

/** A tracked person an article names, with the company they speak for. */
export interface PressPerson {
  name: string;
  company: string;
  /** Their role there. Never given for a former one: it is the role they had. */
  role: string | null;
  former: boolean;
}

/** One article in the list. */
export interface PressMention {
  /** The article's id, or the row's for a story that has no article: unique in the list. */
  key: string;
  date: string | null;
  outlet: string | null;
  title: string | null;
  url: string | null;
  /** Every tracked company it counts for: betterhomes first, then the rivals in the filter's order. */
  companies: { label: string; isUs: boolean }[];
  /** The tracked people it names, in the order it names them. None for a story nobody read for names. */
  people: PressPerson[];
}

/** A company the list can be filtered by, with how many articles count for it. */
export interface PressCompany {
  label: string;
  isUs: boolean;
  count: number;
}

export interface PressMentions {
  /** Newest first, undated last. */
  items: PressMention[];
  /** betterhomes, then each rival with an article: the most articles first, as the competitor stories were ordered. */
  companies: PressCompany[];
}

/** The people an article's candidates name, by their name on file, in article order. */
function namedIn(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((c) => {
    const people = c && typeof c === "object" ? (c as { people?: unknown }).people : null;
    return Array.isArray(people) ? people.filter((p): p is string => typeof p === "string" && !!p.trim()) : [];
  });
}

/**
 * The list, from the counted rows (ours first, then the rivals', each in the
 * order its read gives them), the articles read for them, and the tracked
 * people. `people` is null when they could not be read: no one is named then.
 * `us` is betterhomes' label, whose filter is shown even with no article.
 *
 * Rows of one article are one row of the list: the article a row names, else
 * the one imported from it or from a bot row folded into it (legacyIds), with
 * a duplicate taken as the article it copies. A row that is in no article, a
 * clip only the PR agency's history has, is an article of its own. An
 * article's date, outlet, headline and link are its first row's, a blank
 * filled from the next.
 *
 * Its people are the tracked people its candidates name, each once, at the
 * company they speak for in it: one the article counts for, when they are on
 * file there, current or former; else where they are now; else where they
 * were. So someone who moved is shown at their old company in a story that
 * counts for it. A name no longer on file is left out.
 */
export function buildPressMentions(
  rows: PressRow[],
  articles: PressArticle[],
  people: PressPersonRecord[] | null,
  us: string,
): PressMentions {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const byLegacy = new Map<string, PressArticle>();
  for (const a of articles) if (a.legacy_mention_id && !byLegacy.has(a.legacy_mention_id)) byLegacy.set(a.legacy_mention_id, a);
  // A duplicate is the article it copies, followed as far as the articles read go.
  const headOf = (id: string) => {
    const seen = new Set([id]);
    let at = id;
    for (let a = byId.get(at); a?.status === "duplicate" && a.dup_of && !seen.has(a.dup_of); a = byId.get(at)) {
      at = a.dup_of;
      seen.add(at);
    }
    return at;
  };

  const groups = new Map<string, { rows: PressRow[]; articles: string[] }>();
  for (const r of rows) {
    const linked = r.articleId ? [r.articleId] : r.legacyIds.flatMap((id) => byLegacy.get(id)?.id ?? []);
    const head = linked.length ? headOf(linked[0]) : null;
    const key = head ? `article ${head}` : `row ${r.id}`;
    const group = groups.get(key) ?? { rows: [], articles: [] };
    group.rows.push(r);
    for (const id of head ? [head, ...linked] : []) if (!group.articles.includes(id)) group.articles.push(id);
    groups.set(key, group);
  }

  // Everyone on file, by name: someone who moved is on file once per company.
  const onFile = new Map<string, PressPersonRecord[]>();
  for (const p of people ?? []) onFile.set(nameKey(p.name), [...(onFile.get(nameKey(p.name)) ?? []), p]);
  const peopleOf = (ids: string[], companies: Set<string>): PressPerson[] => {
    const out: PressPerson[] = [];
    const seen = new Set<string>();
    for (const name of ids.flatMap((id) => namedIn(byId.get(id)?.candidates))) {
      const k = nameKey(name);
      const records = onFile.get(k);
      if (seen.has(k) || !records?.length) continue;
      seen.add(k);
      // Current first, then at a company the article counts for when there is one.
      const byCurrent = [...records].sort((a, b) => Number(b.active) - Number(a.active));
      const p = byCurrent.find((r) => companies.has(r.company)) ?? byCurrent[0];
      out.push({ name: p.name, company: p.company, role: p.active ? p.role : null, former: !p.active });
    }
    return out;
  };

  const first = <T>(xs: PressRow[], pick: (r: PressRow) => T | null): T | null =>
    xs.map(pick).find((v) => v !== null && v !== "") ?? null;
  const items: PressMention[] = [...groups.entries()].map(([key, g]) => ({
    key,
    date: first(g.rows, (r) => r.date),
    outlet: first(g.rows, (r) => r.outlet),
    title: first(g.rows, (r) => r.title),
    url: first(g.rows, (r) => r.url),
    companies: g.rows
      .filter((r, i) => g.rows.findIndex((o) => o.company === r.company) === i)
      .map((r) => ({ label: r.company, isUs: r.isUs })),
    people: people ? peopleOf(g.articles, new Set(g.rows.map((r) => r.company))) : [],
  }));
  // Newest first and undated last; the same day keeps the order the reads gave.
  items.sort((a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? 1 : -1));

  // The rivals with an article, the most first; a tie in the order they first appear, newest first.
  const counts = new Map<string, number>();
  for (const item of items) for (const c of item.companies) if (!c.isUs) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  const rivals = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const rank = new Map(rivals.map(([label], i) => [label, i]));
  for (const item of items) {
    item.companies.sort((a, b) => (a.isUs === b.isUs ? (rank.get(a.label) ?? 0) - (rank.get(b.label) ?? 0) : a.isUs ? -1 : 1));
  }
  return {
    items,
    companies: [
      { label: us, isUs: true, count: items.filter((i) => i.companies.some((c) => c.isUs)).length },
      ...rivals.map(([label, count]) => ({ label, isUs: false, count })),
    ],
  };
}

/**
 * Who an article names, for the line under its headline: "Richard Waind
 * (betterhomes, CEO); Carl Allsopp (Allsopp & Allsopp, CEO and co-founder)",
 * and a former one as "Louis Harding (former, betterhomes)".
 */
export function peopleLine(people: PressPerson[]): string {
  return people
    .map((p) => `${p.name} (${p.former ? `former, ${p.company}` : p.role ? `${p.company}, ${p.role}` : p.company})`)
    .join("; ");
}
