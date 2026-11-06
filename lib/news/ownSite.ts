// A company's own website is not coverage of that company (decided by Ash,
// Nov 2026). Allsopp & Allsopp's blog on allsoppandallsopp.com, Dubai
// Sotheby's International Realty's pages on sothebysrealty.ae, or a page on
// bhomes.com, never count for the company that published them, so a rival is
// never credited for writing about itself, and nor are we.
//
// Pure, so every step that sorts or writes a story (lib/news/run.ts, write.ts,
// migrate.ts) and Bot Activity (lib/data.ts) apply the one rule the same way.
// Another company named on the page still counts for that company: the rule
// is about who published it.
//
// Each company's websites are its `sites` (lib/news/registry.ts), kept in
// tracked_keywords and edited in PR & Media settings. The first lists were
// checked on 6 Nov 2026 by loading each page or finding the company's own news
// on it. "name.*" is the name under any ending, for a firm with a site per
// country (knightfrank.ae, knightfrank.com, knightfrank.co.uk), and a
// subdomain counts as its site (invest.metropolitan.realestate).
import { companyKey } from "@/lib/news/registry";
import type { Candidate, Company, Decision, Registry } from "@/lib/news/types";

/**
 * A publisher's host, lower case, without "www.". Null for anything that is
 * not an address, and for Google's own (a news.google.com link says nothing
 * about who published the story).
 */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host && !/(^|\.)google\.[a-z.]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** True when `host` is one of `sites`, or a subdomain of one. */
function onSite(host: string, sites: string[]): boolean {
  return sites.some((site) => {
    if (site.endsWith(".*")) {
      // The name as one part of the host, never as its ending: knightfrank.co.uk, not knightfranknews.com.
      const name = site.slice(0, -2);
      return host.split(".").slice(0, -1).includes(name);
    }
    return host === site || host.endsWith(`.${site}`);
  });
}

/**
 * The names a company's own site is published under: its own names, which for
 * a rival never include a bare word like "Metropolitan" (lib/news/registry.ts).
 * For betterhomes, all but "Better Homes", which is the American magazine's
 * words too.
 */
function publisherNames(company: Company): string[] {
  return company.isUs ? company.names.filter((n) => n !== "Better Homes") : company.names;
}

/**
 * The company, among `companies`, whose own website the article is on, by its
 * label, or null. Told by the publisher's address when the article has one,
 * and otherwise by the publisher's name as Google News gives it ("Allsopp &
 * Allsopp", "Dubai Sotheby's International Realty"), which a story stored
 * with only a Google link has. A name Google gives as an address
 * ("luxhabitat.ae") is read as one.
 */
export function ownSiteOf(article: { url?: string | null; outlet?: string | null }, companies: Company[]): string | null {
  const host = hostOf(article.url);
  const outlet = (article.outlet ?? "").trim();
  const outletHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(outlet) ? outlet.toLowerCase().replace(/^www\./, "") : null;
  const outletKey = outlet ? companyKey(outlet) : "";
  for (const company of companies) {
    if (host && onSite(host, company.sites)) return company.label;
    if (outletHost && onSite(outletHost, company.sites)) return company.label;
    // The name is only trusted when the address doesn't say otherwise.
    if (!host && outletKey && publisherNames(company).some((n) => companyKey(n) === outletKey)) return company.label;
  }
  return null;
}

/** The same, for every company the registry tracks. */
export function ownSiteIn(article: { url?: string | null; outlet?: string | null }, reg: Registry): string | null {
  return ownSiteOf(article, reg.companies);
}

/** Why an article on a company's own site is not that company's coverage, as Bot Activity shows it. */
export function ownSiteReason(company: string): string {
  // "Sotheby's own website", not "Sotheby's's".
  const whose = /['’]s$/i.test(company) ? company : `${company}'s`;
  return `it is on ${whose} own website, which doesn't count as coverage`;
}

/** The decision for an article on a company's own site that names no one else: no AI was asked. */
export function ownSiteDecision(company: string, checkedAt: string): Decision {
  return {
    mentions: [],
    irrelevantReason: ownSiteReason(company),
    possibleMoves: [],
    dropped: [],
    model: "none: the company's own website",
    checkedAt,
  };
}

/**
 * True when every sentence names only `company` or its people (current or
 * former), so asking the AI could only end in the rule above. A sentence
 * naming anyone else, or naming nobody, sends the article to the AI as usual.
 */
export function namesOnly(candidates: Candidate[], company: string, reg: Registry): boolean {
  if (!candidates.length) return false;
  const theirs = new Set(reg.people.filter((p) => p.company === company).map((p) => p.name));
  return candidates.every(
    (c) => (c.companies.length > 0 || c.people.length > 0) && c.companies.every((x) => x === company) && c.people.every((p) => theirs.has(p)),
  );
}

/**
 * The decision without the company whose own site the article is on: its
 * mentions go, recorded in `dropped` with the reason, and an article left with
 * none is rejected for that reason. Other companies' mentions stand. The same
 * decision comes back when there is nothing to take out.
 */
export function withoutOwnSite(decision: Decision, owner: string | null): Decision {
  if (!owner) return decision;
  const mentions = (decision.mentions ?? []).filter((m) => m.company !== owner);
  if (mentions.length === (decision.mentions ?? []).length) return decision;
  const why = ownSiteReason(owner);
  return {
    ...decision,
    mentions,
    irrelevantReason: mentions.length ? decision.irrelevantReason : why,
    dropped: [
      ...(decision.dropped ?? []),
      ...(decision.mentions ?? []).filter((m) => m.company === owner).map((m) => ({ company: owner, sentence: m.sentence, why })),
    ],
  };
}
