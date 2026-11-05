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
 * Other ways the press writes each rival, keyed by its tracked_keywords label.
 *
 * Deliberately missing: the bare words that also mean something else.
 * "Metropolitan" alone catches "metropolitan area", and "White Co" catches
 * "white collar", so only the full company names count here; the AI still
 * sees a sentence that names one of their people.
 */
export const COMPANY_ALIASES: Record<string, string[]> = {
  "Allsopp & Allsopp": ["Allsopp & Allsopp", "Allsopp and Allsopp", "Allsopp Allsopp"],
  "Haus & Haus": ["haus & haus", "haus and haus"],
  "Driven Properties": ["Driven Properties", "Driven | Forbes Global Properties", "Driven Forbes Global Properties"],
  "Engel & Völkers": ["Engel & Völkers", "Engel & Volkers", "Engel and Volkers", "Engel and Völkers", "Engel Volkers"],
  Metropolitan: ["Metropolitan Premium Properties", "Metropolitan Group", "Metropolitan Homes"],
  "Sotheby's": ["Sotheby's International Realty", "Sotheby's Realty", "Dubai Sotheby's", "Luxhabitat Sotheby's", "Sotheby's"],
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
    const names = [...new Set([label, ...(COMPANY_ALIASES[label] ?? [])])];
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
