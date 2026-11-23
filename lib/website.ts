// The Website tab's shared rules: its channels, in the order its charts stack
// them, and what a page look-up accepts. Pure and free of server imports, so
// the server (lib/websiteGrowth.ts) and the page (components/WebsiteDashboard.tsx)
// file a visit, an enquiry or a link the same way.
//
// Two lists because the two sources see different things. PostHog sees how a
// visit arrived ($channel_type, PostHog's own rules). The CRM sees the tags an
// enquiry carried, and nothing at all for most of them: an untagged enquiry may
// have come from a search engine or been typed in, and the CRM cannot tell.

import { sectionName } from "@/lib/growthMath";

/** How a visit arrived, as PostHog files it. Direct is drawn on its own (section 04). */
export const VISIT_CHANNELS = [
  { key: "organic", label: "Organic search", posthog: "Organic Search" },
  { key: "ai", label: "AI assistants", posthog: "AI" },
  { key: "paidSearch", label: "Paid search", posthog: "Paid Search" },
  { key: "paidSocial", label: "Paid social", posthog: "Paid Social" },
  { key: "organicSocial", label: "Organic social", posthog: "Organic Social" },
  { key: "email", label: "Email", posthog: "Email" },
  { key: "referral", label: "Referral", posthog: "Referral" },
  { key: "other", label: "Other", posthog: null },
] as const;
export type VisitChannel = (typeof VISIT_CHANNELS)[number]["key"] | "direct";

/** PostHog's channel name as one of ours: Direct as itself, a name we don't list as Other. */
export function visitChannel(posthog: string): VisitChannel {
  if (posthog === "Direct") return "direct";
  return VISIT_CHANNELS.find((c) => c.posthog === posthog)?.key ?? "other";
}

/** How an enquiry arrived, by the tags it carried into the CRM (lib/websiteGrowth.ts, ENQUIRY_CHANNEL). */
export const ENQUIRY_CHANNELS = [
  { key: "untagged", label: "Untagged (organic and direct)" },
  { key: "ai", label: "AI assistants" },
  { key: "paidSearch", label: "Paid search" },
  { key: "paidSocial", label: "Paid social" },
  { key: "popup", label: "On-site pop-up" },
  { key: "email", label: "Email" },
  { key: "other", label: "Other tagged" },
] as const;
export type EnquiryChannel = (typeof ENQUIRY_CHANNELS)[number]["key"];

/**
 * The CRM channel that matches a visit channel, where both sides see the same
 * thing: an enquiry tagged as paid search came from a paid search visit. Organic
 * search and direct have no match (the CRM files both as untagged).
 */
export const MATCHED_CHANNELS: { visit: VisitChannel; enquiry: EnquiryChannel }[] = [
  { visit: "ai", enquiry: "ai" },
  { visit: "email", enquiry: "email" },
  { visit: "paidSocial", enquiry: "paidSocial" },
  { visit: "paidSearch", enquiry: "paidSearch" },
];

/** Zero for every channel in a list. */
export function zeroes<K extends string>(keys: readonly { key: K }[]): Record<K, number> {
  return Object.fromEntries(keys.map((c) => [c.key, 0])) as Record<K, number>;
}

/**
 * A form as people know it, from the name the site gives it: the website's
 * own forms module prefixes its names ("bhomes-website_website_forms_list-your-property"),
 * which is left off. "market-reports-blog-post" is "Market reports blog post".
 */
export function formName(name: string): string {
  return sectionName(name.replace(/^.*forms_/, ""));
}

/** The periods a page look-up offers, in days. */
export const LOOKUP_DAYS = [7, 30, 90] as const;

/**
 * A bhomes.com link or path as the page look-up asks for it: lower case, no
 * query, no trailing slash ("" is the home page). Null for anything that is
 * not a plain path, so nothing but letters, digits and - _ / . % reaches a query.
 */
export function lookupPath(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
    else if (/^(www\.)?bhomes\.com/i.test(s)) s = new URL(`https://${s}`).pathname;
  } catch {
    return null;
  }
  s = s.split(/[?#]/)[0].toLowerCase();
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/\/+$/, "");
  return /^[a-z0-9\-_/.%]*$/.test(s) ? s : null;
}
