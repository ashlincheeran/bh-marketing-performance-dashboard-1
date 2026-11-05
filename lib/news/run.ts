// The news bot's runner (docs/news-pipeline.md, "Steps"): what each step does,
// and how the steps follow one another as a chain of short links. Server-only.
//
// A link is one step run by /api/news. It claims work for up to 200 seconds,
// saves where it got to, and hands the next link back to the route, so no call
// comes near the 300-second function limit however long the morning is. What a
// step claims it finishes or gives back, and every link leaves a news_runs row,
// so a chain that breaks off loses nothing: whatever is still waiting is there
// for the next run.
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { headers } from "next/headers";
import { adminClient } from "@/lib/supabase";
import { getAppSettings } from "@/lib/appSettings";
import { claudeConfigured, type AiFailure } from "@/lib/claude";
import { safeEqual } from "@/lib/gate";
import { notify } from "@/lib/notify";
import { classifyArticle } from "@/lib/news/classify";
import { isRecheckKind, requeueForRecheck, seedFromMentions, type RecheckKind } from "@/lib/news/migrate";
import { readArticle, type ReadOptions } from "@/lib/news/read";
import { loadRegistry } from "@/lib/news/registry";
import { buildQueries, runSearches, type SearchQuery } from "@/lib/news/search";
import { spotNames } from "@/lib/news/spot";
import {
  claim,
  dubaiDay,
  finishRun,
  insertFound,
  release,
  requeueDueUnreadable,
  saveArticle,
  saveResolvedUrl,
  startRun,
  waiting,
} from "@/lib/news/store";
import { loadOutlets, writeDecision, type OutletRef } from "@/lib/news/write";
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
export type ChainStep = "search" | "read" | "check";
/** Everything /api/news can run: the chain's steps, and the one-off moves from the old bot. */
export type RouteStep = ChainStep | "seed" | "recheck";
export type RunTrigger = "cron" | "manual";

export const ROUTE_STEPS: readonly RouteStep[] = ["search", "read", "check", "seed", "recheck"];

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
 * browser), and lib/apify.ts can't be cut short, so one starts only while the
 * step has that long left.
 */
const APIFY_MIN_LEFT_MS = 150_000;
/** How long the hand-off waits for the next link to say it has started. */
const HAND_OFF_TIMEOUT_MS = 20_000;

const NO_CLAUDE_KEY = "no Claude key (ANTHROPIC_API_KEY)";

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

/** The first link of a new run. */
export function firstLink(trigger: RunTrigger): LinkRequest {
  return { step: "search", runId: newRunId(), link: 0, trigger };
}

// ─── The pure parts ─────────────────────────────────────────────────────────

/** Where a chain goes after a link: another link, the run's summary, or nowhere (the seed is not a run). */
export type Move = { kind: "link"; step: ChainStep; link: number } | { kind: "summary"; note?: string } | { kind: "none" };

/**
 * The next link after this one. Search always goes on to read. Read runs again
 * while articles are queued, then goes to check. Check runs again while
 * articles wait, then the run is summed up. A step that failed, or an AI that
 * can't answer, ends the run there; what is left waits for the next run. No
 * run makes more than `maxLinks` links.
 */
export function nextMove(step: RouteStep, result: Pick<StepResult, "more" | "aiError" | "error">, link: number, maxLinks = MAX_LINKS): Move {
  if (step === "seed") return { kind: "none" };
  if (result.error) return { kind: "summary" };
  let next: ChainStep | null;
  if (step === "search" || step === "recheck") next = "read";
  else if (step === "read") next = result.more ? "read" : "check";
  else next = !result.aiError && result.more ? "check" : null;
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
  counts: StepCounts | null;
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
 * mentions rows the checks wrote, skipped what was turned down (rejected by
 * the AI, or naming nobody). Each figure comes from its own step, so a seed
 * or a re-check in the same run can't be counted as found. The error is the
 * check's (the AI failing), else the first step's that failed, else how the
 * chain ended.
 */
export function summariseRun(rows: RunLogRow[], trigger: string, ending: Ending | null = null): RunSummary {
  const total = (step: string, ...fields: (keyof StepCounts)[]) =>
    rows.filter((r) => r.step === step).reduce((n, r) => n + fields.reduce((m, f) => m + whole(r.counts?.[f]), 0), 0);
  const failed = rows.filter((r) => r.ok === false);
  const error =
    failed.find((r) => r.step === "check" && r.error)?.error ?? failed.find((r) => r.error)?.error ?? ending?.error ?? null;
  return {
    trigger,
    ok: failed.length === 0 && !ending?.failed,
    found: total("search", "fresh"),
    considered: total("read", "read"),
    inserted: total("check", "ours", "rivals"),
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
  if (step === "recheck" && !isRecheckKind(kind)) return { error: "a recheck needs kind=unchecked_ours or kind=rivals_2026" };
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
 * The request for the next link: a POST to this deployment's /api/news with
 * the cron secret. Preview addresses sit behind Vercel's login, so the
 * protection bypass goes along whenever the deployment has one.
 */
export function handOffRequest(
  origin: string,
  next: { step: RouteStep; link: number },
  run: { runId: string; trigger: RunTrigger; kind?: RecheckKind },
  env: Record<string, string | undefined> = process.env,
): { url: string; headers: Record<string, string> } | { error: string } {
  const secret = env.CRON_SECRET;
  if (!secret) return { error: "CRON_SECRET is not set, so the next step cannot be called" };
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

/** True if `p` settles within `ms`, false if it is still running then (it carries on, unobserved). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── The steps ──────────────────────────────────────────────────────────────

/**
 * Everything the steps reach outside this module. The real ones are the
 * default; tests hand in stand-ins, so the steps run without a database, the
 * web or Claude.
 */
export interface StepDeps {
  claim: (from: ArticleStatus, to: ArticleStatus, limit: number, runId: string) => Promise<ArticleRow[]>;
  saveArticle: (id: string, patch: Partial<ArticleRow>) => Promise<void>;
  saveResolvedUrl: (id: string, url: string | null) => Promise<{ duplicateOf: string | null }>;
  release: (ids: string[], status: ArticleStatus, error: string | null) => Promise<void>;
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
  writeDecision: (article: ArticleRow, decision: Decision, reg: Registry, outlets: OutletRef[]) => Promise<{ ours: number; rivals: number }>;
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
  saveArticle,
  saveResolvedUrl,
  release,
  waiting,
  requeueDueUnreadable: () => requeueDueUnreadable(),
  insertFound,
  startRun,
  finishRun,
  loadRegistry,
  loadOutlets,
  prKeywords: loadPrKeywords,
  newsSettings: async () => (await getAppSettings()).news,
  search: (queries, budgetMs) => runSearches(queries, { budgetMs }),
  readArticle,
  classifyArticle,
  writeDecision: (article, decision, reg, outlets) => writeDecision(article, decision, reg, outlets),
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
}

/** Articles that broke a step's own code, said so that it reads after "The read step failed: " on Bot Activity. */
const describeProblems = (problems: string[]) =>
  problems.length ? `${plural(problems.length, "article", "articles")} could not be handled, the first ${problems[0]}` : null;

/**
 * Put articles back where they came from and let go of them, all at once, since
 * this runs at the end of a step's time. One at a time rather than through
 * release(), which would wipe the error an article is waiting with. Best
 * effort: anything left is given back by the lease.
 */
async function putBack(ids: string[], held: Held, deps: StepDeps): Promise<void> {
  await Promise.all(
    ids.map(async (id) => {
      const status = held.get(id);
      if (!status) return;
      try {
        await deps.saveArticle(id, { status });
        held.delete(id);
      } catch (e) {
        console.error(`[news] could not give back ${id}: ${messageOf(e)}`);
      }
    }),
  );
}

async function openLog(step: string, ctx: { runId: string; link: number; trigger: string }, deps: StepDeps): Promise<number | null> {
  try {
    return await deps.startRun(step, ctx.runId, ctx.link, ctx.trigger);
  } catch (e) {
    console.error(`[news] could not open the run log: ${messageOf(e)}`);
    return null;
  }
}

async function closeLog(logId: number | null, ok: boolean, counts: StepCounts, error: string | null, deps: StepDeps): Promise<void> {
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
async function searchStep(ctx: StepContext, counts: StepCounts, deps: StepDeps): Promise<Outcome> {
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
 */
async function readStep(ctx: StepContext, counts: StepCounts, held: Held, deps: StepDeps): Promise<Outcome> {
  const claimUntil = deps.now() + ctx.budgetMs;
  const finishBy = claimUntil + FINISH_GRACE_MS;
  const inBudget = () => deps.now() < claimUntil;
  const [reg, settings] = await Promise.all([deps.loadRegistry(), deps.newsSettings()]);
  Object.assign(counts, { read: 0, unreadable: 0, noNames: 0, duplicates: 0, apifyReads: 0 });
  const tally = (field: "read" | "unreadable" | "noNames" | "duplicates" | "apifyReads") => {
    counts[field] = (counts[field] ?? 0) + 1;
  };

  // The month's reads are counted once per step, when Apify is first wanted.
  // A read is reserved when it is allowed rather than counted when it is done,
  // so four lanes asking at once can't all slip under the cap together.
  let usedThisMonth: Promise<number> | null = null;
  let allowedThisStep = 0;
  const apifyAllowed = async () => {
    if (finishBy - deps.now() < APIFY_MIN_LEFT_MS) return false;
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
  const readOne = async (a: ArticleRow) => {
    try {
      const result = await deps.readArticle({ googleLink: a.google_link, url: a.url }, opts);
      if (result.resolvedUrl) {
        // Another stored article already has this address: this one is a copy
        // of it, saved as such by saveResolvedUrl, and goes no further.
        const { duplicateOf } = await deps.saveResolvedUrl(a.id, result.resolvedUrl);
        if (duplicateOf) {
          held.delete(a.id);
          tally("duplicates");
          return;
        }
      }
      const outcome = readOutcome(a, result, spotNames(a.title, result.text, reg), new Date(deps.now()));
      await deps.saveArticle(a.id, outcome.patch);
      held.delete(a.id);
      tally(outcome.status === "read" ? "read" : outcome.status === "no_names" ? "noNames" : "unreadable");
    } catch (e) {
      // Saved as unreadable, so a broken article is tried on later mornings
      // and then left, rather than breaking every link that claims it.
      const message = messageOf(e);
      problems.push(`${a.id}: ${message}`);
      try {
        const failed: ReadResult = { text: "", status: "error", via: "none", resolvedUrl: null, note: `the read failed: ${message}` };
        await deps.saveArticle(a.id, readOutcome(a, failed, { candidates: [] }, new Date(deps.now())).patch);
        held.delete(a.id);
        tally("unreadable");
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
    await putBack(unstarted.map((a) => a.id), held, deps);
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

/**
 * check: claim read articles a batch at a time and have Claude sort each one;
 * what counts goes to mentions and the decision to the article. When the AI
 * itself fails (no key, no credit, a refused key) every article this step
 * holds goes back to read and the step stops, so nothing new counts unchecked.
 */
async function checkStep(ctx: StepContext, counts: StepCounts, held: Held, deps: StepDeps): Promise<Outcome> {
  if (!deps.claudeConfigured()) {
    counts.remaining = await deps.waiting("read");
    return { more: false, aiError: NO_CLAUDE_KEY };
  }
  const claimUntil = deps.now() + ctx.budgetMs;
  const finishBy = claimUntil + FINISH_GRACE_MS;
  const [reg, outlets, settings] = await Promise.all([deps.loadRegistry(), deps.loadOutlets(), deps.newsSettings()]);
  Object.assign(counts, { checked: 0, ours: 0, rivals: 0, rejected: 0, aiFailures: 0 });
  const add = (field: "checked" | "ours" | "rivals" | "rejected" | "aiFailures", n = 1) => {
    counts[field] = (counts[field] ?? 0) + n;
  };

  // Set by the first failure that would fail every article the same way.
  const halt: { failure: AiFailure | null } = { failure: null };
  const keepGoing = () => deps.now() < claimUntil && !halt.failure;
  const problems: string[] = [];

  const checkOne = async (a: ArticleRow) => {
    try {
      const candidates = a.candidates ?? [];
      const outcome = await deps.classifyArticle(
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
        await deps.saveArticle(a.id, aiFailurePatch(a, outcome.failure.message, new Date(deps.now())));
        held.delete(a.id);
        return;
      }
      // Mentions first: if saving the decision then fails, the article is
      // checked again, and writing the same decision twice changes nothing.
      const written = await deps.writeDecision(a, outcome.decision, reg, outlets);
      await deps.saveArticle(a.id, { status: "decided", decision: outcome.decision, error: null, next_try_at: null });
      held.delete(a.id);
      add("checked");
      add("ours", written.ours);
      add("rivals", written.rivals);
      if (!outcome.decision.mentions.length) add("rejected");
    } catch (e) {
      const message = messageOf(e);
      problems.push(`${a.id}: ${message}`);
      try {
        await deps.saveArticle(a.id, aiFailurePatch(a, `the check failed: ${message}`, new Date(deps.now())));
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
    await putBack(unstarted.map((a) => a.id), held, deps);
    if (!finished || unstarted.length) {
      stoppedEarly = true;
      break;
    }
    if (batch.length < CHECK_BATCH) break;
  }

  const failure = halt.failure;
  if (failure) {
    const ids = [...held.keys()];
    await deps.release(ids, "read", failure.message);
    for (const id of ids) held.delete(id);
  }
  counts.remaining = await deps.waiting("read");
  if (failure) return { more: false, aiError: failure.message, problem: describeProblems(problems) };
  return { more: stoppedEarly && counts.remaining > 0, problem: describeProblems(problems) };
}

/**
 * Run one step of a run and log it in news_runs. `more` is true when the step
 * stopped for time with work of its own still waiting, so the chain runs it
 * again. Never throws: a failure comes back as `error`, after the articles the
 * step still held are given back.
 */
export async function runStep(step: ChainStep, ctx: StepContext, deps: StepDeps = REAL_DEPS): Promise<StepResult> {
  const counts: StepCounts = {};
  const held: Held = new Map();
  const logId = await openLog(step, ctx, deps);
  try {
    const out =
      step === "search"
        ? await searchStep(ctx, counts, deps)
        : step === "read"
          ? await readStep(ctx, counts, held, deps)
          : await checkStep(ctx, counts, held, deps);
    const error = out.aiError ?? out.problem ?? null;
    await closeLog(logId, error === null, counts, error, deps);
    return out.aiError ? { counts, more: out.more, aiError: out.aiError } : { counts, more: out.more };
  } catch (e) {
    const error = messageOf(e);
    await putBack([...held.keys()], held, deps);
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
 * followed: it means a login page stood in the way, not the route.
 */
export async function handOff(
  origin: string | null,
  next: { step: RouteStep; link: number },
  run: { runId: string; trigger: RunTrigger; kind?: RecheckKind },
  fetchImpl: typeof fetch = fetch,
): Promise<HandOff> {
  if (!origin) return { ok: false, error: "this deployment's address is not known", certain: true };
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
    const counts: Record<string, number> = { seeded: r.seeded, alreadyStored: r.skipped };
    await closeLog(logId, true, counts, null, REAL_DEPS);
  } catch (e) {
    await closeLog(logId, false, {}, messageOf(e), REAL_DEPS);
  }
}

async function recheckLink(req: LinkRequest): Promise<StepResult> {
  const counts: StepCounts = {};
  const logId = await openLog("recheck", req, REAL_DEPS);
  try {
    if (!req.kind) throw new Error("a recheck needs a kind");
    counts.requeued = await requeueForRecheck(req.kind);
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
  runStep: (step: ChainStep, ctx: StepContext) => Promise<StepResult>;
  seed: (req: LinkRequest) => Promise<void>;
  recheck: (req: LinkRequest) => Promise<StepResult>;
  handOff: (origin: string | null, next: { step: ChainStep; link: number }, run: LinkRequest) => Promise<HandOff>;
  writeSummary: (run: LinkRequest, ending: Ending | null) => Promise<void>;
}

const REAL_CHAIN: ChainDeps = {
  runStep: (step, ctx) => runStep(step, ctx),
  seed: seedLink,
  recheck: recheckLink,
  handOff: (origin, next, run) => handOff(origin, next, run),
  writeSummary,
};

/**
 * Run one link, then start the next or, at the end of the chain, write the
 * summary. Called inside after() by /api/news, so it never throws. A hand-off
 * that surely failed ends the run with a summary that says so, and the next
 * morning's cron picks up whatever is left; one that may have got through
 * writes nothing, since the chain may well be running and will write its own.
 */
export async function runLink(req: LinkRequest, origin: string | null, deps: ChainDeps = REAL_CHAIN): Promise<void> {
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
      await deps.writeSummary(req, move.note ? { error: move.note, failed: false } : null);
      return;
    }
    const handed = await deps.handOff(origin, move, req);
    if (handed.ok) return;
    console.error(`[news] ${req.runId}: link ${move.link} (${move.step}) could not be started: ${handed.error}`);
    if (handed.certain) {
      await deps.writeSummary(req, { error: `the ${move.step} step could not be started (${handed.error}), so what is left waits for the next run`, failed: true });
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
 * Start a run from a server action (the Run now button) and return at once.
 *
 * The first link is handed to /api/news, which has the 300 seconds a step
 * needs; a page's server action may have far less. When that can't be done
 * (no cron secret, no known address, or the route refused), search runs here,
 * in the background of this request, and then hands read to the route. A
 * hand-off that got no answer is not repeated here, since the run may already
 * be under way and two would race each other.
 */
export async function startNewsRun(trigger: RunTrigger): Promise<{ runId: string; started: boolean; error?: string }> {
  const first = firstLink(trigger);
  const origin = await currentOrigin();
  if (origin && process.env.CRON_SECRET) {
    const handed = await handOff(origin, first, first);
    if (handed.ok) return { runId: first.runId, started: true };
    if (!handed.certain) {
      return {
        runId: first.runId,
        started: false,
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
