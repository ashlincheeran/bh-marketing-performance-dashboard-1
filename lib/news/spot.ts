// The name spotter (docs/news-pipeline.md, "read", step 4): the sentences of an
// article that name a tracked company or person. They become the numbered
// candidates the AI sorts, and an article with none is rejected for free.
//
// So a name missed here is coverage lost without anyone looking, while a name
// found by mistake only costs the AI a glance. betterhomes is found by the
// strict rules in lib/match.ts, shared with the old bot. Rivals and people are
// found by their spellings in the registry, as whole words, whatever the case,
// accents or apostrophes. It reads no database and calls nothing, so tests run
// it as it is.
import { betterhomesAt, quoteSpan, splitSentences } from "@/lib/match";
import { COMPANY_ALIASES } from "@/lib/news/registry";
import type { Candidate, Company, Registry, SpotResult } from "@/lib/news/types";

export { splitSentences };

/** The apostrophes people type and the ones typesetting turns them into. All of them count as "'". */
const APOSTROPHE = /['\u2018\u2019\u02bc\u2032`\u00b4]/;
const ACCENTS = /[\u0300-\u036f]/g;

/**
 * Text in lower case, without accents and with one kind of apostrophe, so
 * "Völkers" meets "Volkers" and "Sotheby’s" meets "Sotheby's". For each folded
 * character, `from` and `to` say which stretch of the original it came from, so
 * a name found in the folded text is cut from the original as written.
 */
function fold(s: string): { text: string; from: number[]; to: number[] } {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of s) {
    const folded = APOSTROPHE.test(ch) ? "'" : ch.toLowerCase().normalize("NFD").replace(ACCENTS, "");
    for (let k = 0; k < folded.length; k++) {
      from.push(at);
      to.push(at + ch.length);
    }
    text += folded;
    at += ch.length;
  }
  return { text, from, to };
}

// A whole word is letters, digits and hyphens: "co-working" is one word, so
// "White and Co" is not in it. The same goes for "Knight Frank-led", which is
// missed, but such a story almost always names the company elsewhere. A hyphen
// before a name is a prefix, as in "ex-Knight Frank", and still counts.
const BEFORE = "(?<![\\p{L}\\p{M}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{M}\\p{N}\\u2010\\u2011-])";
/** Between the words of a name: spaces, or a hyphen, as in "Kelly-Anne" or "Al-Msaddi". */
const JOIN = "[\\s\\u2010\\u2011-]+";
/** A spelling's words, which may hold an apostrophe ("sotheby's"), and its other marks, such as "&" or "|". */
const TOKENS = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}'\u2010\u2011-]/gu;

const escapeForPattern = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * One spelling as a pattern over folded text. The spaces between its words may
 * be hyphens, the spaces around "&" or "|" may be missing, and an apostrophe
 * inside a word may be left out ("Sothebys"). Null for a spelling with fewer
 * than three letters or digits: a stray "&" or "Al" saved as an alias would
 * match almost every article.
 */
function spellingPattern(spelling: string): string | null {
  const tokens = fold(spelling).text.match(TOKENS) ?? [];
  if (tokens.join("").replace(/[^\p{L}\p{N}]/gu, "").length < 3) return null;
  let pattern = "";
  let afterWord = false;
  for (const token of tokens) {
    const word = /^[\p{L}\p{M}\p{N}]/u.test(token);
    if (pattern) pattern += word && afterWord ? JOIN : "\\s*";
    pattern += word ? token.split("'").map(escapeForPattern).join("'?") : escapeForPattern(token);
    afterWord = word;
  }
  return pattern;
}

/** All of one company's or person's spellings as one pattern. Longest first, so the fullest name is the one found. */
function namePattern(spellings: string[]): RegExp | null {
  const parts = [...new Set(spellings.map(spellingPattern).filter((p): p is string => p !== null))];
  if (!parts.length) return null;
  parts.sort((a, b) => b.length - a.length);
  return new RegExp(`${BEFORE}(?:${parts.join("|")})${AFTER}`, "gu");
}

/**
 * The spellings that count for a rival. buildRegistry puts the label in
 * `names` too, but where COMPANY_ALIASES lists a rival's spellings and leaves
 * its label out, that is on purpose (docs/news-pipeline.md): "Metropolitan"
 * alone is also "the wider metropolitan area", so only the full names count.
 */
function spellingsOf(company: Company): string[] {
  const listed = COMPANY_ALIASES[company.label];
  if (!listed) return company.names;
  const kept = new Set(listed.map((s) => fold(s).text));
  return company.names.filter((n) => n !== company.label || kept.has(fold(n).text));
}

interface NameMatcher {
  kind: "company" | "person";
  /** The company's label, or the person's name as stored (Person.name). */
  name: string;
  pattern: RegExp;
}

/** A pattern for every rival and every person, current or former. betterhomes has its own rules. */
function matchersFor(reg: Registry): NameMatcher[] {
  const out: NameMatcher[] = [];
  for (const company of reg.companies) {
    if (company.isUs) continue;
    const pattern = namePattern(spellingsOf(company));
    if (pattern) out.push({ kind: "company", name: company.label, pattern });
  }
  // A person who moved is on file once per company, under the same name, and is one person here.
  const spellings = new Map<string, string[]>();
  for (const person of reg.people) {
    const aliases = (person.aliases ?? []).filter((a): a is string => typeof a === "string");
    spellings.set(person.name, [...(spellings.get(person.name) ?? []), person.name, ...aliases]);
  }
  for (const [name, list] of spellings) {
    const pattern = namePattern(list);
    if (pattern) out.push({ kind: "person", name, pattern });
  }
  return out;
}

interface Hit {
  kind: "company" | "person";
  name: string;
  /** Where the name sits in the sentence as written, from `start` up to `end`. */
  start: number;
  end: number;
}

/** Every tracked name in one sentence, in the order they appear. */
function hitsIn(sentence: string, usLabel: string, matchers: NameMatcher[]): Hit[] {
  const hits: Hit[] = [];
  const us = betterhomesAt(sentence);
  if (us) hits.push({ kind: "company", name: usLabel, start: us.index, end: us.index + us.length });
  const folded = fold(sentence);
  for (const m of matchers) {
    for (const found of folded.text.matchAll(m.pattern)) {
      const at = found.index ?? 0;
      hits.push({ kind: m.kind, name: m.name, start: folded.from[at], end: folded.to[at + found[0].length - 1] });
    }
  }
  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * The part of a sentence to quote: cut around its first name the way
 * findBrandSentences cuts. That cut can start after the name when the 180
 * characters before it hold no space (a long web address, say), so then the
 * quote starts at the name instead.
 */
function quoteAround(sentence: string, first: Hit): [number, number] {
  const [from, to] = quoteSpan(sentence, first.start, first.end);
  if (from <= first.start) return [from, to];
  const [f, t] = quoteSpan(sentence.slice(first.start), 0, first.end - first.start);
  return [first.start + f, first.start + t];
}

const namesOf = (hits: Hit[], kind: Hit["kind"]) => [...new Set(hits.filter((h) => h.kind === kind).map((h) => h.name))];

/**
 * The sentences of the headline and text that name a tracked company or
 * person, numbered from 1 in article order, at most `max` of them.
 *
 * A candidate lists the companies named by a company name and, separately,
 * the people named, by their name as stored. A person never adds their
 * company: whether "said Louis Harding" counts for Knight Frank is for the AI
 * and the check step, which know who is current and who has moved on. A long
 * sentence is cut to 400 characters around a name, and a name the cut left out
 * gets a cut of its own, since the quote is all the AI and the PR table see. A
 * candidate lists only the names its quote kept. The same quote twice, such as
 * a headline repeated as the first line, is one candidate.
 *
 * When there are more than `max`, every company and person named gets its
 * first sentence before any name gets a second, betterhomes first: in a
 * round-up quoting a dozen brokers, the first twelve sentences used to fill
 * the list, and a quote from our CEO further down never reached the AI.
 * companiesNamed and peopleNamed cover the whole article either way.
 */
export function spotNames(title: string, text: string, reg: Registry, max = 12): SpotResult {
  const matchers = matchersFor(reg);
  const found: Omit<Candidate, "n">[] = [];
  const companiesNamed = new Set<string>();
  const peopleNamed = new Set<string>();
  for (const sentence of splitSentences(`${title || ""}\n${text || ""}`)) {
    const hits = hitsIn(sentence, reg.us.label, matchers);
    if (!hits.length) continue;
    for (const hit of hits) (hit.kind === "company" ? companiesNamed : peopleNamed).add(hit.name);
    // One quote around the first name, then another around the first name it
    // left out, until every name in the sentence is in a quote. Each quote
    // holds the name it was cut around, so this always ends.
    let left = hits;
    while (left.length) {
      const [from, to] = quoteAround(sentence, left[0]);
      const inside = (h: Hit) => h.start >= from && h.end <= to;
      const kept = hits.filter(inside);
      left = left.filter((h) => !inside(h));
      const quote = sentence.slice(from, to).trim();
      if (found.some((c) => c.text === quote)) continue;
      found.push({ text: quote, companies: namesOf(kept, "company"), people: namesOf(kept, "person") });
    }
  }

  // Which candidates to keep: a first sentence for every name, then the rest in order.
  const chosen = new Set<number>();
  const take = (i: number) => {
    if (i >= 0 && chosen.size < max) chosen.add(i);
  };
  take(found.findIndex((c) => c.companies.includes(reg.us.label)));
  const covered = (pick: (c: Omit<Candidate, "n">) => string[]) => new Set([...chosen].flatMap((i) => pick(found[i])));
  for (const company of companiesNamed) {
    if (!covered((c) => c.companies).has(company)) take(found.findIndex((c) => c.companies.includes(company)));
  }
  for (const person of peopleNamed) {
    if (!covered((c) => c.people).has(person)) take(found.findIndex((c) => c.people.includes(person)));
  }
  for (let i = 0; i < found.length && chosen.size < max; i++) take(i);
  const candidates = [...chosen].sort((a, b) => a - b).map((i, k) => ({ n: k + 1, ...found[i] }));
  return { candidates, companiesNamed: [...companiesNamed], peopleNamed: [...peopleNamed] };
}
