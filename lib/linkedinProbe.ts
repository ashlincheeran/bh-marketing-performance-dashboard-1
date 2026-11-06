/**
 * Find a LinkedIn actor that actually returns a company's posts.
 *
 * Why this exists: the LinkedIn scrape has been guessed at three times and got
 * it wrong three times, because an actor's real input schema can't be read from
 * outside — and the environment this repo is developed in has apify.com blocked
 * by network policy, so no actor can be tried there. The deployment CAN reach
 * Apify, so the search runs here instead: hit /api/perf/probe and it tries each
 * candidate against a real company page and reports what came back.
 *
 * A FAILED attempt is useful too. Apify rejects bad input with an error naming
 * the fields it expected, so a validation failure reveals the schema — which is
 * why every attempt's error text is reported rather than swallowed.
 *
 * Actor ids below are only ones seen as real Apify store URLs; none are invented.
 */
import { errorMessage } from "@/lib/coerce";
import { runApify } from "@/lib/socialPerf";

export interface ProbeAttempt {
  label: string;
  actor: string;
  input: Record<string, unknown>;
  ok: boolean;
  rows: number;
  /** Rows that look like a post: some text plus at least one engagement number. */
  postish: number;
  followers: number | null;
  firstRowKeys: string[];
  sample: string | null;
  error: string | null;
  ms: number;
}

/** Does this row look like a real post rather than a profile stub or error? */
function looksLikePost(o: any): boolean {
  if (!o || typeof o !== "object") return false;
  const text = o.text ?? o.content ?? o.postContent ?? o.description ?? o.message ?? o.commentary;
  if (typeof text !== "string" || !text.trim()) return false;
  const eng = [
    o.likes, o.reactions, o.numLikes, o.reactionsCount, o.likesCount,
    o.comments, o.numComments, o.commentsCount,
    o.engagement?.likes, o.engagement?.reactions, o.engagement?.comments,
  ];
  return eng.some((v) => typeof v === "number");
}

function findFollowers(rows: any[]): number | null {
  const keys = ["followers", "followerCount", "followersCount", "companyFollowers", "numFollowers"];
  for (const r of rows) {
    for (const holder of [r, r?.company, r?.companyProfile, r?.author, r?.profile]) {
      if (!holder || typeof holder !== "object") continue;
      for (const k of keys) {
        const v = holder[k];
        if (typeof v === "number" && v > 0) return v;
      }
    }
  }
  return null;
}

/**
 * Candidate (actor, input) pairs, cheapest and most likely first.
 *
 * Both a full URL and a bare slug are tried for the same actor, because which
 * one an actor accepts is exactly the sort of thing that can't be known without
 * running it.
 */
function candidates(url: string, slug: string, maxPosts: number): { label: string; actor: string; input: Record<string, unknown> }[] {
  return [
    { label: "company-posts · companies[url]", actor: "harvestapi/linkedin-company-posts", input: { companies: [url], maxPosts } },
    { label: "company-posts · companies[slug]", actor: "harvestapi/linkedin-company-posts", input: { companies: [slug], maxPosts } },
    { label: "company-posts · companyUrls[url]", actor: "harvestapi/linkedin-company-posts", input: { companyUrls: [url], maxPosts } },
    { label: "company-posts · startUrls[url]", actor: "harvestapi/linkedin-company-posts", input: { startUrls: [{ url }], maxPosts } },
    // The actor already installed — it can filter a search down to one author.
    { label: "post-search · authorsCompanies[url]", actor: "harvestapi/linkedin-post-search", input: { authorsCompanies: [url], maxPosts } },
    { label: "post-search · authorsCompanies[slug]", actor: "harvestapi/linkedin-post-search", input: { authorsCompanies: [slug], maxPosts } },
    { label: "unseenuser · companies[url]", actor: "unseenuser/company-posts", input: { companies: [url], maxPosts } },
    { label: "unseenuser · startUrls[url]", actor: "unseenuser/company-posts", input: { startUrls: [{ url }], maxPosts } },
    { label: "calm_builder · startUrls[url]", actor: "calm_builder/linkedin-company-scraper", input: { startUrls: [{ url }], maxPosts } },
    { label: "calm_builder · companyUrls[url]", actor: "calm_builder/linkedin-company-scraper", input: { companyUrls: [url], maxPosts } },
  ];
}

/**
 * Try candidates in order until one returns post-shaped rows.
 *
 * Serial on purpose: Apify caps total memory across simultaneous runs and
 * answers 402 past it, and a probe that trips that limit would report failures
 * that are really just contention.
 */
export async function probeLinkedIn(
  url: string,
  slug: string,
  opts: { maxPosts?: number; perAttemptMs?: number; budgetMs?: number } = {},
): Promise<{ attempts: ProbeAttempt[]; winner: ProbeAttempt | null }> {
  const maxPosts = opts.maxPosts ?? 5; // small: this is a schema hunt, not a data pull
  const perAttemptMs = opts.perAttemptMs ?? 45_000;
  const budgetMs = opts.budgetMs ?? 240_000;
  const t0 = Date.now();

  const attempts: ProbeAttempt[] = [];
  let winner: ProbeAttempt | null = null;

  for (const c of candidates(url, slug, maxPosts)) {
    if (Date.now() - t0 > budgetMs - 10_000) break;
    const started = Date.now();
    try {
      const rows = await runApify(c.actor, c.input, perAttemptMs);
      const postish = rows.filter(looksLikePost).length;
      const a: ProbeAttempt = {
        ...c,
        ok: true,
        rows: rows.length,
        postish,
        followers: findFollowers(rows),
        firstRowKeys: Object.keys(rows[0] ?? {}).slice(0, 30),
        sample: postish ? JSON.stringify(rows.find(looksLikePost)).slice(0, 400) : null,
        error: null,
        ms: Date.now() - started,
      };
      attempts.push(a);
      if (postish > 0) {
        winner = a;
        break;
      }
    } catch (e) {
      attempts.push({
        ...c,
        ok: false,
        rows: 0,
        postish: 0,
        followers: null,
        firstRowKeys: [],
        sample: null,
        error: errorMessage(e),
        ms: Date.now() - started,
      });
    }
  }

  return { attempts, winner };
}
