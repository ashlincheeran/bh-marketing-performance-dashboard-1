// Who the news bot is looking for: betterhomes, the rivals in tracked_keywords,
// and the spokespeople in tracked_people. The searches, the name spotter and
// the AI's instructions all come from this one list.
import { readClient } from "@/lib/supabase";
import type { Company, Person, Registry } from "@/lib/news/types";

/** betterhomes. Its name is matched by the strict rules in lib/match.ts, not by `names`. */
export const US: Company = {
  label: "betterhomes",
  isUs: true,
  names: ["betterhomes", "bhomes", "Better Homes", "PRIME by betterhomes"],
  query: "betterhomes",
};

/**
 * Every way the press writes each rival, keyed by its tracked_keywords label.
 * For a rival listed here these are all of its names: the label is not added
 * on top, so a label that is also an ordinary word is never a spelling by
 * itself.
 *
 * Deliberately missing: the bare words that also mean something else.
 * "Metropolitan" alone catches "metropolitan area", and "White Co" catches
 * "white collar", so only the full company names count here; the AI still
 * sees a sentence that names one of their people. A rival not listed here is
 * known by its label alone.
 */
export const COMPANY_ALIASES: Record<string, string[]> = {
  "Allsopp & Allsopp": ["Allsopp & Allsopp", "Allsopp and Allsopp", "Allsopp Allsopp"],
  // The company writes its own name in lower case.
  "Haus & Haus": ["Haus & Haus", "haus & haus", "haus and haus"],
  "Driven Properties": ["Driven Properties", "Driven | Forbes Global Properties", "Driven Forbes Global Properties"],
  "Engel & Völkers": [
    "Engel & Völkers",
    "Engel & Volkers",
    "Engel and Volkers",
    "Engel and Völkers",
    "Engel Volkers",
    // "oe" is how "ö" is written without the accent.
    "Engel & Voelkers",
    "Engel and Voelkers",
    "Engel Voelkers",
  ],
  Metropolitan: ["Metropolitan Premium Properties", "Metropolitan Group", "Metropolitan Homes"],
  // Luxhabitat is the Sotheby's franchise Honey Deylami runs, and the press often names it alone.
  "Sotheby's": ["Sotheby's International Realty", "Sotheby's Realty", "Dubai Sotheby's", "Luxhabitat Sotheby's", "Luxhabitat", "Sotheby's"],
  "White & Co": ["White & Co", "White & Co.", "White and Co", "White & Co Real Estate"],
  "fäm Properties": ["fäm Properties", "fam Properties", "fäm Real Estate"],
  "Knight Frank": ["Knight Frank"],
};

/** The pure part, so tests can build a registry without a database. */
export function buildRegistry(rivals: { label: string; query: string }[], people: Person[]): Registry {
  const seen = new Set<string>([US.label.toLowerCase()]);
  const companies: Company[] = [US];
  for (const r of rivals) {
    const label = (r.label || r.query || "").trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    // A copy, so nothing done to one registry's names reaches the shared list.
    const names = [...new Set(COMPANY_ALIASES[label] ?? [label])];
    companies.push({ label, isUs: false, names, query: r.query });
  }
  const labels = new Set(companies.map((c) => c.label));
  return { us: US, companies, people: people.filter((p) => labels.has(p.company)) };
}

/** The current list. Throws when the database can't be read, so a run never searches with half a list. */
export async function loadRegistry(): Promise<Registry> {
  const db = readClient();
  if (!db) throw new Error("Supabase is not configured");
  const [rivals, people] = await Promise.all([
    db.from("tracked_keywords").select("query,label").eq("kind", "competitor").eq("active", true).order("created_at", { ascending: true }),
    db.from("tracked_people").select("name,company,role,aliases,active,note").order("company").order("name"),
  ]);
  if (rivals.error) throw new Error(`rivals could not be read: ${rivals.error.message}`);
  if (people.error) throw new Error(`spokespeople could not be read: ${people.error.message}`);
  return buildRegistry(
    (rivals.data ?? []).map((r) => ({ label: String(r.label ?? r.query), query: String(r.query) })),
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
  if (!name) return null;
  const exact = reg.companies.find((c) => c.label === name);
  if (exact) return exact;
  const key = companyKey(name);
  if (!key) return null;
  return (
    reg.companies.find((c) => companyKey(c.label) === key) ??
    reg.companies.find((c) => c.names.some((n) => companyKey(n) === key)) ??
    null
  );
}
