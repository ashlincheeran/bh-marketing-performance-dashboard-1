// The keys that make "the same article" mean the same thing everywhere: when a
// search result arrives, when its real address is found, and when old stories
// are imported. A repeat on any key is dropped before anything reads it.
import { createHash } from "node:crypto";
import { outletKey } from "@/lib/match";

export { outletKey };

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * The headline without the " - Outlet" Google News adds, and without a
 * trailing "| Outlet" some sites put in their own titles.
 */
export function stripOutletSuffix(title: string, outlet: string | null): string {
  let t = (title || "").replace(/\s+/g, " ").trim();
  if (outlet) {
    const o = outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s+[-–—|]\\s+${o}\\s*$`, "i"), "").trim();
  }
  return t;
}

/** The headline folded to letters and digits: case, accents, punctuation and the outlet suffix don't count. */
export function titleKey(title: string, outlet: string | null): string {
  return fold(stripOutletSuffix(title, outlet))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Query parameters that say how a reader arrived, not which page it is:
 * campaign tags, click ids, share and referral markers, AMP and refresh
 * switches. Dropped, so the same article shared two ways compares equal.
 */
const TRACKING = /^(?:utm_.*|fbclid|gclid|dclid|msclkid|mc_[ce]id|igsh(?:id)?|si|feature|ocid|cmpid|cmp|ref|ref_src|referrer|from|mod|amp|outputtype|_refresh|guccounter|guce_.*|zephr_.*|leadsource|reduced|share|source|src|_ga)$/i;

/**
 * The article's address folded so the same page compares equal: lower-case
 * host without "www.", no fragment, no trailing slash, and the query without
 * its tracking parameters, the rest sorted. The query has to stay: on YouTube
 * (watch?v=), on news agencies (ArticleDetails.aspx?id=) and on many WordPress
 * sites (?p=123) it is the article itself, and dropping it made every such
 * article the same address, filed as a duplicate of the first.
 */
export function urlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  const kept = [...u.searchParams]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  return `${host}${path}${query}`;
}

/** A stable id for a new article: from the Google link when there is one, else the address, else the headline and outlet. */
export function articleId(parts: { googleLink?: string | null; url?: string | null; titleKey: string; outletKey: string }): string {
  const basis = parts.googleLink || urlKey(parts.url) || `${parts.titleKey}|${parts.outletKey}`;
  return "na_" + createHash("sha1").update(basis).digest("hex").slice(0, 20);
}
