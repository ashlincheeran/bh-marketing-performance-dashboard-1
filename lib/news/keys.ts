// The keys that make "the same article" mean the same thing everywhere: when a
// search result arrives, when its real address is found, and when old stories
// are imported. A repeat on any key is dropped before anything reads it.
import { createHash } from "node:crypto";
import { outletKey } from "@/lib/match";

export { outletKey };

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
 * The article's address folded so the same page compares equal: lower-case
 * host without "www.", no fragment, no trailing slash, no tracking query. The
 * query is kept only when the path is empty ("/?p=123" is a whole article
 * address on many WordPress sites).
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
  const query = path === "" && u.search ? u.search : "";
  return `${host}${path}${query}`;
}

/** A stable id for a new article: from the Google link when there is one, else the address, else the headline and outlet. */
export function articleId(parts: { googleLink?: string | null; url?: string | null; titleKey: string; outletKey: string }): string {
  const basis = parts.googleLink || urlKey(parts.url) || `${parts.titleKey}|${parts.outletKey}`;
  return "na_" + createHash("sha1").update(basis).digest("hex").slice(0, 20);
}
