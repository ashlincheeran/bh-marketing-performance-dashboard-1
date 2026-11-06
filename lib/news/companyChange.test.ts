import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompanyChange } from "@/lib/news/companyChange";

const refused = (change: unknown, kind: unknown = "competitor") => {
  const out = checkCompanyChange(change, kind);
  assert.equal(out.ok, false, JSON.stringify(change));
  return out.ok ? "" : out.error;
};
const saved = (change: unknown, kind: unknown = "competitor") => {
  const out = checkCompanyChange(change, kind);
  assert.ok(out.ok, out.ok ? "" : out.error);
  return out.patch;
};

test("a rival's other spellings are saved on one line each, once whatever their case", () => {
  assert.deepEqual(saved({ aliases: ["  Knight   Frank ", "knight frank", "Knight\nFrank UAE", "KNIGHT FRANK UAE", "Knight Frank Residential"] }), {
    aliases: ["Knight Frank", "Knight Frank UAE", "Knight Frank Residential"],
  });
  // None at all is allowed: the rival is then known by its name alone.
  assert.deepEqual(saved({ aliases: [] }), { aliases: [] });
  // Accents and "&" are kept as written: the matching folds them itself.
  assert.deepEqual(saved({ aliases: ["Engel & Völkers", "Engel and Voelkers"] }).aliases, ["Engel & Völkers", "Engel and Voelkers"]);
});

test("a spelling that is too short, too long, or betterhomes' own name is refused", () => {
  for (const alias of ["", " ", "K", "x".repeat(61), 42, null]) {
    assert.equal(refused({ aliases: ["Knight Frank", alias] }), "Each other spelling must be 2 to 60 characters.", String(alias));
  }
  assert.ok(checkCompanyChange({ aliases: ["Kf", "x".repeat(60)] }, "competitor").ok, "2 and 60 characters are allowed");
  for (const ours of ["betterhomes", "Betterhomes Dubai", "bhomes", "Better Homes"]) {
    assert.equal(refused({ aliases: [ours] }), `"${ours}" is betterhomes' own name, so it can't be another company's spelling.`, ours);
  }
  // Another company with our words in its name is not ours.
  assert.deepEqual(saved({ aliases: ["Better Homes & Gardens Real Estate"] }).aliases, ["Better Homes & Gardens Real Estate"]);
  assert.match(refused({ aliases: "Knight Frank" }), /could not be read/);
});

test("at most 20 spellings, counted once the repeats are gone", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `Rival Name ${i + 1}`);
  assert.equal(saved({ aliases: [...twenty, "rival name 1", "RIVAL NAME 2"] }).aliases?.length, 20);
  assert.equal(refused({ aliases: [...twenty, "Rival Name 21"] }), "A company can have at most 20 other spellings.");
});

test("websites are saved as their host, lower case, with no scheme, path, port or www", () => {
  assert.deepEqual(
    saved({
      sites: [
        "https://www.KnightFrank.ae/research/dubai?x=1#top",
        "knightfrank.ae",
        "http://invest.metropolitan.realestate:8080/x",
        "//allsoppandallsopp.com",
        " WWW.Engelvoelkers.* ",
        "luxhabitat.ae/",
      ],
    }),
    { sites: ["knightfrank.ae", "invest.metropolitan.realestate", "allsoppandallsopp.com", "engelvoelkers.*", "luxhabitat.ae"] },
  );
  assert.deepEqual(saved({ sites: [] }), { sites: [] });
});

test("anything that is not a website is refused, with an example of one", () => {
  for (const site of ["knightfrank", "knight frank.com", "*.knightfrank.com", "knight.frank.*", ".com", "a..b", "name@site.com", "", 7]) {
    const error = refused({ sites: [site] });
    assert.match(error, /is not a website\. Give an address like allsoppandallsopp\.com, or knightfrank\.\* for every country\./, String(site));
  }
  assert.equal(refused({ sites: ["knightfrank"] }), '"knightfrank" is not a website. Give an address like allsoppandallsopp.com, or knightfrank.* for every country.');
  assert.match(refused({ sites: "knightfrank.ae" }), /could not be read/);
  const eleven = Array.from({ length: 11 }, (_, i) => `site${i}.com`);
  assert.equal(refused({ sites: eleven }), "A company can have at most 10 websites.");
  assert.equal(saved({ sites: [...eleven.slice(0, 10), "SITE0.com"] }).sites?.length, 10);
});

test("betterhomes' row takes websites only, and a search takes neither", () => {
  assert.deepEqual(saved({ sites: ["bhomes.com", "https://www.betterhomes.ae/"] }, "us"), { sites: ["bhomes.com", "betterhomes.ae"] });
  assert.equal(
    refused({ aliases: ["bhomes"], sites: ["bhomes.com"] }, "us"),
    "betterhomes' spellings are fixed by the bot's own rules, so they can't be changed here.",
  );
  assert.equal(refused({ aliases: [] }, "us"), "betterhomes' spellings are fixed by the bot's own rules, so they can't be changed here.");
  for (const kind of ["pr", "", null, "rival"]) assert.equal(refused({ sites: ["knightfrank.ae"] }, kind), "That is a search, not a company.");
});

test("both lists can change at once, and a change of nothing is refused", () => {
  assert.deepEqual(saved({ aliases: ["Savills"], sites: ["savills.ae"] }), { aliases: ["Savills"], sites: ["savills.ae"] });
  for (const change of [{}, null, "aliases", [], { other: ["x"] }]) assert.equal(refused(change), "Nothing was given to change.");
});
