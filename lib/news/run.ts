// The news bot's runner (docs/news-pipeline.md, "Steps"): what each step does,
// and how the steps follow one another as a chain of short links. Server-only.
//
// A link is one step run by /api/news. It claims work for up to 200 seconds,
// saves where it got to, and hands the next link back to the route, so no call
// comes near the 300-second function limit however long the morning is. What a
// step claims it finishes or gives back, and every link leaves a news_runs row,
// so a chain that breaks off loses nothing: whatever is still waiting is there
// for the next run.
//
// With counting off in Settings (test mode) the check step holds its
// decisions instead of writing them to mentions, and the publish step writes
// them once counting is on again. A chain that ends refreshes the PR insights.
//
// A person's Keep or Reject on Bot Activity wins over a run that holds the
// article. A step saves an article only while it still holds it (the claim,
// or for publish the held status), looks again just before it writes to
// mentions, and takes back what it wrote if a person's Reject landed in
// between.
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { headers } from "next/headers";
import { adminClient } from "@/lib/supabase";
import { getNewsSettings } from "@/lib/appSettings";
import { claudeConfigured, type AiFailure } from "@/lib/claude";
import { safeEqual } from "@/lib/gate";
import { notify } from "@/lib/notify";
import { classifyArticle } from "@/lib/news/classify";
import { RECHECK_KINDS, isRecheckKind, requeueForRecheck, seedFromMentions, type RecheckKind } from "@/lib/news/migrate";
import { namesOnly, ownSiteDecision, ownSiteIn, ownSiteReason, withoutOwnSite } from "@/lib/news/ownSite";
import { readArticle, type ReadOptions } from "@/lib/news/read";
import { loadRegistry } from "@/lib/news/registry";
import { buildQueries, headlineSkip, runSearches, type SearchQuery } from "@/lib/news/search";
import { spotNames } from "@/lib/news/spot";
import {
  articleState,
  claim,
  dubaiDay,
  finishRun,
  heldArticles,
  importedDuplicates,
  insertFound,
  noteRunEnding,
  release,
  requeueDueUnreadable,
  saveArticle,
  saveResolvedUrl,
  startRun,
  waiting,
  type ArticleState,
  type SaveGuard,
} from "@/lib/news/store";
import {
  loadOutlets,
  markPersonRejected,
  withdrawLegacyRow,
  withdrawLegacyRows,
  writeDecision,
  type OutletRef,
  type SameStory,
  type WriteCounts,
} from "@/lib/news/write";
import type {
  ArticleRow,
  ArticleStatus,
  Candidate,
  Decision,
  FoundItem,
  NewsSettings,
  ReadResult,
  Registry,
  SpotResult,
  StepCounts,
  StepResult,
} from "@/lib/news/types";

/** The steps a chain is made of. */
export type ChainStep = "search" | "read" | "check" | "publish";
/** Everything /api/news can run: the chain's steps, and the one-off moves from the old bot. */
export type RouteStep = ChainStep | "seed" | "recheck";
/** Where a chain may be started from outside it: a morning's run, publishing what test mode held, and the moves from the old bot. */
export type StartStep = "search" | "publish" | "seed" | "recheck";
export type RunTrigger = "cron" | "manual";

export const ROUTE_STEPS: readonly RouteStep[] = ["search", "read", "check", "publish", "seed", "recheck"];
export const START_STEPS: readonly StartStep[] = ["search", "publish", "seed", "recheck"];

/** How long a real step claims new work. Work already claimed is then finished. */
export const STEP_BUDGET_MS = 200_000;
/** The most links one run makes, so a chain can never run on for ever. */
export const MAX_LINKS = 40;

/** The searches' share of the search step. */
const SEARCH_BUDGET_MS = 120_000;
const READ_BATCH = 8;
const READ_CONCURRENCY = 4;
const CHECK_BATCH = 6;
const CHECK_CONCURRENCY = 3;
/** Held articles the publish step reads at a time, oldest first, and writes four at a time. */
const PUBLISH_PAGE = 20;
const PUBLISH_CONCURRENCY = 4;
/** An article that could not be read is tried again after this, on a later morning. */
export const UNREADABLE_RETRY_MS = 20 * 60 * 60_000;
/** An article the AI failed on this many times waits for a person. */
export const MAX_AI_ATTEMPTS = 3;
/**
 * An article the AI failed on is not claimed again until this has passed, so
 * one run never asks about it twice in a row. Without it the next claim of
 * the same step would hand the same article straight back, and a minute of
 * trouble at Anthropic would use up all three of its tries.
 */
export const AI_RETRY_MS = 60 * 60_000;
/**
 * How long past its budget a step waits for the work it already claimed. A
 * page read is bounded by its timeouts and a Claude call by the SDK's, so this
 * is a backstop: with the 20-second hand-off and the saves around it, it keeps
 * a link inside 300 seconds, and anything still running then is given back by
 * the claim's lease.
 */
export const FINISH_GRACE_MS = 45_000;
/**
 * An Apify read can take two or three minutes (a quick crawler, then a real
 * browser), and lib/apify.ts can't be cut short, so one starts only while at
 * least this much of the step's budget is left. Started later, it would run on
 * past the grace and the hand-off, and past the function's 300 seconds.
 */
const APIFY_MIN_LEFT_MS = 150_000;
/** How long the hand-off waits for the next link to say it has started. */
const HAND_OFF_TIMEOUT_MS = 20_000;
/** The most the PR insights may take to refresh at the end of a chain. */
export const INSIGHTS_TIMEOUT_MS = 60_000;
/** Less time than this left in the function, and the insights are not started: one Claude call needs about that. */
const INSIGHTS_MIN_MS = 15_000;
/** The link's function stops at 300 seconds; nothing runs past this, which leaves a margin. */
const LINK_LIMIT_MS = 290_000;

const NO_CLAUDE_KEY = "no Claude key (ANTHROPIC_API_KEY)";

/** What the publish step logs when it is run while counting is still off. */
export const COUNTING_OFF = "counting on the PR tab is switched off (test mode), so no held article was published";

/**
 * The start of the note a person's Reject on Bot Activity leaves on an article
 * (lib/data.ts). Their verdict stands over the bot's: nothing of the article is
 * written to mentions after it.
 */
const PERSON_REJECTED = "rejected by a person";
/** The start of the note a person's Keep leaves (lib/data.ts). Their row stands, and so does the note. */
const PERSON_KEPT = "kept by a person";

const noteStart = (a: Pick<ArticleRow, "note">) => (a.note ?? "").trim().toLowerCase();

/** True when a person rejected the article on Bot Activity. */
export const rejectedByPerson = (a: Pick<ArticleRow, "note">) => noteStart(a).startsWith(PERSON_REJECTED);

/** True when the note is a person's Keep or Reject, which no step writes over. */
export const personsNote = (a: Pick<ArticleRow, "note">) => rejectedByPerson(a) || noteStart(a).startsWith(PERSON_KEPT);

/**
 * A read's patch for an article as it is now: without the read's own note when
 * the article carries a person's, so their Keep or Reject stays on record
 * where Bot Activity and the re-checks look for it.
 */
export function keepPersonsNote(patch: Partial<ArticleRow>, now: Pick<ArticleRow, "note">): Partial<ArticleRow> {
  if (!personsNote(now)) return patch;
  const out = { ...patch };
  delete out.note;
  return out;
}

/**
 * What a step logs in news_runs.counts: the shared StepCounts, and a few of
 * the runner's own, which Bot Activity does not add up.
 */
export interface RunCounts extends StepCounts {
  /** Mentions rows new to the table, written by a check or the publish step: the summary's "inserted". */
  added?: number;
  /** The old bot's rows taken out of the count as the same story as another article. */
  withdrawn?: number;
  /** Old rows marked as rejected by a person before a re-check (lib/news/migrate.ts). */
  markedRejected?: number;
  /** What a seed stored, and what it found stored already. */
  seeded?: number;
  alreadyStored?: number;
  /** Old rows the seed stored as duplicates of another imported article: the old bot had stored the story twice. */
  twins?: number;
  /** Stored address keys the seed brought up to the current rule. */
  rekeyed?: number;
}

/** What a link of the chain comes to: the step's result, and where the check sends the chain. */
export interface LinkResult extends StepResult {
  counts: RunCounts;
  /** Counting is on, yet held articles wait: the chain publishes them before it ends. */
  publishNext?: boolean;
}

/** What a step is told about its run. */
export interface StepContext {
  runId: string;
  link: number;
  trigger: string;
  budgetMs: number;
}

/** One link of a run, as /api/news is asked to run it. */
export interface LinkRequest {
  step: RouteStep;
  runId: string;
  /** 0 for the first link, counting up along the chain. */
  link: number;
  trigger: RunTrigger;
  /** Which imported stories a recheck sends back through the bot. */
  kind?: RecheckKind;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A run's id: "nr", when it started (UTC, to the second), and a random part so two runs started together differ. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `nr${stamp}-${randomUUID().slice(0, 8)}`;
}

/** The first link of a new run: a morning's search, unless another start is asked for. */
export function firstLink(trigger: RunTrigger, step: StartStep = "search", kind?: RecheckKind): LinkRequest {
  const link: LinkRequest = { step, runId: newRunId(), link: 0, trigger };
  if (step === "recheck" && kind) link.kind = kind;
  return link;
}

// ─── The pure parts ─────────────────────────────────────────────────────────

/** Where a chain goes after a link: another link, the run's summary, or nowhere (the seed is not a run). */
export type Move = { kind: "link"; step: ChainStep; link: number } | { kind: "summary"; note?: string } | { kind: "none" };

/**
 * The next link after this one. Search always goes on to read. Read runs again
 * while articles are queued, then goes to check. Check runs again while
 * articles wait, then the run is summed up, unless counting is on and held
 * articles still wait (publishNext), which are published first. Publish runs
 * again while held articles wait, then the run is summed up. A step that
 * failed, or an AI that can't answer, ends the run there; what is left waits
 * for the next run. No run makes more than `maxLinks` links.
 */
export function nextMove(
  step: RouteStep,
  result: Pick<LinkResult, "more" | "aiError" | "error" | "publishNext">,
  link: number,
  maxLinks = MAX_LINKS,
): Move {
  if (step === "seed") return { kind: "none" };
  if (result.error) return { kind: "summary" };
  let next: ChainStep | null;
  if (step === "search" || step === "recheck") next = "read";
  else if (step === "read") next = result.more ? "read" : "check";
  else if (step === "check") next = result.aiError ? null : result.more ? "check" : result.publishNext ? "publish" : null;
  else next = result.more ? "publish" : null;
  if (!next) return { kind: "summary" };
  if (link + 1 >= maxLinks) return { kind: "summary", note: `stopped after ${maxLinks} links with work still waiting, which the next run picks up` };
  return { kind: "link", step: next, link: link + 1 };
}

/** The first day of this Dubai month and of the next, YYYY-MM-DD, since news_runs.run_day is a Dubai day. */
export function dubaiMonth(now = new Date()): { first: string; next: string } {
  const [year, month] = dubaiDay(now).split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    first: `${year}-${pad(month)}-01`,
    next: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`,
  };
}

const whole = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** The Apify reads recorded in news_runs rows. */
export function apifyReadsIn(rows: { counts: unknown }[]): number {
  return rows.reduce((sum, r) => sum + whole((r.counts as StepCounts | null)?.apifyReads), 0);
}

/** True while one more Apify read keeps this calendar month within the cap Settings gives. */
export function apifyWithinCap(usedThisMonth: number, usedThisStep: number, cap: number): boolean {
  return usedThisMonth + usedThisStep < cap;
}

/**
 * The companies the article names, for the check: the candidates' companies
 * taken together. The full text is not stored, so this is all the check step
 * can know, and a name past the spotter's cap of candidates is not in it.
 */
export function companiesNamedIn(candidates: Candidate[] | null | undefined): string[] {
  return [...new Set((candidates ?? []).flatMap((c) => c.companies ?? []))];
}

/**
 * What one read comes to (docs/news-pipeline.md, read step 4): names found,
 * read, with the candidates; read in full and nobody named, no_names; anything
 * else unreadable, to be tried again on a later morning. read_attempts counts
 * every read, so after the third failed one the article stays unreadable. The
 * note says how the read went, which Bot Activity gives as the reason.
 */
export function readOutcome(
  article: Pick<ArticleRow, "read_attempts">,
  result: ReadResult,
  spot: Pick<SpotResult, "candidates">,
  now: Date,
): { status: "read" | "no_names" | "unreadable"; patch: Partial<ArticleRow> } {
  const base: Partial<ArticleRow> = {
    body_status: result.status,
    body_chars: result.text.length,
    read_via: result.via,
    read_attempts: (article.read_attempts ?? 0) + 1,
    note: result.note ?? null,
    error: null,
  };
  if (spot.candidates.length) {
    return { status: "read", patch: { ...base, status: "read", candidates: spot.candidates, next_try_at: null } };
  }
  if (result.status === "ok") {
    const note = `read in full${result.note ? ` (${result.note})` : ""}, and it names no tracked company or person`;
    return { status: "no_names", patch: { ...base, note, status: "no_names", candidates: [], next_try_at: null } };
  }
  const retryAt = new Date(now.getTime() + UNREADABLE_RETRY_MS).toISOString();
  return { status: "unreadable", patch: { ...base, status: "unreadable", candidates: [], next_try_at: retryAt } };
}

/** The decision for an article whose headline or outlet names another company with our name in it: no AI was asked. */
export function headlineDecision(reason: string, checkedAt: string): Decision {
  return {
    mentions: [],
    irrelevantReason: `the headline names ${reason}`,
    possibleMoves: [],
    dropped: [],
    model: "none: ruled out by its headline",
    checkedAt,
  };
}

/** The decision for an article read in full that names nobody we track: no AI was asked. */
export function noNamesDecision(checkedAt: string): Decision {
  return {
    mentions: [],
    irrelevantReason: "it was read in full and names no tracked company or person",
    possibleMoves: [],
    dropped: [],
    model: "none: read in full, no names",
    checkedAt,
  };
}

/**
 * An article the AI could not sort, or whose check broke: back to read with
 * the reason, not to be claimed again for AI_RETRY_MS, or failed after its
 * third try, for a person to look at.
 */
export function aiFailurePatch(article: Pick<ArticleRow, "ai_attempts">, message: string, now: Date): Partial<ArticleRow> {
  const attempts = (article.ai_attempts ?? 0) + 1;
  if (attempts >= MAX_AI_ATTEMPTS) return { status: "failed", ai_attempts: attempts, error: message };
  return { status: "read", ai_attempts: attempts, error: message, next_try_at: new Date(now.getTime() + AI_RETRY_MS).toISOString() };
}

/** A step's news_runs row, as the summary reads it. */
export interface RunLogRow {
  step: string;
  ok: boolean | null;
  counts: RunCounts | null;
  error: string | null;
}

/** The ingest_runs row a run ends with: what Bot Activity and Settings show as the bot's last run. */
export interface RunSummary {
  trigger: string;
  ok: boolean;
  found: number;
  considered: number;
  inserted: number;
  skipped: number;
  error: string | null;
}

/** How a chain ended, when it was not by running out of work. */
export interface Ending {
  error: string;
  /** True when the run was cut short by a fault, rather than by the link limit. */
  failed: boolean;
}

/**
 * A run's summary from its steps' rows: found is the new articles the searches
 * stored, considered the articles read that name someone, inserted the
 * mentions rows new to the table that the checks and the publish step added
 * (a row brought up to date, such as the old bot's row of a re-checked story,
 * is not new coverage), skipped what was turned down (rejected by the AI, or
 * naming nobody). Each figure comes from its own step, so a seed or a
 * re-check in the same run can't be counted as found. The error is the
 * check's (the AI failing), else the first step's that failed, else how the
 * chain ended.
 */
export function summariseRun(rows: RunLogRow[], trigger: string, ending: Ending | null = null): RunSummary {
  const total = (step: string, ...fields: (keyof RunCounts)[]) =>
    rows.filter((r) => r.step === step).reduce((n, r) => n + fields.reduce((m, f) => m + whole(r.counts?.[f]), 0), 0);
  const failed = rows.filter((r) => r.ok === false);
  const error =
    failed.find((r) => r.step === "check" && r.error)?.error ?? failed.find((r) => r.error)?.error ?? ending?.error ?? null;
  return {
    trigger,
    ok: failed.length === 0 && !ending?.failed,
    found: total("search", "fresh"),
    considered: total("read", "read"),
    inserted: total("check", "added") + total("publish", "added"),
    skipped: total("check", "rejected") + total("read", "noNames"),
    error,
  };
}

/** A run id as it may appear in the address: what newRunId makes, or anything as tame. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One link as /api/news's query asks for it, or why the query is wrong.
 * `fallbackTrigger` is the trigger when the query names none: a chain's own
 * hand-offs always name theirs.
 */
export function parseLinkRequest(
  params: URLSearchParams,
  fallbackTrigger: RunTrigger,
  makeRunId: () => string = newRunId,
): LinkRequest | { error: string } {
  const step = params.get("step") ?? "";
  if (!(ROUTE_STEPS as readonly string[]).includes(step)) return { error: `step must be one of ${ROUTE_STEPS.join(", ")}` };
  const run = params.get("run");
  if (run !== null && !RUN_ID.test(run)) return { error: "run must be a run id: letters, digits, - and _ only" };
  const rawLink = params.get("link");
  if (rawLink !== null && rawLink !== "" && !/^\d{1,3}$/.test(rawLink)) return { error: "link must be a whole number" };
  const link = rawLink ? Number(rawLink) : 0;
  if (link >= MAX_LINKS) return { error: `a run makes at most ${MAX_LINKS} links, so link must be below ${MAX_LINKS}` };
  const trigger = params.get("trigger");
  if (trigger !== null && trigger !== "cron" && trigger !== "manual") return { error: "trigger must be cron or manual" };
  const kind = params.get("kind");
  if (step === "recheck" && !isRecheckKind(kind)) return { error: `a recheck needs kind=${RECHECK_KINDS.join(", kind=")}` };
  const request: LinkRequest = {
    step: step as RouteStep,
    runId: run ?? makeRunId(),
    link,
    trigger: (trigger as RunTrigger | null) ?? fallbackTrigger,
  };
  if (step === "recheck") request.kind = kind as RecheckKind;
  return request;
}

/** True when the request carries the cron secret, as Vercel's scheduler and the chain's hand-offs send it. */
export function isCronRequest(h: { get(name: string): string | null }, secret = process.env.CRON_SECRET): boolean {
  return !!secret && safeEqual(h.get("authorization") ?? "", `Bearer ${secret}`);
}

/**
 * Where the next link is sent. In production, the project's public domain
 * (VERCEL_PROJECT_PRODUCTION_URL, which Vercel gives without the https://):
 * a deployment's own address sits behind Vercel's login, and the domain the
 * public uses does not. Anywhere else, or when that is not set, the address
 * the request came in on.
 */
export function handOffOrigin(requestOrigin: string | null, env: Record<string, string | undefined> = process.env): string | null {
  const domain = env.VERCEL_ENV === "production" ? env.VERCEL_PROJECT_PRODUCTION_URL?.trim() : "";
  if (domain) {
    try {
      return new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).origin;
    } catch {
      // Not a domain after all: the request's own address still works.
    }
  }
  return requestOrigin;
}

/**
 * The request for the next link: a POST to /api/news (at handOffOrigin) with
 * the cron secret. Preview addresses sit behind Vercel's login, so the
 * protection bypass goes along whenever the deployment has one.
 */
export function handOffRequest(
  requestOrigin: string | null,
  next: { step: RouteStep; link: number },
  run: { runId: string; trigger: RunTrigger; kind?: RecheckKind },
  env: Record<string, string | undefined> = process.env,
): { url: string; headers: Record<string, string> } | { error: string } {
  const secret = env.CRON_SECRET;
  if (!secret) return { error: "CRON_SECRET is not set, so the next step cannot be called" };
  const origin = handOffOrigin(requestOrigin, env);
  if (!origin) return { error: "this deployment's address is not known" };
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return { error: `${origin} is not a web address` };
  }
  if (!/^https?:$/.test(base.protocol)) return { error: `${origin} is not a web address` };
  const query = new URLSearchParams({ step: next.step, run: run.runId, link: String(next.link), trigger: run.trigger });
  if (next.step === "recheck" && run.kind) query.set("kind", run.kind);
  const out: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) out["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return { url: `${base.origin}/api/news?${query}`, headers: out };
}

const firstOf = (v: string | null) => v?.split(",")[0]?.trim() || null;

/**
 * This deployment's address, from the request a server action is answering:
 * the host the browser used, which is also the one Vercel routes to this
 * deployment.
 */
export function originFromHeaders(h: { get(name: string): string | null }): string | null {
  const host = firstOf(h.get("x-forwarded-host")) ?? firstOf(h.get("host"));
  if (!host) return null;
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const proto = firstOf(h.get("x-forwarded-proto")) ?? (local ? "http" : "https");
  if (proto !== "http" && proto !== "https") return null;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/** A pool of work over a list, and a way to take back what it has not started. */
export interface Pool<T> {
  /** Settles once every lane has stopped. */
  done: Promise<void>;
  /** Takes the items not yet started out of the pool, so none of them starts later. */
  drain(): T[];
}

/**
 * Work through `items`, `concurrency` at a time, starting each only while
 * `keepGoing()` holds. `work` must not throw: each step catches its own
 * failures per article, so one bad article never stops the rest.
 */
export function startPool<T>(items: T[], concurrency: number, keepGoing: () => boolean, work: (item: T) => Promise<void>): Pool<T> {
  const queue = [...items];
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, queue.length));
  const lane = async () => {
    while (queue.length && keepGoing()) await work(queue.shift() as T);
  };
  const done = Promise.all(Array.from({ length: lanes }, lane)).then(() => undefined);
  return { done, drain: () => queue.splice(0) };
}

/**
 * What `p` came to within `ms`, or that it was still running then. It carries
 * on unobserved, and a failure after that can no longer reach anyone.
 */
async function within<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: true; error: unknown } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        (value) => ({ done: true as const, value }),
        (error: unknown) => ({ done: true as const, error }),
      ),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True if `p` settles within `ms`, false if it is still running then (it carries on, unobserved). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return (await within(p, ms)).done;
}

// ─── The steps ──────────────────────────────────────────────────────────────

/**
 * Everything the steps reach outside this module. The real ones are the
 * default; tests hand in stand-ins, so the steps run without a database, the
 * web or Claude.
 */
export interface StepDeps {
  claim: (from: ArticleStatus, to: ArticleStatus, limit: number, runId: string) => Promise<ArticleRow[]>;
  /** Save an article while the guard still holds; false when it no longer does (lib/news/store.ts saveArticle). */
  saveArticle: (id: string, patch: Partial<ArticleRow>, guard: SaveGuard) => Promise<boolean>;
  /** Save the unwrapped address while `runId` holds the article; `lost` when it no longer does. */
  saveResolvedUrl: (id: string, url: string | null, runId: string) => Promise<{ duplicateOf: string | null; lost?: true }>;
  /** Put back the ones of these articles `runId` still holds. */
  release: (ids: string[], status: ArticleStatus, error: string | null, runId: string) => Promise<void>;
  /** An article's status, claim and note as they are now, read just before a step writes. */
  articleState: (id: string) => Promise<ArticleState | null>;
  /** Take an article's rows out of the count as a person's Reject (lib/news/write.ts markPersonRejected). */
  markPersonRejected: (article: ArticleRow, reg: Registry) => Promise<number>;
  waiting: (status: ArticleStatus) => Promise<number>;
  requeueDueUnreadable: () => Promise<number>;
  insertFound: (items: FoundItem[]) => Promise<{ fresh: number; repeats: number; skipped: number }>;
  startRun: (step: string, runId: string, link: number, trigger: string) => Promise<number | null>;
  finishRun: (logId: number | null, ok: boolean, counts: StepCounts, error?: string | null) => Promise<void>;
  loadRegistry: () => Promise<Registry>;
  loadOutlets: () => Promise<OutletRef[]>;
  prKeywords: () => Promise<string[]>;
  newsSettings: () => Promise<NewsSettings>;
  search: (queries: SearchQuery[], budgetMs: number) => Promise<{ items: FoundItem[]; failures: { query: string; error: string }[] }>;
  readArticle: (input: { googleLink: string | null; url: string | null }, opts: ReadOptions) => Promise<ReadResult>;
  classifyArticle: typeof classifyArticle;
  writeDecision: (
    article: ArticleRow,
    decision: Decision,
    reg: Registry,
    outlets: OutletRef[],
  ) => Promise<Pick<WriteCounts, "ours" | "rivals" | "added">>;
  /** Take an imported duplicate's old row out of the count; true when it was counting. */
  withdrawLegacyRow: (article: ArticleRow, ownerId: string) => Promise<boolean>;
  /** The same for many at once, skipping the rows already withdrawn. */
  withdrawLegacyRows: (stories: SameStory[]) => Promise<{ withdrawn: number; personDecided: number }>;
  /** Held articles, oldest first. */
  heldArticles: (offset: number, limit: number) => Promise<ArticleRow[]>;
  /** Every imported article stored as a duplicate of another. */
  importedDuplicates: () => Promise<SameStory[]>;
  /** Import any old bot's rows stored since the last import (lib/news/migrate.ts seedFromMentions). */
  importLateRows: () => Promise<{ seeded: number; twins: number }>;
  claudeConfigured: () => boolean;
  /** Apify reads recorded this Dubai month by finished read steps. */
  apifyReadsThisMonth: () => Promise<number>;
  now: () => number;
}

function db() {
  const c = adminClient();
  if (!c) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return c;
}

/** The active PR keywords, oldest first. A failed read throws, so no run searches with an empty list by mistake. */
async function loadPrKeywords(): Promise<string[]> {
  const { data, error } = await db()
    .from("tracked_keywords")
    .select("query")
    .eq("kind", "pr")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`the PR keywords could not be read: ${error.message}`);
  return (data ?? []).map((r) => String(r.query ?? "").trim()).filter(Boolean);
}

/** This month's Apify reads, from the read steps' rows. Paged, since a busy month passes 1,000 rows. */
async function apifyReadsThisMonth(): Promise<number> {
  const { first, next } = dubaiMonth();
  const PAGE = 1000;
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db()
      .from("news_runs")
      .select("counts")
      .eq("step", "read")
      .gte("run_day", first)
      .lt("run_day", next)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`this month's Apify reads could not be counted: ${error.message}`);
    total += apifyReadsIn(data ?? []);
    if (!data || data.length < PAGE) return total;
  }
}

const REAL_DEPS: StepDeps = {
  claim,
  saveArticle: (id, patch, guard) => saveArticle(id, patch, guard),
  saveResolvedUrl: (id, url, runId) => saveResolvedUrl(id, url, runId),
  release: (ids, status, error, runId) => release(ids, status, error, runId),
  articleState: (id) => articleState(id),
  markPersonRejected: (article, reg) => markPersonRejected(article, reg),
  waiting,
  requeueDueUnreadable: () => requeueDueUnreadable(),
  insertFound,
  startRun,
  finishRun,
  loadRegistry,
  loadOutlets,
  prKeywords: loadPrKeywords,
  newsSettings: () => getNewsSettings(),
  search: (queries, budgetMs) => runSearches(queries, { budgetMs }),
  readArticle,
  classifyArticle,
  writeDecision: (article, decision, reg, outlets) => writeDecision(article, decision, reg, outlets),
  withdrawLegacyRow: (article, ownerId) => withdrawLegacyRow(article, ownerId),
  withdrawLegacyRows: (stories) => withdrawLegacyRows(stories),
  heldArticles: (offset, limit) => heldArticles(offset, limit),
  importedDuplicates: () => importedDuplicates(),
  importLateRows: async () => {
    const r = await seedFromMentions();
    return { seeded: r.seeded, twins: r.twins };
  },
  claudeConfigured,
  apifyReadsThisMonth,
  now: () => Date.now(),
};

/** Claimed articles not yet saved, with the status each goes back to if the step stops. */
type Held = Map<string, ArticleStatus>;

/** What a step reports to runStep: whether to run again, and what went wrong, if anything. */
interface Outcome {
  more: boolean;
  aiError?: string;
  /** Logged on the step's row as its error. The chain still goes on. */
  problem?: string | null;
  /** Why the step did nothing, logged on its row; the step itself went as it should. */
  note?: string;
  /** For the check: held articles wait while counting is on, so the chain publishes them. */
  publishNext?: boolean;
}

/**
 * Articles that broke a step's own code, worded the way Bot Activity reads
 * them (lib/data.ts): "2 articles failed, the first: na_1: <why>".
 */
const describeProblems = (problems: string[]) =>
  problems.length ? `${plural(problems.length, "article", "articles")} failed, the first: ${problems[0]}` : null;

/**
 * Put articles back where they came from and let go of them, all at once, since
 * this runs at the end of a step's time. One at a time rather than through
 * release(), which would wipe the error an article is waiting with. Only the
 * ones this run still holds: an article a person closed on Bot Activity in the
 * meantime stays closed. Best effort: anything left is given back by the lease.
 */
async function putBack(ids: string[], held: Held, runId: string, deps: StepDeps): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      const status = held.get(id);
      if (!status) return;
      try {
        await deps.saveArticle(id, { status }, { claimedBy: runId });
        held.delete(id);
      } catch (e) {
        console.error(`[news] could not give back ${id}: ${messageOf(e)}`);
      }
    }),
  );
}

/**
 * After a save refused because the article changed under the step, between its
 * last look and its save: when that was a person's Reject, the rows the step
 * wrote just before are taken out of the count as theirs. Their Reject closes
 * the article first and then marks the rows it finds, so a row written after
 * that would otherwise count against it. Anything else (another publish that
 * wrote the same decision) leaves nothing to take back.
 */
async function takeBackAfterReject(a: ArticleRow, reg: Registry, deps: StepDeps): Promise<void> {
  const now = await deps.articleState(a.id);
  if (now && rejectedByPerson(now)) await deps.markPersonRejected(a, reg);
}

async function openLog(step: string, ctx: { runId: string; link: number; trigger: string }, deps: StepDeps): Promise<number | null> {
  try {
    return await deps.startRun(step, ctx.runId, ctx.link, ctx.trigger);
  } catch (e) {
    console.error(`[news] could not open the run log: ${messageOf(e)}`);
    return null;
  }
}

async function closeLog(logId: number | null, ok: boolean, counts: RunCounts, error: string | null, deps: StepDeps): Promise<void> {
  try {
    await deps.finishRun(logId, ok, counts, error);
  } catch (e) {
    console.error(`[news] could not close the run log: ${messageOf(e)}`);
  }
}

/**
 * search: unreadable articles whose time has come go back in the queue, then
 * every search runs and what it found is stored, minus what is stored
 * already. It never runs again on its own; read follows it.
 */
async function searchStep(ctx: StepContext, counts: RunCounts, deps: StepDeps): Promise<Outcome> {
  const startedAt = deps.now();
  counts.requeued = await deps.requeueDueUnreadable();
  const [reg, keywords, settings] = await Promise.all([deps.loadRegistry(), deps.prKeywords(), deps.newsSettings()]);
  const queries = buildQueries(reg, keywords, settings.searchWindow);
  counts.queries = queries.length;
  const left = startedAt + ctx.budgetMs - deps.now();
  const { items, failures } = await deps.search(queries, Math.max(0, Math.min(SEARCH_BUDGET_MS, left)));
  counts.queryFailures = failures.length;
  counts.found = items.length;
  const stored = await deps.insertFound(items);
  counts.fresh = stored.fresh;
  counts.repeats = stored.repeats;
  counts.skipped = stored.skipped;
  // A morning on which no search worked found nothing because it couldn't
  // look, which must not pass as a quiet morning.
  const allFailed = queries.length > 0 && failures.length >= queries.length;
  return { more: false, problem: allFailed ? `every search failed, the first with: ${failures[0]?.error ?? "no reason given"}` : null };
}

/**
 * read: claim queued articles a batch at a time, read each one (Apify only as
 * Settings and the monthly cap allow), and save what it came to. Claiming
 * stops when the budget runs out or nothing is left, and an article claimed
 * but not yet started by then goes back in the queue for the next link.
 *
 * An imported story found to be another stored article is that article's
 * duplicate, and the old bot's row it came from stops counting, since the
 * other article counts the story now. In test mode that waits for the publish
 * step, as nothing a test run does may change the PR tab.
 *
 * Every save needs this run's claim still in place. A person's Reject while
 * the page is read closes the article and lets go of the claim, so the read
 * saves nothing over it. A person's Keep leaves the claim, and the read keeps
 * their note rather than writing its own.
 */
async function readStep(ctx: StepContext, counts: RunCounts, held: Held, deps: StepDeps): Promise<Outcome> {
  const claimUntil = deps.now() + ctx.budgetMs;
  const finishBy = claimUntil + FINISH_GRACE_MS;
  const inBudget = () => deps.now() < claimUntil;
  const [reg, settings] = await Promise.all([deps.loadRegistry(), deps.newsSettings()]);
  Object.assign(counts, { read: 0, unreadable: 0, noNames: 0, duplicates: 0, apifyReads: 0 });
  const tally = (field: "read" | "unreadable" | "noNames" | "skipped" | "held" | "duplicates" | "apifyReads" | "withdrawn") => {
    counts[field] = (counts[field] ?? 0) + 1;
  };

  // The month's reads are counted once per step, when Apify is first wanted.
  // A read is reserved when it is allowed rather than counted when it is done,
  // so four lanes asking at once can't all slip under the cap together.
  let usedThisMonth: Promise<number> | null = null;
  let allowedThisStep = 0;
  const apifyAllowed = async () => {
    // Measured against the budget, not the grace after it: the read must end well inside the link.
    if (claimUntil - deps.now() < APIFY_MIN_LEFT_MS) return false;
    usedThisMonth ??= deps.apifyReadsThisMonth();
    if (!apifyWithinCap(await usedThisMonth, allowedThisStep, settings.apifyMonthlyCap)) return false;
    allowedThisStep++;
    return true;
  };
  const opts: ReadOptions = {
    apifyBackup: settings.apifyBackup,
    apifyAllowed,
    onApifyRead: async () => tally("apifyReads"),
  };

  const problems: string[] = [];
  const claimed = { claimedBy: ctx.runId };
  // The article as it is now, just before the read's result is saved, or null
  // when this run no longer holds it: a person closed it while it was read.
  const stillOurs = async (id: string): Promise<ArticleState | null> => {
    const now = await deps.articleState(id);
    return now?.claimed_by === ctx.runId ? now : null;
  };
  // Loaded only if an imported story turns out to name nobody (see below).
  let outlets: Promise<OutletRef[]> | null = null;
  const readOne = async (a: ArticleRow) => {
    try {
      const result = await deps.readArticle({ googleLink: a.google_link, url: a.url }, opts);
      if (result.resolvedUrl) {
        // Another stored article already has this address: this one is a copy
        // of it, saved as such by saveResolvedUrl, and goes no further.
        const { duplicateOf, lost } = await deps.saveResolvedUrl(a.id, result.resolvedUrl, ctx.runId);
        if (lost) {
          held.delete(a.id);
          return;
        }
        if (duplicateOf) {
          held.delete(a.id);
          tally("duplicates");
          // An imported article's old row is not withdrawn here: the article
          // it copies may not have been checked yet. The end of the check
          // step, and publish, take it out of the count once that article
          // has a verdict (lib/news/store.ts importedDuplicates).
          return;
        }
      }
      const outcome = readOutcome(a, result, spotNames(a.title, result.text, reg), new Date(deps.now()));
      const now = await stillOurs(a.id);
      if (!now) {
        held.delete(a.id);
        return;
      }
      const patch = keepPersonsNote(outcome.patch, now);
      // Skipped, saying why, unless the note is a person's Keep or Reject, which stays.
      const skippedPatch = (why: string): Partial<ArticleRow> => ({
        ...patch,
        status: "skipped",
        next_try_at: null,
        ...("note" in patch ? { note: why } : {}),
      });
      // An old bot's story is decided without asking the AI, and written like
      // any rejection (held instead, in test mode): its old row must stop
      // counting, which a no_names or skipped status alone would never do. A
      // rejection only takes rows out of the count, and never a row a person
      // decided, so it can't undo a person's verdict however late it lands.
      const rejectImported = async (decision: Decision, field: "noNames" | "skipped") => {
        let saved: boolean;
        if (settings.countOnPrTab) {
          outlets ??= deps.loadOutlets();
          if (!rejectedByPerson(now)) await deps.writeDecision(a, decision, reg, await outlets);
          saved = await deps.saveArticle(a.id, { ...patch, status: "decided", decision }, claimed);
        } else {
          saved = await deps.saveArticle(a.id, { ...patch, status: "held", decision }, claimed);
          // Counted with the check step's held decisions, so Bot Activity's Held tile includes it.
          if (saved) tally("held");
        }
        held.delete(a.id);
        if (saved) tally(field);
      };
      // Read in full, naming nobody we track.
      if (outcome.status === "no_names" && a.legacy_mention_id) {
        await rejectImported(noNamesDecision(new Date(deps.now()).toISOString()), "noNames");
        return;
      }
      // On a company's own website (lib/news/ownSite.ts), read and naming only
      // that company or its people: never its coverage, and no one else's, so
      // decided here with no AI. A new one the bot could not read is left at
      // that too, as only its publisher is known. An imported one could not
      // be read is retried as usual: its old row may be another company's.
      const owner = ownSiteIn({ url: result.resolvedUrl ?? a.url, outlet: a.outlet }, reg);
      const onlyOwner = !!owner && outcome.status === "read" && namesOnly(outcome.patch.candidates ?? [], owner, reg);
      const unreadOwnSite = !!owner && outcome.status === "unreadable" && !a.legacy_mention_id;
      if (owner && (onlyOwner || unreadOwnSite)) {
        if (a.legacy_mention_id) {
          await rejectImported(ownSiteDecision(owner, new Date(deps.now()).toISOString()), "skipped");
        } else {
          const saved = await deps.saveArticle(a.id, skippedPatch(ownSiteReason(owner)), claimed);
          held.delete(a.id);
          if (saved) tally("skipped");
        }
        return;
      }
      // Not read, but the headline or outlet names another company with our
      // name in it (Better Homes & Gardens, BetterHome Group): ruled out as
      // the search step rules out a new one, instead of retried for nothing.
      const other = outcome.status === "unreadable" ? headlineSkip(a.title, a.outlet) : null;
      if (other) {
        if (a.legacy_mention_id) {
          await rejectImported(headlineDecision(other, new Date(deps.now()).toISOString()), "skipped");
        } else {
          const saved = await deps.saveArticle(a.id, skippedPatch(other), claimed);
          held.delete(a.id);
          if (saved) tally("skipped");
        }
        return;
      }
      const saved = await deps.saveArticle(a.id, patch, claimed);
      held.delete(a.id);
      if (saved) tally(outcome.status === "read" ? "read" : outcome.status === "no_names" ? "noNames" : "unreadable");
    } catch (e) {
      // Saved as unreadable, so a broken article is tried on later mornings
      // and then left, rather than breaking every link that claims it.
      const message = messageOf(e);
      problems.push(`${a.id}: ${message}`);
      try {
        const failed: ReadResult = { text: "", status: "error", via: "none", resolvedUrl: null, note: `the read failed: ${message}` };
        const now = await stillOurs(a.id);
        const patch = readOutcome(a, failed, { candidates: [] }, new Date(deps.now())).patch;
        if (now && (await deps.saveArticle(a.id, keepPersonsNote(patch, now), claimed))) tally("unreadable");
        held.delete(a.id);
      } catch {
        // The claim's lease gives it back.
      }
    }
  };

  let stoppedEarly = false;
  for (;;) {
    if (!inBudget()) {
      stoppedEarly = true;
      break;
    }
    const batch = await deps.claim("queued", "reading", READ_BATCH, ctx.runId);
    for (const a of batch) held.set(a.id, "queued");
    if (!batch.length) break;
    const pool = startPool(batch, READ_CONCURRENCY, inBudget, readOne);
    const finished = await settlesWithin(pool.done, finishBy - deps.now());
    const unstarted = pool.drain();
    await putBack(unstarted.map((a) => a.id), held, ctx.runId, deps);
    if (!finished || unstarted.length) {
      stoppedEarly = true;
      break;
    }
    // A short batch means the queue is empty for now.
    if (batch.length < READ_BATCH) break;
  }
  counts.remaining = await deps.waiting("queued");
  return { more: stoppedEarly && counts.remaining > 0, problem: describeProblems(problems) };
}

/** What a write that was not made comes to. */
const NOTHING_WRITTEN = { ours: 0, rivals: 0, added: 0 };

/**
 * check: claim read articles a batch at a time and have Claude sort each one;
 * what counts goes to mentions and the decision to the article. When the AI
 * itself fails (no key, no credit, a refused key, a model the key can't use)
 * every article this step holds goes back to read and the step stops, so
 * nothing new counts unchecked.
 *
 * With counting off in Settings (test mode), read once for the articles of
 * the whole step, nothing is written to mentions: the article is saved as
 * held, with its decision, for the publish step. An article a person rejected
 * on Bot Activity is decided but never written, so their Reject stands.
 *
 * A person may reject an article while the AI is asked about it. Their Reject
 * closes it and lets go of this run's claim, so every save here needs the
 * claim, and the claim is looked at again just before anything is written to
 * mentions. Should the Reject land between that look and the save, the save
 * is refused and the rows just written are taken back as theirs.
 */
async function checkStep(ctx: StepContext, counts: RunCounts, held: Held, deps: StepDeps): Promise<Outcome> {
  if (!deps.claudeConfigured()) {
    counts.remaining = await deps.waiting("read");
    return { more: false, aiError: NO_CLAUDE_KEY };
  }
  const claimUntil = deps.now() + ctx.budgetMs;
  const finishBy = claimUntil + FINISH_GRACE_MS;
  const [reg, outlets, settings] = await Promise.all([deps.loadRegistry(), deps.loadOutlets(), deps.newsSettings()]);
  const counting = settings.countOnPrTab;
  Object.assign(counts, { checked: 0, ours: 0, rivals: 0, rejected: 0, aiFailures: 0, added: 0, held: 0 });
  const add = (field: "checked" | "ours" | "rivals" | "rejected" | "aiFailures" | "added" | "held", n = 1) => {
    counts[field] = (counts[field] ?? 0) + n;
  };

  // Set by the first failure that would fail every article the same way.
  const halt: { failure: AiFailure | null } = { failure: null };
  const keepGoing = () => deps.now() < claimUntil && !halt.failure;
  const problems: string[] = [];
  const claimed = { claimedBy: ctx.runId };

  const checkOne = async (a: ArticleRow) => {
    try {
      const candidates = a.candidates ?? [];
      // On a company's own website (lib/news/ownSite.ts): naming only that
      // company or its people, it is decided without the AI; naming others,
      // the AI is asked as usual and the publisher is taken out of its answer.
      const owner = ownSiteIn(a, reg);
      const outcome =
        owner && namesOnly(candidates, owner, reg)
          ? { decision: ownSiteDecision(owner, new Date(deps.now()).toISOString()) }
          : await deps.classifyArticle(
              { title: a.title, outlet: a.outlet, publishedOn: a.published_on },
              candidates,
              { companiesNamed: companiesNamedIn(candidates) },
              reg,
              settings.model,
            );
      if ("failure" in outcome) {
        add("aiFailures");
        // Every other article would fail the same way: it stays held, and is
        // given back with the rest once the lanes have stopped.
        if (outcome.failure.stopRun) {
          halt.failure ??= outcome.failure;
          return;
        }
        await deps.saveArticle(a.id, aiFailurePatch(a, outcome.failure.message, new Date(deps.now())), claimed);
        held.delete(a.id);
        return;
      }
      const decision = withoutOwnSite(outcome.decision, owner);
      if (!counting) {
        const saved = await deps.saveArticle(a.id, { status: "held", decision, error: null, next_try_at: null }, claimed);
        held.delete(a.id);
        // Refused: a person closed it while the AI was asked, and nothing of it is held for publishing.
        if (!saved) return;
        add("checked");
        add("held");
        if (!decision.mentions.length) add("rejected");
        return;
      }
      // Right before writing: still this run's, so no person has closed it
      // while the AI was asked.
      const now = await deps.articleState(a.id);
      if (now?.claimed_by !== ctx.runId) {
        held.delete(a.id);
        return;
      }
      const personRejected = rejectedByPerson(now);
      // Mentions first: if saving the decision then fails, the article is
      // checked again, and writing the same decision twice changes nothing.
      const written = personRejected ? NOTHING_WRITTEN : await deps.writeDecision(a, decision, reg, outlets);
      const saved = await deps.saveArticle(a.id, { status: "decided", decision, error: null, next_try_at: null }, claimed);
      held.delete(a.id);
      if (!saved) {
        if (personRejected) return;
        try {
          await takeBackAfterReject(a, reg, deps);
        } catch (e) {
          problems.push(`${a.id}: what was written after a person rejected it could not be taken back: ${messageOf(e)}`);
        }
        return;
      }
      add("checked");
      add("ours", written.ours);
      add("rivals", written.rivals);
      add("added", written.added);
      if (!decision.mentions.length) add("rejected");
    } catch (e) {
      const message = messageOf(e);
      problems.push(`${a.id}: ${message}`);
      try {
        await deps.saveArticle(a.id, aiFailurePatch(a, `the check failed: ${message}`, new Date(deps.now())), claimed);
        held.delete(a.id);
      } catch {
        // The claim's lease gives it back.
      }
    }
  };

  let stoppedEarly = false;
  for (;;) {
    if (!keepGoing()) {
      stoppedEarly = true;
      break;
    }
    const batch = await deps.claim("read", "checking", CHECK_BATCH, ctx.runId);
    for (const a of batch) held.set(a.id, "read");
    if (!batch.length) break;
    const pool = startPool(batch, CHECK_CONCURRENCY, keepGoing, checkOne);
    const finished = await settlesWithin(pool.done, finishBy - deps.now());
    const unstarted = pool.drain();
    // Stopped by the AI: what is unstarted stays held, and goes back below with the rest.
    if (halt.failure) break;
    await putBack(unstarted.map((a) => a.id), held, ctx.runId, deps);
    if (!finished || unstarted.length) {
      stoppedEarly = true;
      break;
    }
    if (batch.length < CHECK_BATCH) break;
  }

  const failure = halt.failure;
  if (failure) {
    const ids = [...held.keys()];
    await deps.release(ids, "read", failure.message, ctx.runId);
    for (const id of ids) held.delete(id);
  }
  counts.remaining = await deps.waiting("read");
  if (failure) return { more: false, aiError: failure.message, problem: describeProblems(problems) };
  const more = stoppedEarly && counts.remaining > 0;
  if (more) return { more, problem: describeProblems(problems) };
  // The last check of the chain goes by counting as it is now, not as it was
  // when the step began. Switched on while this step was holding articles,
  // they are published before the chain ends, rather than waiting for a later
  // run; switched off, nothing on the PR tab changes. A read that fails keeps
  // the step's own.
  const countingNow = await deps.newsSettings().then(
    (s) => s.countOnPrTab,
    () => counting,
  );
  // Counting is on, yet articles are held: test mode was switched off while a
  // check was holding them, or publishing them failed. The chain publishes
  // them before it ends, so none is held for good.
  const publishNext = countingNow && (await deps.waiting("held")) > 0;
  // The old rows of imported duplicates whose article now has a verdict stop
  // counting on their own: publish does the same when it runs instead.
  let swept: string | null = null;
  if (countingNow && !publishNext) {
    try {
      counts.withdrawn = (await deps.withdrawLegacyRows(await deps.importedDuplicates())).withdrawn;
    } catch (e) {
      swept = `the old rows of imported duplicates could not be taken out of the count: ${messageOf(e)}`;
    }
  }
  return { more, publishNext, problem: [describeProblems(problems), swept].filter(Boolean).join("; ") || null };
}

/**
 * publish: write every held article's decision to mentions, now that counting
 * is on, a page of the oldest at a time, and save each as decided. A held
 * article a person rejected on Bot Activity is decided without a write, and
 * one held with no decision goes back to read to be checked again. One that
 * fails stays held, and the step moves on past it. Run while counting is still
 * off, it does nothing and says so in its log.
 *
 * Publish takes no claim, so each article is looked at again just before its
 * decision is written, and saved only while it is still held. One a person
 * rejected since its page was read, or another publish has written, is left
 * to them; one a person rejected between that look and the save has the rows
 * just written taken back as theirs. Only the articles this step moved from
 * held to decided are counted, so two publishes at once count each once.
 *
 * Once nothing is left held, the old bot's row of every imported duplicate is
 * taken out of the count (withdrawLegacyRows), which the read step leaves to
 * this step in test mode. Already-withdrawn rows are left as they are, so
 * every run can sweep them all.
 */
async function publishStep(ctx: StepContext, counts: RunCounts, deps: StepDeps): Promise<Outcome> {
  const settings = await deps.newsSettings();
  if (!settings.countOnPrTab) {
    counts.remaining = await deps.waiting("held");
    return { more: false, note: COUNTING_OFF };
  }
  const claimUntil = deps.now() + ctx.budgetMs;
  const finishBy = claimUntil + FINISH_GRACE_MS;
  const inBudget = () => deps.now() < claimUntil;
  // The old bot kept storing stories until the merge. Imported first, a story
  // it stored after the last import is linked to the new bot's article for it
  // (a duplicate), so the two are never both counted.
  let lateRows: string | null = null;
  try {
    const late = await deps.importLateRows();
    if (late.seeded || late.twins) Object.assign(counts, { seeded: late.seeded, twins: late.twins });
  } catch (e) {
    lateRows = `the old bot's latest rows could not be imported first: ${messageOf(e)}`;
  }
  const [reg, outlets] = await Promise.all([deps.loadRegistry(), deps.loadOutlets()]);
  Object.assign(counts, { published: 0, ours: 0, rivals: 0, added: 0 });
  const add = (field: "published" | "ours" | "rivals" | "added", n = 1) => {
    counts[field] = (counts[field] ?? 0) + n;
  };

  const problems: string[] = [];
  const stillHeld = { status: "held" as const };
  // Held articles this step tried and had to leave held. They stay at the
  // front of the list, oldest first, so the next page starts after them.
  let left = 0;
  const publishOne = async (a: ArticleRow) => {
    let written: Pick<WriteCounts, "ours" | "rivals" | "added"> | null = null;
    try {
      // Right before writing: still held, so no person has rejected it and
      // no other publish has written it since this page was read.
      const now = await deps.articleState(a.id);
      if (now?.status !== "held") return;
      if (!a.decision) {
        await deps.saveArticle(a.id, { status: "read", error: "it was held without a decision, so it is checked again" }, stillHeld);
        return;
      }
      // Mentions first, as in the check: a failed save leaves it held, and the
      // same decision written again changes nothing.
      written = rejectedByPerson(now) ? null : await deps.writeDecision(a, a.decision, reg, outlets);
      if (await deps.saveArticle(a.id, { status: "decided", error: null, next_try_at: null }, stillHeld)) {
        if (!written) return;
        add("published");
        add("ours", written.ours);
        add("rivals", written.rivals);
        add("added", written.added);
        return;
      }
    } catch (e) {
      left++;
      problems.push(`${a.id}: ${messageOf(e)}`);
      return;
    }
    // No longer held when it came to the save: decided by a person, or by
    // another publish, and no longer this step's to count.
    if (!written) return;
    try {
      await takeBackAfterReject(a, reg, deps);
    } catch (e) {
      problems.push(`${a.id}: what was written after a person rejected it could not be taken back: ${messageOf(e)}`);
    }
  };

  let stoppedEarly = false;
  for (;;) {
    if (!inBudget()) {
      stoppedEarly = true;
      break;
    }
    const page = await deps.heldArticles(left, PUBLISH_PAGE);
    if (!page.length) break;
    const pool = startPool(page, PUBLISH_CONCURRENCY, inBudget, publishOne);
    const finished = await settlesWithin(pool.done, finishBy - deps.now());
    // Not claimed, so the ones not started simply stay held for the next link.
    if (!finished || pool.drain().length) {
      stoppedEarly = true;
      break;
    }
    if (page.length < PUBLISH_PAGE) break;
  }

  let swept: string | null = null;
  if (!stoppedEarly) {
    try {
      counts.withdrawn = (await deps.withdrawLegacyRows(await deps.importedDuplicates())).withdrawn;
    } catch (e) {
      swept = `the old rows of imported duplicates could not be taken out of the count: ${messageOf(e)}`;
    }
  }
  counts.remaining = await deps.waiting("held");
  const problem = [lateRows, describeProblems(problems), swept].filter(Boolean).join("; ") || null;
  return { more: stoppedEarly && counts.remaining > 0, problem };
}

/**
 * Run one step of a run and log it in news_runs. `more` is true when the step
 * stopped for time with work of its own still waiting, so the chain runs it
 * again. Never throws: a failure comes back as `error`, after the articles the
 * step still held are given back.
 */
export async function runStep(step: ChainStep, ctx: StepContext, deps: StepDeps = REAL_DEPS): Promise<LinkResult> {
  const counts: RunCounts = {};
  const held: Held = new Map();
  const logId = await openLog(step, ctx, deps);
  try {
    const out =
      step === "search"
        ? await searchStep(ctx, counts, deps)
        : step === "read"
          ? await readStep(ctx, counts, held, deps)
          : step === "check"
            ? await checkStep(ctx, counts, held, deps)
            : await publishStep(ctx, counts, deps);
    const error = out.aiError ?? out.problem ?? null;
    // A note is the step's own account of why it did nothing, not a failure.
    await closeLog(logId, error === null, counts, error ?? out.note ?? null, deps);
    const result: LinkResult = { counts, more: out.more };
    if (out.aiError) result.aiError = out.aiError;
    if (out.publishNext) result.publishNext = true;
    return result;
  } catch (e) {
    const error = messageOf(e);
    await putBack([...held.keys()], held, ctx.runId, deps);
    await closeLog(logId, false, counts, error, deps);
    return { counts, more: false, error };
  }
}

// ─── The chain ──────────────────────────────────────────────────────────────

/** How a hand-off went. `certain` is false when the call may have arrived though no answer came back. */
export type HandOff = { ok: true } | { ok: false; error: string; certain: boolean };

/**
 * Start the next link by calling /api/news, and wait (up to 20 seconds) for it
 * to answer 202, which it does before doing any work. A redirect is not
 * followed: it means a login page stood in the way, not the route. `origin`
 * is the request's own address; in production the public domain is used
 * instead (handOffOrigin).
 */
export async function handOff(
  origin: string | null,
  next: { step: RouteStep; link: number },
  run: { runId: string; trigger: RunTrigger; kind?: RecheckKind },
  fetchImpl: typeof fetch = fetch,
): Promise<HandOff> {
  const req = handOffRequest(origin, next, run);
  if ("error" in req) return { ok: false, error: req.error, certain: true };
  try {
    const res = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(HAND_OFF_TIMEOUT_MS),
    });
    if (res.status === 202) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: true };
    }
    // The route's own refusals are short JSON worth keeping; a login page is not.
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
    const said = body.startsWith("{") ? `: ${body.slice(0, 120)}` : "";
    return { ok: false, error: `/api/news answered HTTP ${res.status}${said}`, certain: true };
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `/api/news did not answer within ${HAND_OFF_TIMEOUT_MS / 1000} seconds`, certain: false };
    }
    const cause = (e as { cause?: unknown } | null)?.cause;
    const why = cause instanceof Error ? ` (${cause.message})` : "";
    return { ok: false, error: `/api/news could not be reached: ${messageOf(e)}${why}`, certain: true };
  }
}

/** Write the run's summary to ingest_runs, from all of this run's news_runs rows. */
async function writeSummary(run: LinkRequest, ending: Ending | null): Promise<void> {
  // A test run on a preview keeps its record in news_runs, which Bot Activity
  // reads: ingest_runs and the notifications are shared with production, whose
  // PR tab would otherwise show it as its own last run. How such a run ended,
  // which only the summary would carry, goes on its last news_runs row instead
  // (runLink's recordEnding). Production always writes them, test mode or not,
  // so its "Last run" and its failure notices stay true after the merge.
  if (process.env.VERCEL_ENV !== "production" && !(await getNewsSettings()).countOnPrTab) return;
  // By run id alone, not by day: a run begun just before midnight in Dubai
  // still adds up to one summary.
  const { data, error } = await db()
    .from("news_runs")
    .select("step,ok,counts,error")
    .eq("run_id", run.runId)
    .order("id", { ascending: true });
  if (error) throw new Error(`the run's steps could not be read: ${error.message}`);
  const summary = summariseRun((data ?? []) as RunLogRow[], run.trigger, ending);
  const { error: e } = await db().from("ingest_runs").insert(summary);
  if (e) throw new Error(`the run's summary could not be saved: ${e.message}`);
  // A bot that can't check or can't search is broken, not quiet: say so where
  // people look, so it can't sit unnoticed. Repeats collapse into one line.
  if (!summary.ok) await notify("error", "news", "The news bot's last run had a problem", summary.error, "news:failed");
}

async function seedLink(req: LinkRequest): Promise<void> {
  const logId = await openLog("seed", req, REAL_DEPS);
  try {
    const r = await seedFromMentions();
    // Under names of their own, not fresh and repeats: Bot Activity adds up
    // every step's counts for the day, and thousands of imported stories must
    // not read as that morning's finds.
    const counts: RunCounts = { seeded: r.seeded, alreadyStored: r.skipped, twins: r.twins, rekeyed: r.rekeyed };
    await closeLog(logId, true, counts, null, REAL_DEPS);
  } catch (e) {
    await closeLog(logId, false, {}, messageOf(e), REAL_DEPS);
  }
}

async function recheckLink(req: LinkRequest): Promise<LinkResult> {
  const counts: RunCounts = {};
  const logId = await openLog("recheck", req, REAL_DEPS);
  try {
    if (!req.kind) throw new Error("a recheck needs a kind");
    const r = await requeueForRecheck(req.kind);
    counts.requeued = r.requeued;
    counts.markedRejected = r.markedRejected;
    await closeLog(logId, true, counts, null, REAL_DEPS);
    return { counts, more: false };
  } catch (e) {
    const error = messageOf(e);
    await closeLog(logId, false, counts, error, REAL_DEPS);
    return { counts, more: false, error };
  }
}

/** What runLink reaches outside this module, so tests can follow a chain without running one. */
export interface ChainDeps {
  runStep: (step: ChainStep, ctx: StepContext) => Promise<LinkResult>;
  seed: (req: LinkRequest) => Promise<void>;
  recheck: (req: LinkRequest) => Promise<LinkResult>;
  handOff: (origin: string | null, next: { step: ChainStep; link: number }, run: LinkRequest) => Promise<HandOff>;
  writeSummary: (run: LinkRequest, ending: Ending | null) => Promise<void>;
  /** Leave how the run ended on its last news_runs row, where Bot Activity reads it (lib/news/store.ts noteRunEnding). */
  recordEnding: (run: LinkRequest, ending: Ending) => Promise<void>;
  /** Write fresh PR insights to insights_cache (lib/insights.ts refreshInsightsCache). */
  refreshInsights: () => Promise<{ ok: boolean; error?: string }>;
  claudeConfigured: () => boolean;
  /** Settings' countOnPrTab, read when the chain ends. */
  countingOn: () => Promise<boolean>;
  now: () => number;
}

const REAL_CHAIN: ChainDeps = {
  runStep: (step, ctx) => runStep(step, ctx),
  seed: seedLink,
  recheck: recheckLink,
  handOff: (origin, next, run) => handOff(origin, next, run),
  writeSummary,
  recordEnding: async (run, ending) => {
    await noteRunEnding(run.runId, ending.error);
  },
  // Loaded only when a chain ends: the insights bring the PR page's whole
  // data layer with them, which no other link needs.
  refreshInsights: async () => (await import("@/lib/insights")).refreshInsightsCache(adminClient()),
  claudeConfigured,
  // A failed read counts as off: the refresh it decides on can wait a day.
  countingOn: async () => (await getNewsSettings().catch(() => null))?.countOnPrTab ?? false,
  now: () => Date.now(),
};

/**
 * How long the insights may take at the end of a link that has run for
 * `elapsedMs`: a minute at most, and never past the function's limit.
 */
export function insightsBudgetMs(elapsedMs: number): number {
  return Math.max(0, Math.min(INSIGHTS_TIMEOUT_MS, LINK_LIMIT_MS - elapsedMs));
}

/**
 * The PR insights, written again at the end of a chain so the PR tab's advice
 * reads the coverage the run just counted. Best effort: at most a minute, and
 * a failure is logged, never thrown, since the run itself is done.
 *
 * Not in test mode: a test run counts nothing, so there is nothing new to
 * advise on. A run that can't read Settings skips it too: the refresh can
 * wait for the next morning.
 */
async function refreshInsightsAtEnd(req: LinkRequest, deps: ChainDeps, startedAt: number): Promise<void> {
  if (!deps.claudeConfigured()) return;
  try {
    if (!(await deps.countingOn())) return;
  } catch {
    // Counting is the default.
  }
  const budget = insightsBudgetMs(deps.now() - startedAt);
  if (budget < INSIGHTS_MIN_MS) {
    console.error(`[news] ${req.runId}: too little of the link's time was left to refresh the PR insights`);
    return;
  }
  // Started inside a promise, so even a refresh that throws at once is caught below.
  const outcome = await within(Promise.resolve().then(() => deps.refreshInsights()), budget);
  if (!outcome.done) console.error(`[news] ${req.runId}: the PR insights did not refresh within ${Math.round(budget / 1000)} seconds`);
  else if ("error" in outcome) console.error(`[news] ${req.runId}: the PR insights could not be refreshed: ${messageOf(outcome.error)}`);
  else if (!outcome.value.ok) console.error(`[news] ${req.runId}: the PR insights were not refreshed: ${outcome.value.error ?? "no reason given"}`);
}

/**
 * Run one link, then start the next or, at the end of the chain, write the
 * summary and refresh the PR insights (unless the run stopped because the AI
 * failed, when the insights would fail the same way, or counting is off).
 * Called inside after() by /api/news, so it never throws. A hand-off that
 * surely failed ends the run with a summary that says so, and the next
 * morning's cron picks up whatever is left; one that may have got through
 * writes nothing, since the chain may well be running and will write its own.
 *
 * How a chain ended, when that is more than running out of work (a next link
 * that could not be started, or the link limit), also goes on the run's last
 * news_runs row, as a problem, whatever the mode. Bot Activity reads
 * news_runs, and a preview's test run writes no summary at all, so a chain
 * that stopped there would otherwise look as if it had simply finished. The
 * summary is written first, so production's still reads as it always has.
 */
export async function runLink(req: LinkRequest, origin: string | null, deps: ChainDeps = REAL_CHAIN): Promise<void> {
  const startedAt = deps.now();
  const finish = async (ending: Ending | null, refresh: boolean) => {
    try {
      await deps.writeSummary(req, ending);
    } catch (e) {
      console.error(`[news] ${req.runId}: the run's summary could not be written: ${messageOf(e)}`);
    }
    if (ending) {
      try {
        await deps.recordEnding(req, ending);
      } catch (e) {
        console.error(`[news] ${req.runId}: how the run ended could not be recorded: ${messageOf(e)}`);
      }
    }
    if (refresh) await refreshInsightsAtEnd(req, deps, startedAt);
  };
  try {
    if (req.step === "seed") {
      await deps.seed(req);
      return;
    }
    const result =
      req.step === "recheck"
        ? await deps.recheck(req)
        : await deps.runStep(req.step, { runId: req.runId, link: req.link, trigger: req.trigger, budgetMs: STEP_BUDGET_MS });
    const move = nextMove(req.step, result, req.link);
    if (move.kind === "none") return;
    if (move.kind === "summary") {
      await finish(move.note ? { error: move.note, failed: false } : null, !result.aiError);
      return;
    }
    const handed = await deps.handOff(origin, move, req);
    if (handed.ok) return;
    console.error(`[news] ${req.runId}: link ${move.link} (${move.step}) could not be started: ${handed.error}`);
    if (handed.certain) {
      await finish(
        { error: `the ${move.step} step could not be started (${handed.error}), so what is left waits for the next run`, failed: true },
        true,
      );
    }
  } catch (e) {
    console.error(`[news] ${req.runId}: link ${req.link} (${req.step}) failed: ${messageOf(e)}`);
  }
}

/** This deployment's address, from the request being answered, else from Vercel's own variable. */
async function currentOrigin(): Promise<string | null> {
  try {
    const found = originFromHeaders(await headers());
    if (found) return found;
  } catch {
    // Not answering a request.
  }
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
}

/**
 * Start a chain from a server action and return at once: a morning's run
 * (search, the Run now button), publishing what test mode held (publish, when
 * counting is switched back on), or a move from the old bot (seed, or recheck
 * with a kind).
 *
 * The first link is handed to /api/news, which has the 300 seconds a step
 * needs; a page's server action may have far less. When that can't be done
 * (no cron secret, no known address, or the route refused), the first link
 * runs here, in the background of this request, and then tries to hand the
 * next to the route. That hand-off goes to the same address with the same
 * headers, so whatever refused this one (Vercel's login on a preview without
 * the bypass secret, say) refuses it too: the run then stops after its first
 * link, with the reason on its news_runs row, where Bot Activity shows it. A
 * hand-off that got no answer is not repeated here, since the run may already
 * be under way and two would race each other.
 */
export async function startNewsStep(
  step: StartStep,
  trigger: RunTrigger,
  opts: { kind?: RecheckKind } = {},
): Promise<{ runId: string; started: boolean; uncertain?: boolean; error?: string }> {
  // Checked here as well as by the types: a server action's arguments come from the browser.
  if (!START_STEPS.includes(step)) {
    return { runId: newRunId(), started: false, error: `The news bot cannot start at "${String(step)}".` };
  }
  if (step === "recheck" && !isRecheckKind(opts.kind)) {
    return { runId: newRunId(), started: false, error: `A re-check needs one of these kinds: ${RECHECK_KINDS.join(", ")}.` };
  }
  const first = firstLink(trigger, step, opts.kind);
  const origin = handOffOrigin(await currentOrigin());
  if (origin && process.env.CRON_SECRET) {
    const handed = await handOff(origin, first, first);
    if (handed.ok) return { runId: first.runId, started: true };
    if (!handed.certain) {
      return {
        runId: first.runId,
        started: false,
        uncertain: true,
        error: "The news bot did not confirm that it started. It may still be running, so look at Bot Activity in a few minutes.",
      };
    }
    console.error(`[news] ${first.runId}: /api/news would not start the run, so it starts here: ${handed.error}`);
  }
  try {
    after(() => runLink(first, origin));
  } catch (e) {
    return { runId: first.runId, started: false, error: `The news bot could not be started: ${messageOf(e)}` };
  }
  return { runId: first.runId, started: true };
}

/** Start a morning's run from a server action (the Run now button). */
export function startNewsRun(trigger: RunTrigger): Promise<{ runId: string; started: boolean; error?: string }> {
  return startNewsStep("search", trigger);
}
