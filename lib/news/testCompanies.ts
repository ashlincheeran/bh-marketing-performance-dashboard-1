// The companies the news bot tracks, as migration 0024 stored them in
// tracked_keywords (6 Nov 2026): each rival's other spellings and own
// websites, and betterhomes' websites. Tests build their registry from these
// the way loadRegistry builds it from the table, so each rule is tested on the
// real lists. Not a test file itself: the runner reads *.test.ts files only.
import { buildRegistry, type RivalInput } from "@/lib/news/registry";
import type { Person, Registry } from "@/lib/news/types";

/** Each rival as tracked_keywords holds it, in its order, without its search. */
export const TRACKED_RIVALS: { label: string; aliases: string[]; sites: string[] }[] = [
  { label: "Allsopp & Allsopp", aliases: ["Allsopp & Allsopp", "Allsopp and Allsopp", "Allsopp Allsopp"], sites: ["allsoppandallsopp.com"] },
  // The company writes its own name in lower case.
  { label: "Haus & Haus", aliases: ["Haus & Haus", "haus & haus", "haus and haus"], sites: ["hausandhaus.com"] },
  {
    label: "Driven Properties",
    aliases: ["Driven Properties", "Driven | Forbes Global Properties", "Driven Forbes Global Properties"],
    sites: ["drivenproperties.com"],
  },
  {
    label: "Engel & Völkers",
    aliases: [
      "Engel & Völkers",
      "Engel & Volkers",
      "Engel and Volkers",
      "Engel and Völkers",
      "Engel Volkers",
      // "oe" is how "ö" is written without the accent.
      "Engel & Voelkers",
      "Engel and Voelkers",
      "Engel Voelkers",
    ],
    sites: ["engelvoelkers.*"],
  },
  // "Metropolitan" alone is left out on purpose: it is also "the metropolitan area".
  { label: "Metropolitan", aliases: ["Metropolitan Premium Properties", "Metropolitan Group", "Metropolitan Homes"], sites: ["metropolitan.realestate"] },
  {
    label: "Sotheby's",
    // Luxhabitat is the Sotheby's franchise Honey Deylami runs, and the press often names it alone.
    aliases: [
      "Sotheby's International Realty",
      "Sotheby's Realty",
      "Dubai Sotheby's",
      "Dubai Sotheby's International Realty",
      "Luxhabitat Sotheby's",
      "Luxhabitat Sotheby's International Realty",
      "Luxhabitat",
      "Sotheby's",
    ],
    // Dubai Sotheby's International Realty, Luxhabitat Sotheby's International Realty, and the network's own site.
    sites: ["sothebysrealty.*", "luxhabitat.ae"],
  },
  // whiteandco.ae forwards to whiteandcogroup.com.
  { label: "White & Co", aliases: ["White & Co", "White & Co.", "White and Co", "White & Co Real Estate"], sites: ["whiteandcogroup.com", "whiteandco.ae"] },
  { label: "fäm Properties", aliases: ["fäm Properties", "fam Properties", "fäm Real Estate"], sites: ["famproperties.com"] },
  { label: "Knight Frank", aliases: ["Knight Frank", "Knight Frank UAE"], sites: ["knightfrank.*"] },
];

/** betterhomes' own websites, the sites of its 'us' row. */
export const OUR_SITES = ["bhomes.com", "betterhomes.ae"];

/** The rivals with a search each, "<label> dubai" unless `search` makes another. */
export function trackedRivals(search = (label: string) => `${label} dubai`): RivalInput[] {
  return TRACKED_RIVALS.map((r) => ({ ...r, query: search(r.label) }));
}

/** The registry the bot builds from these lists, with these people. */
export function trackedRegistry(people: Person[] = [], search?: (label: string) => string): Registry {
  return buildRegistry(trackedRivals(search), people, { sites: OUR_SITES });
}

/** One rival, with a search, for a test that needs only a few. */
export function trackedRival(label: string, query = `${label} dubai`): RivalInput {
  const rival = TRACKED_RIVALS.find((r) => r.label === label);
  if (!rival) throw new Error(`${label} is not a tracked rival`);
  return { ...rival, query };
}
