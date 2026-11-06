import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERSON_CHECK,
  aiProblem,
  checkPersonInput,
  clipsFromRows,
  collectMoves,
  competitorStories,
  describeArticle,
  describeProblem,
  keepDecision,
  keptPatch,
  keptRow,
  noteVerdict,
  pressLookups,
  rejectedDecision,
  rejectedPatch,
  shareOfVoice,
  stillOpen,
  summariseRunDay,
  toArticleMentionRow,
  type ArticleMentionRow,
  type CompetitorNewsItem,
  type CompetitorRow,
  type NewsArticleRecord,
  type NewsRunRecord,
} from "@/lib/data";
import { ownSiteDecision } from "@/lib/news/ownSite";
import { enrichMentions } from "@/lib/pr";
import { buildPressMentions } from "@/lib/pressMentions";
import { buildRegistry } from "@/lib/news/registry";
import { headlineDecision, noNamesDecision } from "@/lib/news/run";
import { KEPT_NOTE, REJECTED_NOTE } from "@/lib/news/store";
import { trackedRegistry } from "@/lib/news/testCompanies";
import { mentionRowsFor, type OutletRef } from "@/lib/news/write";
import type { ArticleRow, Candidate, DecidedMention, Decision } from "@/lib/news/types";
import type { Mention } from "@/lib/types";

// Pure functions only: nothing here reads the database or the network.

/** Every company the bot tracks, with its spellings and websites, as getNewsArticles reads them. */
const TRACKED = trackedRegistry();

const ID = "na_0123456789abcdef0123";
const CHECKED = "2026-11-05T04:12:00.000Z";

const OURS: DecidedMention = {
  company: "betterhomes",
  sentence: 2,
  quote: "Richard Waind, CEO of betterhomes, said rents rose again.",
  role: "spokesperson",
  sentiment: "positive",
};
const KNIGHT_FRANK: DecidedMention = {
  company: "Knight Frank",
  sentence: 3,
  quote: "Faisal Durrani of Knight Frank said prime prices held.",
  role: "data",
  sentiment: "neutral",
};

const decision = (mentions: DecidedMention[], extra: Partial<Decision> = {}): Decision => ({
  mentions,
  irrelevantReason: null,
  possibleMoves: [],
  dropped: [],
  model: "claude-haiku-5-5",
  checkedAt: CHECKED,
  ...extra,
});

const record = (over: Partial<NewsArticleRecord> = {}): NewsArticleRecord => ({
  id: ID,
  title: "Dubai rents rise again",
  outlet: "Khaleej Times",
  published_on: "2026-11-04",
  first_seen_at: "2026-11-05T04:01:00.000Z",
  url: "https://www.khaleejtimes.com/business/property/rents-rise-again",
  google_link: "https://news.google.com/rss/articles/CBMiTestOnly?oc=5",
  status: "decided",
  decision: null,
  legacy_mention_id: null,
  note: null,
  error: null,
  read_attempts: 1,
  ...over,
});

const row = (over: Partial<ArticleMentionRow> = {}): ArticleMentionRow => ({
  id: `nb_${ID}`,
  isUs: true,
  company: "betterhomes",
  counting: true,
  personVerdict: null,
  ...over,
});

test("an article the AI found about us and a rival reads as both, with each proof", () => {
  const item = describeArticle(
    record({ decision: decision([OURS, KNIGHT_FRANK]) }),
    [row(), row({ id: `nr_${ID}_knight-frank`, isUs: false, company: "Knight Frank" })],
    TRACKED,
  );
  assert.equal(item.result, "Ours + Knight Frank");
  assert.equal(item.tone, "positive");
  assert.equal(item.group, "ours");
  assert.deepEqual(
    item.quotes.map((q) => [q.company, q.isUs, q.role]),
    [
      ["betterhomes", true, "spokesperson"],
      ["Knight Frank", false, "data"],
    ],
  );
  assert.equal(item.reason, null);
  assert.equal(item.link, "https://www.khaleejtimes.com/business/property/rents-rise-again");
  // It counts as ours already, so only Reject applies.
  assert.equal(item.canKeep, false);
  assert.equal(item.canReject, true);
});

test("a rival's article can still be kept as ours, or rejected", () => {
  const item = describeArticle(
    record({ decision: decision([KNIGHT_FRANK]) }),
    [row({ id: `nr_${ID}_knight-frank`, isUs: false, company: "Knight Frank" })],
    TRACKED,
  );
  assert.equal(item.result, "Knight Frank");
  assert.equal(item.tone, "mixed");
  assert.equal(item.group, "rivals");
  assert.equal(item.canKeep, true);
  assert.equal(item.canReject, true);
});

test("a rejected article gives the AI's reason as a sentence, and offers Keep only", () => {
  const item = describeArticle(
    record({ decision: decision([], { irrelevantReason: "it is about Better Homes & Gardens, the American magazine" }) }),
    [],
    TRACKED,
  );
  assert.equal(item.result, "Rejected");
  assert.equal(item.group, "rejected");
  assert.equal(item.reason, "It is about Better Homes & Gardens, the American magazine.");
  assert.equal(item.canKeep, true);
  assert.equal(item.canReject, false);
});

test("claims the program refused are listed with why", () => {
  const item = describeArticle(
    record({
      decision: decision([], {
        irrelevantReason: "the AI's sentences did not name the companies it claimed (Knight Frank)",
        dropped: [{ company: "Knight Frank", sentence: 4, why: "sentence 4 does not name Knight Frank or one of its people" }],
      }),
    }),
    [],
    TRACKED,
  );
  assert.equal(item.reason, "The AI's sentences did not name the companies it claimed (Knight Frank).");
  assert.deepEqual(item.refused, ["Knight Frank: sentence 4 does not name Knight Frank or one of its people."]);

  // Our name keeps its small letter, even at the start of a sentence.
  const ours = describeArticle(
    record({ decision: decision([], { dropped: [{ company: "betterhomes", sentence: 1, why: "sentence 1 names Better Homes & Gardens" }] }) }),
    [],
    TRACKED,
  );
  assert.deepEqual(ours.refused, ["betterhomes: sentence 1 names Better Homes & Gardens."]);
});

test("a person's Keep stands over the AI's rejection", () => {
  const item = describeArticle(record({ decision: decision([]), note: KEPT_NOTE }), [row({ personVerdict: "kept" })], TRACKED);
  assert.equal(item.result, "Rejected");
  assert.equal(item.person, "kept");
  assert.equal(item.group, "ours");
  assert.equal(item.countNote, null);
  assert.equal(item.canKeep, false);
  assert.equal(item.canReject, true);
});

test("a person's Reject stands over the AI's ours", () => {
  const item = describeArticle(
    record({ decision: decision([OURS]), note: REJECTED_NOTE }),
    [row({ counting: false, personVerdict: "rejected" })],
    TRACKED,
  );
  assert.equal(item.result, "Ours");
  assert.equal(item.person, "rejected");
  assert.equal(item.group, "rejected");
  assert.equal(item.canKeep, true);
  assert.equal(item.canReject, false);
});

test("an article with no rows carries the verdict in its note", () => {
  const failed = record({ status: "failed", error: "Claude's answer was cut off at 1500 tokens." });
  const waiting = describeArticle(failed, [], TRACKED);
  assert.equal(waiting.result, "Failed");
  assert.equal(waiting.person, null);
  assert.equal(waiting.reason, "Claude's answer was cut off at 1500 tokens. A person needs to decide.");
  // Nothing counts, but the AI gave up, so a person may reject it.
  assert.equal(waiting.canReject, true);

  const rejected = describeArticle({ ...failed, note: REJECTED_NOTE }, [], TRACKED);
  assert.equal(rejected.person, "rejected");
  assert.equal(rejected.group, "rejected");
  assert.equal(rejected.canReject, false);
});

test("when the rows can't be read, the decision decides the buttons", () => {
  const ours = describeArticle(record({ decision: decision([OURS]) }), null, TRACKED);
  assert.equal(ours.canKeep, false);
  assert.equal(ours.canReject, true);
  const rejected = describeArticle(record({ decision: decision([]) }), null, TRACKED);
  assert.equal(rejected.canKeep, true);
  assert.equal(rejected.canReject, false);
});

test("each status that isn't sorted yet says what it is waiting for", () => {
  const queued = describeArticle(record({ status: "queued" }), [], TRACKED);
  assert.equal(queued.result, "Waiting");
  assert.equal(queued.group, "waiting");
  assert.equal(queued.reason, "Waiting to be read.");

  const read = describeArticle(record({ status: "read", error: "The Claude account is out of credit" }), [], TRACKED);
  assert.equal(read.reason, "It names a tracked company or person, so it is waiting for the AI. Last try: The Claude account is out of credit.");

  const unreadable = describeArticle(record({ status: "unreadable", note: "blocked by the site (HTTP 403)", read_attempts: 1 }), [], TRACKED);
  assert.equal(unreadable.result, "Unreadable");
  assert.equal(unreadable.reason, "Blocked by the site (HTTP 403). It is tried again on a later morning: 1 of 3 tries so far.");
  const givenUp = describeArticle(record({ status: "unreadable", read_attempts: 3 }), [], TRACKED);
  assert.match(givenUp.reason ?? "", /Tried 3 times, so it is not tried again\.$/);

  const noNames = describeArticle(record({ status: "no_names" }), [], TRACKED);
  assert.equal(noNames.result, "No names");
  assert.equal(noNames.group, "rejected");

  const skipped = describeArticle(record({ status: "skipped", note: "the headline names Better Homes & Gardens" }), [], TRACKED);
  assert.equal(skipped.result, "Skipped");
  assert.equal(skipped.reason, "The headline names Better Homes & Gardens.");
});

test("the stories the program ruled out by itself are set apart, unless part of one counts or a person decided it", () => {
  const ruledOut = (r: NewsArticleRecord, rows: ArticleMentionRow[] | null = []) => describeArticle(r, rows, TRACKED).ruledOut;
  // A look-alike name in the headline, a page naming nobody, and the program's own decisions, the AI never asked.
  assert.equal(ruledOut(record({ status: "skipped", note: "the headline names Better Homes & Gardens, another company" })), true);
  assert.equal(ruledOut(record({ status: "no_names" })), true);
  assert.equal(ruledOut(record({ decision: headlineDecision("Better Homes & Gardens, another company", CHECKED) })), true);
  assert.equal(ruledOut(record({ decision: noNamesDecision(CHECKED) })), true);
  assert.equal(ruledOut(record({ status: "held", decision: ownSiteDecision("Knight Frank", CHECKED) })), true);
  // Ruled out, it can still be kept.
  assert.equal(describeArticle(record({ status: "no_names" }), [], TRACKED).canKeep, true);

  // Not the AI's own rejection, nor anything that counts, waits or failed.
  assert.equal(ruledOut(record({ decision: decision([]) })), false);
  assert.equal(ruledOut(record({ decision: decision([OURS]) }), [row()]), false);
  for (const status of ["queued", "read", "unreadable", "failed", "duplicate"] as const) assert.equal(ruledOut(record({ status })), false, status);
  // A person's word on it lists it with the rest.
  assert.equal(ruledOut(record({ status: "no_names", note: KEPT_NOTE }), [row({ personVerdict: "kept" })]), false);
  assert.equal(ruledOut(record({ status: "skipped", note: REJECTED_NOTE })), false);
  // An old bot's story whose row still counts until its held rejection is published is still counted, so it stays in view.
  const held = record({ status: "held", legacy_mention_id: "3f2a9c1b7d4e5f60", decision: noNamesDecision(CHECKED) });
  assert.equal(ruledOut(held, [row({ id: "3f2a9c1b7d4e5f60" })]), false);
  assert.equal(ruledOut(held, [row({ id: "3f2a9c1b7d4e5f60", counting: false })]), true);
});

test("a duplicate offers neither button: the article it copies is the one that counts", () => {
  const item = describeArticle(record({ status: "duplicate" }), [], TRACKED);
  assert.equal(item.result, "Duplicate");
  assert.equal(item.group, "duplicate");
  assert.equal(item.canKeep, false);
  assert.equal(item.canReject, false);
});

test("a held article shows what would count, and that it doesn't yet", () => {
  const item = describeArticle(record({ status: "held", decision: decision([OURS, KNIGHT_FRANK]) }), [], TRACKED);
  assert.equal(item.result, "Ours + Knight Frank (held)");
  assert.equal(item.group, "held");
  assert.equal(item.reason, "Sorted while counting on the PR tab was switched off, so it is held back until it is published.");
  assert.equal(item.quotes.length, 2);
  assert.equal(item.countNote, null);
  assert.equal(item.canKeep, true);
  // It counts once published, so a person can reject it before then.
  assert.equal(item.canReject, true);

  const rival = describeArticle(record({ status: "held", decision: decision([KNIGHT_FRANK]) }), [], TRACKED);
  assert.equal(rival.result, "Knight Frank (held)");
  assert.equal(rival.group, "held");
});

test("a held rejection is a rejection, and a held article a person rejected offers no Reject", () => {
  const rejected = describeArticle(record({ status: "held", decision: decision([], { irrelevantReason: "it is about a magazine" }) }), [], TRACKED);
  assert.equal(rejected.result, "Rejected");
  assert.equal(rejected.group, "rejected");
  assert.equal(rejected.canReject, false);

  const noted = describeArticle(record({ status: "held", decision: decision([OURS]), note: REJECTED_NOTE }), [], TRACKED);
  assert.equal(noted.person, "rejected");
  assert.equal(noted.group, "rejected");
  assert.equal(noted.canReject, false);
});

test("a person's Reject on an article no row carries reads as theirs once it is closed", () => {
  const closed = describeArticle(
    record({ status: "decided", decision: rejectedDecision(CHECKED), note: REJECTED_NOTE }),
    [],
    TRACKED,
  );
  assert.equal(closed.result, "Rejected");
  assert.equal(closed.person, "rejected");
  assert.equal(closed.group, "rejected");
  assert.equal(closed.reason, "A person rejected it.");
  assert.equal(closed.canKeep, true);
  assert.equal(closed.canReject, false);
  assert.deepEqual(rejectedDecision(CHECKED), {
    mentions: [],
    irrelevantReason: "a person rejected it",
    possibleMoves: [],
    dropped: [],
    model: PERSON_CHECK,
    checkedAt: CHECKED,
  });
  // A Reject saved while the list was called Bot Activity reads the same.
  const older = describeArticle(
    record({ status: "decided", decision: { ...rejectedDecision(CHECKED), irrelevantReason: "a person rejected it on Bot Activity" }, note: REJECTED_NOTE }),
    [],
    TRACKED,
  );
  assert.equal(older.reason, "A person rejected it.");
});

test("only the statuses a later run takes articles from are still open", () => {
  for (const status of ["queued", "reading", "read", "checking", "held", "unreadable", "failed"]) assert.equal(stillOpen(status), true, status);
  for (const status of ["decided", "no_names", "skipped", "duplicate", "", "nonsense"]) assert.equal(stillOpen(status), false, status);
});

test("a note records a person's verdict when it starts with one", () => {
  assert.equal(noteVerdict(KEPT_NOTE), "kept");
  assert.equal(noteVerdict(`${REJECTED_NOTE} on 5 Nov 2026`), "rejected");
  assert.equal(noteVerdict("Kept by a person"), "kept");
  assert.equal(noteVerdict("imported from the old bot (new)"), null);
  assert.equal(noteVerdict(null), null);
  // A longer note of a person's is shown as the verdict, not as the bot's reason.
  const item = describeArticle(record({ status: "queued", note: `${KEPT_NOTE}, later` }), [], TRACKED);
  assert.equal(item.person, "kept");
  assert.equal(item.reason, "Waiting to be read.");
});

test("the old bot's row still counting is said, and can be rejected", () => {
  const item = describeArticle(record({ status: "queued", legacy_mention_id: "3f2a9c1b7d4e5f60" }), [row({ id: "3f2a9c1b7d4e5f60" })], TRACKED);
  assert.equal(item.result, "Waiting");
  assert.equal(item.countNote, "Still counted on the PR tab from the old bot, until the new one checks it.");
  assert.equal(item.canKeep, false);
  assert.equal(item.canReject, true);
});

test("a story imported from the old bot shows what the old bot's row counts, not a rejection", () => {
  const imported = record({ id: "lm_3f2a9c1b7d4e5f60", decision: null, legacy_mention_id: "3f2a9c1b7d4e5f60", note: "imported from the old bot (new)" });
  const ours = describeArticle(imported, [row({ id: "3f2a9c1b7d4e5f60" })], TRACKED);
  assert.equal(ours.result, "Ours");
  assert.equal(ours.group, "ours");
  assert.equal(ours.reason, "Imported from the old bot (new). The new bot has not checked it.");
  assert.equal(ours.countNote, null);
  assert.equal(ours.canKeep, false);
  assert.equal(ours.canReject, true);

  const rival = describeArticle(imported, [row({ id: "3f2a9c1b7d4e5f60", isUs: false, company: "Haus & Haus" })], TRACKED);
  assert.equal(rival.result, "Haus & Haus");
  assert.equal(rival.group, "rivals");

  const turnedDown = describeArticle({ ...imported, note: "imported from the old bot (rejected)" }, [row({ id: "3f2a9c1b7d4e5f60", counting: false })], TRACKED);
  assert.equal(turnedDown.result, "Rejected");
  assert.equal(turnedDown.canKeep, true);
  assert.equal(turnedDown.canReject, false);

  assert.equal(describeArticle(imported, null, TRACKED).result, "Imported");
});

test("an article with no date of its own is dated by the Dubai day it was found", () => {
  const item = describeArticle(record({ published_on: null, first_seen_at: "2026-11-04T21:30:00.000Z" }), [], TRACKED);
  assert.equal(item.date, "2026-11-05");
  assert.equal(describeArticle(record({ published_on: null, first_seen_at: "not a date" }), [], TRACKED).date, "");
});

/** The rivals tracked now, as articleMentionRows reads them: Knight Frank and Engel & Völkers. */
const trackedRivals = buildRegistry(
  [
    { label: "Knight Frank", query: "knight frank dubai" },
    { label: "Engel & Völkers", query: "engel volkers dubai" },
  ],
  [],
);

const ref = (over: Partial<Parameters<typeof toArticleMentionRow>[0]>) =>
  toArticleMentionRow({ id: "a", status: "new", source: "googlenews", competitor: null, personVerdict: null, ...over }, trackedRivals);

test("a row's verdict: the person's word, an old Keep, never the historical import's default", () => {
  assert.equal(ref({ status: "rejected", personVerdict: "rejected" }).personVerdict, "rejected");
  // Rejected by hand in the old rival feed's cleanup: a person's Reject, and not counted.
  const byHand = ref({ status: "rejected", source: "competitor_news", competitor: "Sotheby's", rejectedBy: "manual" });
  assert.equal(byHand.personVerdict, "rejected");
  assert.equal(byHand.counting, false);
  assert.equal(ref({ status: "new", source: "competitor_news", competitor: "Sotheby's", rejectedBy: "manual" }).personVerdict, null);
  // A Keep given since wins over the cleanup.
  assert.equal(ref({ status: "reviewed", personVerdict: "kept", rejectedBy: "manual" }).personVerdict, "kept");
  assert.equal(ref({ status: "reviewed" }).personVerdict, "kept");
  assert.equal(ref({ status: "reviewed", source: "historical_import" }).personVerdict, null);
  assert.equal(ref({}).company, "betterhomes");
  const rival = ref({ source: "competitor_news", competitor: "Knight Frank" });
  assert.equal(rival.isUs, false);
  assert.equal(rival.company, "Knight Frank");
  assert.equal(rival.counting, true);
  assert.equal(ref({ source: "competitor_news" }).company, "a rival");
});

test("a rival's row is named and counted as the PR tab counts it: by the tracked label, and not once untracked", () => {
  // Stored under another spelling: the label, as the competitor feed and Share of Voice name it.
  const spelt = ref({ source: "competitor_news", competitor: "Engel and Volkers" });
  assert.equal(spelt.company, "Engel & Völkers");
  assert.equal(spelt.counting, true);
  assert.equal(ref({ source: "competitor_news", competitor: "Engel & Volkers", status: "rejected" }).counting, false);

  // A rival no longer tracked: the competitor feed and Share of Voice leave it out, so it counts nowhere.
  const untracked = ref({ source: "competitor_news", competitor: "Haus & Haus" });
  assert.equal(untracked.company, "Haus & Haus");
  assert.equal(untracked.counting, false);
  // Nor does a rival's row that names us, or names nobody.
  assert.equal(ref({ source: "competitor_news", competitor: "betterhomes" }).counting, false);
  assert.equal(ref({ source: "competitor_news" }).counting, false);
  // Ours counts by its status alone, as the PR table reads it.
  assert.equal(ref({ source: "historical_import" }).counting, true);

  // The article whose only row is an untracked rival's is not said to count, and offers no Reject.
  const requeued = describeArticle(
    record({ status: "queued", legacy_mention_id: "3f2a9c1b7d4e5f60" }),
    [{ ...untracked, id: "3f2a9c1b7d4e5f60" }],
    TRACKED,
  );
  assert.equal(requeued.countNote, null);
  assert.equal(requeued.canReject, false);
  const counted = describeArticle(
    record({ status: "queued", legacy_mention_id: "3f2a9c1b7d4e5f60" }),
    [{ ...spelt, id: "3f2a9c1b7d4e5f60" }],
    TRACKED,
  );
  assert.equal(counted.countNote, "Still counted on the PR tab from the old bot, until the new one checks it.");
  assert.equal(counted.canReject, true);
});

test("Claude's failures are said in a few plain words", () => {
  assert.equal(aiProblem("ANTHROPIC_API_KEY is not set, so the AI check cannot run."), "no key is set");
  assert.equal(aiProblem("no Claude key (ANTHROPIC_API_KEY)"), "no key is set");
  assert.equal(aiProblem("The Claude key was refused (HTTP 401): invalid x-api-key"), "the key was refused");
  assert.equal(
    aiProblem("The Claude account is out of credit or at its usage limit (HTTP 400): Your credit balance is too low"),
    "no credit",
  );
  assert.equal(aiProblem("The Claude account has reached its spend limit (HTTP 429): limit reached"), "no credit");
  assert.equal(aiProblem("Claude reports a billing problem on the account (HTTP 402): pay up"), "no credit");
  assert.equal(aiProblem("Claude is limiting how often this account may call it (HTTP 429): slow down"), "too many requests for now");
  assert.equal(aiProblem("Claude had a problem on its side (HTTP 529): Overloaded"), "Claude is having problems on its side");
  assert.equal(aiProblem("Claude could not be reached: fetch failed: getaddrinfo ENOTFOUND"), "Claude could not be reached");
  assert.equal(aiProblem("Something else entirely."), "Something else entirely");
});

test("a step's error reads as the AI's when it is Claude's, and as the step's otherwise", () => {
  assert.deepEqual(describeProblem("check", "The Claude account is out of credit or at its usage limit (HTTP 400): x"), {
    kind: "ai",
    text: "The AI is not answering: no credit",
    detail: "The Claude account is out of credit or at its usage limit (HTTP 400): x",
  });
  assert.equal(describeProblem("check", "no Claude key (ANTHROPIC_API_KEY)").text, "The AI is not answering: no key is set");
  const search = describeProblem("search", "every search failed, the first with: HTTP 503.");
  assert.equal(search.text, "The search step failed: every search failed, the first with: HTTP 503");
  assert.equal(search.kind, "step");
  assert.equal(describeProblem("check", "saving article na_1 failed: timeout").kind, "step");
});

test("a next step that could not be started stopped the run, which is not the last step failing", () => {
  const ending = "the check step could not be started (/api/news answered HTTP 401), so what is left waits for the next run";
  assert.deepEqual(describeProblem("read", ending), {
    kind: "step",
    text: "The run stopped after the read step: the check step could not be started (/api/news answered HTTP 401), so what is left waits for the next run",
    detail: ending,
  });
  // Whichever step's row it is on, by that step's name.
  const next = "the read step could not be started (/api/news could not be reached: fetch failed), so what is left waits for the next run";
  for (const [step, name] of [
    ["search", "search"],
    ["check", "check"],
    ["publish", "publish"],
    ["seed", "import"],
    ["recheck", "re-check"],
  ]) {
    assert.equal(describeProblem(step, next).text, `The run stopped after the ${name} step: ${next}`, step);
  }
  // Recorded after an error the row already had (lib/news/store.ts noteRunEnding): the stop is what is said,
  // and the whole record stays as the detail.
  const both = `1 article failed, the first: na_1: the page timed out; ${ending}`;
  assert.deepEqual(describeProblem("read", both), {
    kind: "step",
    text: `The run stopped after the read step: ${ending}`,
    detail: both,
  });
  // As Bot Activity sums up the day: the run's last row, closed clean and then marked with how the run ended.
  const day = summariseRunDay(
    "2026-11-05",
    [
      { run_id: "run_1", step: "search", started_at: "2026-11-05T04:00:00.000Z", finished_at: "2026-11-05T04:01:00.000Z", ok: true, counts: {}, error: null },
      { run_id: "run_1", step: "read", started_at: "2026-11-05T04:01:05.000Z", finished_at: "2026-11-05T04:03:00.000Z", ok: false, counts: { read: 3 }, error: ending },
    ],
    Date.parse("2026-11-05T06:00:00.000Z"),
  );
  assert.equal(day.problem?.text, `The run stopped after the read step: ${ending}`);
});

test("articles that failed one by one are not the AI being down", () => {
  const one = describeProblem("check", "1 article failed, the first: na_0123456789abcdef0123: Claude declined to sort this article (cyber).");
  assert.equal(one.kind, "articles");
  assert.equal(one.text, "1 article could not be checked this time and is tried again later. The first: Claude declined to sort this article (cyber).");
  const two = describeProblem("read", "2 articles failed, the first: na_1: the page timed out");
  assert.equal(two.text, "2 articles could not be read this time and are tried again later. The first: The page timed out.");
});

const step = (over: Partial<NewsRunRecord>): NewsRunRecord => ({
  run_id: "run_1",
  step: "search",
  started_at: "2026-11-05T04:00:00.000Z",
  finished_at: "2026-11-05T04:01:00.000Z",
  ok: true,
  counts: {},
  error: null,
  ...over,
});

const NOW = Date.parse("2026-11-05T06:00:00.000Z");

test("a day's steps are added up, all but the remaining snapshot", () => {
  const day = summariseRunDay(
    "2026-11-05",
    [
      step({ counts: { queries: 40, queryFailures: 2, found: 64, fresh: 12, repeats: 50, skipped: 2 } }),
      step({ step: "read", started_at: "2026-11-05T04:01:05.000Z", finished_at: "2026-11-05T04:03:10.000Z", counts: { read: 6, unreadable: 2, noNames: 3, remaining: 4 } }),
      step({ step: "read", started_at: "2026-11-05T04:03:12.000Z", finished_at: "2026-11-05T04:04:00.000Z", counts: { read: 4, noNames: 1, remaining: 0, junk: 9 } }),
      step({ step: "check", started_at: "2026-11-05T04:04:02.000Z", finished_at: "2026-11-05T04:05:30.000Z", counts: { checked: 5, ours: 2, rivals: 1, rejected: 2, ours_extra: "x" } }),
    ],
    NOW,
  );
  assert.equal(day.steps, 4);
  assert.deepEqual(day.counts, {
    queries: 40,
    queryFailures: 2,
    found: 64,
    fresh: 12,
    repeats: 50,
    skipped: 2,
    read: 10,
    unreadable: 2,
    noNames: 4,
    checked: 5,
    ours: 2,
    rivals: 1,
    rejected: 2,
  });
  assert.equal(day.lastStepAt, "2026-11-05T04:05:30.000Z");
  assert.equal(day.problem, null);
  assert.equal(day.running, false);
});

test("the AI's error shows until its step works again", () => {
  // A failure is logged with ok false, as runStep logs every one.
  const failed = step({
    step: "check",
    started_at: "2026-11-05T04:04:00.000Z",
    finished_at: "2026-11-05T04:04:05.000Z",
    ok: false,
    error: "The Claude account is out of credit or at its usage limit (HTTP 400): Your credit balance is too low",
  });
  const stands = summariseRunDay("2026-11-05", [step({}), failed], NOW);
  assert.equal(stands.problem?.text, "The AI is not answering: no credit");
  assert.equal(stands.problem?.kind, "ai");

  const later = step({ step: "check", run_id: "run_2", started_at: "2026-11-05T07:00:00.000Z", finished_at: "2026-11-05T07:01:00.000Z" });
  assert.equal(summariseRunDay("2026-11-05", [step({}), failed, later], NOW).problem, null);
});

test("a step that did nothing on purpose is no failure, and doesn't hide one", () => {
  // runStep logs a step's own account of why it did nothing in `error`, with ok true:
  // COUNTING_OFF in lib/news/run.ts, from a publish while counting is off.
  const note = step({
    step: "publish",
    started_at: "2026-11-05T05:00:00.000Z",
    finished_at: "2026-11-05T05:00:01.000Z",
    ok: true,
    error: "counting on the PR tab is switched off (test mode), so no held article was published",
  });
  assert.equal(summariseRunDay("2026-11-05", [step({}), note], NOW).problem, null);

  // An older real failure still shows: the note is not a clean finish either.
  const noCredit = step({
    step: "check",
    started_at: "2026-11-05T04:04:00.000Z",
    finished_at: "2026-11-05T04:04:05.000Z",
    ok: false,
    error: "The Claude account is out of credit or at its usage limit (HTTP 400): Your credit balance is too low",
  });
  const day = summariseRunDay("2026-11-05", [step({}), noCredit, note], NOW);
  assert.equal(day.problem?.text, "The AI is not answering: no credit");
  assert.equal(day.problem?.kind, "ai");
});

test("a step still open is working until its life runs out, then it is a problem", () => {
  const open = step({ step: "read", started_at: "2026-11-05T05:58:00.000Z", finished_at: null, ok: null });
  const working = summariseRunDay("2026-11-05", [step({}), open], NOW);
  assert.equal(working.running, true);
  assert.equal(working.problem, null);
  assert.equal(working.lastStepAt, "2026-11-05T05:58:00.000Z");

  const died = summariseRunDay("2026-11-05", [step({}), { ...open, started_at: "2026-11-05T05:40:00.000Z" }], NOW);
  assert.equal(died.running, false);
  assert.equal(died.problem?.text, "The last read step stopped part way through. The next run picks its articles up again.");
});

test("what test mode holds and what the publish writes are added up too", () => {
  const day = summariseRunDay(
    "2026-11-05",
    [
      step({ step: "check", counts: { checked: 4, held: 3, rejected: 1 } }),
      step({ step: "publish", started_at: "2026-11-05T05:00:00.000Z", finished_at: "2026-11-05T05:00:30.000Z", counts: { published: 3, ours: 2, rivals: 1 } }),
    ],
    NOW,
  );
  assert.deepEqual(day.counts, { checked: 4, held: 3, rejected: 1, published: 3, ours: 2, rivals: 1 });
});

test("no steps today is an empty day, not a failure", () => {
  assert.deepEqual(summariseRunDay("2026-11-05", [], NOW), {
    day: "2026-11-05",
    steps: 0,
    counts: {},
    lastStepAt: null,
    problem: null,
    running: false,
  });
});

test("possible moves are gathered per person and company, newest first, from recent articles only", () => {
  const base = { outlet: "Gulf News", url: null, google_link: "https://news.google.com/rss/articles/x", first_seen_at: "2026-11-05T04:00:00.000Z" };
  const moves = collectMoves(
    [
      { ...base, id: "na_1", title: "Knight Frank on prime", published_on: "2026-11-04", moves: [{ person: "Louis Harding", companyInArticle: "Knight Frank" }] },
      { ...base, id: "na_2", title: "Prime homes", published_on: "2026-10-20", moves: [{ person: "louis harding", companyInArticle: "knight frank" }, { person: "", companyInArticle: "x" }] },
      { ...base, id: "na_3", title: "Leasing", published_on: "2026-11-01", moves: [{ person: "Jacob Fletcher", companyInArticle: "Engel & Völkers" }] },
      { ...base, id: "na_4", title: "Old story", published_on: "2023-03-01", moves: [{ person: "Louis Harding", companyInArticle: "betterhomes" }] },
      { ...base, id: "na_5", title: "Nothing", published_on: "2026-11-03", moves: null },
    ],
    "2026-09-06",
  );
  assert.deepEqual(
    moves.map((m) => [m.person, m.companyInArticle, m.articles.map((a) => a.id)]),
    [
      ["Louis Harding", "Knight Frank", ["na_1", "na_2"]],
      ["Jacob Fletcher", "Engel & Völkers", ["na_3"]],
    ],
  );
  assert.equal(moves[0].articles[0].link, "https://news.google.com/rss/articles/x");
});

const reg = buildRegistry(
  [{ label: "Knight Frank", query: "knight frank dubai" }],
  [
    { name: "Richard Waind", company: "betterhomes", role: "CEO", aliases: [], active: true, note: null },
    { name: "Louis Harding", company: "betterhomes", role: "Former CEO", aliases: [], active: false, note: null },
    { name: "Louis Harding", company: "Knight Frank", role: "Head of Residential", aliases: [], active: true, note: null },
  ],
);

const candidate = (n: number, text: string, companies: string[], people: string[] = []): Candidate => ({ n, text, companies, people });

test("Keep proves us with the AI's own sentence when it found one", () => {
  const d = keepDecision({ title: "Rents rise", candidates: [candidate(1, "x", ["betterhomes"])], decision: decision([KNIGHT_FRANK, OURS]) }, reg, CHECKED);
  assert.deepEqual(d.mentions, [{ ...OURS }]);
  assert.equal(d.model, PERSON_CHECK);
  assert.equal(d.checkedAt, CHECKED);
  assert.equal(d.irrelevantReason, null);
});

test("Keep otherwise proves us with the first sentence naming us or one of our current people", () => {
  const byName = keepDecision(
    {
      title: "Rents rise",
      candidates: [candidate(1, "Knight Frank said prices held.", ["Knight Frank"]), candidate(2, "betterhomes said rents rose.", ["betterhomes"])],
      decision: null,
    },
    reg,
    CHECKED,
  );
  assert.deepEqual(byName.mentions, [{ company: "betterhomes", sentence: 2, quote: "betterhomes said rents rose.", role: "passing", sentiment: null }]);

  // Louis Harding is ours only as former: he proves nothing for us now.
  const byPerson = keepDecision(
    {
      title: "Rents rise",
      candidates: [candidate(1, "Louis Harding said prime held.", [], ["Louis Harding"]), candidate(2, "Richard Waind said rents rose.", [], ["Richard Waind"])],
      decision: null,
    },
    reg,
    CHECKED,
  );
  assert.equal(byPerson.mentions[0].sentence, 2);
  assert.equal(byPerson.mentions[0].quote, "Richard Waind said rents rose.");
});

test("Keep falls back to the headline, as sentence 0", () => {
  const d = keepDecision({ title: "Rents rise in Dubai Marina", candidates: null, decision: null }, reg, CHECKED);
  assert.deepEqual(d.mentions, [{ company: "betterhomes", sentence: 0, quote: "Rents rise in Dubai Marina", role: "passing", sentiment: null }]);
});

const OUTLETS: OutletRef[] = [{ id: 7, name: "Khaleej Times", tier: "T1-Local" }];

const article = (over: Partial<ArticleRow> = {}): ArticleRow => ({
  id: ID,
  google_link: "https://news.google.com/rss/articles/CBMiTestOnly?oc=5",
  url: "https://www.khaleejtimes.com/business/property/rents-rise-again",
  url_key: "khaleejtimes.com/business/property/rents-rise-again",
  title: "Dubai rents rise again",
  title_key: "dubai rents rise again",
  outlet: "Khaleej Times",
  outlet_key: "khaleejtimes",
  published_on: "2026-11-04",
  found_by: ["betterhomes"],
  status: "decided",
  read_attempts: 1,
  ai_attempts: 1,
  body_status: "ok",
  body_chars: 2400,
  read_via: "plain",
  candidates: null,
  decision: decision([]),
  legacy_mention_id: null,
  dup_of: null,
  note: null,
  error: null,
  next_try_at: null,
  claimed_at: null,
  claimed_by: null,
  first_seen_at: "2026-11-05T04:01:00.000Z",
  updated_at: "2026-11-05T04:05:00.000Z",
  ...over,
});

test("a kept article's new row is the bot's row for us, reviewed, with the person's verdict", () => {
  const a = article();
  const [ours] = mentionRowsFor(a, keepDecision(a, reg, CHECKED), reg, OUTLETS, CHECKED).filter((r) => r.brand === "betterhomes");
  assert.equal(ours.id, `nb_${ID}`);
  const written = keptRow(ours.row);
  assert.equal(written.status, "reviewed");
  assert.equal(written.source, "googlenews");
  assert.equal(written.brand, "betterhomes");
  assert.equal(written.tier, "T1-Local");
  const meta = written.metadata as Record<string, unknown>;
  assert.equal(meta.personVerdict, "kept");
  assert.equal(meta.articleId, ID);
  assert.deepEqual(meta.factCheck, { result: "pass", role: "passing", quote: "Dubai rents rise again", sentence: 0, checkedAt: CHECKED, model: PERSON_CHECK });
});

test("an article from the old bot's row for us is kept under that row's id", () => {
  const a = article({ legacy_mention_id: "3f2a9c1b7d4e5f60" });
  const rows = mentionRowsFor(a, keepDecision(a, reg, CHECKED), reg, OUTLETS, CHECKED, {
    id: "3f2a9c1b7d4e5f60",
    source: "googlenews",
    competitor: null,
  });
  assert.deepEqual(rows.map((r) => [r.id, r.legacy]), [["3f2a9c1b7d4e5f60", true]]);
});

test("Keep on a stored row keeps its own proof and everything else, and drops the rejection reason", () => {
  const a = article();
  const [ours] = mentionRowsFor(a, keepDecision(a, reg, CHECKED), reg, OUTLETS, CHECKED);
  const oldProof = { role: "spokesperson", quote: "betterhomes CEO Richard Waind said rents rose." };
  const patch = keptPatch({ metadata: { factCheck: oldProof, reason: "fact check: no sentence names us", eavNote: "kept" } }, ours.row, ID);
  assert.equal(patch.status, "reviewed");
  assert.equal(patch.metadata.personVerdict, "kept");
  assert.equal(patch.metadata.articleId, ID);
  assert.equal(patch.metadata.eavNote, "kept");
  assert.deepEqual(patch.metadata.factCheck, oldProof);
  assert.equal("reason" in patch.metadata, false);

  // A failed check proves nothing, so the Keep's own proof replaces it.
  const failed = keptPatch({ metadata: { factCheck: { result: "fail", why: "not about betterhomes", prevStatus: "new" } } }, ours.row, ID);
  assert.equal((failed.metadata.factCheck as { result: string }).result, "pass");
  assert.equal(keptPatch({ metadata: null }, ours.row, ID).metadata.personVerdict, "kept");
});

test("Reject marks the row rejected by the person and keeps what it held", () => {
  assert.deepEqual(rejectedPatch({ metadata: { competitor: "Knight Frank", factCheck: { result: "pass" } } }, ID), {
    status: "rejected",
    metadata: { competitor: "Knight Frank", factCheck: { result: "pass" }, articleId: ID, personVerdict: "rejected" },
  });
  assert.deepEqual(rejectedPatch({ metadata: "not an object" }, ID).metadata, { articleId: ID, personVerdict: "rejected" });
});

test("a person to add is checked before anything is written", () => {
  const companies = ["betterhomes", "Knight Frank"];
  assert.deepEqual(checkPersonInput({ name: "  Faisal   Durrani ", company: "Knight Frank", role: " Head of Research " }, companies), {
    ok: true,
    person: { name: "Faisal Durrani", company: "Knight Frank", role: "Head of Research" },
  });
  assert.deepEqual(checkPersonInput({ name: "Nada Osman", company: "betterhomes", role: "" }, companies), {
    ok: true,
    person: { name: "Nada Osman", company: "betterhomes", role: null },
  });
  assert.equal(checkPersonInput({ name: "N", company: "betterhomes", role: "" }, companies).ok, false);
  assert.equal(checkPersonInput({ name: "x".repeat(81), company: "betterhomes", role: "" }, companies).ok, false);
  assert.equal(checkPersonInput({ name: "Nada Osman", company: "Haus & Haus", role: "" }, companies).ok, false);
  assert.equal(checkPersonInput({ name: "Nada Osman", company: "betterhomes", role: "x".repeat(121) }, companies).ok, false);
  assert.equal(checkPersonInput({ name: { toString: () => "Nada Osman" }, company: "betterhomes" }, companies).ok, false);
  assert.equal(checkPersonInput(null, companies).ok, false);
});

// ── The PR tab's reads, without the database ────────────────────

const clip = (over: Record<string, unknown>) => ({
  id: "a1",
  published_on: "2026-11-04",
  tier: "T1-Local",
  outlet_name: "Khaleej Times",
  title: "Dubai rents rise again",
  url: null,
  eav: null,
  reach: null,
  brand: "betterhomes",
  sentiment: "positive",
  source: "historical_import",
  metadata: null,
  ...over,
});

test("a bot find folded into its archive twin still counts as found by the bot", () => {
  // Newest first, as getMentions reads them: the archive's copy names the outlet, so it is kept.
  const archiveKept = clipsFromRows([
    clip({}),
    clip({ id: "b1", published_on: "2026-11-03", outlet_name: "khaleejtimes.com", source: "googlenews" }),
  ]);
  assert.deepEqual(
    archiveKept.map((m) => [m.id, m.source, m.foundByBot]),
    [["a1", "historical_import", true]],
  );

  // The bot's copy first, by its web address: the archive's named copy takes its place, and the mark.
  const replaced = clipsFromRows([
    clip({ id: "b1", published_on: "2026-11-05", outlet_name: "khaleejtimes.com", source: "googlenews" }),
    clip({}),
  ]);
  assert.deepEqual(
    replaced.map((m) => [m.id, m.foundByBot]),
    [["a1", true]],
  );

  // The bot's own row is marked; a story only the archive has is not.
  const both = clipsFromRows([clip({ id: "b2", title: "Prime villas sell out", source: "googlenews" }), clip({})]);
  assert.deepEqual(
    both.map((m) => [m.id, m.foundByBot ?? false]),
    [
      ["b2", true],
      ["a1", false],
    ],
  );
});

test("a clip keeps the bot's article, its own or a folded twin's, for Press mentions", () => {
  // The archive's named copy is kept, and takes the article of the bot's copy folded into it.
  const archiveKept = clipsFromRows([
    clip({}),
    clip({ id: "nb_na_1", published_on: "2026-11-03", outlet_name: "khaleejtimes.com", source: "googlenews", articleId: "na_1" }),
  ]);
  assert.deepEqual(
    archiveKept.map((m) => [m.id, m.articleId]),
    [["a1", "na_1"]],
  );
  // A row's own article stands over a twin's.
  const own = clipsFromRows([
    clip({ id: "nb_na_2", source: "googlenews", articleId: "na_2" }),
    clip({ id: "nb_na_3", outlet_name: "khaleejtimes.com", source: "googlenews", articleId: "na_3" }),
  ]);
  assert.deepEqual(
    own.map((m) => [m.id, m.articleId]),
    [["nb_na_2", "na_2"]],
  );
  // A clip no article is behind has none, rather than an empty one.
  const [history] = clipsFromRows([clip({ articleId: "  " })]);
  assert.equal("articleId" in history, false);
});

test("the headline a Keep stood in with is not shown as a sentence the fact check found", () => {
  // The article names nobody: a person kept it all the same.
  const a = article({ title: "Dubai villa prices climb 9% in October", candidates: null, decision: null });
  const kept = keepDecision(a, reg, CHECKED);
  const [ours] = mentionRowsFor(a, kept, reg, OUTLETS, CHECKED);
  // Stored as the bot's shape, the headline as sentence 0...
  assert.equal((keptRow(ours.row).metadata as { factCheck: { sentence: number } }).factCheck.sentence, 0);
  // ...but Bot Activity shows no proof, once the Keep's decision is the article's own.
  const item = describeArticle(record({ title: a.title, decision: kept, note: KEPT_NOTE }), [row({ personVerdict: "kept" })], TRACKED);
  assert.equal(item.result, "Ours");
  assert.deepEqual(item.quotes, []);

  // A sentence a Keep found naming us is a real proof, and shows.
  const named = article({ candidates: [candidate(3, "betterhomes said rents rose.", ["betterhomes"])], decision: null });
  const keptNamed = keepDecision(named, reg, CHECKED);
  const shown = describeArticle(record({ decision: keptNamed, note: KEPT_NOTE }), [row({ personVerdict: "kept" })], TRACKED);
  assert.deepEqual(shown.quotes, [{ company: "betterhomes", isUs: true, role: "passing", quote: "betterhomes said rents rose." }]);
});

const rivalReg = buildRegistry(
  [
    { label: "Knight Frank", query: "knight frank dubai" },
    { label: "Engel & Völkers", query: "engel volkers dubai" },
  ],
  [],
);

const rivalRow = (over: Partial<CompetitorRow>): CompetitorRow => ({
  id: "c1",
  published_on: "2026-11-04",
  outlet_name: "Gulf News",
  title: "Prime prices hold",
  url: null,
  competitor: "Knight Frank",
  ...over,
});

test("rival stories are named by the rival's label, untracked rivals left out, one per placement", () => {
  const items = competitorStories(
    [
      rivalRow({}),
      // The same story again, under the outlet's web address.
      rivalRow({ id: "c2", published_on: "2026-11-03", outlet_name: "gulfnews.com" }),
      // The same headline for another rival is that rival's story.
      rivalRow({ id: "c3", competitor: "Engel and Volkers" }),
      rivalRow({ id: "c4", competitor: "Haus & Haus", title: "No longer tracked" }),
      rivalRow({ id: "c5", competitor: null, title: "Nobody's" }),
      rivalRow({ id: "c6", competitor: "betterhomes", title: "Ours, filed wrongly" }),
    ],
    rivalReg,
  );
  assert.deepEqual(
    items.map((c) => [c.id, c.brand]),
    [
      ["c1", "Knight Frank"],
      ["c3", "Engel & Völkers"],
    ],
  );
  assert.deepEqual(items[0], {
    id: "c1",
    brand: "Knight Frank",
    published_on: "2026-11-04",
    outlet_name: "Gulf News",
    title: "Prime prices hold",
    url: null,
    // The copy under the web address, folded in.
    botRowIds: ["c2"],
  });
});

test("a rival story keeps the bot's article, its own or a folded twin's", () => {
  const items = competitorStories(
    [
      // The old bot's row names no article; the new bot's copy of the story, folded into it, does.
      rivalRow({}),
      rivalRow({ id: "nr_na_1_knight-frank", published_on: "2026-11-03", outlet_name: "gulfnews.com", articleId: "na_1" }),
      rivalRow({ id: "c3", title: "Villa prices climb", articleId: "na_2" }),
      rivalRow({ id: "c4", title: "Before the new bot" }),
    ],
    rivalReg,
  );
  assert.deepEqual(
    items.map((c) => [c.id, c.articleId]),
    [
      ["c1", "na_1"],
      ["c3", "na_2"],
      ["c4", undefined],
    ],
  );
});

const counted = (id: string, over: Partial<Mention> = {}): Mention => ({
  id,
  date: "2026-11-04",
  year: 2026,
  month: 11,
  tier: "T2",
  outlet: "Khaleej Times",
  title: `Story ${id}`,
  url: null,
  eav: null,
  reach: null,
  eavEff: 0,
  reachEff: 0,
  modeled: false,
  brand: "betterhomes",
  sentiment: null,
  source: "googlenews",
  ...over,
});

test("Press mentions reads the articles rows name, and looks up the bots' other rows as imported ones", () => {
  const { rows, named, imported } = pressLookups(
    [
      counted("nb_na_1", { articleId: "na_1" }),
      // The old bot's row, which names no article: an imported article may have come from it.
      counted("m1"),
      // A clip from the PR agency's history was never imported.
      counted("h1", { source: "historical_import" }),
      // The archive's copy of a bot find, with the article of the bot's copy folded into it.
      counted("h2", { source: "historical_import", foundByBot: true, articleId: "na_2" }),
    ],
    [
      { id: "nr_na_1_knight-frank", brand: "Knight Frank", published_on: "2026-11-04", outlet_name: "Gulf News", title: "Prime prices hold", url: null, articleId: "na_1" },
      { id: "c1", brand: "Knight Frank", published_on: "2026-10-01", outlet_name: "Gulf News", title: "Villa prices climb", url: null },
    ],
  );
  assert.deepEqual(named, ["na_1", "na_2"]);
  assert.deepEqual(imported, ["m1", "c1"]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.company, r.isUs, r.articleId, r.legacyIds]),
    [
      ["nb_na_1", "betterhomes", true, "na_1", ["nb_na_1"]],
      ["m1", "betterhomes", true, null, ["m1"]],
      ["h1", "betterhomes", true, null, []],
      ["h2", "betterhomes", true, "na_2", []],
      ["nr_na_1_knight-frank", "Knight Frank", false, "na_1", ["nr_na_1_knight-frank"]],
      ["c1", "Knight Frank", false, null, ["c1"]],
    ],
  );
  // Found by a bot: our bot's rows, the archive's copy of a bot find, and every rival story; not an agency-only clip.
  assert.deepEqual(
    rows.map((r) => [r.id, r.byBot]),
    [
      ["nb_na_1", true],
      ["m1", true],
      ["h1", false],
      ["h2", true],
      ["nr_na_1_knight-frank", true],
      ["c1", true],
    ],
  );
});

test("the PR agency's copy of a story the old bot found is listed once, with both companies and the people", () => {
  // hist_1 is the archive's copy, kept because it names the outlet the rate card's way; m1 is the old bot's, folded into it.
  const ours = enrichMentions(
    clipsFromRows([
      clip({ id: "hist_1", outlet_name: "Gulf News", title: "Prime prices hold" }),
      clip({ id: "m1", outlet_name: "gulfnews.com", title: "Prime prices hold", source: "googlenews" }),
    ]),
    [],
  );
  assert.deepEqual(
    ours.map((m) => [m.id, m.foundByBot, m.botRowIds]),
    [["hist_1", true, ["m1"]]],
  );
  const rivals = competitorStories([rivalRow({ id: "c1" })], rivalReg);
  const { rows, imported } = pressLookups(ours, rivals);
  assert.deepEqual(imported, ["m1", "c1"]);
  // The old bot's two rows became one article and its duplicate.
  const articles = [
    { id: "lm_m1", status: "decided", legacy_mention_id: "m1", dup_of: null, candidates: [{ n: 1, text: "x", companies: [], people: ["Richard Waind"] }] },
    { id: "lm_c1", status: "duplicate", legacy_mention_id: "c1", dup_of: "lm_m1", candidates: null },
  ];
  const people = [{ name: "Richard Waind", company: "betterhomes", role: "CEO", active: true }];
  const { items } = buildPressMentions(rows, articles, people, "betterhomes");
  assert.deepEqual(
    items.map((m) => [m.key, m.companies.map((c) => c.label), m.people.map((p) => p.name)]),
    [["article lm_m1", ["betterhomes", "Knight Frank"], ["Richard Waind"]]],
  );
});

test("a rival story keeps the bot's rows folded into it", () => {
  const [kept] = competitorStories(
    [rivalRow({}), rivalRow({ id: "c2", published_on: "2026-11-03", outlet_name: "gulfnews.com" }), rivalRow({ id: "c3", published_on: "2026-11-02" })],
    rivalReg,
  );
  assert.deepEqual([kept.id, kept.botRowIds], ["c1", ["c2", "c3"]]);
});

const rival = (brand: string, published_on: string, title = `${brand} story ${published_on}`): CompetitorNewsItem => ({
  id: `${brand}-${published_on}`,
  brand,
  published_on,
  outlet_name: "Gulf News",
  title,
  url: null,
});
const ours = (published_on: string, title = `Our story ${published_on}`, outlet_name = "Khaleej Times") => ({ published_on, title, outlet_name, url: null });

test("Share of Voice counts the year to the last rival story, months with no rival story left out", () => {
  const rivals = [
    rival("Engel & Völkers", "2026-03-15"),
    rival("Knight Frank", "2026-03-02"),
    rival("Knight Frank", "2026-01-10"),
    // Last year's: it ends no window, and counts for nobody this year.
    rival("Knight Frank", "2025-12-30"),
  ];
  const sov = shareOfVoice(
    rivals,
    [
      ours("2026-01-12"),
      ours("2026-02-03"),
      ours("2026-03-10", "Rents rise"),
      // The same story again, by the outlet's web address: one placement.
      ours("2026-03-11", "Rents rise", "khaleejtimes.com"),
      // After the last rival story: not counted.
      ours("2026-03-20"),
    ],
    "2026-11-05",
  );
  assert.deepEqual(
    sov.items.map((i) => [i.brand, i.mentions, i.share, i.isUs]),
    [
      ["Knight Frank", 2, 40, false],
      ["betterhomes", 2, 40, true],
      ["Engel & Völkers", 1, 20, false],
    ],
  );
  assert.equal(sov.through, "2026-03-15");
  assert.deepEqual(sov.monthsLeftOut, ["2026-02"]);
  assert.equal(sov.capturedOn, "2026-11-05");
  assert.equal(sov.error, null);
});

test("Share of Voice starts the year on the day given, Dubai's, and needs a rival story to exist", () => {
  const rivals = [rival("Knight Frank", "2026-12-31")];
  // 1 Jan in Dubai: last year's stories no longer count.
  const newYear = shareOfVoice(rivals, [ours("2026-12-31")], "2027-01-01");
  assert.deepEqual(newYear.items, []);
  assert.equal(newYear.through, "2026-12-31");
  // 31 Dec in Dubai: they still do.
  assert.equal(shareOfVoice(rivals, [ours("2026-12-31")], "2026-12-31").items.length, 2);

  assert.deepEqual(shareOfVoice([], [ours("2026-11-01")], "2026-11-05"), {
    items: [],
    capturedOn: null,
    through: null,
    monthsLeftOut: [],
    error: null,
  });
});

test("Bot Activity never shows a story as counting for the company whose own website it is on", () => {
  const onTheirSite = { url: "https://www.knightfrank.ae/research/dubai-residential", outlet: "Knight Frank UAE" };
  // Held from before the rule, kept for Knight Frank alone: shown as not counting for anyone, and why.
  const alone = describeArticle(record({ ...onTheirSite, status: "held", decision: decision([KNIGHT_FRANK]) }), [], TRACKED);
  assert.deepEqual(alone.quotes, []);
  assert.equal(alone.reason, "It is on Knight Frank's own website, which doesn't count as coverage.");
  assert.equal(alone.canReject, false);
  // Naming us too: still ours to count, only Knight Frank's proof goes.
  const both = describeArticle(record({ ...onTheirSite, status: "held", decision: decision([OURS, KNIGHT_FRANK]) }), [], TRACKED);
  assert.deepEqual(both.quotes.map((q) => q.company), ["betterhomes"]);
  assert.equal(both.canReject, true);
  // Anywhere else, Knight Frank's proof stands.
  const elsewhere = describeArticle(record({ status: "held", decision: decision([KNIGHT_FRANK]) }), [], TRACKED);
  assert.deepEqual(elsewhere.quotes.map((q) => q.company), ["Knight Frank"]);
});

test("the websites Bot Activity goes by are the tracked companies' own, as the bot's are", () => {
  const onTheirSite = { url: "https://www.savills.ae/research/dubai", outlet: "Savills" };
  const savills: DecidedMention = { ...KNIGHT_FRANK, company: "Savills", quote: "Savills said prime prices held." };
  const held = record({ ...onTheirSite, status: "held", decision: decision([savills]) });
  // A website added to a rival's row in settings counts at once.
  const withSite = buildRegistry([{ label: "Savills", query: "savills dubai", sites: ["savills.ae"] }], []);
  assert.deepEqual(describeArticle(held, [], withSite).quotes, []);
  // Without it, the page is someone else's: the proof stands.
  const withoutSite = buildRegistry([{ label: "Savills", query: "savills dubai" }], []);
  assert.deepEqual(describeArticle(held, [], withoutSite).quotes.map((q) => q.company), ["Savills"]);
  // The companies could not be read: the decision is shown as stored.
  const unread = describeArticle(record({ url: "https://www.knightfrank.ae/x", status: "held", decision: decision([KNIGHT_FRANK]) }), null, null);
  assert.deepEqual(unread.quotes.map((q) => q.company), ["Knight Frank"]);
  assert.equal(unread.result, "Knight Frank (held)");
});

test("a preview run stopped by Vercel's login between steps reads as a preview's limit, in amber, not as a fault", () => {
  const now = describeProblem("read", "the check step could not be started (Vercel's login answered instead of the bot (HTTP 302)), so what is left waits for the next run");
  assert.equal(now.kind, "preview");
  assert.equal(
    now.text,
    "This preview ran one step at a time: Vercel's login stops a preview from starting its next step by itself, so the check step waits for the next run. Live runs on production are not affected",
  );
  // Logged before the login was named: the route itself never redirects.
  assert.equal(describeProblem("read", "the check step could not be started (/api/news answered HTTP 302), so what is left waits for the next run").kind, "preview");
  // The route's own refusal is still a stopped run.
  const refused = describeProblem("read", 'the check step could not be started (/api/news answered HTTP 401: {"error":"unauthorized"}), so what is left waits for the next run');
  assert.equal(refused.kind, "step");
  assert.match(refused.text, /^The run stopped after the read step: the check step could not be started/);
});

test("a run that reached its link limit reads as a stop the next run picks up, in amber, not as a failed step", () => {
  const limit = describeProblem("check", "stopped after 40 links with work still waiting, which the next run picks up");
  assert.deepEqual([limit.kind, limit.text], [
    "limit",
    "The run stopped after the check step: it reached its limit of 40 links, and what is left waits for the next run",
  ]);
  // After an error the step's row already had, the step's own error is what is said.
  const after = describeProblem("check", "Claude's answer was cut off; stopped after 40 links with work still waiting, which the next run picks up");
  assert.equal(after.kind, "ai");
  assert.doesNotMatch(after.text, /40 links/);
});
