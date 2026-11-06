// Who the news bot is looking for: betterhomes, the rivals in tracked_keywords,
// and the spokespeople in tracked_people. The searches, the name spotter and
// the AI's instructions all come from this one list.
//
// Each rival's other spellings and websites are its tracked_keywords row's
// aliases and sites (migration 0024), and betterhomes' websites are the sites
// of the one row of kind 'us', so all of them are edited in PR & Media
// settings rather than written here.
import { readClient } from "@/lib/supabase";
import type { Company, Person, Registry } from "@/lib/news/types";

/**
 * betterhomes. Its name is matched by the strict rules in lib/match.ts, not by
 * `names`. Its websites come from tracked_keywords too (buildRegistry), so
 * here it has none.
 */
export const US: Company = {
  label: "betterhomes",
  isUs: true,
  names: ["betterhomes", "bhomes", "Better Homes", "PRIME by betterhomes"],
  query: "betterhomes",
  sites: [],
};

/** A rival as tracked_keywords holds it. */
export interface RivalInput {
  label: string;
  query: string;
  /** Every way the press writes it. None means its label alone. */
  aliases?: string[];
  /** Its own websites, as ownSite.ts reads them. */
  sites?: string[];
}

/** The text items of a list, trimmed, each once, blanks left out. Anything else is no list. */
function textList(v: unknown, fold: (s: string) => string = (s) => s): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((s): s is string => typeof s === "string").map((s) => fold(s.trim())).filter(Boolean))];
}

/** A stored list of other spellings, as the bot reads it: each trimmed and once, blanks left out. */
export const aliasList = (v: unknown): string[] => textList(v);

/** A stored list of websites, as the bot reads it: the same, in lower case. */
export const siteList = (v: unknown): string[] => textList(v, (s) => s.toLowerCase());

/**
 * The pure part, so tests can build a registry without a database.
 *
 * A rival with other spellings is known by those alone: its label is not added
 * on top, so a label that is also an ordinary word is never a spelling by
 * itself. "Metropolitan" alone catches "metropolitan area", and "White Co"
 * catches "white collar", so such a rival lists only its full company names;
 * the AI still sees a sentence that names one of its people. A rival with
 * none is known by its label alone. betterhomes keeps its names from the code
 * and takes its websites from `us`, the 'us' row.
 */
export function buildRegistry(rivals: RivalInput[], people: Person[], us?: { sites?: string[] } | null): Registry {
  const ours: Company = { ...US, sites: siteList(us?.sites) };
  const seen = new Set<string>([US.label.toLowerCase()]);
  const companies: Company[] = [ours];
  for (const r of rivals) {
    const label = (r.label || r.query || "").trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const aliases = aliasList(r.aliases);
    companies.push({ label, isUs: false, names: aliases.length ? aliases : [label], query: r.query, sites: siteList(r.sites) });
  }
  const labels = new Set(companies.map((c) => c.label));
  return { us: ours, companies, people: people.filter((p) => labels.has(p.company)) };
}

/** A company's tracked_keywords row, as Supabase returns it. */
export interface CompanyRow {
  kind: unknown;
  query: unknown;
  label: unknown;
  aliases?: unknown;
  sites?: unknown;
}

/**
 * The registry from tracked_keywords rows, in the order given: each
 * 'competitor' row is a rival, and the first 'us' row holds betterhomes'
 * websites. Rows of any other kind are left out.
 */
export function registryFromRows(rows: CompanyRow[], people: Person[]): Registry {
  const rivals = rows
    .filter((r) => r.kind === "competitor")
    .map((r) => ({ label: String(r.label ?? r.query), query: String(r.query), aliases: aliasList(r.aliases), sites: siteList(r.sites) }));
  const us = rows.find((r) => r.kind === "us");
  return buildRegistry(rivals, people, us ? { sites: siteList(us.sites) } : null);
}

/** The columns registryFromRows reads. */
export const COMPANY_COLUMNS = "kind,query,label,aliases,sites";

/** The current list. Throws when the database can't be read, so a run never searches with half a list. */
export async function loadRegistry(): Promise<Registry> {
  const db = readClient();
  if (!db) throw new Error("Supabase is not configured");
  const [rows, people] = await Promise.all([
    db
      .from("tracked_keywords")
      .select(COMPANY_COLUMNS)
      .in("kind", ["competitor", "us"])
      .eq("active", true)
      .order("created_at", { ascending: true }),
    db.from("tracked_people").select("name,company,role,aliases,active,note").order("company").order("name"),
  ]);
  if (rows.error) throw new Error(`rivals could not be read: ${rows.error.message}`);
  if (people.error) throw new Error(`spokespeople could not be read: ${people.error.message}`);
  return registryFromRows(
    rows.data ?? [],
    (people.data ?? []).map((p) => ({
      name: String(p.name),
      company: String(p.company),
      role: (p.role as string | null) ?? null,
      aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [],
      active: p.active !== false,
      note: (p.note as string | null) ?? null,
    })),
  );
}

/** The company a person speaks for now, if they are on the list as current. */
export function currentCompanyOf(reg: Registry, personName: string): string | null {
  return reg.people.find((p) => p.active && p.name === personName)?.company ?? null;
}

/** Companies a person used to speak for. */
export function formerCompaniesOf(reg: Registry, personName: string): string[] {
  return reg.people.filter((p) => !p.active && p.name === personName).map((p) => p.company);
}

const ACCENTS = /[\u0300-\u036f]/g;
const APOSTROPHES = /['\u2018\u2019\u02bc`\u00b4]/g;

/**
 * A company name folded so spellings of one name compare equal: case,
 * accents, apostrophes, punctuation and "&" for "and" don't count, so
 * "Engel and Volkers" is "Engel & Völkers", and a curly apostrophe is a straight one.
 */
export function companyKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(ACCENTS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The registry's company a name means, or null when it means none of them:
 * the label exactly, else the label written another way ("knight frank",
 * "Allsopp and Allsopp"), else one of the company's own spellings
 * ("Metropolitan Premium Properties", "Engel & Voelkers"). Whatever wrote the
 * name (the AI, the old bot), what is stored and counted is the label.
 */
export function companyNamed(reg: Registry, name: string | null | undefined): Company | null {
  return companyIn(reg.companies, name);
}

/** The same, among `companies`. */
export function companyIn(companies: Company[], name: string | null | undefined): Company | null {
  if (!name) return null;
  const exact = companies.find((c) => c.label === name);
  if (exact) return exact;
  const key = companyKey(name);
  if (!key) return null;
  return (
    companies.find((c) => companyKey(c.label) === key) ??
    companies.find((c) => c.names.some((n) => companyKey(n) === key)) ??
    null
  );
}
