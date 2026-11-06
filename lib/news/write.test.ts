import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry } from "@/lib/news/registry";
import {
  SAME_ADDRESS,
  changedOnOldScreen,
  decidedByPerson,
  labelSlug,
  legacyCompany,
  loadOutlets,
  markPersonRejected,
  matchOutlet,
  mentionRowsFor,
  supabaseMentionStore,
  withdrawLegacyRow,
  withdrawLegacyRows,
  writeDecision,
  type MentionStore,
  type OutletRef,
  type SameStory,
  type StoredMention,
} from "@/lib/news/write";
import type { ArticleRow, DecidedMention, Decision } from "@/lib/news/types";

// Nothing here touches the database: writeDecision is handed a stand-in store that keeps rows in a Map.

const reg = buildRegistry(
  [
    { label: "Knight Frank", query: "knight frank dubai" },
    { label: "fäm Properties", query: "fam properties dubai" },
    { label: "Engel & Völkers", query: "engel volkers dubai" },
    { label: "Sotheby's", query: "sothebys realty dubai" },
    { label: "Metropolitan", query: "metropolitan premium properties dubai" },
  ],
  [],
);

const ID = "na_0123456789abcdef0123";
const GOOGLE = "https://news.google.com/rss/articles/CBMiTestOnlyNotARealLink?oc=5";
const ADDRESS = "https://www.khaleejtimes.com/business/property/rents-rise-again";
const CHECKED = "2026-11-05T04:12:00.000Z";
const MODEL = "claude-haiku-5-5";
const LEGACY = "3f2a9c1b7d4e5f60";

// Part of the real rate card: one publication under two spellings with one tier, and another whose two spellings disagree.
const OUTLETS: OutletRef[] = [
  { id: 7, name: "Khaleej Times", tier: "T2" },
  { id: 8, name: "Khaleej TImes", tier: "T2" },
  { id: 12, name: "Gulf News", tier: "T1-Local" },
  { id: 20, name: "Mena FN", tier: "T2" },
  { id: 21, name: "MENA FN", tier: "T3" },
];

function article(over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: ID,
    google_link: GOOGLE,
    url: ADDRESS,
    url_key: "khaleejtimes.com/business/property/rents-rise-again",
    title: "Dubai rents rise again, new market report finds",
    title_key: "dubai rents rise again new market report finds",
    outlet: "Khaleej Times",
    outlet_key: "khaleejtimes",
    published_on: "2026-11-04",
    found_by: ["betterhomes", "knight frank dubai"],
    status: "checking",
    read_attempts: 1,
    ai_attempts: 0,
    body_status: "ok",
    body_chars: 2400,
    read_via: "plain",
    candidates: null,
    decision: null,
    legacy_mention_id: null,
    dup_of: null,
    note: null,
    error: null,
    next_try_at: null,
    claimed_at: CHECKED,
    claimed_by: "run_test",
    first_seen_at: "2026-11-04T04:01:00.000Z",
    updated_at: "2026-11-04T04:05:00.000Z",
    ...over,
  };
}

const OURS: DecidedMention = {
  company: "betterhomes",
  sentence: 2,
  quote: "Rents rose 4 per cent, according to an analysis of Dubai Land Department data by Betterhomes.",
  role: "data",
  sentiment: "positive",
};
const KNIGHT_FRANK: DecidedMention = {
  company: "Knight Frank",
  sentence: 3,
  quote: "Louis Harding, chief executive of Knight Frank Middle East, said overseas buyers were driving demand.",
  role: "spokesperson",
  sentiment: "neutral",
};
const FAM: DecidedMention = {
  company: "fäm Properties",
  sentence: 4,
  quote: "Firas Al Msaddi, chief executive of fäm Properties, said the rise would continue into next year.",
  role: "spokesperson",
  sentiment: "mixed",
};

function decision(mentions: DecidedMention[], over: Partial<Decision> = {}): Decision {
  return { mentions, irrelevantReason: null, possibleMoves: [], dropped: [], model: MODEL, checkedAt: CHECKED, ...over };
}

const pass = (m: DecidedMention) => ({
  result: "pass",
  role: m.role,
  quote: m.quote,
  sentence: m.sentence,
  checkedAt: CHECKED,
  model: MODEL,
});

test("our mention is one googlenews row, shaped like the rows the PR page already reads", () => {
  assert.deepEqual(mentionRowsFor(article(), decision([OURS]), reg, OUTLETS, CHECKED), [
    {
      id: `nb_${ID}`,
      brand: "betterhomes",
      legacy: false,
      row: {
        id: `nb_${ID}`,
        published_on: "2026-11-04",
        outlet_name: "Khaleej Times",
        title: "Dubai rents rise again, new market report finds",
        url: ADDRESS,
        eav: null,
        reach: null,
        media_type: "online",
        tags: ["leasing", "market-report"],
        tier: "T2",
        outlet_id: 7,
        brand: "betterhomes",
        sentiment: "positive",
        source: "googlenews",
        status: "new",
        raw: { link: GOOGLE, resolved: ADDRESS, outlet: "Khaleej Times" },
        metadata: {
          articleId: ID,
          keywords: ["betterhomes", "knight frank dubai"],
          bodyStatus: "ok",
          readVia: "plain",
          factCheck: pass(OURS),
        },
      },
    },
  ]);
});

test("a rival's row is competitor_news under its label exactly, with a stable ascii id", () => {
  const [fam] = mentionRowsFor(article(), decision([FAM]), reg, OUTLETS, CHECKED);
  assert.equal(fam.id, `nr_${ID}_fam-properties`);
  assert.equal(fam.row.id, fam.id);
  assert.match(fam.id, /^[a-z0-9_-]+$/);
  assert.equal(fam.brand, "fäm Properties");
  assert.equal(fam.legacy, false);
  assert.equal(fam.row.source, "competitor_news");
  assert.equal(fam.row.brand, null);
  assert.equal(fam.row.metadata.competitor, "fäm Properties");
  assert.equal(fam.row.sentiment, "mixed");
  assert.deepEqual(fam.row.metadata.factCheck, pass(FAM));
  assert.equal(fam.row.status, "new");

  // The same label always gives the same id, on any day and however its letters are encoded.
  assert.equal(mentionRowsFor(article(), decision([FAM]), reg, OUTLETS, "2026-12-01T04:00:00.000Z")[0].id, fam.id);
  assert.equal(labelSlug("fäm Properties"), "fam-properties");
  assert.equal(labelSlug("fa\u0308m Properties"), "fam-properties");
  assert.equal(labelSlug("Engel & Völkers"), "engel-volkers");
  assert.equal(labelSlug("Sotheby's"), "sothebys");
  assert.equal(labelSlug("Sotheby\u2019s"), "sothebys");
  assert.equal(labelSlug("  Knight   Frank "), "knight-frank");
  // A label with no Latin letters at all still gets an id of its own.
  assert.match(labelSlug("بيوت دبي"), /^[0-9a-f]{12}$/);
  assert.equal(labelSlug("بيوت دبي"), labelSlug("بيوت دبي"));
  assert.notEqual(labelSlug("بيوت دبي"), labelSlug("عقارات"));
});

test("an article about us and a rival gives one row for each, each with its own proof", () => {
  const rows = mentionRowsFor(article(), decision([OURS, KNIGHT_FRANK]), reg, OUTLETS, CHECKED);
  assert.deepEqual(
    rows.map((r) => [r.id, r.brand, r.row.source, r.row.brand, r.row.metadata.competitor, r.row.sentiment]),
    [
      [`nb_${ID}`, "betterhomes", "googlenews", "betterhomes", undefined, "positive"],
      [`nr_${ID}_knight-frank`, "Knight Frank", "competitor_news", null, "Knight Frank", "neutral"],
    ],
  );
  assert.deepEqual(rows[0].row.metadata.factCheck, pass(OURS));
  assert.deepEqual(rows[1].row.metadata.factCheck, pass(KNIGHT_FRANK));
  // The placement itself is the same story at the same outlet on both.
  const placement = ({ row }: (typeof rows)[number]) => {
    const { published_on, outlet_name, title, url, tier, outlet_id, tags, raw, status, media_type } = row;
    return { published_on, outlet_name, title, url, tier, outlet_id, tags, raw, status, media_type };
  };
  assert.deepEqual(placement(rows[0]), placement(rows[1]));
});

test("metadata.competitor is the registry's label exactly, whatever spelling the decision used", () => {
  const spelt = (company: string) => ({ ...KNIGHT_FRANK, company });
  const rows = mentionRowsFor(
    article(),
    decision([
      spelt("knight frank"),
      spelt("fam Properties"),
      spelt("Engel & Volkers"),
      spelt("Sotheby\u2019s"),
      spelt("Metropolitan Premium Properties"),
    ]),
    reg,
    OUTLETS,
    CHECKED,
  );
  const labels = ["Knight Frank", "fäm Properties", "Engel & Völkers", "Sotheby's", "Metropolitan"];
  assert.deepEqual(
    rows.map((r) => r.row.metadata.competitor),
    labels,
  );
  assert.deepEqual(
    rows.map((r) => r.brand),
    labels,
  );
});

test("a company the registry doesn't know adds no row, and one named twice adds one", () => {
  const rows = mentionRowsFor(
    article(),
    decision([{ ...KNIGHT_FRANK, company: "Savills" }, OURS, { ...OURS, sentence: 5, quote: "Betterhomes agents agreed." }]),
    reg,
    OUTLETS,
    CHECKED,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [`nb_${ID}`],
  );
  assert.equal(rows[0].row.metadata.factCheck.sentence, 2);
  assert.deepEqual(mentionRowsFor(article(), decision([]), reg, OUTLETS, CHECKED), []);
});

test("the tier and outlet come from the rate card, matched by the outlet's name", () => {
  const tierOf = (outlet: string | null, url: string | null = null) => {
    const [r] = mentionRowsFor(article({ outlet, url }), decision([OURS]), reg, OUTLETS, CHECKED);
    return [r.row.tier, r.row.outlet_id];
  };
  assert.deepEqual(tierOf("Khaleej Times"), ["T2", 7]);
  assert.deepEqual(tierOf("Gulf News"), ["T1-Local", 12]);
  // In any case, and named by its web address the way the feed sometimes does.
  assert.deepEqual(tierOf("GULF NEWS"), ["T1-Local", 12]);
  assert.deepEqual(tierOf("khaleejtimes.com"), ["T2", 7]);
  // Not on the card: Other, and no outlet.
  assert.deepEqual(tierOf("Some Property Blog"), ["Other", null]);
  // Two spellings on the card with different tiers settle nothing, and the exact one still does.
  assert.deepEqual(tierOf("Mena Fn"), ["Other", null]);
  assert.deepEqual(tierOf("MENA FN"), ["T3", 21]);
  // No outlet name, but the publisher's own address is known.
  assert.deepEqual(tierOf(null, "https://gulfnews.com/business/property/rents-rise"), ["T1-Local", 12]);
  // A Google link names no publisher, and an empty card matches nothing.
  assert.equal(matchOutlet(OUTLETS, null, GOOGLE), null);
  assert.equal(matchOutlet([], "Gulf News", null), null);
});

test("the row links to the publisher's address, or to the Google link until it is known", () => {
  const [r] = mentionRowsFor(article({ url: null, url_key: null }), decision([OURS]), reg, OUTLETS, CHECKED);
  assert.equal(r.row.url, GOOGLE);
  assert.deepEqual(r.row.raw, { link: GOOGLE, resolved: null, outlet: "Khaleej Times" });
});

test("an article from the old bot reuses that bot's googlenews row for ours", () => {
  const old = { id: LEGACY, source: "googlenews", competitor: null };
  const rows = mentionRowsFor(article({ legacy_mention_id: LEGACY }), decision([OURS, KNIGHT_FRANK]), reg, OUTLETS, CHECKED, old);
  assert.deepEqual(
    rows.map((r) => [r.id, r.row.id, r.brand, r.legacy, r.row.source, r.row.brand]),
    [
      [LEGACY, LEGACY, "betterhomes", true, "googlenews", "betterhomes"],
      [`nr_${ID}_knight-frank`, `nr_${ID}_knight-frank`, "Knight Frank", false, "competitor_news", null],
    ],
  );
  assert.deepEqual(rows[0].row.metadata.factCheck, pass(OURS));

  // Only the row the article itself names is ever reused.
  assert.equal(mentionRowsFor(article(), decision([OURS]), reg, OUTLETS, CHECKED, old)[0].id, `nb_${ID}`);
  assert.equal(mentionRowsFor(article({ legacy_mention_id: "another" }), decision([OURS]), reg, OUTLETS, CHECKED, old)[0].id, `nb_${ID}`);
  // An old row of ours is not a rival's, so a rival-only decision leaves it out.
  assert.deepEqual(
    mentionRowsFor(article({ legacy_mention_id: LEGACY }), decision([KNIGHT_FRANK]), reg, OUTLETS, CHECKED, old).map((r) => r.legacy),
    [false],
  );
});

test("an old rival's row stands for that rival under the label the registry has now", () => {
  const old = { id: LEGACY, source: "competitor_news", competitor: "Engel & Volkers" };
  const [ev] = mentionRowsFor(
    article({ legacy_mention_id: LEGACY }),
    decision([{ ...KNIGHT_FRANK, company: "Engel & Völkers" }]),
    reg,
    OUTLETS,
    CHECKED,
    old,
  );
  assert.deepEqual([ev.id, ev.legacy, ev.row.source, ev.row.metadata.competitor], [LEGACY, true, "competitor_news", "Engel & Völkers"]);
  assert.equal(legacyCompany(old, reg), "Engel & Völkers");
  // Any row that isn't a rival's counted for us on the PR page, so it is ours here too.
  assert.equal(legacyCompany({ id: "x", source: "historical_import", competitor: null }, reg), "betterhomes");
  // A rival no longer tracked: the check was never asked about it.
  assert.equal(legacyCompany({ id: "x", source: "competitor_news", competitor: "Savills" }, reg), null);
  assert.equal(legacyCompany({ id: "x", source: "competitor_news", competitor: null }, reg), null);
});

test("a row a person kept or rejected is recognised, whichever screen they used", () => {
  assert.equal(decidedByPerson({ status: "reviewed", metadata: {} }), true);
  assert.equal(decidedByPerson({ status: "rejected", metadata: { personVerdict: "rejected", reason: "news check: not about betterhomes" } }), true);
  assert.equal(decidedByPerson({ status: "new", metadata: { personVerdict: "kept" } }), true);
  // The old Bot Activity's Reject changed the status alone, on a row whose fact check had passed.
  assert.equal(decidedByPerson({ status: "rejected", metadata: { factCheck: pass(OURS) } }), true);
  assert.equal(decidedByPerson({ status: "rejected", metadata: { factCheck: { role: "spokesperson", quote: "q", why: "w" } } }), true);
  // The bot's own rejections give their reason.
  assert.equal(decidedByPerson({ status: "rejected", metadata: { reason: "fact check: not about us", factCheck: { result: "fail" } } }), false);
  assert.equal(decidedByPerson({ status: "rejected", metadata: { reason: "pending re-read: article not read (blocked), so not counted" } }), false);
  // Before the fact check the bot gave no reason either, so a bare rejection proves nothing.
  assert.equal(decidedByPerson({ status: "rejected", metadata: { hasBody: true } }), false);
  assert.equal(decidedByPerson({ status: "new", metadata: null }), false);
});

// ── writeDecision, against a stand-in for the mentions table ──────────

type Row = Record<string, unknown>;

/** The mentions table in a Map. Like the real one, update refuses a row a person has decided. */
function fakeTable(rows: Row[] = []) {
  const table = new Map<string, Row>(rows.map((r) => [String(r.id), structuredClone(r)]));
  const calls = { loads: [] as string[][], inserted: [] as string[], updated: [] as string[] };
  const store: MentionStore = {
    async load(ids) {
      calls.loads.push(ids);
      return ids.filter((id) => table.has(id)).map((id) => structuredClone(table.get(id)) as StoredMention);
    },
    async insert(list) {
      const added: string[] = [];
      for (const r of list) {
        if (table.has(r.id)) continue;
        table.set(r.id, structuredClone(r));
        added.push(r.id);
      }
      calls.inserted.push(...added);
      return added;
    },
    async update(id, patch) {
      const r = table.get(id);
      if (!r || r.status === "reviewed" || meta(r).personVerdict != null) return false;
      table.set(id, { ...r, ...structuredClone(patch) });
      calls.updated.push(id);
      return true;
    },
  };
  return { table, calls, store };
}

const meta = (r: Row | undefined) => (r?.metadata ?? {}) as Record<string, unknown>;

/** A row as the old bot, or an earlier check, left it. */
function storedRow(id: string, over: Row = {}): Row {
  return {
    id,
    published_on: "2026-11-04",
    outlet_name: "Khaleej Times",
    title: "Dubai rents rise again, new market report finds",
    url: GOOGLE,
    eav: null,
    reach: null,
    media_type: "online",
    tier: "T2",
    outlet_id: 7,
    brand: "betterhomes",
    sentiment: "neutral",
    source: "googlenews",
    status: "new",
    tags: ["leasing"],
    raw: { link: GOOGLE, source: "Khaleej Times", pubDate: "2026-11-04" },
    metadata: { bodyStatus: "blocked", keywords: ["betterhomes"] },
    ...over,
  };
}

const rival = (label: string, over: Row = {}) =>
  storedRow(`nr_${ID}_${labelSlug(label)}`, {
    source: "competitor_news",
    brand: null,
    metadata: { articleId: ID, competitor: label, factCheck: pass(KNIGHT_FRANK) },
    ...over,
  });

const none = { ours: 0, rivals: 0, rejectedLegacy: 0, added: 0, withdrawn: 0, personDecided: 0 };

test("new rows are added in one call and counted by company", async () => {
  const { table, calls, store } = fakeTable();
  const counts = await writeDecision(article(), decision([OURS, KNIGHT_FRANK]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, ours: 1, rivals: 1, added: 2 });
  assert.deepEqual(calls.inserted, [`nb_${ID}`, `nr_${ID}_knight-frank`]);
  assert.deepEqual(calls.updated, []);
  // Exactly the rows mentionRowsFor makes, proved at the time the decision was checked.
  const expected = mentionRowsFor(article(), decision([OURS, KNIGHT_FRANK]), reg, OUTLETS, CHECKED);
  assert.deepEqual(table.get(`nb_${ID}`), expected[0].row);
  assert.deepEqual(table.get(`nr_${ID}_knight-frank`), expected[1].row);
  // It looked, in one read, for every row the article could already have: ours and one per rival.
  assert.equal(calls.loads.length, 1);
  assert.deepEqual(
    [...calls.loads[0]].sort(),
    [`nb_${ID}`, ...["Knight Frank", "fäm Properties", "Engel & Völkers", "Sotheby's", "Metropolitan"].map((l) => `nr_${ID}_${labelSlug(l)}`)].sort(),
  );
});

test("a row a person decided is never changed, and no second row is added for its company", async () => {
  const kept = storedRow(`nb_${ID}`, { status: "reviewed" });
  const rejected = rival("Knight Frank", { status: "rejected", metadata: { competitor: "Knight Frank", personVerdict: "rejected" } });
  const keptRival = rival("fäm Properties", { metadata: { competitor: "fäm Properties", personVerdict: "kept" } });
  const { table, calls, store } = fakeTable([kept, rejected, keptRival]);
  const counts = await writeDecision(article(), decision([OURS, KNIGHT_FRANK, FAM]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, personDecided: 3 });
  assert.deepEqual(calls.inserted, []);
  assert.deepEqual(calls.updated, []);
  assert.deepEqual(table.get(kept.id as string), kept);
  assert.deepEqual(table.get(rejected.id as string), rejected);
  assert.deepEqual(table.get(keptRival.id as string), keptRival);
  // Nor are they taken out of the count when the check disagrees.
  const again = await writeDecision(article(), decision([]), reg, OUTLETS, store);
  assert.deepEqual(again, { ...none, personDecided: 3 });
  assert.deepEqual(calls.updated, []);
});

test("a person's verdict on the old bot's row stands, and the story is not counted again under a new id", async () => {
  const rejectedByPerson = storedRow(LEGACY, { status: "rejected", metadata: { personVerdict: "rejected" } });
  const first = fakeTable([rejectedByPerson]);
  const counts = await writeDecision(article({ legacy_mention_id: LEGACY }), decision([OURS]), reg, OUTLETS, first.store);
  assert.deepEqual(counts, { ...none, personDecided: 1 });
  assert.deepEqual(first.calls.inserted, []);
  assert.deepEqual(first.table.get(LEGACY), rejectedByPerson);
  assert.equal(first.table.has(`nb_${ID}`), false);

  // Rejected on the old Bot Activity, which changed the status and nothing else.
  const oldScreen = storedRow(LEGACY, { status: "rejected", metadata: { factCheck: { result: "pass", role: "passing", quote: "q" } } });
  const second = fakeTable([oldScreen]);
  assert.deepEqual(await writeDecision(article({ legacy_mention_id: LEGACY }), decision([OURS]), reg, OUTLETS, second.store), {
    ...none,
    personDecided: 1,
  });
  assert.deepEqual(second.table.get(LEGACY), oldScreen);
  assert.equal(second.table.has(`nb_${ID}`), false);
});

test("a person's verdict that lands while the bot is writing still stands", async () => {
  const { table, store } = fakeTable([storedRow(`nb_${ID}`)]);
  const racing: MentionStore = {
    ...store,
    async load(ids) {
      const rows = await store.load(ids);
      // Reject is pressed just after the bot read the row.
      table.set(`nb_${ID}`, { ...table.get(`nb_${ID}`)!, status: "rejected", metadata: { personVerdict: "rejected" } });
      return rows;
    },
  };
  const counts = await writeDecision(article(), decision([OURS]), reg, OUTLETS, racing);
  assert.deepEqual(counts, { ...none, personDecided: 1 });
  assert.equal(table.get(`nb_${ID}`)!.status, "rejected");
  assert.deepEqual(meta(table.get(`nb_${ID}`)), { personVerdict: "rejected" });
});

test("a row stored before is brought up to date, keeping whatever the bot doesn't know", async () => {
  const before = storedRow(`nb_${ID}`, {
    status: "rejected",
    eav: 5200,
    tier: "T1-Local",
    outlet_id: 12,
    tags: ["top-50"],
    raw: { link: GOOGLE, pubDate: "2026-11-04" },
    metadata: {
      articleId: ID,
      reason: "news check: not about betterhomes",
      factCheck: { result: "fail", why: "not about betterhomes", prevStatus: "new" },
      notedBy: "PR team",
    },
  });
  const { table, store } = fakeTable([before]);
  // An outlet the rate card doesn't have, so the tier the row has is the best known.
  const blog = article({ outlet: "Some Property Blog", url: "https://someblog.example/rents-rise", body_status: null });
  const counts = await writeDecision(blog, decision([OURS]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, ours: 1 });
  assert.deepEqual(table.get(`nb_${ID}`), {
    ...before,
    status: "new",
    outlet_name: "Some Property Blog",
    url: "https://someblog.example/rents-rise",
    sentiment: "positive",
    tags: ["top-50", "leasing", "market-report"],
    raw: { link: GOOGLE, pubDate: "2026-11-04", resolved: "https://someblog.example/rents-rise", outlet: "Some Property Blog" },
    metadata: {
      articleId: ID,
      notedBy: "PR team",
      keywords: ["betterhomes", "knight frank dubai"],
      readVia: "plain",
      factCheck: pass(OURS),
    },
  });
});

test("the old bot's row is brought up to date for its brand, so the story counts once", async () => {
  const old = storedRow(LEGACY, {
    status: "rejected",
    metadata: { reason: "pending re-read: article not read (blocked), so not counted", hasBody: false },
  });
  const { table, calls, store } = fakeTable([old]);
  const counts = await writeDecision(article({ legacy_mention_id: LEGACY }), decision([OURS]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, ours: 1 });
  assert.ok(calls.loads[0].includes(LEGACY));
  assert.deepEqual(calls.inserted, []);
  assert.deepEqual(calls.updated, [LEGACY]);
  assert.equal(table.has(`nb_${ID}`), false);
  const row = table.get(LEGACY)!;
  assert.equal(row.status, "new");
  assert.equal(row.source, "googlenews");
  assert.equal(row.url, ADDRESS);
  assert.deepEqual(meta(row), {
    hasBody: false,
    articleId: ID,
    keywords: ["betterhomes", "knight frank dubai"],
    bodyStatus: "ok",
    readVia: "plain",
    factCheck: pass(OURS),
  });
});

test("the old bot's row stops counting when the check finds the story isn't about its brand", async () => {
  const old = storedRow(LEGACY);
  const { table, calls, store } = fakeTable([old]);
  const counts = await writeDecision(article({ legacy_mention_id: LEGACY }), decision([KNIGHT_FRANK]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, rivals: 1, rejectedLegacy: 1, added: 1 });
  assert.deepEqual(calls.inserted, [`nr_${ID}_knight-frank`]);
  // Only its status and metadata change, and the status it had is kept for the PR page's list of drops.
  assert.deepEqual(table.get(LEGACY), {
    ...old,
    status: "rejected",
    metadata: {
      bodyStatus: "blocked",
      keywords: ["betterhomes"],
      articleId: ID,
      reason: "news check: not about betterhomes",
      factCheck: { result: "fail", why: "not about betterhomes", prevStatus: "new", checkedAt: CHECKED, model: MODEL },
    },
  });
  // The same decision again changes nothing.
  assert.deepEqual(await writeDecision(article({ legacy_mention_id: LEGACY }), decision([KNIGHT_FRANK]), reg, OUTLETS, store), {
    ...none,
    rivals: 1,
  });
  assert.deepEqual(calls.updated, [LEGACY, `nr_${ID}_knight-frank`]);
  assert.equal(table.get(LEGACY)!.status, "rejected");
});

test("a rejected article takes the old bot's row out of the count with the AI's reason", async () => {
  const { table, calls, store } = fakeTable([storedRow(LEGACY)]);
  const rejected = decision([], { irrelevantReason: "about Better Homes & Gardens, a different company" });
  const counts = await writeDecision(article({ legacy_mention_id: LEGACY }), rejected, reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, rejectedLegacy: 1 });
  assert.deepEqual(calls.inserted, []);
  assert.equal(table.get(LEGACY)!.status, "rejected");
  assert.equal(meta(table.get(LEGACY)).reason, "news check: about Better Homes & Gardens, a different company");

  // A row the old bot had already rejected gets the new reason, keeps its old fact check, and was not counting anyway.
  const before = storedRow(LEGACY, {
    status: "rejected",
    metadata: {
      reason: "pending re-read: article not read (blocked), so not counted",
      factCheck: { result: "unread", bodyStatus: "blocked", prevStatus: "new" },
    },
  });
  const earlier = fakeTable([before]);
  assert.deepEqual(await writeDecision(article({ legacy_mention_id: LEGACY }), rejected, reg, OUTLETS, earlier.store), none);
  assert.deepEqual(meta(earlier.table.get(LEGACY)), {
    reason: "news check: about Better Homes & Gardens, a different company",
    factCheck: { result: "unread", bodyStatus: "blocked", prevStatus: "new" },
    articleId: ID,
  });
});

test("the old bot's row is left alone when a person kept it, or when its rival is no longer tracked", async () => {
  const kept = storedRow(LEGACY, { status: "reviewed" });
  const first = fakeTable([kept]);
  assert.deepEqual(await writeDecision(article({ legacy_mention_id: LEGACY }), decision([KNIGHT_FRANK]), reg, OUTLETS, first.store), {
    ...none,
    rivals: 1,
    added: 1,
    personDecided: 1,
  });
  assert.deepEqual(first.table.get(LEGACY), kept);

  const savills = storedRow(LEGACY, { source: "competitor_news", brand: null, metadata: { competitor: "Savills" } });
  const second = fakeTable([savills]);
  assert.deepEqual(await writeDecision(article({ legacy_mention_id: LEGACY }), decision([OURS]), reg, OUTLETS, second.store), {
    ...none,
    ours: 1,
    added: 1,
  });
  assert.deepEqual(second.table.get(LEGACY), savills);
  assert.deepEqual(second.calls.inserted, [`nb_${ID}`]);
});

test("a row an earlier check wrote stops counting when this check no longer supports it", async () => {
  const kf = rival("Knight Frank");
  const { table, store } = fakeTable([kf]);
  const counts = await writeDecision(article(), decision([OURS]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, ours: 1, added: 1, withdrawn: 1 });
  assert.equal(table.get(kf.id as string)!.status, "rejected");
  assert.equal(meta(table.get(kf.id as string)).reason, "news check: not about Knight Frank");
  assert.equal(meta(table.get(kf.id as string)).competitor, "Knight Frank");
});

test("a story stored both as the old bot's row and as our new row keeps only the old one", async () => {
  // The article was checked, then matched to the old bot's row of the same story.
  const ours = storedRow(`nb_${ID}`, { metadata: { articleId: ID, factCheck: pass(OURS) } });
  const old = storedRow(LEGACY);
  const { table, store } = fakeTable([ours, old]);
  const counts = await writeDecision(article({ legacy_mention_id: LEGACY }), decision([OURS]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, ours: 1, withdrawn: 1 });
  assert.equal(table.get(LEGACY)!.status, "new");
  assert.equal(table.get(`nb_${ID}`)!.status, "rejected");
  assert.equal(meta(table.get(`nb_${ID}`)).reason, "news check: already stored in the old bot's row");
});

test("a rejected article with nothing stored writes nothing", async () => {
  const { calls, store } = fakeTable();
  assert.deepEqual(await writeDecision(article(), decision([], { irrelevantReason: "a different company" }), reg, OUTLETS, store), none);
  assert.deepEqual(calls.inserted, []);
  assert.deepEqual(calls.updated, []);
});

// ── the real store and the rate card, against a client that records its calls ──

type Answer = { data: unknown; error: { message: string } | null };

/** A stand-in Supabase client: every call is recorded, and each query answers with the next of `answers`. */
function recordingClient(...answers: Answer[]) {
  const calls: unknown[][] = [];
  const query: Record<string, unknown> = {
    then: (resolve: (value: Answer) => unknown) => resolve(answers.shift() ?? { data: [], error: null }),
  };
  for (const name of ["select", "in", "upsert", "update", "eq", "neq", "is", "order", "range"]) {
    query[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return query;
    };
  }
  const client = {
    from: (table: string) => {
      calls.push(["from", table]);
      return query;
    },
  };
  return { client: client as unknown as Parameters<typeof supabaseMentionStore>[0], calls };
}

const failing = () => recordingClient({ data: null, error: { message: "connection reset" } }).client;

test("the real store reads, adds and updates mentions the way the rules above need", async () => {
  const stored: StoredMention = { id: `nb_${ID}`, status: "new", source: "googlenews", tags: [], metadata: {}, raw: null };
  const reads = recordingClient({ data: [stored], error: null });
  assert.deepEqual(await supabaseMentionStore(reads.client).load([`nb_${ID}`, `nr_${ID}_knight-frank`]), [stored]);
  assert.deepEqual(reads.calls, [
    ["from", "mentions"],
    ["select", "id,status,source,tags,metadata,raw"],
    ["in", "id", [`nb_${ID}`, `nr_${ID}_knight-frank`]],
  ]);

  // New rows go in as an upsert on id that leaves a stored row alone, and only what was added comes back.
  const [ours] = mentionRowsFor(article(), decision([OURS]), reg, OUTLETS, CHECKED);
  const adds = recordingClient({ data: [{ id: ours.id }], error: null });
  assert.deepEqual(await supabaseMentionStore(adds.client).insert([ours.row]), [ours.id]);
  assert.deepEqual(adds.calls, [
    ["from", "mentions"],
    ["upsert", [ours.row], { onConflict: "id", ignoreDuplicates: true }],
    ["select", "id"],
  ]);

  // A plain update, which the database applies only while nobody has kept or judged the row.
  const patch = { status: "rejected" };
  const updates = recordingClient({ data: [{ id: ours.id }], error: null }, { data: [], error: null });
  const store = supabaseMentionStore(updates.client);
  assert.equal(await store.update(ours.id, patch), true);
  assert.equal(await store.update(ours.id, patch), false);
  assert.deepEqual(updates.calls.slice(0, 6), [
    ["from", "mentions"],
    ["update", patch],
    ["eq", "id", ours.id],
    ["neq", "status", "reviewed"],
    ["is", "metadata->>personVerdict", null],
    ["select", "id"],
  ]);

  // Nothing to read or add asks nothing of the database.
  const idle = recordingClient();
  assert.deepEqual(await supabaseMentionStore(idle.client).load([]), []);
  assert.deepEqual(await supabaseMentionStore(idle.client).insert([]), []);
  assert.deepEqual(idle.calls, []);

  // A failed call is an error, never an empty answer, and with no service key there is no store.
  await assert.rejects(supabaseMentionStore(failing()).load([ours.id]), /reading the stored mentions failed: connection reset/);
  await assert.rejects(supabaseMentionStore(failing()).insert([ours.row]), /adding mentions failed: connection reset/);
  await assert.rejects(supabaseMentionStore(failing()).update(ours.id, patch), new RegExp(`updating mention ${ours.id} failed: connection reset`));
  assert.throws(() => supabaseMentionStore(null), /SUPABASE_SERVICE_ROLE_KEY not set/);
});

test("the rate card is read whole, a thousand rows at a time, and a failed read is an error", async () => {
  const card = (first: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: first + i, name: `Outlet ${first + i}`, tier: "T3" }));
  const pages = recordingClient({ data: card(1, 1000), error: null }, { data: [...card(1001, 2), { id: 1003, name: "Untiered", tier: null }], error: null });
  const outlets = await loadOutlets(pages.client);
  assert.equal(outlets.length, 1003);
  assert.deepEqual(outlets[1000], { id: 1001, name: "Outlet 1001", tier: "T3" });
  assert.deepEqual(outlets[1002], { id: 1003, name: "Untiered", tier: "Other" });
  assert.deepEqual(pages.calls.slice(0, 4), [
    ["from", "outlets"],
    ["select", "id,name,tier"],
    ["order", "id", { ascending: true }],
    ["range", 0, 999],
  ]);
  assert.deepEqual(
    pages.calls.filter((c) => c[0] === "range"),
    [
      ["range", 0, 999],
      ["range", 1000, 1999],
    ],
  );
  await assert.rejects(loadOutlets(failing()), /the outlets could not be read: connection reset/);
  await assert.rejects(loadOutlets(null), /SUPABASE_SERVICE_ROLE_KEY not set/);
});

// ── the old row of an imported duplicate ──────────────────────────────

test("an imported duplicate's old row stops counting, as the same story as the article that counts it now", async () => {
  const old = storedRow(LEGACY);
  const { table, calls, store } = fakeTable([old]);
  const dup = { id: `lm_${LEGACY}`, legacy_mention_id: LEGACY };
  assert.equal(await withdrawLegacyRow(dup, "na_owner", store), true);
  const row = table.get(LEGACY)!;
  assert.equal(row.status, "rejected");
  const { factCheck, ...rest } = meta(row);
  assert.deepEqual(rest, {
    bodyStatus: "blocked",
    keywords: ["betterhomes"],
    articleId: dup.id,
    reason: "news check: the same story as article na_owner",
  });
  // A failed check that keeps the status it had, as writeDecision leaves one, with no AI named.
  const check = factCheck as Record<string, unknown>;
  assert.deepEqual([check.result, check.why, check.prevStatus, check.model], ["fail", "the same story as article na_owner", "new", SAME_ADDRESS]);
  assert.ok(!Number.isNaN(Date.parse(String(check.checkedAt))));
  // Only its status and metadata change.
  assert.deepEqual({ ...row, status: old.status, metadata: old.metadata }, old);

  // The same call again changes nothing, and nor does one for an article with no old row.
  assert.equal(await withdrawLegacyRow(dup, "na_owner", store), false);
  assert.equal(await withdrawLegacyRow({ id: "na_new", legacy_mention_id: null }, "na_owner", store), false);
  assert.deepEqual(calls.updated, [LEGACY]);
});

test("a person's verdict on an old row stands, and a row already out of the count only gets the new reason", async () => {
  const kept = storedRow("old_kept", { status: "reviewed" });
  const rejected = storedRow("old_rejected", { status: "rejected", metadata: { personVerdict: "rejected" } });
  // Rejected on the old Bot Activity, which set the status and nothing else.
  const oldScreen = storedRow("old_screen", { status: "rejected", metadata: { factCheck: { result: "pass", role: "data", quote: "q" } } });
  const pending = storedRow("old_pending", {
    status: "rejected",
    metadata: { reason: "pending re-read: article not read (blocked), so not counted", factCheck: { result: "unread", prevStatus: "new" } },
  });
  const counting = storedRow("old_counting", { source: "competitor_news", brand: null, metadata: { competitor: "Knight Frank" } });
  const { table, calls, store } = fakeTable([kept, rejected, oldScreen, pending, counting]);
  const stories: SameStory[] = [
    { id: "lm_kept", legacy_mention_id: "old_kept", dup_of: "na_1" },
    { id: "lm_rejected", legacy_mention_id: "old_rejected", dup_of: "na_1" },
    { id: "lm_screen", legacy_mention_id: "old_screen", dup_of: "na_1" },
    { id: "lm_pending", legacy_mention_id: "old_pending", dup_of: "na_2" },
    { id: "lm_counting", legacy_mention_id: "old_counting", dup_of: "na_3" },
    // Not imported, a copy of nothing, a copy of itself, or an old row since deleted: nothing to do.
    { id: "na_x", legacy_mention_id: null, dup_of: "na_1" },
    { id: "lm_y", legacy_mention_id: "old_y", dup_of: null },
    { id: "lm_z", legacy_mention_id: "old_z", dup_of: "lm_z" },
    { id: "lm_gone", legacy_mention_id: "old_gone", dup_of: "na_1" },
  ];
  assert.deepEqual(await withdrawLegacyRows(stories, store, CHECKED), { withdrawn: 1, personDecided: 3 });
  for (const row of [kept, rejected, oldScreen]) assert.deepEqual(table.get(row.id as string), row);
  assert.deepEqual(meta(table.get("old_pending")), {
    reason: "news check: the same story as article na_2",
    factCheck: { result: "unread", prevStatus: "new" },
    articleId: "lm_pending",
  });
  // A rival's old row goes the same way: the article it copies counts the story for that rival now.
  assert.equal(table.get("old_counting")!.status, "rejected");
  assert.deepEqual(meta(table.get("old_counting")), {
    competitor: "Knight Frank",
    articleId: "lm_counting",
    reason: "news check: the same story as article na_3",
    factCheck: { result: "fail", why: "the same story as article na_3", prevStatus: "new", checkedAt: CHECKED, model: SAME_ADDRESS },
  });
  // Swept again, nothing more is written.
  const updatedOnce = [...calls.updated];
  assert.deepEqual(await withdrawLegacyRows(stories, store, CHECKED), { withdrawn: 0, personDecided: 3 });
  assert.deepEqual(calls.updated, updatedOnce);
});

test("a Keep pressed while the old rows are being withdrawn still stands", async () => {
  const { table, store } = fakeTable([storedRow(LEGACY)]);
  const racing: MentionStore = {
    ...store,
    async load(ids) {
      const rows = await store.load(ids);
      table.set(LEGACY, { ...table.get(LEGACY)!, metadata: { personVerdict: "kept" } });
      return rows;
    },
  };
  assert.deepEqual(await withdrawLegacyRows([{ id: "lm_1", legacy_mention_id: LEGACY, dup_of: "na_1" }], racing, CHECKED), {
    withdrawn: 0,
    personDecided: 1,
  });
  assert.equal(table.get(LEGACY)!.status, "new");
});

test("many old rows are read a few hundred at a time, each once", async () => {
  const stories = Array.from({ length: 600 }, (_, i) => ({ id: `lm_${i}`, legacy_mention_id: `${String(i).padStart(16, "0")}`, dup_of: "na_1" }));
  const { calls, store } = fakeTable();
  assert.deepEqual(await withdrawLegacyRows(stories, store, CHECKED), { withdrawn: 0, personDecided: 0 });
  assert.ok(calls.loads.length > 2);
  assert.ok(calls.loads.every((ids) => ids.length <= 200));
  assert.deepEqual(calls.loads.flat(), stories.map((s) => s.legacy_mention_id));
  // Nothing to withdraw asks nothing.
  const idle = fakeTable();
  await withdrawLegacyRows([], idle.store, CHECKED);
  assert.deepEqual(idle.calls.loads, []);
});

// ── a person's change on the old Bot Activity, made after the import ──────

test("an old row whose status changed since the import, with nothing the new bot wrote on it, was changed by a person", () => {
  // Rejected on production's old Bot Activity during the test window: the status alone changed.
  assert.equal(changedOnOldScreen({ status: "rejected", metadata: { keywords: ["betterhomes"] } }, "new"), true);
  // Or put back into the count there.
  assert.equal(changedOnOldScreen({ status: "new", metadata: { reason: "fact check: unread" } }, "rejected"), true);
  // As it was imported: nothing to tell.
  assert.equal(changedOnOldScreen({ status: "new", metadata: null }, "new"), false);
  // Changed by the new bot or the new Bot Activity, which leave the article's id.
  assert.equal(changedOnOldScreen({ status: "rejected", metadata: { articleId: "lm_1", reason: "news check: not about betterhomes" } }, "new"), false);
  // An article the new bot found, or a status nobody recorded: never taken for a person's.
  assert.equal(changedOnOldScreen({ status: "rejected", metadata: {} }, null), false);
  assert.equal(changedOnOldScreen({ status: "rejected", metadata: {} }, undefined), false);
});

test("publishing a held re-check leaves alone an old row a person rejected on the old screen since the import", async () => {
  // An unchecked_ours story: imported as new, with no fact check, then rejected on production's old Bot Activity.
  const rejectedThere = storedRow(LEGACY, { status: "rejected" });
  const { table, calls, store } = fakeTable([rejectedThere]);
  const imported = article({ id: `lm_${LEGACY}`, legacy_mention_id: LEGACY, legacy_status: "new" });
  const counts = await writeDecision(imported, decision([OURS]), reg, OUTLETS, store);
  assert.deepEqual(counts, { ...none, personDecided: 1 });
  assert.deepEqual(table.get(LEGACY), rejectedThere);
  // Nor is the story counted again under a new id.
  assert.deepEqual(calls.inserted, []);
  assert.equal(table.has(`nb_lm_${LEGACY}`), false);
  // A rejection leaves it alone too.
  assert.deepEqual(await writeDecision(imported, decision([]), reg, OUTLETS, store), { ...none, personDecided: 1 });
  assert.deepEqual(calls.updated, []);
});

test("an old row the new bot changed since the import is still the bot's to bring up to date", async () => {
  // An earlier check of the article took it out of the count, leaving the article's id.
  const earlier = storedRow(LEGACY, { status: "rejected", metadata: { articleId: `lm_${LEGACY}`, reason: "news check: not about betterhomes" } });
  const { table, store } = fakeTable([earlier]);
  const imported = article({ id: `lm_${LEGACY}`, legacy_mention_id: LEGACY, legacy_status: "new" });
  assert.deepEqual(await writeDecision(imported, decision([OURS]), reg, OUTLETS, store), { ...none, ours: 1 });
  assert.equal(table.get(LEGACY)!.status, "new");
  // Only the old row is judged by its import status: our own row is the new bot's.
  const ours = storedRow(`nb_${ID}`, { status: "rejected", metadata: { reason: "news check: not about betterhomes" } });
  const own = fakeTable([ours]);
  assert.deepEqual(await writeDecision(article({ legacy_status: "new" }), decision([OURS]), reg, OUTLETS, own.store), { ...none, ours: 1 });
  assert.equal(own.table.get(`nb_${ID}`)!.status, "new");
});

test("an imported duplicate's old row a person changed on the old screen stays as they left it", async () => {
  const rejectedThere = storedRow("old_dup", { status: "rejected" });
  const restoredThere = storedRow("old_back", { status: "new", metadata: { reason: "fact check: unread" } });
  const asImported = storedRow("old_same");
  const { table, calls, store } = fakeTable([rejectedThere, restoredThere, asImported]);
  const stories: SameStory[] = [
    { id: "lm_dup", legacy_mention_id: "old_dup", dup_of: "na_1", legacy_status: "new" },
    { id: "lm_back", legacy_mention_id: "old_back", dup_of: "na_1", legacy_status: "rejected" },
    { id: "lm_same", legacy_mention_id: "old_same", dup_of: "na_1", legacy_status: "new" },
  ];
  assert.deepEqual(await withdrawLegacyRows(stories, store, CHECKED), { withdrawn: 1, personDecided: 2 });
  assert.deepEqual(table.get("old_dup"), rejectedThere);
  assert.deepEqual(table.get("old_back"), restoredThere);
  assert.deepEqual(calls.updated, ["old_same"]);
  // The single-row form passes the status along too.
  const one = fakeTable([storedRow(LEGACY, { status: "rejected" })]);
  assert.equal(await withdrawLegacyRow({ id: "lm_1", legacy_mention_id: LEGACY, legacy_status: "new" }, "na_1", one.store), false);
  assert.deepEqual(one.calls.updated, []);
});

// ── rows written after a person's Reject ──────────────────────────────

test("rows a step wrote after a person's Reject are taken out of the count as theirs, and nothing they decided changes", async () => {
  const ours = storedRow(`nb_${ID}`, { metadata: { articleId: ID, factCheck: pass(OURS) } });
  const kf = rival("Knight Frank");
  // Marked by the Reject itself, and kept by a person.
  const marked = rival("fäm Properties", { status: "rejected", metadata: { articleId: ID, competitor: "fäm Properties", personVerdict: "rejected" } });
  const kept = storedRow(LEGACY, { status: "reviewed" });
  // Another article's row is never touched.
  const other = storedRow("nb_na_other");
  const { table, calls, store } = fakeTable([ours, kf, marked, kept, other]);
  assert.equal(await markPersonRejected(article({ legacy_mention_id: LEGACY }), reg, store), 2);
  for (const id of [`nb_${ID}`, kf.id as string]) {
    assert.equal(table.get(id)!.status, "rejected", id);
    assert.deepEqual([meta(table.get(id)).personVerdict, meta(table.get(id)).articleId], ["rejected", ID], id);
  }
  // What the row knew stays: the rival's label and its proof.
  assert.equal(meta(table.get(kf.id as string)).competitor, "Knight Frank");
  assert.deepEqual(meta(table.get(kf.id as string)).factCheck, pass(KNIGHT_FRANK));
  assert.deepEqual([table.get(marked.id as string), table.get(LEGACY), table.get("nb_na_other")], [marked, kept, other]);
  // It looked for every row the article can have, in one read; again, it changes nothing.
  assert.equal(calls.loads.length, 1);
  assert.ok(calls.loads[0].includes(LEGACY) && calls.loads[0].includes(`nb_${ID}`));
  assert.equal(await markPersonRejected(article({ legacy_mention_id: LEGACY }), reg, store), 0);
});
