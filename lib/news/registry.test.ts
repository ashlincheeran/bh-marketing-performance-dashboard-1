import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANY_ALIASES, US, buildRegistry, companyKey, companyNamed, currentCompanyOf, formerCompaniesOf } from "@/lib/news/registry";
import type { Person } from "@/lib/news/types";

const person = (name: string, company: string, active = true): Person => ({ name, company, role: null, aliases: [], active, note: null });

// Every rival as tracked_keywords holds them, and one the alias list doesn't know.
const reg = buildRegistry(
  [...Object.keys(COMPANY_ALIASES).map((label) => ({ label, query: `${label.toLowerCase()} dubai` })), { label: "Savills", query: "savills dubai" }],
  [person("Louis Harding", "betterhomes", false), person("Louis Harding", "Knight Frank"), person("Someone Else", "Bayut")],
);
const company = (label: string) => reg.companies.find((c) => c.label === label);

test("betterhomes comes first, then every rival in the order tracked_keywords gives them", () => {
  assert.equal(reg.us, US);
  assert.deepEqual(
    reg.companies.map((c) => c.label),
    ["betterhomes", ...Object.keys(COMPANY_ALIASES), "Savills"],
  );
  assert.deepEqual(
    reg.companies.map((c) => c.isUs),
    reg.companies.map((c) => c.label === "betterhomes"),
  );
  assert.equal(company("Knight Frank")?.query, "knight frank dubai");
});

test("a listed rival's names are its listed spellings alone, so a bare ordinary word is never one", () => {
  for (const [label, spellings] of Object.entries(COMPANY_ALIASES)) assert.deepEqual(company(label)?.names, spellings, label);
  // The label is not added on top: "Metropolitan" alone is also "the metropolitan area".
  assert.ok(!company("Metropolitan")?.names.includes("Metropolitan"));
  assert.deepEqual(company("Metropolitan")?.names, ["Metropolitan Premium Properties", "Metropolitan Group", "Metropolitan Homes"]);
  // A rival the list doesn't know is known by its label.
  assert.deepEqual(company("Savills")?.names, ["Savills"]);
  // A copy: changing one registry's names leaves the shared list as it was.
  company("Knight Frank")?.names.push("KF");
  assert.deepEqual(COMPANY_ALIASES["Knight Frank"], ["Knight Frank"]);
  assert.deepEqual(buildRegistry([{ label: "Knight Frank", query: "q" }], []).companies[1].names, ["Knight Frank"]);
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
  // A label differing from the list's only in case is not the list's company.
  assert.deepEqual(r.companies[1].names, ["knight frank"]);
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
  assert.equal(means("Sotheby\u2019s"), "Sotheby's");
  assert.equal(means("White & Co."), "White & Co");
  assert.equal(means("fam properties"), "fäm Properties");
  // Then the company's own spellings.
  assert.equal(means("Engel & Voelkers"), "Engel & Völkers");
  assert.equal(means("Metropolitan Premium Properties"), "Metropolitan");
  assert.equal(means("Driven | Forbes Global Properties"), "Driven Properties");
  assert.equal(means("Better Homes"), "betterhomes");
  assert.equal(means("PRIME by betterhomes"), "betterhomes");
  // Anything else is none of them.
  for (const name of ["Bayut", "Better Homes & Gardens", "Sotheby's auction house", "Driven", "", "  ", "&", null]) {
    assert.equal(means(name), null, String(name));
  }
  assert.equal(companyKey("Engel & Völkers"), "engel and volkers");
  assert.equal(companyKey(" Sotheby's  International "), "sothebys international");
});
