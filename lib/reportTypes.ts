// The weekly email's settings shape and rules, shared by the Settings form and
// the server. No database code here, so the browser can import it.

/** How a person receives the email. Paused keeps them on the list without sending. */
export type RecipientRole = "to" | "cc" | "bcc" | "paused";

export interface Recipient {
  email: string;
  name: string;
  role: RecipientRole;
}

export interface ReportSettings {
  enabled: boolean;
  /** 1 = Monday … 7 = Sunday, in Dubai. The email goes at 09:00 Dubai that day. */
  weekday: number;
  /** The page photographed, one of REPORT_PAGES. */
  page: string;
  subject: string;
  /** A line or two above the picture. */
  intro: string;
  recipients: Recipient[];
  lastSentAt: string | null;
  /** What the last attempt did, in words, failure included. */
  lastResult: string | null;
}

export const REPORT_PAGES = [
  { path: "/", label: "Dashboard" },
  { path: "/company", label: "Company Performance" },
  { path: "/pr", label: "PR & Media" },
  { path: "/digital", label: "Digital Performance" },
  { path: "/seo", label: "SEO" },
  { path: "/website", label: "Website" },
  { path: "/portals", label: "Portals" },
] as const;

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const ROLES: RecipientRole[] = ["to", "cc", "bcc", "paused"];

export const MAX_RECIPIENTS = 50;

export const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  enabled: false,
  weekday: 1,
  page: "/",
  subject: "Weekly marketing dashboard",
  intro: "",
  recipients: [],
  lastSentAt: null,
  lastResult: null,
};

// Plain addresses only: no display-name syntax, commas or angle brackets, so
// one entry can never turn into several recipients on the way to the mail server.
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"']+\.[a-z]{2,}$/i;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

export const pageLabel = (path: string) => REPORT_PAGES.find((p) => p.path === path)?.label ?? "Dashboard";

/** Whatever is stored, as valid settings: unknown pages, days and roles fall back to the defaults. */
export function cleanReportSettings(raw: unknown): ReportSettings {
  const p = (raw ?? {}) as Partial<Record<keyof ReportSettings, unknown>>;
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  for (const r of Array.isArray(p.recipients) ? p.recipients : []) {
    const email = String((r as Recipient)?.email ?? "").trim().toLowerCase();
    if (!isEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const role = ROLES.includes((r as Recipient).role) ? (r as Recipient).role : "to";
    recipients.push({ email, name: String((r as Recipient).name ?? "").trim().slice(0, 80), role });
  }
  const weekday = Number(p.weekday);
  return {
    enabled: p.enabled === true,
    weekday: Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : 1,
    page: REPORT_PAGES.some((x) => x.path === p.page) ? String(p.page) : "/",
    subject: String(p.subject ?? "").trim().slice(0, 150) || DEFAULT_REPORT_SETTINGS.subject,
    intro: String(p.intro ?? "").trim().slice(0, 600),
    recipients: recipients.slice(0, MAX_RECIPIENTS),
    lastSentAt: typeof p.lastSentAt === "string" ? p.lastSentAt : null,
    lastResult: typeof p.lastResult === "string" ? p.lastResult : null,
  };
}
