// What PR & Media settings may change on a tracked company (tracked_keywords,
// migration 0024): a rival's other spellings, and any company's own websites.
// Checked on the server before anything is saved (app/actions.ts
// updateCompanyAction). Pure, with no server code, so a form may use it too.
import { asRecord, oneLine } from "@/lib/coerce";
import { namesBetterhomes } from "@/lib/match";
import { canSpot } from "@/lib/news/spot";

/** The most other spellings one rival may have. */
const MAX_ALIASES = 20;
/** The most websites one company may have. */
const MAX_SITES = 10;

/**
 * A website as lib/news/ownSite.ts reads it: lower case, with no scheme,
 * path, port or leading "www.", so "https://www.KnightFrank.ae/research" is
 * knightfrank.ae. Null when what is left is not a web address (letters,
 * digits and hyphens, in two parts or more split by dots) or "name.*", that
 * name under any ending.
 */
function siteOf(input: unknown): string | null {
  const site = oneLine(input)
    .toLowerCase()
    .replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d*$/, "")
    .replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site) || /^[a-z0-9-]+\.\*$/.test(site) ? site : null;
}

/** The fields of a company's row that settings may write. */
interface CompanyPatch {
  aliases?: string[];
  sites?: string[];
}

/**
 * A change to a company's row, checked and cleaned, or why it is refused.
 * `kind` is the row's: 'competitor' takes both lists, and 'us' (betterhomes)
 * takes websites only, since its spellings are the strict rules in
 * lib/match.ts. Each list given replaces the stored one.
 *
 * Other spellings: each on one line, 2 to 60 characters with three letters
 * or digits at least (the name spotter passes over a shorter one, so "KF" or
 * "E&V" would never be found), never betterhomes' own name, each once
 * whatever its case, at most 20. Websites: cleaned by siteOf, each once, at
 * most 10. An empty list clears it.
 */
export function checkCompanyChange(change: unknown, kind: unknown): { ok: true; patch: CompanyPatch } | { ok: false; error: string } {
  if (kind !== "competitor" && kind !== "us") return { ok: false, error: "That is a search, not a company." };
  const raw = asRecord(change);
  const patch: CompanyPatch = {};

  if (raw.aliases !== undefined) {
    if (kind === "us") {
      return { ok: false, error: "betterhomes' spellings are fixed by the bot's own rules, so they can't be changed here." };
    }
    if (!Array.isArray(raw.aliases)) return { ok: false, error: "The other spellings could not be read. Reload the page and try again." };
    const aliases: string[] = [];
    const seen = new Set<string>();
    for (const item of raw.aliases) {
      const alias = oneLine(item);
      if (alias.length < 2 || alias.length > 60) return { ok: false, error: "Each other spelling must be 2 to 60 characters." };
      if (!canSpot(alias)) {
        return { ok: false, error: `"${alias}" is too short to find: each other spelling needs three letters or digits at least.` };
      }
      if (namesBetterhomes(alias)) {
        return { ok: false, error: `"${alias}" is betterhomes' own name, so it can't be another company's spelling.` };
      }
      if (seen.has(alias.toLowerCase())) continue;
      seen.add(alias.toLowerCase());
      aliases.push(alias);
    }
    if (aliases.length > MAX_ALIASES) return { ok: false, error: `A company can have at most ${MAX_ALIASES} other spellings.` };
    patch.aliases = aliases;
  }

  if (raw.sites !== undefined) {
    if (!Array.isArray(raw.sites)) return { ok: false, error: "The websites could not be read. Reload the page and try again." };
    const sites: string[] = [];
    for (const item of raw.sites) {
      const site = siteOf(item);
      if (!site) {
        return {
          ok: false,
          error: `"${oneLine(item)}" is not a website. Give an address like allsoppandallsopp.com, or knightfrank.* for every country.`,
        };
      }
      if (!sites.includes(site)) sites.push(site);
    }
    if (sites.length > MAX_SITES) return { ok: false, error: `A company can have at most ${MAX_SITES} websites.` };
    patch.sites = sites;
  }

  if (!patch.aliases && !patch.sites) return { ok: false, error: "Nothing was given to change." };
  return { ok: true, patch };
}
