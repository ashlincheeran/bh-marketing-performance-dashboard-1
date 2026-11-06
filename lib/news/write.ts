// Writing what the check decided to `mentions`, the table the PR page counts
// (docs/news-pipeline.md, "What gets counted"). Server-only.
//
// The rows look exactly like the ones the old bot wrote (the retired
// lib/ingest.ts), so the PR table, Share of Voice and the competitor feed read
// them unchanged: ours is source googlenews with brand betterhomes, a rival's
// is source competitor_news with brand null and its label in
// metadata.competitor. Each carries its proving sentence in
// metadata.factCheck, which the PR table shows under the headline.
//
// Three rules keep the count honest. A row a person decided is never changed.
// An article imported from the old bot updates that bot's row rather than
// adding a second one beside it. And a row of the article's that the latest
// check no longer supports stops counting, with the reason, so a re-check can
// take back what an earlier one counted.
import { createHash } from "node:crypto";
import { adminClient } from "@/lib/supabase";
import { outletKey } from "@/lib/news/keys";
import { companyNamed } from "@/lib/news/registry";
import { chunkByLength } from "@/lib/news/store";
import type { ArticleRow, Decision, MentionRole, Registry, Tone } from "@/lib/news/types";

/** An outlet on the rate card (the outlets table): what a row needs to carry its tier. */
export type OutletRef = { id: number; name: string; tier: string };

/** How the check proved a row. The PR table shows `quote` under the headline. */
export type FactCheckPass = {
  result: "pass";
  role: MentionRole;
  quote: string;
  /** The proving candidate's number, as the AI was shown it. */
  sentence: number;
  checkedAt: string;
  model: string;
};

/** A row of `mentions` as the news bot writes it. */
export type MentionRow = {
  id: string;
  published_on: string | null;
  outlet_name: string | null;
  title: string;
  url: string | null;
  eav: null;
  reach: null;
  media_type: "online";
  tags: string[];
  tier: string;
  outlet_id: number | null;
  /** betterhomes for ours. Null for a rival's, which metadata.competitor names instead. */
  brand: string | null;
  sentiment: Tone | null;
  source: "googlenews" | "competitor_news";
  status: "new";
  raw: { link: string | null; resolved: string | null; outlet: string | null };
  metadata: {
    articleId: string;
    keywords: string[];
    bodyStatus: string | null;
    readVia: string | null;
    factCheck: FactCheckPass;
    /** The rival's label exactly as the registry has it: Share of Voice and the competitor feed count by it. */
    competitor?: string;
  };
};

/** One row mentionRowsFor made, with the company it counts for. */
export type DecidedRow = {
  id: string;
  /** betterhomes, or the rival's label. */
  brand: string;
  row: MentionRow;
  /** The old bot's row, reused under its own id. */
  legacy: boolean;
};

/** The old bot's row an imported article came from (news_articles.legacy_mention_id). */
export interface LegacyRow {
  id: string;
  /** competitor_news for a rival's; googlenews, or any other source, for ours. */
  source: string | null;
  /** Its metadata.competitor, on a rival's row. */
  competitor: string | null;
}

/** What writeDecision did. */
export interface WriteCounts {
  /** Our rows now counting: added, or brought up to date. */
  ours: number;
  /** Rivals' rows now counting: added, or brought up to date. */
  rivals: number;
  /** The old bot's row, taken out of the count because the check found the article is not about its company. */
  rejectedLegacy: number;
  /** Rows new to the table, of the ones in `ours` and `rivals`. A re-checked row is counted there but not here. */
  added: number;
  /** Rows an earlier check of the article wrote that this one no longer supports, taken out of the count. */
  withdrawn: number;
  /** Rows a person had decided, left exactly as they were. */
  personDecided: number;
}

/** What writeDecision reads of a stored row. */
export type StoredMention = {
  id: string;
  status: string;
  source: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
};

/**
 * The database calls writeDecision makes, behind an interface so tests can
 * hand it a stand-in. supabaseMentionStore is the real one.
 */
export interface MentionStore {
  /** The rows stored under any of these ids. */
  load(ids: string[]): Promise<StoredMention[]>;
  /** Add rows not stored yet, leaving alone any stored in the meantime. Returns the ids actually added. */
  insert(rows: MentionRow[]): Promise<string[]>;
  /** Change one row unless a person has decided it since it was read. Returns whether it changed. */
  update(id: string, patch: Record<string, unknown>): Promise<boolean>;
}

/** betterhomes' id in the brands table, which mentions.brand refers to. */
const OUR_BRAND = "betterhomes";

const ACCENTS = /[\u0300-\u036f]/g;
const APOSTROPHES = /['\u2018\u2019\u02bc`\u00b4]/g;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The same object without the values that are null: what the bot doesn't know must not erase what a row knows. */
const known = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/**
 * A rival's label as part of a row id: lower-case letters and digits joined
 * by "-", with accents folded and apostrophes dropped, so "fäm Properties" is
 * "fam-properties" and "Sotheby's" is "sothebys". A label must always give the
 * same id, or a re-check would add a second row beside the first. One with no
 * such letters at all (written only in Arabic, say) is named by a short hash
 * of itself rather than by nothing.
 */
export function labelSlug(label: string): string {
  const clean = label.trim();
  const words =
    clean.normalize("NFD").replace(ACCENTS, "").toLowerCase().replace(APOSTROPHES, "").match(/[a-z0-9]+/g) ?? [];
  return words.join("-") || createHash("sha1").update(clean).digest("hex").slice(0, 12);
}

/** The id of our row for an article. */
export function ourMentionId(articleId: string): string {
  return `nb_${articleId}`;
}

/** The id of a rival's row for an article. */
export function rivalMentionId(articleId: string, label: string): string {
  return `nr_${articleId}_${labelSlug(label)}`;
}

/**
 * The company an old row counted for, read the way the PR page reads it
 * (lib/data.ts getMentions and getSov): a competitor_news row for the rival in
 * metadata.competitor, as the registry labels it, and any other row for
 * betterhomes. Null for a rival no longer tracked: the check was not asked
 * about that company, so it can neither confirm the row nor take it back.
 */
export function legacyCompany(legacy: LegacyRow, reg: Registry): string | null {
  if (legacy.source !== "competitor_news") return reg.us.label;
  const company = companyNamed(reg, legacy.competitor);
  return company && !company.isUs ? company.label : null;
}

/**
 * The rate-card outlet a story's publication is, for its tier and outlet_id.
 *
 * By the name as stored first, then by the name in any case, then by the
 * publication's key (outletKey), which makes "khaleejtimes.com" Khaleej Times,
 * then by the key of the article's own site. The card holds one publication
 * under several spellings ("MENAFN", "MenaFN", "Mena FN"), not always with the
 * same tier, so a spelling that leads to rows with different tiers settles
 * nothing: a wrong tier misreports Tier 1 coverage, where "Other" only leaves
 * it out. Of rows that agree, the first on the card (the lowest id) is the one.
 */
export function matchOutlet(outlets: OutletRef[], outletName: string | null, url: string | null): OutletRef | null {
  const name = (outletName ?? "").trim();
  const exact = name ? outlets.find((o) => o.name === name) : undefined;
  if (exact) return exact;
  const lower = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const tries: [string, (o: OutletRef) => string][] = [
    [lower(name), (o) => lower(o.name)],
    [name ? outletKey(name) : "", (o) => outletKey(o.name)],
    [url ? outletKey(null, url) : "", (o) => outletKey(o.name)],
  ];
  for (const [key, keyOf] of tries) {
    if (!key) continue;
    const found = outlets.filter((o) => keyOf(o) === key);
    if (found.length && found.every((o) => o.tier === found[0].tier)) return found[0];
  }
  return null;
}

/**
 * The topic tags a story gets from its headline: the deriveTags of the
 * retired lib/ingest.ts, repeated here so old and new rows filter alike on the
 * PR page.
 */
function deriveTags(title: string): string[] {
  const t = title.toLowerCase();
  const tags = new Set<string>();
  if (/rent|tenant|lease|leasing/.test(t)) tags.add("leasing");
  if (/report/.test(t)) tags.add("market-report");
  if (/ceo|appoint|steps down|director|leadership/.test(t)) tags.add("leadership");
  if (/off-plan|off plan|offplan/.test(t)) tags.add("off-plan");
  if (/top 50/.test(t)) tags.add("top-50");
  if (/ramadan/.test(t)) tags.add("ramadan");
  return [...tags];
}

/**
 * The mentions rows a decision makes: one per company it found the article to
 * be about. Pure, so it can be tested and shown without a database.
 *
 * Ours is `nb_<articleId>`, a rival's `nr_<articleId>_<label slug>`. When the
 * article came from the old bot, pass that bot's row as `legacy`: the company
 * it counted for is written under the old row's id instead, so the story is
 * not counted twice. A company the registry doesn't know adds no row, since it
 * was never checked against the registry's names, and a company named twice
 * adds one.
 */
export function mentionRowsFor(
  article: ArticleRow,
  decision: Decision,
  reg: Registry,
  outlets: OutletRef[],
  checkedAt: string,
  legacy?: LegacyRow | null,
): DecidedRow[] {
  const outlet = matchOutlet(outlets, article.outlet, article.url);
  // Only the old row this article names: any other would overwrite a different story.
  const old = legacy && article.legacy_mention_id && legacy.id === article.legacy_mention_id ? legacy : null;
  const oldCompany = old ? legacyCompany(old, reg) : null;
  const out: DecidedRow[] = [];
  for (const m of decision.mentions ?? []) {
    const company = companyNamed(reg, m.company);
    if (!company) continue;
    const isLegacy = old !== null && oldCompany === company.label;
    const id = isLegacy ? old.id : company.isUs ? ourMentionId(article.id) : rivalMentionId(article.id, company.label);
    if (out.some((r) => r.brand === company.label || r.id === id)) continue;
    out.push({
      id,
      brand: company.label,
      legacy: isLegacy,
      row: {
        id,
        published_on: article.published_on,
        outlet_name: article.outlet,
        title: article.title,
        url: article.url || article.google_link || null,
        eav: null,
        reach: null,
        media_type: "online",
        tags: deriveTags(article.title),
        tier: outlet?.tier ?? "Other",
        outlet_id: outlet?.id ?? null,
        brand: company.isUs ? OUR_BRAND : null,
        sentiment: m.sentiment ?? null,
        source: company.isUs ? "googlenews" : "competitor_news",
        status: "new",
        raw: { link: article.google_link, resolved: article.url, outlet: article.outlet },
        metadata: {
          articleId: article.id,
          keywords: article.found_by ?? [],
          bodyStatus: article.body_status,
          readVia: article.read_via,
          factCheck: {
            result: "pass",
            role: m.role,
            quote: m.quote,
            sentence: m.sentence,
            checkedAt,
            model: decision.model,
          },
          ...(company.isUs ? {} : { competitor: company.label }),
        },
      },
    });
  }
  return out;
}

/**
 * True when a person decided this row, so the bot leaves it exactly as it is
 * (docs/news-pipeline.md, rule 6): kept (status reviewed), or given a verdict
 * on Bot Activity (metadata.personVerdict).
 *
 * Also a row whose fact check passed that is now rejected with no reason.
 * The old Bot Activity's Reject set the status and nothing else, and every
 * rejection the bot has written since the fact check began gives its reason,
 * so only a person leaves a row like that. Bot rejections from before the fact
 * check gave no reason either, which is why a passed fact check is required.
 * An imported story's old row that a person changed on the old screen since
 * the import is told apart by changedOnOldScreen instead.
 */
export function decidedByPerson(row: { status: string; metadata: Record<string, unknown> | null }): boolean {
  const meta = asRecord(row.metadata);
  if (row.status === "reviewed") return true;
  if (meta.personVerdict === "kept" || meta.personVerdict === "rejected") return true;
  const check = asRecord(meta.factCheck);
  const passed = check.result === "pass" || (check.result === undefined && !!check.role);
  return row.status === "rejected" && !meta.reason && passed;
}

/**
 * True when a person changed an imported story's old row on the old Bot
 * Activity since the import, so the bot leaves it as it is, like any row a
 * person decided. Production runs the old screen until the merge, and its Keep
 * and Reject set the status and nothing else. Its bot never changes a stored
 * row's status, and everything the new bot and the new Bot Activity write
 * leaves the article's id on the row. So a status other than the one the row
 * had when it was imported (news_articles.legacy_status), on a row with no
 * article's id, is a person's. Never true while that status is unknown.
 */
export function changedOnOldScreen(
  row: { status: string; metadata: Record<string, unknown> | null },
  legacyStatus: string | null | undefined,
): boolean {
  return !!legacyStatus && row.status !== legacyStatus && !asRecord(row.metadata).articleId;
}

/** The key, and the columns patchFor merges with what is stored rather than overwriting. */
const MERGED = new Set(["id", "tags", "metadata", "raw"]);

/**
 * What changes on a stored row to make it this check's row.
 *
 * The bot's values replace the row's, except where the bot knows less: a value
 * it has no figure for leaves the row's own, so an EAV someone entered
 * survives, and an outlet missing from the rate card keeps the tier the row
 * has. Metadata and raw are merged rather than replaced, keeping keys this
 * module doesn't know; only the old rejection reason goes, since the row
 * counts now. Tags are added to.
 */
function patchFor(existing: StoredMention, row: MentionRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && !MERGED.has(key)) patch[key] = value;
  }
  if (row.outlet_id === null) delete patch.tier;
  const earlier = { ...asRecord(existing.metadata) };
  delete earlier.reason;
  patch.metadata = { ...earlier, ...known(row.metadata) };
  patch.raw = { ...asRecord(existing.raw), ...known(row.raw) };
  patch.tags = [...new Set([...(Array.isArray(existing.tags) ? existing.tags : []), ...row.tags])];
  return patch;
}

/**
 * A row of the article's that no longer counts: rejected, with the reason Bot
 * Activity shows. When it counted until now, its fact check records the status
 * it had, the way the retired lib/prFactcheck.ts did, so the PR page lists it
 * among the stories the check moved out of the count, where it can be kept.
 */
function rejectionPatch(existing: StoredMention, reason: string, articleId: string, model: string, checkedAt: string) {
  const metadata: Record<string, unknown> = { ...asRecord(existing.metadata), articleId, reason };
  if (existing.status !== "rejected") {
    metadata.factCheck = {
      result: "fail",
      why: reason.replace(/^news check: /, ""),
      prevStatus: existing.status,
      checkedAt,
      model,
    };
  }
  return { status: "rejected", metadata };
}

/**
 * Write a decision to `mentions`, and return what it did. Call it for every
 * decision, rejected ones too: a rejection writes no row, but it takes the old
 * bot's row, or one an earlier check wrote, out of the count.
 *
 * Every row the article can have is read first: ours, one per tracked rival,
 * and the old bot's. New rows are added and stored ones brought up to date. A
 * row a person decided is never changed, and no second row is added for its
 * company, so their Keep or Reject is not undone under another id. That
 * includes the old bot's row when a person changed it on the old Bot Activity
 * since the import (changedOnOldScreen). A stored row the decision no longer
 * supports is rejected with the reason: "news check: " and the decision's
 * irrelevantReason or "not about <company>". The old bot's row for a company
 * this check was not asked about (a rival no longer tracked) is left alone.
 *
 * Writing the same decision twice leaves the table as writing it once did, so
 * a step that fails part way can simply run again.
 */
export async function writeDecision(
  article: ArticleRow,
  decision: Decision,
  reg: Registry,
  outlets: OutletRef[],
  store: MentionStore = supabaseMentionStore(),
): Promise<WriteCounts> {
  const checkedAt = decision.checkedAt || new Date().toISOString();
  // Which company each row the article can have counts for.
  const owners = new Map<string, string>([[ourMentionId(article.id), reg.us.label]]);
  for (const c of reg.companies) if (!c.isUs) owners.set(rivalMentionId(article.id, c.label), c.label);
  const legacyId = article.legacy_mention_id;
  const stored = new Map((await store.load([...new Set([...owners.keys(), ...(legacyId ? [legacyId] : [])])])).map((r) => [r.id, r]));

  const old = legacyId ? stored.get(legacyId) : undefined;
  const legacy: LegacyRow | null = old
    ? { id: old.id, source: old.source, competitor: (asRecord(old.metadata).competitor as string | undefined) ?? null }
    : null;
  const legacyFor = legacy ? legacyCompany(legacy, reg) : null;
  if (legacy && legacyFor) owners.set(legacy.id, legacyFor);

  const rows = mentionRowsFor(article, decision, reg, outlets, checkedAt, legacy);
  const counts: WriteCounts = { ours: 0, rivals: 0, rejectedLegacy: 0, added: 0, withdrawn: 0, personDecided: 0 };
  const nowCounting = (r: DecidedRow) => {
    if (r.row.source === "googlenews") counts.ours++;
    else counts.rivals++;
  };
  const personal = (row: StoredMention) =>
    decidedByPerson(row) || (row.id === legacy?.id && changedOnOldScreen(row, article.legacy_status));

  // New rows first, in one call, so a failure further on never loses coverage.
  const fresh = rows.filter((r) => !stored.has(r.id));
  const added = new Set(fresh.length ? await store.insert(fresh.map((r) => r.row)) : []);
  for (const r of fresh) {
    if (!added.has(r.id)) continue;
    counts.added++;
    nowCounting(r);
  }

  for (const r of rows) {
    const existing = stored.get(r.id);
    if (!existing) continue;
    if (personal(existing) || !(await store.update(r.id, patchFor(existing, r.row)))) counts.personDecided++;
    else nowCounting(r);
  }

  const written = new Set(rows.map((r) => r.id));
  const decided = new Set(rows.map((r) => r.brand));
  for (const existing of stored.values()) {
    const company = owners.get(existing.id);
    if (!company || written.has(existing.id)) continue;
    if (personal(existing)) {
      counts.personDecided++;
      continue;
    }
    // A company still decided but stored here too: the old bot's row stands for it.
    const reason = decided.has(company)
      ? "news check: already stored in the old bot's row"
      : `news check: ${decision.irrelevantReason || `not about ${company}`}`;
    const counting = existing.status !== "rejected";
    if (!counting && asRecord(existing.metadata).reason === reason) continue;
    if (!(await store.update(existing.id, rejectionPatch(existing, reason, article.id, decision.model, checkedAt)))) {
      counts.personDecided++;
      continue;
    }
    if (!counting) continue;
    if (existing.id === legacy?.id) counts.rejectedLegacy++;
    else counts.withdrawn++;
  }
  return counts;
}

/**
 * The `model` in the fact check of an old row withdrawn as the same story as
 * another article: no AI was asked, the article's address settled it.
 */
export const SAME_ADDRESS = "same address";

/**
 * An imported article the read step found to be another stored article
 * (news_articles.dup_of), the old bot's row it came from, and that row's
 * status when it was imported.
 */
export type SameStory = Pick<ArticleRow, "id" | "legacy_mention_id" | "dup_of" | "legacy_status">;

/**
 * Take the old bot's rows of these imported articles out of the count. Each
 * article turned out to be the same story as another stored article, which
 * counts it from now on, so the old row counting as well would count the story
 * twice. A row is rejected with "news check: the same story as article <id>"
 * and, when it was counting, a failed fact check that keeps its old status,
 * as writeDecision rejects one.
 *
 * Never a row a person decided (the same guards as writeDecision, the old
 * screen's changes included), and the same call again changes nothing, so the
 * publish step can sweep every such article on each run. The old rows are
 * read a few hundred at a time, and only the ones that still need it are
 * written.
 */
export async function withdrawLegacyRows(
  stories: SameStory[],
  store: MentionStore = supabaseMentionStore(),
  checkedAt = new Date().toISOString(),
): Promise<{ withdrawn: number; personDecided: number }> {
  const byRow = new Map<string, { articleId: string; ownerId: string; legacyStatus: string | null | undefined }>();
  for (const s of stories) {
    if (s.legacy_mention_id && s.dup_of && s.dup_of !== s.id) {
      byRow.set(s.legacy_mention_id, { articleId: s.id, ownerId: s.dup_of, legacyStatus: s.legacy_status });
    }
  }
  const counts = { withdrawn: 0, personDecided: 0 };
  for (const part of chunkByLength([...byRow.keys()])) {
    for (const row of await store.load(part)) {
      const story = byRow.get(row.id);
      if (!story) continue;
      if (decidedByPerson(row) || changedOnOldScreen(row, story.legacyStatus)) {
        counts.personDecided++;
        continue;
      }
      const reason = `news check: the same story as article ${story.ownerId}`;
      const counting = row.status !== "rejected";
      if (!counting && asRecord(row.metadata).reason === reason) continue;
      if (!(await store.update(row.id, rejectionPatch(row, reason, story.articleId, SAME_ADDRESS, checkedAt)))) {
        counts.personDecided++;
        continue;
      }
      if (counting) counts.withdrawn++;
    }
  }
  return counts;
}

/**
 * The old bot's row of one imported article that is the same story as article
 * `ownerId`, taken out of the count (withdrawLegacyRows). True when the row was
 * counting and now is not.
 */
export async function withdrawLegacyRow(
  article: Pick<ArticleRow, "id" | "legacy_mention_id" | "legacy_status">,
  ownerId: string,
  store: MentionStore = supabaseMentionStore(),
): Promise<boolean> {
  const story: SameStory = { id: article.id, legacy_mention_id: article.legacy_mention_id, dup_of: ownerId, legacy_status: article.legacy_status };
  const { withdrawn } = await withdrawLegacyRows([story], store);
  return withdrawn > 0;
}

/**
 * Take every row of an article out of the count as a person's Reject, for a
 * step whose write landed while a person was rejecting the article on Bot
 * Activity. Their Reject closes the article first and then marks every row it
 * finds; a row the step added after that is marked here instead, the same way:
 * rejected, with the article's id and their verdict. A row that already
 * carries a person's verdict, or that a person kept, is left as it is, and the
 * same call again changes nothing. Returns how many rows changed.
 */
export async function markPersonRejected(
  article: Pick<ArticleRow, "id" | "legacy_mention_id">,
  reg: Registry,
  store: MentionStore = supabaseMentionStore(),
): Promise<number> {
  const ids = new Set([ourMentionId(article.id), ...reg.companies.filter((c) => !c.isUs).map((c) => rivalMentionId(article.id, c.label))]);
  if (article.legacy_mention_id) ids.add(article.legacy_mention_id);
  let changed = 0;
  for (const row of await store.load([...ids])) {
    const meta = asRecord(row.metadata);
    if (row.status === "reviewed" || meta.personVerdict === "kept" || meta.personVerdict === "rejected") continue;
    const patch = { status: "rejected", metadata: { ...meta, articleId: article.id, personVerdict: "rejected" } };
    if (await store.update(row.id, patch)) changed++;
  }
  return changed;
}

type Db = NonNullable<ReturnType<typeof adminClient>>;

/** The real MentionStore, on the service-role client. A test may hand it a stand-in client. */
export function supabaseMentionStore(db: Db | null = adminClient()): MentionStore {
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return {
    async load(ids) {
      if (!ids.length) return [];
      const { data, error } = await db.from("mentions").select("id,status,source,tags,metadata,raw").in("id", ids);
      if (error) throw new Error(`reading the stored mentions failed: ${error.message}`);
      return (data ?? []) as StoredMention[];
    },
    async insert(rows) {
      if (!rows.length) return [];
      // ignoreDuplicates: a row stored since the read is left as it is. The
      // response then holds only the rows actually added.
      const { data, error } = await db.from("mentions").upsert(rows, { onConflict: "id", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(`adding mentions failed: ${error.message}`);
      return (data ?? []).map((r) => String(r.id));
    },
    async update(id, patch) {
      // The same test as decidedByPerson, made again by the database: a person
      // may have pressed Keep or Reject since the row was read.
      const { data, error } = await db
        .from("mentions")
        .update(patch)
        .eq("id", id)
        .neq("status", "reviewed")
        .is("metadata->>personVerdict", null)
        .select("id");
      if (error) throw new Error(`updating mention ${id} failed: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
  };
}

/**
 * Every outlet on the rate card, for matchOutlet. Throws when the table can't
 * be read: without it every story would be filed as "Other", which reads on
 * the PR page as a fall in Tier 1 coverage. A test may hand it a stand-in client.
 */
export async function loadOutlets(db: Db | null = adminClient()): Promise<OutletRef[]> {
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  // Paged: Supabase returns at most 1,000 rows to one select.
  const PAGE = 1000;
  const out: OutletRef[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("outlets")
      .select("id,name,tier")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`the outlets could not be read: ${error.message}`);
    for (const o of data ?? []) out.push({ id: Number(o.id), name: String(o.name), tier: String(o.tier ?? "Other") });
    if (!data || data.length < PAGE) return out;
  }
}
