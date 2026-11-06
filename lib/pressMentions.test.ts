import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPressMentions, peopleLine, type PressArticle, type PressPersonRecord, type PressRow } from "@/lib/pressMentions";

// Press mentions on the PR tab, built from rows as the tab's reads give them.
// Pure: nothing here reads the database.

const US = "betterhomes";

const ours = (id: string, over: Partial<PressRow> = {}): PressRow => ({
  id,
  company: US,
  isUs: true,
  date: "2026-11-04",
  outlet: "Khaleej Times",
  title: `Story ${id}`,
  url: `https://www.khaleejtimes.com/${id}`,
  articleId: null,
  legacyIds: [],
  ...over,
});
const rival = (id: string, company: string, over: Partial<PressRow> = {}): PressRow => ({ ...ours(id, over), company, isUs: false, ...over });

const candidate = (n: number, people: string[], companies: string[] = []) => ({ n, text: `Sentence ${n}.`, companies, people });
const article = (id: string, over: Partial<PressArticle> = {}): PressArticle => ({
  id,
  status: "decided",
  legacy_mention_id: null,
  dup_of: null,
  candidates: null,
  ...over,
});

const PEOPLE: PressPersonRecord[] = [
  { name: "Lewis Allsopp", company: "Allsopp & Allsopp", role: "CEO", active: true },
  { name: "Richard Waind", company: "betterhomes", role: "CEO", active: true },
  // On file at two companies: former at ours, current at Knight Frank.
  { name: "Louis Harding", company: "betterhomes", role: "Former CEO", active: false },
  { name: "Faisal Durrani", company: "Knight Frank", role: "Partner and Head of Research, MENA", active: true },
  { name: "Louis Harding", company: "Knight Frank", role: "Head of Residential", active: true },
  // Former only.
  { name: "Nada Osman", company: "betterhomes", role: "Head of Marketing", active: false },
  { name: "Omar Haddad", company: "Knight Frank", role: null, active: true },
];

test("one article's rows, ours and a rival's, are one row with both companies and the people it names", () => {
  const { items, companies } = buildPressMentions(
    [ours("nb_na_1", { articleId: "na_1" }), rival("nr_na_1_knight-frank", "Knight Frank", { articleId: "na_1" })],
    [article("na_1", { candidates: [candidate(1, ["Richard Waind"], ["betterhomes"]), candidate(2, ["Faisal Durrani", "Richard Waind"])] })],
    PEOPLE,
    US,
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    key: "article na_1",
    date: "2026-11-04",
    outlet: "Khaleej Times",
    title: "Story nb_na_1",
    url: "https://www.khaleejtimes.com/nb_na_1",
    companies: [
      { label: "betterhomes", isUs: true },
      { label: "Knight Frank", isUs: false },
    ],
    people: [
      { name: "Richard Waind", company: "betterhomes", role: "CEO", former: false },
      { name: "Faisal Durrani", company: "Knight Frank", role: "Partner and Head of Research, MENA", former: false },
    ],
  });
  assert.equal(
    peopleLine(items[0].people),
    "Richard Waind (betterhomes, CEO); Faisal Durrani (Knight Frank, Partner and Head of Research, MENA)",
  );
  // It counts once under each company it is about.
  assert.deepEqual(companies, [
    { label: "betterhomes", isUs: true, count: 1 },
    { label: "Knight Frank", isUs: false, count: 1 },
  ]);
});

test("an old bot's row is the article imported from it, and a duplicate is the article it copies", () => {
  const { items } = buildPressMentions(
    [
      // The old bot stored the story twice, once as ours and once as Knight Frank's; neither row names an article.
      ours("m1", { legacyIds: ["m1"] }),
      rival("m2", "Knight Frank", { legacyIds: ["m2"] }),
      // A row that names a duplicate is the copied article's too.
      rival("nr_lm_m3_allsopp-allsopp", "Allsopp & Allsopp", { articleId: "lm_m3" }),
    ],
    [
      article("lm_m1", { legacy_mention_id: "m1" }),
      article("lm_m2", { legacy_mention_id: "m2", status: "duplicate", dup_of: "lm_m1" }),
      article("lm_m3", { legacy_mention_id: "m3", status: "duplicate", dup_of: "lm_m1" }),
    ],
    PEOPLE,
    US,
  );
  assert.deepEqual(
    items.map((m) => [m.key, m.companies.map((c) => c.label)]),
    [["article lm_m1", ["betterhomes", "Knight Frank", "Allsopp & Allsopp"]]],
  );
  // Nobody read the old bot's stories for names: no people line.
  assert.deepEqual(items[0].people, []);
});

test("the PR agency's copy of a story the old bot found is that story's article, with its people", () => {
  // The archive's copy (h1) was kept and the old bot's row (m1) folded into it;
  // Knight Frank's row was imported as a duplicate of the same article.
  const { items } = buildPressMentions(
    [ours("h1", { outlet: "Gulf News", legacyIds: ["m1"] }), rival("c1", "Knight Frank", { legacyIds: ["c1"] })],
    [
      article("lm_m1", { legacy_mention_id: "m1", candidates: [candidate(1, ["Richard Waind"], ["betterhomes"])] }),
      article("lm_c1", { legacy_mention_id: "c1", status: "duplicate", dup_of: "lm_m1" }),
    ],
    PEOPLE,
    US,
  );
  assert.deepEqual(
    items.map((m) => [m.key, m.companies.map((c) => c.label), peopleLine(m.people)]),
    [["article lm_m1", ["betterhomes", "Knight Frank"], "Richard Waind (betterhomes, CEO)"]],
  );
});

test("a clip from the PR agency's history is an article of its own", () => {
  const { items } = buildPressMentions(
    [ours("h1", { title: "Rents rise" }), ours("h2", { title: "Rents rise" })],
    [article("lm_x", { legacy_mention_id: "x", candidates: [candidate(1, ["Richard Waind"])] })],
    PEOPLE,
    US,
  );
  assert.deepEqual(
    items.map((m) => [m.key, m.people.length]),
    [
      ["row h1", 0],
      ["row h2", 0],
    ],
  );
});

test("a row whose article could not be read is still that article's", () => {
  const { items } = buildPressMentions(
    [ours("nb_na_9", { articleId: "na_9" }), rival("nr_na_9_knight-frank", "Knight Frank", { articleId: "na_9" })],
    [],
    null,
    US,
  );
  assert.deepEqual(
    items.map((m) => [m.key, m.companies.length, m.people.length]),
    [["article na_9", 2, 0]],
  );
});

test("each person once, at the company on file: current over former, former said as such, unknown names left out", () => {
  const candidates = [
    candidate(1, ["louis  harding", "Somebody Else"]),
    candidate(2, ["Nada Osman", "Louis Harding", "Omar Haddad"]),
    { n: 3, text: "Not a candidate's shape", people: "Richard Waind" },
    null,
  ];
  const [item] = buildPressMentions([ours("nb_na_2", { articleId: "na_2" })], [article("na_2", { candidates })], PEOPLE, US).items;
  assert.deepEqual(item.people, [
    // Former at ours and current at Knight Frank, in a story that counts for us: he spoke for us in it.
    { name: "Louis Harding", company: "betterhomes", role: null, former: true },
    { name: "Nada Osman", company: "betterhomes", role: null, former: true },
    { name: "Omar Haddad", company: "Knight Frank", role: null, former: false },
  ]);
  assert.equal(
    peopleLine(item.people),
    "Louis Harding (former, betterhomes); Nada Osman (former, betterhomes); Omar Haddad (Knight Frank)",
  );
  // In a story that counts for Knight Frank he is shown there, and in one for neither, where he is now.
  const atRival = (company: string) =>
    buildPressMentions([rival(`nr_na_2_${company}`, company, { articleId: "na_2" })], [article("na_2", { candidates })], PEOPLE, US).items[0]
      .people[0];
  assert.deepEqual(atRival("Knight Frank"), { name: "Louis Harding", company: "Knight Frank", role: "Head of Residential", former: false });
  assert.deepEqual(atRival("Allsopp & Allsopp"), { name: "Louis Harding", company: "Knight Frank", role: "Head of Residential", former: false });
  // The people could not be read: nobody is named, rather than a guess.
  const [unread] = buildPressMentions([ours("nb_na_2", { articleId: "na_2" })], [article("na_2", { candidates })], null, US).items;
  assert.deepEqual(unread.people, []);
});

test("newest first and undated last, the same day in the order the reads gave", () => {
  const { items } = buildPressMentions(
    [
      ours("a", { date: "2026-01-05" }),
      ours("b", { date: null }),
      ours("c", { date: "2026-03-01" }),
      rival("d", "Knight Frank", { date: "2026-03-01" }),
      rival("e", "Knight Frank", { date: null }),
    ],
    [],
    PEOPLE,
    US,
  );
  assert.deepEqual(
    items.map((m) => m.key),
    ["row c", "row d", "row a", "row b", "row e"],
  );
});

test("an article's details are its first row's, a blank filled from the next", () => {
  const [item] = buildPressMentions(
    [
      ours("nb_na_3", { articleId: "na_3", url: null, outlet: "" }),
      rival("nr_na_3_knight-frank", "Knight Frank", { articleId: "na_3", outlet: "Gulf News", url: "https://gulfnews.com/a" }),
    ],
    [],
    null,
    US,
  ).items;
  assert.deepEqual([item.outlet, item.url, item.title], ["Gulf News", "https://gulfnews.com/a", "Story nb_na_3"]);
});

test("the filter is betterhomes first, then each rival by its articles, a tie in the order first seen", () => {
  const { items, companies } = buildPressMentions(
    [
      rival("1", "Knight Frank", { date: "2026-11-01" }),
      rival("2", "Allsopp & Allsopp", { date: "2026-11-03", articleId: "na_5" }),
      rival("3", "Knight Frank", { date: "2026-11-03", articleId: "na_5" }),
      rival("4", "Allsopp & Allsopp", { date: "2026-10-01" }),
      rival("5", "Haus & Haus", { date: "2026-09-01" }),
    ],
    [],
    null,
    US,
  );
  // betterhomes is always offered, with no article here; Allsopp & Allsopp ties Knight Frank and is seen first, newest first.
  assert.deepEqual(
    companies.map((c) => [c.label, c.count]),
    [
      ["betterhomes", 0],
      ["Allsopp & Allsopp", 2],
      ["Knight Frank", 2],
      ["Haus & Haus", 1],
    ],
  );
  // An article's badges follow the same order.
  assert.deepEqual(items[0].companies.map((c) => c.label), ["Allsopp & Allsopp", "Knight Frank"]);
});
