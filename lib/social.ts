// Apify scrapers for the People Sentiment tab.
//
// One generic actor runner + a defensive normalizer per platform. Every field
// read is guarded with several fallback key names because community actors
// change their output shape often. Each platform is independent: a failing or
// mis-configured actor logs and returns [], it never sinks the whole run.
//
// No APIFY_TOKEN / blocked egress → throws, and the ingest layer catches it.
import type {
  SocialChannel,
  SocialConfig,
  Subject,
  SubjectKind,
  TimeWindow,
} from "@/lib/socialTypes";
import { WINDOW_DAYS } from "@/lib/socialTypes";

export interface CollectedItem {
  channel: SocialChannel;
  subject: string;
  subject_kind: SubjectKind;
  external_id: string | null;
  url: string | null;
  author: string | null;
  posted_at: string | null; // ISO
  content: string;
  rating: number | null;
  likes: number;
  comments: number;
  shares: number;
  source_actor: string;
  query: string;
}

export interface ScrapeCtx {
  window: TimeWindow;
  maxItems: number;
  subjects: Subject[];
  p: (msg: string) => void;
  timeoutMs?: number; // per-actor cap for this run (sized to remaining budget)
}

// ── tiny helpers ────────────────────────────────────────────────
function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v; // seconds vs ms
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function firstStr(o: any, keys: string[]): string | null {
  for (const k of keys) { const v = str(o?.[k]); if (v) return v; }
  return null;
}
function firstNum(o: any, keys: string[]): number {
  for (const k of keys) { if (o?.[k] != null) return num(o[k]); }
  return 0;
}

/** Run an Apify actor synchronously and return its dataset items. Throws on failure. */
async function runApifyActor(actor: string, input: unknown, timeoutMs = 110_000): Promise<any[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not set");
  const secs = Math.max(20, Math.round(timeoutMs / 1000));
  const url =
    `https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${secs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`HTTP ${res.status} ${body}`);
    }
    const items = await res.json();
    return Array.isArray(items) ? items : [];
  } catch (e: any) {
    // Make the timeout obvious in the run log instead of "operation was aborted".
    if (e?.name === "AbortError" || /abort/i.test(String(e?.message))) {
      throw new Error(`timed out after ${secs}s (actor too slow — lower Items/platform or disable it)`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const REDDIT_TIME: Record<TimeWindow, string> = { month: "month", quarter: "year", year: "year" };

// Drop items older than the selected window — actor date filters are unreliable.
function withinWindow(iso: string | null, window: TimeWindow): boolean {
  if (!iso) return true; // keep undated; better to over-include than silently drop
  const days = WINDOW_DAYS[window];
  return Date.now() - new Date(iso).getTime() <= days * 864e5;
}

// Attach a base (company-tagged) item to any person whose name appears in its text.
function fanOutToPeople(base: CollectedItem, subjects: Subject[]): CollectedItem[] {
  const out = [base];
  const text = base.content.toLowerCase();
  for (const s of subjects) {
    if (s.kind === "person" && s.name && text.includes(s.name.toLowerCase())) {
      out.push({ ...base, subject: s.name, subject_kind: "person" });
    }
  }
  return out;
}

type BaseItem = Omit<CollectedItem, "subject" | "subject_kind">;

// Which tracked subjects does this text refer to? Person by name, company by alias.
function subjectMatches(content: string, subjects: Subject[]): Subject[] {
  const t = content.toLowerCase();
  const out: Subject[] = [];
  for (const s of subjects) {
    if (s.kind === "person") {
      if (s.name && t.includes(s.name.toLowerCase())) out.push(s);
    } else if (/better ?homes|bhomes/.test(t)) {
      out.push(s);
    }
  }
  return out;
}

// For search-based platforms (one combined query): attribute each hit to the
// subject(s) it actually names; fall back to the company if nothing matches.
function attribute(base: BaseItem, subjects: Subject[]): CollectedItem[] {
  let subs = subjectMatches(base.content, subjects);
  if (!subs.length) {
    const co = subjects.find((s) => s.kind === "company");
    subs = co ? [co] : [];
  }
  return subs.map((s) => ({ ...base, subject: s.name, subject_kind: s.kind }));
}

// ── per-platform scrape + normalize ─────────────────────────────

async function scrapeReddit(cfg: SocialConfig, ctx: ScrapeCtx): Promise<CollectedItem[]> {
  const pc = cfg.platforms.reddit;
  // One run for all subjects. Keep the query count small and scrape POSTS ONLY:
  // comment-search over a residential proxy across many terms is what made this
  // actor blow past the timeout. (Set includeComments on the source to re-enable.)
  const companyQs = (pc.queries?.length ? pc.queries : ["betterhomes dubai"]).slice(0, 3);
  const personQs = ctx.subjects.filter((s) => s.kind === "person" && s.name).map((s) => s.name);
  const searches = [...companyQs, ...personQs];
  const items = await runApifyActor(pc.actor, {
    searches,
    searchPosts: true,
    searchComments: pc.includeComments === true,
    sort: "new",
    time: REDDIT_TIME[ctx.window],
    maxItems: ctx.maxItems,
    skipCommunity: true,
    skipUserPosts: true,
    includeNSFW: false,
    proxy: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  }, ctx.timeoutMs);
  const out: CollectedItem[] = [];
  for (const it of items) {
    const title = firstStr(it, ["title"]) ?? "";
    const body = firstStr(it, ["body", "text", "content", "comment"]) ?? "";
    const content = [title, body].filter(Boolean).join(" — ").trim();
    if (!content) continue;
    const posted = toISO(it.createdAt ?? it.created ?? it.createdAtFormatted ?? it.date ?? it.created_utc);
    if (!withinWindow(posted, ctx.window)) continue;
    const base: BaseItem = {
      channel: "reddit",
      external_id: firstStr(it, ["id", "parsedId", "commentId", "postId", "url"]),
      url: firstStr(it, ["url", "commentUrl", "postUrl", "link"]),
      author: firstStr(it, ["username", "author", "userName"]),
      posted_at: posted,
      content,
      rating: null,
      likes: firstNum(it, ["upVotes", "upvotes", "score", "numberOfupVotes"]),
      comments: firstNum(it, ["numberOfComments", "numComments", "comments"]),
      shares: 0,
      source_actor: pc.actor,
      query: searches.join(" | "),
    };
    out.push(...attribute(base, ctx.subjects));
  }
  return out;
}

async function scrapeLinkedIn(cfg: SocialConfig, ctx: ScrapeCtx): Promise<CollectedItem[]> {
  const pc = cfg.platforms.linkedin;
  // One run for all subjects: company query + each person's name.
  const searchQueries = [
    "Betterhomes Dubai",
    ...ctx.subjects.filter((s) => s.kind === "person" && s.name).map((s) => `${s.name} Betterhomes`),
  ];
  const input: Record<string, unknown> = {
    searchQueries,
    maxPosts: ctx.maxItems,
    sortBy: "date",
    profileScraperMode: "short",
  };
  if (ctx.window === "month") input.postedLimit = "month";
  const items = await runApifyActor(pc.actor, input, ctx.timeoutMs);
  const out: CollectedItem[] = [];
  for (const it of items) {
    const content = firstStr(it, ["content", "text", "postContent", "description"]) ?? "";
    if (!content) continue;
    const posted = toISO(it.postedAt?.date ?? it.postedAt?.timestamp ?? it.postedAtISO ?? it.date ?? it.time ?? it.publishedAt);
    if (!withinWindow(posted, ctx.window)) continue;
    const base: BaseItem = {
      channel: "linkedin",
      external_id: firstStr(it, ["id", "urn", "linkedinUrl", "url"]),
      url: firstStr(it, ["linkedinUrl", "url", "postUrl"]),
      author: it.author?.name ?? firstStr(it, ["authorName", "author"]),
      posted_at: posted,
      content,
      rating: null,
      likes: num(it.engagement?.likes) || firstNum(it, ["reactions", "likes", "numLikes", "likesCount"]),
      comments: num(it.engagement?.comments) || firstNum(it, ["comments", "numComments", "commentsCount"]),
      shares: num(it.engagement?.shares) || firstNum(it, ["shares", "reposts"]),
      source_actor: pc.actor,
      query: searchQueries.join(" | "),
    };
    out.push(...attribute(base, ctx.subjects));
  }
  return out;
}

async function scrapeInstagram(cfg: SocialConfig, ctx: ScrapeCtx): Promise<CollectedItem[]> {
  const pc = cfg.platforms.instagram;
  const company = ctx.subjects.find((s) => s.kind === "company");
  if (!company || !pc.username) return [];
  const items = await runApifyActor(pc.actor, { username: pc.username, maxResults: ctx.maxItems }, ctx.timeoutMs);
  const out: CollectedItem[] = [];
  for (const it of items) {
    const code = firstStr(it, ["code", "shortCode", "shortcode"]);
    const caption = it.caption?.text ?? (typeof it.caption === "string" ? it.caption : null) ?? firstStr(it, ["text"]) ?? "";
    if (!caption) continue;
    const posted = toISO(it.taken_at_date ?? it.takenAt ?? it.taken_at_timestamp ?? it.timestamp ?? it.taken_at);
    if (!withinWindow(posted, ctx.window)) continue;
    const base: CollectedItem = {
      channel: "instagram",
      subject: company.name,
      subject_kind: "company",
      external_id: code ?? firstStr(it, ["id", "pk"]),
      url: code ? `https://www.instagram.com/p/${code}/` : firstStr(it, ["url"]),
      author: it.user?.username ?? firstStr(it, ["ownerUsername", "username"]),
      posted_at: posted,
      content: caption,
      rating: null,
      likes: firstNum(it, ["like_count", "likesCount", "likes"]),
      comments: firstNum(it, ["comment_count", "commentsCount", "comments"]),
      shares: 0,
      source_actor: pc.actor,
      query: `@${pc.username}`,
    };
    out.push(...fanOutToPeople(base, ctx.subjects));
  }
  return out;
}

async function scrapeGlassdoor(cfg: SocialConfig, ctx: ScrapeCtx): Promise<CollectedItem[]> {
  const pc = cfg.platforms.glassdoor;
  const company = ctx.subjects.find((s) => s.kind === "company");
  if (!company) return [];
  if (!pc.companyUrl) throw new Error("no Glassdoor company URL set (Advanced → Glassdoor)");
  const items = await runApifyActor(pc.actor, { startUrls: [{ url: pc.companyUrl }], maxItems: ctx.maxItems }, ctx.timeoutMs);
  const out: CollectedItem[] = [];
  for (const it of items) {
    const headline = firstStr(it, ["summary", "headline", "title"]) ?? "";
    const pros = firstStr(it, ["pros"]) ?? "";
    const cons = firstStr(it, ["cons"]) ?? "";
    const content = [headline, pros && `Pros: ${pros}`, cons && `Cons: ${cons}`].filter(Boolean).join(" — ").trim();
    if (!content) continue;
    const posted = toISO(it.reviewDateTime ?? it.date ?? it.publishedDate ?? it.reviewDate);
    if (!withinWindow(posted, ctx.window)) continue;
    const ratingVal = it.ratingOverall ?? it.rating ?? it.overallRating;
    const base: CollectedItem = {
      channel: "glassdoor",
      subject: company.name,
      subject_kind: "company",
      external_id: firstStr(it, ["reviewId", "id", "reviewUrl", "url"]),
      url: firstStr(it, ["reviewUrl", "url"]),
      author: firstStr(it, ["jobTitle", "reviewerJobTitle", "author"]),
      posted_at: posted,
      content,
      rating: ratingVal != null ? num(ratingVal) : null,
      likes: 0,
      comments: 0,
      shares: 0,
      source_actor: pc.actor,
      query: pc.companyUrl,
    };
    out.push(...fanOutToPeople(base, ctx.subjects));
  }
  return out;
}

async function scrapeFacebook(cfg: SocialConfig, ctx: ScrapeCtx): Promise<CollectedItem[]> {
  const pc = cfg.platforms.facebook;
  const company = ctx.subjects.find((s) => s.kind === "company");
  if (!company) return [];
  if (!pc.pageUrl) throw new Error("no Facebook page URL set (Advanced → Facebook)");
  const items = await runApifyActor(pc.actor, { startUrls: [{ url: pc.pageUrl }], resultsLimit: ctx.maxItems }, ctx.timeoutMs);
  const out: CollectedItem[] = [];
  for (const it of items) {
    const content = firstStr(it, ["text", "message", "postText", "caption"]) ?? "";
    if (!content) continue;
    const posted = toISO(it.time ?? it.timestamp ?? it.date ?? it.publishedTime ?? it.createdTime);
    if (!withinWindow(posted, ctx.window)) continue;
    const base: CollectedItem = {
      channel: "facebook",
      subject: company.name,
      subject_kind: "company",
      external_id: firstStr(it, ["postId", "id", "url", "postUrl", "facebookUrl"]),
      url: firstStr(it, ["url", "postUrl", "facebookUrl", "topLevelUrl"]),
      author: it.user?.name ?? firstStr(it, ["pageName", "authorName"]) ?? it.from?.name ?? null,
      posted_at: posted,
      content,
      rating: null,
      likes: firstNum(it, ["likes", "likesCount", "reactionsCount", "reactions"]),
      comments: firstNum(it, ["comments", "commentsCount"]),
      shares: firstNum(it, ["shares", "sharesCount"]),
      source_actor: pc.actor,
      query: pc.pageUrl,
    };
    out.push(...fanOutToPeople(base, ctx.subjects));
  }
  return out;
}

const SCRAPERS: Record<SocialChannel, (cfg: SocialConfig, ctx: ScrapeCtx) => Promise<CollectedItem[]>> = {
  reddit: scrapeReddit,
  linkedin: scrapeLinkedIn,
  instagram: scrapeInstagram,
  glassdoor: scrapeGlassdoor,
  facebook: scrapeFacebook,
};

export async function scrapeChannel(channel: SocialChannel, cfg: SocialConfig, ctx: ScrapeCtx): Promise<CollectedItem[]> {
  return SCRAPERS[channel](cfg, ctx);
}
