// Shared shapes for the news bot (docs/news-pipeline.md). Every module codes
// against these, so a change here is a change to the contract between them.

/** Where an article is in the flow. Mirrors the CHECK constraint in migration 0020. */
export type ArticleStatus =
  | "queued" //     found, waiting to be read
  | "reading" //    claimed by a read run
  | "read" //       read, or headline only, and a tracked name was found: waiting for the AI
  | "checking" //   claimed by a check run
  | "decided" //    the AI sorted it; `decision` holds the result, and it is written to mentions
  | "held" //       the AI sorted it, but counting is off (test mode): nothing is written until publish
  | "no_names" //   read in full and no tracked company or person is named: rejected for free
  | "unreadable" // could not be read and the headline names nobody: retried on a later morning
  | "skipped" //    another company's name in the headline, such as Better Homes & Gardens
  | "duplicate" //  the same article as another row (`dup_of`)
  | "failed"; //    the AI could not answer after repeated tries: needs a person

/** A company the bot tracks: betterhomes, or one of the rivals in tracked_keywords. */
export interface Company {
  /** As stored and shown: "betterhomes", or the rival's tracked_keywords label, such as "Knight Frank". */
  label: string;
  isUs: boolean;
  /** Ways the press writes the name, the label included. betterhomes is matched by its own strict rules instead. */
  names: string[];
  /** The Google News search for the company. */
  query: string;
}

/** A spokesperson from tracked_people. */
export interface Person {
  name: string;
  /** A Company label. */
  company: string;
  role: string | null;
  aliases: string[];
  /** False: no longer speaks for `company`. Counts for it only when the article names the company. */
  active: boolean;
  note: string | null;
}

export interface Registry {
  us: Company;
  /** us first, then rivals. */
  companies: Company[];
  people: Person[];
}

/** A sentence that names a tracked company or person, numbered from 1, as shown to the AI. */
export interface Candidate {
  n: number;
  text: string;
  /** Company labels named in this sentence by a company name. */
  companies: string[];
  /** Canonical names (Person.name) of tracked people named in this sentence. */
  people: string[];
}

export interface SpotResult {
  candidates: Candidate[];
  /** Company labels named anywhere in the headline or text by a company name. */
  companiesNamed: string[];
  /** Canonical names of tracked people named anywhere. */
  peopleNamed: string[];
}

export type MentionRole = "spokesperson" | "data" | "news" | "passing";
export type Tone = "positive" | "neutral" | "negative" | "mixed";

/** One company the AI found the article to be about, after the program checked it. */
export interface DecidedMention {
  company: string;
  /** Candidate.n of the proving sentence. */
  sentence: number;
  /** That sentence's text, our copy, word for word from the article. */
  quote: string;
  role: MentionRole;
  sentiment: Tone | null;
}

export interface Decision {
  /** Empty means rejected. */
  mentions: DecidedMention[];
  /** Why it was rejected, when mentions is empty. */
  irrelevantReason: string | null;
  /** A listed person described at a company other than the one on file. */
  possibleMoves: { person: string; companyInArticle: string }[];
  /** Claims the program refused, with the reason, so a wrong answer is visible rather than silent. */
  dropped: { company: string; sentence: number; why: string }[];
  model: string;
  checkedAt: string;
}

/** A row of news_articles, as Supabase returns it. */
export interface ArticleRow {
  id: string;
  google_link: string | null;
  url: string | null;
  url_key: string | null;
  title: string;
  title_key: string;
  outlet: string | null;
  outlet_key: string;
  published_on: string | null;
  found_by: string[];
  status: ArticleStatus;
  read_attempts: number;
  ai_attempts: number;
  body_status: string | null;
  body_chars: number | null;
  read_via: string | null;
  candidates: Candidate[] | null;
  decision: Decision | null;
  legacy_mention_id: string | null;
  /**
   * The status the old bot's row had when its story was imported (migration
   * 0023), null for an article the new bot found. A row whose status has
   * changed since, with nothing the new bot wrote on it, was changed by a person
   * on the old Bot Activity (lib/news/write.ts changedOnOldScreen). Optional
   * here only so rows built before the column existed still type: the
   * database always returns it.
   */
  legacy_status?: string | null;
  dup_of: string | null;
  note: string | null;
  error: string | null;
  next_try_at: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  first_seen_at: string;
  updated_at: string;
}

/** One Google News result, before it is stored. */
export interface FoundItem {
  /** The headline without Google's " - Outlet" suffix. */
  title: string;
  /** The news.google.com link from the feed. */
  link: string;
  outlet: string | null;
  /** YYYY-MM-DD. */
  publishedOn: string | null;
  /** The search that found it. */
  query: string;
  /** Set when the headline itself rules the article out, such as Better Homes & Gardens. */
  skip?: string;
}

/** What reading one article produced. */
export interface ReadResult {
  /** The article's text, paragraphs joined by "\n". Empty when nothing could be read. */
  text: string;
  /** ok: 400 characters or more. thin: some text, too little to judge absence from. */
  status: "ok" | "thin" | "blocked" | "empty" | "unresolved" | "error";
  via: "plain" | "apify" | "none";
  /** The publisher's address, when the Google link could be unwrapped. */
  resolvedUrl: string | null;
  note?: string;
}

/** News bot settings, stored in app_settings and edited in Settings. */
export interface NewsSettings {
  model: "claude-haiku-5-5" | "claude-sonnet-5-5" | "claude-opus-5-5";
  /** Read blocked pages through Apify as a last resort. */
  apifyBackup: boolean;
  /** Most Apify reads in a calendar month, when the backup is on. */
  apifyMonthlyCap: number;
  /** Google News time filter appended to each search ("when:2d"), or "" for none. */
  searchWindow: "" | "1d" | "2d" | "7d";
  /**
   * Whether the bot's decisions count on the PR tab. Off is test mode: the AI
   * still sorts every article, but its decisions are held (status held) and
   * nothing reaches `mentions` until counting is turned back on, which runs
   * the publish step. Production and the preview share one database, so this
   * is how the bot is tried without changing the live tab.
   */
  countOnPrTab: boolean;
}

/** Counts a step reports; every field is optional so each step fills its own. */
export interface StepCounts {
  queries?: number;
  queryFailures?: number;
  found?: number;
  fresh?: number;
  repeats?: number;
  skipped?: number;
  requeued?: number;
  read?: number;
  unreadable?: number;
  noNames?: number;
  duplicates?: number;
  checked?: number;
  ours?: number;
  rivals?: number;
  rejected?: number;
  aiFailures?: number;
  remaining?: number;
  apifyReads?: number;
  /** Decisions held back from the PR tab because counting is off. */
  held?: number;
  /** Held decisions written to the PR tab by the publish step. */
  published?: number;
}

export interface StepResult {
  counts: StepCounts;
  /** More work of this step is waiting: run it again. */
  more: boolean;
  /** The AI itself is failing (no key, no credit): stop checking until a later run. */
  aiError?: string;
  error?: string;
}
