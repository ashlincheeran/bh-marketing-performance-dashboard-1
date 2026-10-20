// Apify performance scrapers for the Social Performance benchmark.
//
// One generic actor runner + a defensive normalizer per platform. Each returns
// the account's follower count and its recent posts (with likes / comments /
// shares / plays and a post type), from which the ingest computes the report's
// aggregates. Community actors change their output shape often, so every field
// is read with several fallback key names. A failing platform logs and returns
// null/[]; it never sinks the whole run.
import type { PerfPlatform, PostType } from "@/lib/perfTypes";
import { WINDOW_DAYS, type TimeWindow } from "@/lib/socialTypes";

export interface RawPerfPost {
  external_id: string | null;
  url: string | null;
  type: PostType;
  posted_at: string | null; // ISO
  likes: number;
  comments: number;
  shares: number;
  plays: number | null;
  caption: string | null;
}

export interface PerfScrapeResult {
  followers: number | null;
  posts: RawPerfPost[];
  /**
   * Set when the account resolved but returned nothing usable, so the caller can
   * say WHY it logged "0 posts". Without this, a dead handle and a page that
   * simply hasn't posted this month look identical in the run log.
   */
  note?: string;
}

export interface PerfScrapeCtx {
  window: TimeWindow;
  maxItems: number;
  p: (msg: string) => void;
  timeoutMs?: number;
}

// ── tiny helpers (mirror lib/social.ts) ─────────────────────────
function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
function toISO(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
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
function firstNumOrNull(o: any, keys: string[]): number | null {
  for (const k of keys) { if (o?.[k] != null) { const n = numOrNull(o[k]); if (n != null) return n; } }
  return null;
}
function withinWindow(iso: string | null, window: TimeWindow): boolean {
  if (!iso) return true; // keep undated rather than silently drop
  return Date.now() - new Date(iso).getTime() <= WINDOW_DAYS[window] * 864e5;
}

/**
 * A benchmark post needs its own id and date to count. White & Co's TikTok
 * "post" on 19 Oct 2026 was the profile URL with neither, and was counted as one
 * video with no plays; an undated row can't belong to "last month" either.
 */
const countable = (id: string | null, posted: string | null) => !!id && !!posted;

/** Run an Apify actor synchronously and return its dataset items. Throws on failure. */
export async function runApify(actor: string, input: unknown, timeoutMs = 110_000): Promise<any[]> {
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
      // Keep a generous slice: Apify's input-validation errors name the fields it
      // expected, which is the fastest way to learn an actor's real schema.
      const body = (await res.text()).slice(0, 600);
      throw new Error(`HTTP ${res.status} ${body}`);
    }
    const items = await res.json();
    return Array.isArray(items) ? items : [];
  } catch (e: any) {
    if (e?.name === "AbortError" || /abort/i.test(String(e?.message))) {
      throw new Error(`timed out after ${secs}s (actor too slow — lower Items/platform or disable it)`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── handle normalization ────────────────────────────────────────
/** Strip @ / URL down to a bare username (Instagram, TikTok). */
function toUsername(handle: string): string {
  let h = handle.trim();
  const m = h.match(/(?:instagram|tiktok)\.com\/@?([^/?#]+)/i);
  if (m) h = m[1];
  return h.replace(/^@/, "").replace(/\/+$/, "");
}
/** Ensure a full Facebook page URL. */
function toFacebookUrl(handle: string): string {
  const h = handle.trim();
  if (/^https?:\/\//i.test(h)) return h;
  return `https://www.facebook.com/${h.replace(/^@/, "").replace(/\/+$/, "")}`;
}
/**
 * Normalise the stored handle to a full LinkedIn company URL, passed to the
 * actor AS-IS.
 *
 * Deliberately NOT a slug lookup. A slug makes the actor resolve a name, and a
 * name it can't resolve silently yields zero posts — indistinguishable from a
 * page that hasn't posted. An exact page URL removes that ambiguity: whatever is
 * typed in the Advanced field is what gets scraped, and it can be pasted
 * straight from the browser where it's known to load.
 *
 * The only edit is the host: LinkedIn serves the same page under every country
 * subdomain (ae./uk./de.), so those are folded to www to keep one canonical form.
 * The path is left exactly as given — including any "&", which is legal in a
 * LinkedIn universal name and must not be "cleaned up".
 */
function toLinkedInCompanyUrl(handle: string): string {
  const h = handle.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const m = h.match(/^https?:\/\/(?:[a-z]{2}\.|www\.)?linkedin\.com\/(.+)$/i);
  if (m) return `https://www.linkedin.com/${m[1]}`;
  // A bare handle: assume a company page, which is what this benchmark tracks.
  return `https://www.linkedin.com/company/${h.replace(/^@/, "")}`;
}

/**
 * Explain an empty result by reporting what the actor actually sent back.
 *
 * "0 posts" has two completely different causes and they need opposite fixes:
 * the actor returned nothing (wrong page, wrong input key, blocked), or it
 * returned rows whose field names we don't map. Guessing between them costs a
 * deploy per attempt, so the row's own keys go in the log — that names the
 * fields to map instead of leaving it to be inferred.
 */
/** Our window mapped to the LinkedIn actor's fixed postedLimit enum. */
const LINKEDIN_POSTED_LIMIT: Record<TimeWindow, string> = {
  month: "month",
  quarter: "3months",
  year: "year",
};

/**
 * Read a follower count out of LinkedIn's author byline, e.g. "137,393 followers".
 *
 * The actor exposes no numeric follower field — only this formatted string — so
 * it has to be parsed. The /follower/ guard matters: the same slot reads
 * "12 employees" or a tagline on some pages, and storing an employee count as
 * followers would silently corrupt every engagement rate computed from it.
 */
function followersFromInfo(info: unknown): number | null {
  if (typeof info !== "string" || !/follower/i.test(info)) return null;
  const m = info.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  const n = Math.round(parseFloat(m[1]) * mult);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Classify a LinkedIn post from the fields the actor actually returns. */
function linkedInType(it: any, plays: number | null): PostType {
  if (plays != null && plays > 0) return "video";
  const images = Array.isArray(it.postImages) ? it.postImages.length : 0;
  // A multi-page document (their PDF carousel) counts as a carousel, not an image.
  if (it.document?.totalPageCount > 1 || images > 1) return "carousel";
  if (images === 1 || it.document) return "image";
  return "text";
}

function emptyNote(items: any[], target: string, kept: number): string | undefined {
  if (kept > 0) return undefined;
  // Zero rows is NOT proof the page is wrong. Actors that declare no required
  // input fields drop an unrecognised key and exit 0 with an empty dataset, so a
  // schema mismatch and a dead URL look identical from out here — and Apify
  // charges for the empty query either way. Name both suspects.
  if (!items.length) return `the actor returned no rows at all for "${target}" — either the URL doesn't resolve, or this actor doesn't accept the input key we sent (it fails silently, not with an error)`;
  const keys = Object.keys(items[0] ?? {});
  const err = firstStr(items[0] ?? {}, ["error", "message", "errorMessage"]);
  if (err) return `the actor returned an error row for "${target}": ${err}`;
  return `the actor returned ${items.length} row(s) for "${target}" but none parsed as posts — fields on the first row: ${keys.slice(0, 25).join(", ") || "(none)"}`;
}

// ── mapping helpers ─────────────────────────────────────────────
function igType(raw: string | null): PostType {
  const t = (raw || "").toLowerCase();
  if (t.includes("video") || t.includes("reel") || t.includes("clip")) return "reel";
  if (t.includes("sidecar") || t.includes("carousel") || t.includes("album")) return "carousel";
  return "image";
}

// ── per-platform scrape + normalize ─────────────────────────────

async function scrapeInstagram(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  const username = toUsername(handle);
  // Profile scraper returns a profile object per username with followersCount +
  // a latestPosts[] array. We tolerate actors that instead return posts directly.
  const items = await runApify(
    actor,
    { usernames: [username], resultsLimit: ctx.maxItems, resultsType: "posts" },
    ctx.timeoutMs,
  );
  let followers: number | null = null;
  const rawPosts: any[] = [];
  for (const it of items) {
    const f = firstNumOrNull(it, ["followersCount", "followers", "ownerFollowersCount"]);
    if (f != null && followers == null) followers = f;
    if (Array.isArray(it.latestPosts)) rawPosts.push(...it.latestPosts);
    else if (Array.isArray(it.posts)) rawPosts.push(...it.posts);
    else if (it.shortCode || it.type || it.likesCount != null || it.caption != null) rawPosts.push(it);
  }
  const posts: RawPerfPost[] = [];
  for (const it of rawPosts.slice(0, ctx.maxItems)) {
    const posted = toISO(it.timestamp ?? it.taken_at_timestamp ?? it.takenAt ?? it.taken_at ?? it.date);
    const code = firstStr(it, ["shortCode", "shortcode", "code"]);
    const externalId = code ?? firstStr(it, ["id", "pk", "url"]);
    if (!countable(externalId, posted) || !withinWindow(posted, ctx.window)) continue;
    posts.push({
      external_id: externalId,
      url: code ? `https://www.instagram.com/p/${code}/` : firstStr(it, ["url"]),
      type: igType(firstStr(it, ["type", "productType", "mediaType"])),
      posted_at: posted,
      likes: firstNum(it, ["likesCount", "likes", "like_count"]),
      comments: firstNum(it, ["commentsCount", "comments", "comment_count"]),
      shares: 0,
      plays: firstNumOrNull(it, ["videoViewCount", "videoPlayCount", "playCount", "viewsCount", "views", "igPlayCount"]),
      caption: firstStr(it, ["caption", "text"]),
    });
  }
  return { followers, posts, note: emptyNote(items, username, posts.length) };
}

async function scrapeTikTok(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  const username = toUsername(handle);
  const items = await runApify(
    actor,
    { profiles: [username], resultsPerPage: ctx.maxItems, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false },
    ctx.timeoutMs,
  );
  let followers: number | null = null;
  const posts: RawPerfPost[] = [];
  for (const it of items) {
    const author = it.authorMeta ?? it.author ?? {};
    const f = firstNumOrNull(author, ["fans", "followers", "followerCount"]) ?? firstNumOrNull(it, ["fans", "followers"]);
    if (f != null && followers == null) followers = f;
    const posted = toISO(it.createTimeISO ?? it.createTime ?? it.created ?? it.uploadedAt);
    const externalId = firstStr(it, ["id", "videoId", "webVideoUrl"]);
    if (!countable(externalId, posted) || !withinWindow(posted, ctx.window)) continue;
    posts.push({
      external_id: externalId,
      url: firstStr(it, ["webVideoUrl", "url", "videoUrl"]),
      type: "video", // every TikTok post is a video
      posted_at: posted,
      likes: firstNum(it, ["diggCount", "likes", "likesCount", "hearts"]),
      comments: firstNum(it, ["commentCount", "comments", "commentsCount"]),
      shares: firstNum(it, ["shareCount", "shares"]),
      plays: firstNumOrNull(it, ["playCount", "plays", "views", "viewCount"]),
      caption: firstStr(it, ["text", "caption", "desc"]),
    });
  }
  return { followers, posts, note: emptyNote(items, username, posts.length) };
}

/**
 * Facebook page-level metadata (follower count).
 *
 * The posts scraper returns POSTS — its items carry no page follower figure at
 * all, which is why every Facebook row rendered "? followers". Page stats live
 * in a separate actor, so we pay for a second (small, one-page) run to get them.
 *
 * Returns null on any failure: a missing follower count must never fail the
 * whole account, because the posts are the more valuable half.
 */
const FB_PAGE_ACTOR = process.env.APIFY_FB_PAGE_ACTOR || "apify/facebook-pages-scraper";

async function scrapeFacebookPage(
  pageUrl: string,
  ctx: PerfScrapeCtx,
): Promise<{ followers: number | null; exists: boolean }> {
  try {
    const items = await runApify(
      FB_PAGE_ACTOR,
      { startUrls: [{ url: pageUrl }] },
      Math.min(60_000, ctx.timeoutMs ?? 60_000),
    );
    const page = items.find((it) => it && !it.error) ?? items[0];
    if (!page) return { followers: null, exists: false };
    // Prefer followers; "likes" is the older page-likes metric and runs a little
    // lower, but it beats showing nothing.
    const followers = firstNumOrNull(page, ["followers", "followersCount", "followerCount", "likes", "likesCount"]);
    return { followers, exists: true };
  } catch {
    return { followers: null, exists: false };
  }
}

async function scrapeFacebook(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  const pageUrl = toFacebookUrl(handle);
  // Both runs at once — the page scrape is small and shouldn't extend the wall
  // clock of an already-slow posts scrape.
  const [items, page] = await Promise.all([
    runApify(actor, { startUrls: [{ url: pageUrl }], resultsLimit: ctx.maxItems }, ctx.timeoutMs),
    scrapeFacebookPage(pageUrl, ctx),
  ]);
  let followers: number | null = page.followers;
  const posts: RawPerfPost[] = [];
  for (const it of items) {
    const f =
      firstNumOrNull(it, ["pageFollowers", "followers", "followersCount", "pageLikes", "likes_count"]) ??
      firstNumOrNull(it.pageInfo ?? {}, ["followers", "likes"]);
    if (f != null && followers == null) followers = f;
    const posted = toISO(it.time ?? it.timestamp ?? it.date ?? it.publishedTime ?? it.createdTime);
    const externalId = firstStr(it, ["postId", "id", "url", "postUrl", "facebookUrl"]);
    if (!countable(externalId, posted) || !withinWindow(posted, ctx.window)) continue;
    const plays = firstNumOrNull(it, ["videoViewCount", "viewsCount", "videoViews", "views"]);
    posts.push({
      external_id: externalId,
      url: firstStr(it, ["url", "postUrl", "facebookUrl", "topLevelUrl"]),
      type: plays != null && plays > 0 ? "video" : "image",
      posted_at: posted,
      likes: firstNum(it, ["likes", "likesCount", "reactionsCount", "reactions"]),
      comments: firstNum(it, ["comments", "commentsCount"]),
      shares: firstNum(it, ["shares", "sharesCount"]),
      plays,
      caption: firstStr(it, ["text", "message", "postText", "caption"]),
    });
  }
  // Distinguish the three ways Facebook can give us nothing.
  let note: string | undefined;
  if (!posts.length) {
    if (!page.exists && !items.length) note = "page not reachable — check the URL is the public page";
    else if (!items.length) note = "page found but the posts scraper returned nothing (often a login wall)";
    else note = `page found, ${items.length} post(s) fetched but none inside the window`;
  }
  return { followers, posts, note };
}

async function scrapeLinkedIn(actor: string, handle: string, ctx: PerfScrapeCtx): Promise<PerfScrapeResult> {
  // `companies` with a full page URL, NOT `searchQueries`. The old input ran a
  // KEYWORD SEARCH across all of LinkedIn, so it returned whatever posts
  // happened to mention the brand — anyone's posts, not the company's. Every
  // brand came back with exactly maxItems posts and no follower count, which is
  // the signature of that bug.
  //
  // A company-posts actor takes the page URL and returns that page's own posts
  // plus the company profile (which carries the follower count).
  const company = toLinkedInCompanyUrl(handle);
  const items = await runApify(
    actor,
    {
      // `targetUrls` — verified against the actor's own input schema. Note it
      // declares NO required array, so a wrong key is silently dropped and the
      // run SUCCEEDS with zero rows: no validation error to read, and Apify
      // still bills for the empty query. That is why three guessed key names
      // (companies / companyUrls / startUrls) each looked like a dead page.
      targetUrls: [company],
      maxPosts: ctx.maxItems, // per URL; 0 would mean "all"
      // Server-side window, so we don't pay per post for rows withinWindow()
      // would throw away. Enum values are fixed by the schema.
      postedLimit: LINKEDIN_POSTED_LIMIT[ctx.window],
      includeReposts: false, // a repost isn't the brand's own content
      includeQuotePosts: true,
    },
    ctx.timeoutMs,
  );
  let followers: number | null = null;
  const posts: RawPerfPost[] = [];
  for (const it of items) {
    // Followers is a FORMATTED STRING on the post's author ("137,393 followers"),
    // not a number anywhere — every numeric lookup missed it. It repeats on every
    // row, so the first parse wins.
    if (followers == null) followers = followersFromInfo(it.author?.info);
    const content = firstStr(it, ["content", "text", "postContent", "description"]);
    if (!content) continue;
    const posted = toISO(it.postedAt?.date ?? it.postedAtISO ?? it.date ?? it.time ?? it.publishedAt);
    const externalId = firstStr(it, ["id", "entityId", "shareUrn", "urn", "linkedinUrl"]);
    if (!countable(externalId, posted) || !withinWindow(posted, ctx.window)) continue;
    const plays = firstNumOrNull(it, ["videoViewCount", "views", "impressions"]);
    posts.push({
      external_id: externalId,
      url: firstStr(it, ["linkedinUrl", "url", "postUrl"]),
      type: linkedInType(it, plays),
      posted_at: posted,
      // engagement.* is authoritative and read with ?? so a genuine 0 isn't
      // treated as missing. The fallbacks deliberately exclude top-level
      // `comments` and `reactions`: on this actor those are ARRAYS of comment and
      // reaction objects, not counts, and Number([...]) would quietly yield 0 or
      // a nonsense figure.
      likes: firstNumOrNull(it.engagement ?? {}, ["likes"]) ?? firstNum(it, ["numLikes", "likesCount", "reactionsCount"]),
      comments: firstNumOrNull(it.engagement ?? {}, ["comments"]) ?? firstNum(it, ["numComments", "commentsCount"]),
      shares: firstNumOrNull(it.engagement ?? {}, ["shares"]) ?? firstNum(it, ["sharesCount", "reposts"]),
      plays,
      caption: content,
    });
  }
  return { followers, posts, note: emptyNote(items, company, posts.length) };
}

const SCRAPERS: Record<PerfPlatform, (actor: string, handle: string, ctx: PerfScrapeCtx) => Promise<PerfScrapeResult>> = {
  instagram: scrapeInstagram,
  tiktok: scrapeTikTok,
  facebook: scrapeFacebook,
  linkedin: scrapeLinkedIn,
};

export async function scrapePerfAccount(
  platform: PerfPlatform,
  actor: string,
  handle: string,
  ctx: PerfScrapeCtx,
): Promise<PerfScrapeResult> {
  return SCRAPERS[platform](actor, handle, ctx);
}
