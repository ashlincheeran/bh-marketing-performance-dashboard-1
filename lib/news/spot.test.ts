import { test } from "node:test";
import assert from "node:assert/strict";
import { findBrandSentences, mentionsBetterhomes, namesBetterhomes } from "@/lib/match";
import { splitSentences, spotNames } from "@/lib/news/spot";
import { trackedRegistry } from "@/lib/news/testCompanies";
import type { Person } from "@/lib/news/types";

const person = (name: string, company: string, active = true, aliases: string[] = []): Person => ({
  name,
  company,
  role: null,
  aliases,
  active,
  note: null,
});

// Every rival with its real spellings, and a few of the real people, moves included.
const reg = trackedRegistry([
  // Former here, to show that former people are spotted too.
  person("Rupert Simmonds", "betterhomes", false, ["Rupert Simmons"]),
  person("Louis Harding", "betterhomes", false),
  person("Louis Harding", "Knight Frank"),
  person("Jacob Fletcher", "betterhomes", false, ["Jake Fletcher"]),
  person("Jacob Fletcher", "Engel & Völkers", true, ["Jake Fletcher"]),
  person("Firas Al Msaddi", "fäm Properties", true, ["Firas Al-Msaddi", "Firas Almsaddi"]),
  person("Kelly Anne Steiger", "betterhomes"),
  // Not on file: here for the accent rule, since no name on the real list has an accent.
  person("Zoë Lefèvre", "Haus & Haus"),
]);

/** Who a piece of text names, across the whole of it. */
const named = (text: string, title = "") => {
  const r = spotNames(title, text, reg);
  return { companies: r.companiesNamed, people: r.peopleNamed };
};
const nobody = { companies: [], people: [] };

test("an ordinary phrase, another company and a title-case headline name nobody", () => {
  assert.deepEqual(spotNames("", "Tenants can find better homes at lower prices.", reg), {
    candidates: [],
    companiesNamed: [],
    peopleNamed: [],
  });
  assert.deepEqual(named("", "Better Homes & Gardens Holiday Collection"), nobody);
  assert.deepEqual(named("", "Find Better Homes At Lower Prices"), nobody);
});

test("betterhomes is found by the strict rules, and its people are listed apart", () => {
  const data = "Rents rose 4 per cent, according to an analysis of Dubai Land Department data by Betterhomes.";
  assert.deepEqual(spotNames("", data, reg).candidates, [{ n: 1, text: data, companies: ["betterhomes"], people: [] }]);
  const quoted = "Rupert Simmonds, Director of Leasing at Betterhomes, said demand was high.";
  assert.deepEqual(spotNames("", quoted, reg).candidates, [
    { n: 1, text: quoted, companies: ["betterhomes"], people: ["Rupert Simmonds"] },
  ]);
});

test("a move names both companies and the person, in the order they appear", () => {
  const move = "Knight Frank has appointed Louis Harding, who joins from betterhomes.";
  assert.deepEqual(spotNames("", move, reg), {
    candidates: [{ n: 1, text: move, companies: ["Knight Frank", "betterhomes"], people: ["Louis Harding"] }],
    companiesNamed: ["Knight Frank", "betterhomes"],
    peopleNamed: ["Louis Harding"],
  });
});

test("ordinary words that share a rival's name name nobody", () => {
  assert.deepEqual(named("Rents rose across the wider metropolitan area."), nobody);
  assert.deepEqual(named("Demand from white collar workers grew."), nobody);
  // "Metropolitan" alone is left out of the rival's spellings on purpose, capitals or not.
  assert.deepEqual(named("The Metropolitan Hotel in Deira was sold."), nobody);
  assert.deepEqual(named("Metropolitan Premium Properties said prices rose."), { companies: ["Metropolitan"], people: [] });
});

test("rivals are found however the press writes their names", () => {
  assert.deepEqual(named("Driven | Forbes Global Properties reported a record year."), {
    companies: ["Driven Properties"],
    people: [],
  });
  for (const text of ["It used data from fäm Properties.", "Fam Properties said so.", "FAM PROPERTIES said so."]) {
    assert.deepEqual(named(text), { companies: ["fäm Properties"], people: [] }, text);
  }
  for (const text of ["Engel & Volkers said so.", "Engel and Völkers said so."]) {
    assert.deepEqual(named(text), { companies: ["Engel & Völkers"], people: [] }, text);
  }
  // Curly and straight apostrophes are the same, and one left out still counts.
  for (const text of ["Sotheby\u2019s International Realty sold it.", "Sotheby's sold it.", "Sothebys Realty sold it."]) {
    assert.deepEqual(named(text), { companies: ["Sotheby's"], people: [] }, text);
  }
  assert.deepEqual(named("Knight Frank\u2019s research shows it."), { companies: ["Knight Frank"], people: [] });
  // Luxhabitat, the other Sotheby's franchise, named alone or by its address (Nubia Magazine, 6 Nov 2026 check).
  for (const text of [
    "We relied on valuations from platforms such as Engel & Völkers, Kelt & Co Realty, and Luxhabitat.ae.",
    "Luxhabitat sold the penthouse for AED 420 million.",
  ]) {
    assert.ok(named(text).companies.includes("Sotheby's"), text);
  }
  assert.deepEqual(named("The desert's luxhabitats are many."), nobody);
  assert.deepEqual(named("Agents at haus&haus agreed."), { companies: ["Haus & Haus"], people: [] });
});

test("names count only as whole words", () => {
  assert.deepEqual(named("He lives on Knight Franklin Road."), nobody);
  assert.deepEqual(named("The Metropolitan Homestead estate was sold."), nobody);
  // "co-working" is one word, so "White and Co" is not in it.
  assert.deepEqual(named("The office is black and white and co-working desks fill it."), nobody);
  assert.deepEqual(named("Louis Hardingham said so."), nobody);
  // A prefix still names the company.
  assert.deepEqual(named("An ex-Knight Frank partner said so."), { companies: ["Knight Frank"], people: [] });
});

test("people are found by name or alias, current or former, under the name on file", () => {
  assert.deepEqual(named("Jake Fletcher said so."), { companies: [], people: ["Jacob Fletcher"] });
  assert.deepEqual(named("RUPERT SIMMONS said so."), { companies: [], people: ["Rupert Simmonds"] });
  for (const text of ["Firas Al Msaddi said so.", "Firas Al-Msaddi said so.", "Firas Almsaddi said so."]) {
    assert.deepEqual(named(text), { companies: [], people: ["Firas Al Msaddi"] }, text);
  }
  assert.deepEqual(named("Kelly-Anne Steiger said so."), { companies: [], people: ["Kelly Anne Steiger"] });
  assert.deepEqual(named("Zoe Lefevre said so."), { companies: [], people: ["Zoë Lefèvre"] });
});

test("a person never adds their company", () => {
  const r = spotNames("", "Louis Harding said prices would rise.", reg);
  assert.deepEqual(r.candidates, [{ n: 1, text: "Louis Harding said prices would rise.", companies: [], people: ["Louis Harding"] }]);
  assert.deepEqual(r.companiesNamed, []);
});

test("candidates are numbered in article order and capped, but the whole article is still covered", () => {
  const title = "Knight Frank appoints Louis Harding";
  const text = [
    "The market was busy.",
    "betterhomes said rents rose. Allsopp & Allsopp agreed.",
    "Haus & Haus disagreed. Engel & Völkers said nothing. Jake Fletcher declined to comment.",
  ].join("\n");
  const r = spotNames(title, text, reg, 3);
  assert.deepEqual(r.candidates, [
    { n: 1, text: title, companies: ["Knight Frank"], people: ["Louis Harding"] },
    { n: 2, text: "betterhomes said rents rose.", companies: ["betterhomes"], people: [] },
    { n: 3, text: "Allsopp & Allsopp agreed.", companies: ["Allsopp & Allsopp"], people: [] },
  ]);
  assert.deepEqual(r.companiesNamed, ["Knight Frank", "betterhomes", "Allsopp & Allsopp", "Haus & Haus", "Engel & Völkers"]);
  assert.deepEqual(r.peopleNamed, ["Louis Harding", "Jacob Fletcher"]);

  const many = Array.from({ length: 20 }, (_, i) => `Knight Frank said prices rose ${i + 1} per cent.`).join(" ");
  const capped = spotNames("", many, reg).candidates;
  assert.equal(capped.length, 12);
  assert.deepEqual(
    capped.map((c) => c.n),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.equal(capped[11].text, "Knight Frank said prices rose 12 per cent.");
});

test("a long sentence is cut around its first name, and lists only the names the cut kept", () => {
  const filler = "prices in the prime districts rose again ".repeat(14);
  const sentence = `Knight Frank said ${filler}while betterhomes reported more listings in the quarter.`;
  assert.ok(sentence.length > 600 && sentence.indexOf("betterhomes") > 400);
  const r = spotNames("", sentence, reg);
  const [c] = r.candidates;
  assert.ok(c.text.length <= 400);
  assert.ok(sentence.startsWith(c.text) && sentence[c.text.length] === " ", "starts at the name and ends on a whole word");
  assert.deepEqual(c.companies, ["Knight Frank"]);
  assert.deepEqual(r.companiesNamed, ["Knight Frank", "betterhomes"]);

  const middle = `${filler}and Louis Harding said ${filler}so.`;
  const [m] = spotNames("", middle, reg).candidates;
  assert.ok(m.text.length <= 400 && m.text.includes("Louis Harding"));
  const at = middle.indexOf(m.text);
  assert.ok(at > 0 && middle[at - 1] === " " && middle[at + m.text.length] === " ", "starts and ends on whole words");
  assert.deepEqual(m.people, ["Louis Harding"]);
});

test("a quote never starts after its own name", () => {
  // The 180 characters before the name hold no space, which pushes the usual cut past it.
  const sentence = `See https://example.com/${"a".repeat(250)}/ Louis Harding joined ${"the firm and then ".repeat(30)}left.`;
  const [c] = spotNames("", sentence, reg).candidates;
  assert.ok(c.text.startsWith("Louis Harding joined") && c.text.length <= 400);
  assert.deepEqual(c.people, ["Louis Harding"]);
});

test("the same quote twice is one candidate, and empty input names nobody", () => {
  const title = "Knight Frank appoints Louis Harding";
  const r = spotNames(title, `${title}\nThe appointment starts in May.`, reg);
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(spotNames("", "", reg), { candidates: [], companiesNamed: [], peopleNamed: [] });
});

test("sentences are split as findBrandSentences splits them", () => {
  const text =
    'Dubai rents fall\nBetterhomes said rents fell. Better Homes & Gardens did not comment! "Betterhomes is busy," she said. ' +
    "2026 will be busy for bhomes too. rents rose.   lower case stays\n\n  \r\nBrackets follow. (One opens here.) Then [another] follows.";
  assert.deepEqual(splitSentences(text), [
    "Dubai rents fall",
    "Betterhomes said rents fell.",
    "Better Homes & Gardens did not comment!",
    '"Betterhomes is busy," she said.',
    // A sentence that starts in lower case, or ends inside a bracket, runs on.
    "2026 will be busy for bhomes too. rents rose. lower case stays",
    "Brackets follow.",
    "(One opens here.) Then [another] follows.",
  ]);
  assert.deepEqual(splitSentences(""), []);
});

test("namesBetterhomes holds the strict rule for one sentence", () => {
  for (const yes of ["Data by Betterhomes.", "See bhomes.com for more.", "Agents at Better Homes said the market was busy.", "PRIME by betterhomes"]) {
    assert.equal(namesBetterhomes(yes), true, yes);
  }
  for (const no of [
    "Tenants can find better homes at lower prices.",
    "Better Homes & Gardens Holiday Collection",
    "BetterHome Group opened an office.",
    "Find Better Homes At Lower Prices",
  ]) {
    assert.equal(namesBetterhomes(no), false, no);
  }
});

// Recorded from findBrandSentences before its rule moved into betterhomesAt,
// splitSentences and quoteSpan: the old bot must behave exactly as before.
test("findBrandSentences gives the same results as before", () => {
  const cases: [string, string[]][] = [
    ["Tenants can find better homes at lower prices.", []],
    ["Better Homes & Gardens Holiday Collection", []],
    ["Find Better Homes At Lower Prices", []],
    [
      "Rents rose 4 per cent, according to an analysis of Dubai Land Department data by Betterhomes.",
      ["Rents rose 4 per cent, according to an analysis of Dubai Land Department data by Betterhomes."],
    ],
    [
      "Rupert Simmonds, Director of Leasing at Betterhomes, said demand was high.",
      ["Rupert Simmonds, Director of Leasing at Betterhomes, said demand was high."],
    ],
    [
      "Knight Frank has appointed Louis Harding, who joins from betterhomes.",
      ["Knight Frank has appointed Louis Harding, who joins from betterhomes."],
    ],
    ["Agents at Better Homes said the market was busy.", ["Agents at Better Homes said the market was busy."]],
    ["BetterHome Group opened an office. The firm bhomes.com listed it.", ["The firm bhomes.com listed it."]],
    [
      'Dubai rents fall\nBetterhomes said rents fell. Better Homes & Gardens did not comment! "Betterhomes is busy," she said. 2026 will be busy for bhomes too.',
      ["Betterhomes said rents fell.", '"Betterhomes is busy," she said.', "2026 will be busy for bhomes too."],
    ],
    ["Betterhomes grew.\nBetterhomes grew.\nThe end.", ["Betterhomes grew."]],
    ["The agency Better\u00a0Homes said so.", ["The agency Better Homes said so."]],
    [
      "Prices rose again " +
        "in the prime districts of the city ".repeat(8) +
        "according to Betterhomes, which said demand " +
        "from overseas buyers stayed strong through the quarter ".repeat(6) +
        "and into the next year.",
      [
        "districts of the city in the prime districts of the city in the prime districts of the city in the prime districts of the city in the prime districts of the city according to Betterhomes, which said demand from overseas buyers stayed strong through the quarter from overseas buyers stayed strong through the quarter from overseas buyers stayed strong through the quarter from overseas buyers stayed",
      ],
    ],
  ];
  for (const [text, expected] of cases) assert.deepEqual(findBrandSentences(text), expected, text);
  assert.deepEqual(
    findBrandSentences(
      'Dubai rents fall\nBetterhomes said rents fell. Better Homes & Gardens did not comment! "Betterhomes is busy," she said. 2026 will be busy for bhomes too.',
      2,
    ),
    ["Betterhomes said rents fell.", '"Betterhomes is busy," she said.'],
  );
  assert.equal(mentionsBetterhomes("Rents rose 4 per cent, according to an analysis of Dubai Land Department data by Betterhomes."), true);
  assert.equal(mentionsBetterhomes("Tenants can find better homes at lower prices."), false);
  assert.equal(mentionsBetterhomes("Find Better Homes At Lower Prices"), false);
});

test("in a round-up quoting many brokers, our late quote still reaches the AI", () => {
  const lines = [
    ...Array.from({ length: 12 }, (_, i) => `Knight Frank said prime prices rose ${i + 1} per cent in the quarter.`),
    "Metropolitan Premium Properties said Russian demand had cooled.",
    "Richard Waind, CEO of betterhomes, said rents rose 4 per cent.",
  ];
  const r = spotNames("Brokers weigh in on the market", lines.join("\n"), reg);
  assert.equal(r.candidates.length, 12);
  const named = new Set(r.candidates.flatMap((c) => c.companies));
  assert.ok(named.has("betterhomes"));
  assert.ok(named.has("Metropolitan"));
  assert.ok(named.has("Knight Frank"));
  // Still numbered from 1 in article order.
  assert.deepEqual(
    r.candidates.map((c) => c.n),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.match(r.candidates[11].text, /betterhomes/);
});

test("a second name far into a long sentence gets a quote of its own", () => {
  const filler = "the market moved in ways few expected, with buyers and sellers both waiting, ".repeat(6);
  const sentence = `Knight Frank said ${filler}while Kelly Anne Steiger at betterhomes said demand held up.`;
  assert.ok(sentence.length > 400);
  const r = spotNames("", sentence, reg);
  const people = r.candidates.flatMap((c) => c.people);
  const companies = r.candidates.flatMap((c) => c.companies);
  assert.ok(companies.includes("Knight Frank"));
  assert.ok(companies.includes("betterhomes"));
  assert.ok(people.includes("Kelly Anne Steiger"));
  for (const c of r.candidates) assert.ok(c.text.length <= 400);
});
