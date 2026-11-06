import { test } from "node:test";
import assert from "node:assert/strict";
import {
  US,
  aliasList,
  buildRegistry,
  companyIn,
  companyKey,
  companyNamed,
  currentCompanyOf,
  formerCompaniesOf,
  registryFromRows,
  siteList,
} from "@/lib/news/registry";
import { OUR_SITES, TRACKED_RIVALS, trackedRivals } from "@/lib/news/testCompanies";
import type { Person } from "@/lib/news/types";

const person = (name: string, company: string, active = true): Person => ({ name, company, role: null, aliases: [], active, note: null });

// Every rival as tracked_keywords holds them, and one with no other spellings or websites.
const reg = buildRegistry(
  [...trackedRivals((label) => `${label.toLowerCase()} dubai`), { label: "Savills", query: "savills dubai" }],
  [person("Louis Harding", "betterhomes", false), person("Louis Harding", "Knight Frank"), person("Someone Else", "Bayut")],
  { sites: OUR_SITES },
);
const company = (label: string) => reg.companies.find((c) => c.label === label);

test("betterhomes comes first, then every rival in the order tracked_keywords gives them", () => {
  assert.deepEqual(reg.us, { ...US, sites: OUR_SITES });
  assert.equal(reg.companies[0], reg.us);
  assert.deepEqual(
    reg.companies.map((c) => c.label),
    ["betterhomes", ...TRACKED_RIVALS.map((r) => r.label), "Savills"],
  );
  assert.deepEqual(
    reg.companies.map((c) => c.isUs),
    reg.companies.map((c) => c.label === "betterhomes"),
  );
  assert.equal(company("Knight Frank")?.query, "knight frank dubai");
});

test("a rival's names are its other spellings alone, so a bare ordinary word is never one", () => {
  for (const r of TRACKED_RIVALS) assert.deepEqual(company(r.label)?.names, r.aliases, r.label);
  // The label is not added on top: "Metropolitan" alone is also "the metropolitan area".
  assert.ok(!company("Metropolitan")?.names.includes("Metropolitan"));
  assert.deepEqual(company("Metropolitan")?.names, ["Metropolitan Premium Properties", "Metropolitan Group", "Metropolitan Homes"]);
  // A rival with none is known by its label.
  assert.deepEqual(company("Savills")?.names, ["Savills"]);
  // A copy: changing one registry's names leaves the list it was built from as it was.
  company("Knight Frank")?.names.push("KF");
  assert.deepEqual(TRACKED_RIVALS.find((r) => r.label === "Knight Frank")?.aliases, ["Knight Frank", "Knight Frank UAE"]);
  assert.deepEqual(buildRegistry(trackedRivals(), []).companies.find((c) => c.label === "Knight Frank")?.names, ["Knight Frank", "Knight Frank UAE"]);
});

test("Engel & Völkers is also written with oe for the ö", () => {
  const names = company("Engel & Völkers")?.names ?? [];
  for (const spelling of ["Engel & Voelkers", "Engel and Voelkers", "Engel Voelkers", "Engel & Volkers", "Engel and Völkers"]) {
    assert.ok(names.includes(spelling), spelling);
  }
});

test("a blank or repeated label is left out, and the query stands in for a missing label", () => {
  const r = buildRegistry(
    [
      { label: "", query: "" },
      { label: "  ", query: "" },
      { label: "knight frank", query: "a" },
      { label: "Knight Frank", query: "b" },
      { label: "BETTERHOMES", query: "c" },
      { label: "", query: "Savills" },
    ],
    [],
  );
  assert.deepEqual(
    r.companies.map((c) => [c.label, c.query]),
    [
      ["betterhomes", "betterhomes"],
      ["knight frank", "a"],
      ["Savills", "Savills"],
    ],
  );
  // With no other spellings given, a rival is known by its label as written.
  assert.deepEqual(r.companies[1].names, ["knight frank"]);
});

test("other spellings and websites come from each rival's row, tidied, and betterhomes' websites from the 'us' row", () => {
  const r = buildRegistry(
    [
      { label: "Savills", query: "savills dubai", aliases: [" Savills ", "Savills", "", "  ", "Savills Middle East"], sites: [" Savills.AE ", "savills.ae", "savills.*"] },
      // Spellings given but all blank: known by its label.
      { label: "Bayut", query: "bayut dubai", aliases: ["  "], sites: [] },
    ],
    [],
    { sites: ["BHomes.com", " betterhomes.ae ", ""] },
  );
  const savills = r.companies[1];
  assert.deepEqual(savills.names, ["Savills", "Savills Middle East"]);
  assert.deepEqual(savills.sites, ["savills.ae", "savills.*"]);
  assert.deepEqual(r.companies[2].names, ["Bayut"]);
  assert.deepEqual(r.companies[2].sites, []);
  // betterhomes keeps its names from the code, whatever the row holds, and takes its websites from it.
  assert.deepEqual(r.us.names, US.names);
  assert.deepEqual(r.us.sites, ["bhomes.com", "betterhomes.ae"]);
  // The shared US is never changed.
  assert.deepEqual(US.sites, []);
  // No 'us' row, or one that can't be read: betterhomes has no websites, and every rival none either.
  assert.deepEqual(buildRegistry([], []).us.sites, []);
  assert.deepEqual(buildRegistry([{ label: "Knight Frank", query: "q" }], [], null).companies[1].sites, []);
});

test("a stored list is read the one way, for the bot and for the settings that show it", () => {
  assert.deepEqual(aliasList([" Knight Frank ", "Knight Frank", "knight frank", "", 7, null, "Knight Frank UAE"]), ["Knight Frank", "knight frank", "Knight Frank UAE"]);
  assert.deepEqual(siteList([" KnightFrank.* ", "knightfrank.*", "", "Bhomes.com"]), ["knightfrank.*", "bhomes.com"]);
  for (const notAList of [null, undefined, "knightfrank.*", { 0: "x" }]) {
    assert.deepEqual(aliasList(notAList), []);
    assert.deepEqual(siteList(notAList), []);
  }
});

test("tracked_keywords rows make the registry: rivals in their order, betterhomes' websites from its row, searches left out", () => {
  const r = registryFromRows(
    [
      { kind: "pr", query: "betterhomes dubai", label: null, aliases: [], sites: [] },
      { kind: "competitor", query: "knight frank dubai", label: "Knight Frank", aliases: ["Knight Frank", "Knight Frank UAE"], sites: ["knightfrank.*"] },
      { kind: "us", query: "betterhomes", label: "betterhomes", aliases: ["ignored"], sites: ["bhomes.com", "betterhomes.ae"] },
      // A rival saved without its name is known by its search, as before.
      { kind: "competitor", query: "Savills", label: null, aliases: null, sites: "not a list" },
      { kind: "us", query: "betterhomes", label: "betterhomes", aliases: [], sites: ["second.example"] },
    ],
    [person("Louis Harding", "Knight Frank")],
  );
  assert.deepEqual(
    r.companies.map((c) => [c.label, c.query, c.names, c.sites]),
    [
      ["betterhomes", "betterhomes", US.names, ["bhomes.com", "betterhomes.ae"]],
      ["Knight Frank", "knight frank dubai", ["Knight Frank", "Knight Frank UAE"], ["knightfrank.*"]],
      ["Savills", "Savills", ["Savills"], []],
    ],
  );
  assert.deepEqual(r.people.map((p) => p.name), ["Louis Harding"]);
  assert.deepEqual(registryFromRows([], []).companies.map((c) => c.label), ["betterhomes"]);
});

test("people are kept only for a company the registry knows, current and former alike", () => {
  assert.deepEqual(
    reg.people.map((p) => [p.name, p.company, p.active]),
    [
      ["Louis Harding", "betterhomes", false],
      ["Louis Harding", "Knight Frank", true],
    ],
  );
  assert.equal(currentCompanyOf(reg, "Louis Harding"), "Knight Frank");
  assert.deepEqual(formerCompaniesOf(reg, "Louis Harding"), ["betterhomes"]);
  assert.equal(currentCompanyOf(reg, "Someone Else"), null);
});

test("a company name written another way is the registry's company it means", () => {
  const means = (name: string | null) => companyNamed(reg, name)?.label ?? null;
  assert.equal(means("Knight Frank"), "Knight Frank");
  // Case, accents, apostrophes, punctuation and "&" or "and" don't count.
  assert.equal(means("knight frank"), "Knight Frank");
  assert.equal(means("Engel and Volkers"), "Engel & Völkers");
  assert.equal(means("ENGEL & VÖLKERS"), "Engel & Völkers");
  assert.equal(means("Allsopp and Allsopp"), "Allsopp & Allsopp");
  assert.equal(means("Sotheby’s"), "Sotheby's");
  assert.equal(means("White & Co."), "White & Co");
  assert.equal(means("fam properties"), "fäm Properties");
  // Then the company's own spellings, as its row lists them.
  assert.equal(means("Engel & Voelkers"), "Engel & Völkers");
  assert.equal(means("Metropolitan Premium Properties"), "Metropolitan");
  assert.equal(means("Driven | Forbes Global Properties"), "Driven Properties");
  assert.equal(means("Luxhabitat"), "Sotheby's");
  assert.equal(means("Knight Frank UAE"), "Knight Frank");
  assert.equal(means("Better Homes"), "betterhomes");
  assert.equal(means("PRIME by betterhomes"), "betterhomes");
  // Anything else is none of them.
  for (const name of ["Bayut", "Better Homes & Gardens", "Sotheby's auction house", "Driven", "", "  ", "&", null]) {
    assert.equal(means(name), null, String(name));
  }
  assert.equal(companyKey("Engel & Völkers"), "engel and volkers");
  assert.equal(companyKey(" Sotheby's  International "), "sothebys international");
});

test("the same lookup works on a list of companies, such as an import's", () => {
  const few = reg.companies.filter((c) => c.label === "betterhomes" || c.label === "Sotheby's");
  assert.equal(companyIn(few, "Dubai Sotheby's International Realty")?.label, "Sotheby's");
  assert.equal(companyIn(few, "bhomes")?.label, "betterhomes");
  // A company not in the list is not found, however well it is spelt.
  assert.equal(companyIn(few, "Knight Frank"), null);
  assert.equal(companyIn([], "Knight Frank"), null);
  assert.equal(companyIn(few, undefined), null);
});
