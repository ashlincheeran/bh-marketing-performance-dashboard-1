import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { TrackedKeyword, TrackedPerson } from "@/lib/data";

// The companies card on PR & Media settings as the PR team sees it: the real
// component, rendered by React DOM into a stand-in document, its buttons
// pressed, its server actions answered by stand-ins
// (components/testRender.ts). Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/CompaniesManager.test.ts

const { default: CompaniesManager } = await load<typeof import("@/components/CompaniesManager")>("components/CompaniesManager.tsx");

type Props = Parameters<typeof CompaniesManager>[0];

const row = (over: Partial<TrackedKeyword>): TrackedKeyword => ({
  id: 1,
  query: "",
  label: null,
  createdAt: null,
  aliases: [],
  sites: [],
  ...over,
});

/** A rival known by its name alone, with one website. */
const KNIGHT_FRANK = row({ id: 1, query: "knight frank dubai", label: "Knight Frank", sites: ["knightfrank.*"] });
/** betterhomes' own row, which holds its websites. */
const OURS = row({ id: 5, query: "betterhomes", label: "betterhomes", sites: ["bhomes.com"] });

const person = (over: Partial<TrackedPerson>): TrackedPerson => ({
  id: 11,
  name: "Richard Waind",
  company: "betterhomes",
  role: "CEO",
  active: true,
  note: null,
  ...over,
});

const props = (over: Partial<Props> = {}): Props => ({
  us: OURS,
  prKeywords: [row({ id: 2, query: "betterhomes" })],
  rivals: [KNIGHT_FRANK],
  people: [],
  searches: [
    { company: "betterhomes", searches: ["betterhomes"] },
    { company: "Knight Frank", searches: ["knight frank dubai"] },
  ],
  error: null,
  ...over,
});

/** Mounted for one test, and taken down after it whatever happens. */
async function screenFor(t: { after: (fn: () => void) => void }, over: Partial<Props> = {}) {
  reset();
  const screen = await mount(h(CompaniesManager, props(over)));
  t.after(() => screen.unmount());
  return screen;
}

/** The page is still there: nothing reached the error boundary, and the cards still show. */
function stillThere(screen: { caught: unknown[]; text(): string }) {
  assert.deepEqual(screen.caught, []);
  assert.ok(screen.text().includes("Add a rival"));
  assert.ok(!screen.text().includes("Something went wrong"));
}

/** window.confirm answered by `reply`, as a person pressing OK or Cancel would, for one test. */
function confirming(t: { after: (fn: () => void) => void }, reply: () => boolean): string[] {
  const asked: string[] = [];
  const page = globalThis as { confirm?: (message: string) => boolean };
  page.confirm = (message) => {
    asked.push(message);
    return reply();
  };
  t.after(() => delete page.confirm);
  return asked;
}

test("a betterhomes search added or removed whose call never finishes says so under its list", async (t) => {
  const screen = await screenFor(t);
  answer("addKeywordAction", throwing());
  answer("removeKeywordAction", throwing());

  screen.type("Search term", "betterhomes dubai");
  await screen.until(() => screen.enabled("Add the search"), "Add to be pressable");
  screen.click("Add the search");
  await screen.until(() => screen.text().includes(notFinished("the search was added")), "the error under the list");
  stillThere(screen);

  await screen.until(() => screen.enabled("Remove betterhomes"), "the chip's remove button to be pressable");
  screen.click("Remove betterhomes");
  await screen.until(() => screen.text().includes(notFinished("the search was removed")), "the error under the list");
  stillThere(screen);
  assert.deepEqual(calls, [
    { name: "addKeywordAction", args: ["pr", "betterhomes dubai"] },
    { name: "removeKeywordAction", args: [2] },
  ]);
});

test("a change to a person whose call never finishes says so in their company's card", async (t) => {
  const screen = await screenFor(t, { people: [person({})] });
  answer("setPersonActiveAction", throwing());
  screen.click("Mark former");
  await screen.until(() => screen.text().includes(notFinished("the change to the list was saved")), "the error in the card");
  stillThere(screen);
  await screen.until(() => screen.enabled("Mark former"), "Mark former to be pressable again");
  assert.deepEqual(calls, [{ name: "setPersonActiveAction", args: [11, false] }]);
});

test("each card says what is searched every morning, its people included, and betterhomes' fixed spellings", async (t) => {
  const screen = await screenFor(t, {
    people: [person({}), person({ id: 12, name: "Faisal Durrani", company: "Knight Frank", role: "Partner, Head of Research" })],
    searches: [
      { company: "betterhomes", searches: ["betterhomes", "betterhomes dubai", '"Richard Waind" dubai'] },
      { company: "Knight Frank", searches: ["knight frank dubai", '"Faisal Durrani" dubai'] },
    ],
  });
  const text = screen.text();
  assert.ok(text.includes('Searched every morning: betterhomes · betterhomes dubai · "Richard Waind" dubai'));
  assert.ok(text.includes('Searched every morning: knight frank dubai · "Faisal Durrani" dubai'));
  assert.ok(
    text.includes(
      "betterhomes, bhomes and Better Homes used as a company name; Better Homes & Gardens and BetterHome Group never count.",
    ),
  );
  assert.ok(text.includes("Google News search: knight frank dubai"));
  assert.ok(text.includes("Faisal Durrani Partner, Head of Research"));
  // Known by its name alone until it has other spellings.
  assert.ok(text.includes("None, so the bot looks for its name alone."));
  // betterhomes first, then the rival.
  assert.ok(text.indexOf("Spellings") < text.indexOf("Knight Frank"));

  // The hints where a mistake is easy show under a field once something is typed in it, not in every card at once.
  const spellingHint = "Full company names only: a common word alone, such as Metropolitan or White, would catch unrelated stories.";
  const siteHint = "Websites like allsoppandallsopp.com, or knightfrank.* for every country.";
  assert.ok(!text.includes(spellingHint) && !text.includes(siteHint));
  screen.type("Other spelling of Knight Frank", "Metropolitan");
  await screen.until(() => screen.text().includes(spellingHint), "the spelling hint");
  screen.type("Website of Knight Frank", "knightfrank");
  await screen.until(() => screen.text().includes(siteHint), "the website hint");
  // Once, under the field typed in.
  assert.equal(screen.text().split(siteHint).length, 2);
});

test("another spelling is saved with the whole list, the name kept beside the first, and a second change builds on the first", async (t) => {
  const screen = await screenFor(t);
  answer("updateCompanyAction", async () => ({ ok: true }));

  screen.type("Other spelling of Knight Frank", "Knight Frank UAE");
  await screen.until(() => screen.enabled("Add the spelling to Knight Frank"), "Add to be pressable");
  screen.click("Add the spelling to Knight Frank");
  await screen.until(() => screen.text().includes("Knight Frank UAE ×"), "the new spelling's chip");

  // The page has not looked again yet: the list as saved here is what the next change starts from.
  screen.type("Other spelling of Knight Frank", "Knight Frank Dubai");
  await screen.until(() => screen.enabled("Add the spelling to Knight Frank"), "Add to be pressable again");
  screen.click("Add the spelling to Knight Frank");
  await screen.until(
    () => screen.text().includes("Knight Frank Dubai ×") && screen.enabled("Remove Knight Frank UAE"),
    "the second save to finish",
  );
  screen.click("Remove Knight Frank UAE");
  await screen.until(() => calls.length === 3, "the removal");

  assert.deepEqual(calls, [
    { name: "updateCompanyAction", args: [1, { aliases: ["Knight Frank", "Knight Frank UAE"] }] },
    { name: "updateCompanyAction", args: [1, { aliases: ["Knight Frank", "Knight Frank UAE", "Knight Frank Dubai"] }] },
    { name: "updateCompanyAction", args: [1, { aliases: ["Knight Frank", "Knight Frank Dubai"] }] },
  ]);
  stillThere(screen);
});

test("a website or spelling is checked at once: a mistake is said before any call, and a good website is cleaned", async (t) => {
  const screen = await screenFor(t);
  answer("updateCompanyAction", async () => ({ ok: true }));
  const notASite = '"not a site" is not a website. Give an address like allsoppandallsopp.com, or knightfrank.* for every country.';
  const listed = "That website is listed already.";
  /**
   * Type `value` and press `button` once the field shows it, then wait for
   * `said`. Typing clears the field's last error (`cleared`), which is how
   * the screen shows it has the new value.
   */
  const add = async (label: string, value: string, button: string, said: string, cleared?: string) => {
    screen.type(label, value);
    await screen.until(() => screen.enabled(button) && !(cleared && screen.text().includes(cleared)), `${button} to take ${value}`);
    screen.click(button);
    await screen.until(() => screen.text().includes(said), said);
  };

  await add("Website of Knight Frank", "not a site", "Add the website to Knight Frank", notASite);
  await add("Website of Knight Frank", "KnightFrank.*", "Add the website to Knight Frank", listed, notASite);
  await add(
    "Other spelling of Knight Frank",
    "bhomes",
    "Add the spelling to Knight Frank",
    `"bhomes" is betterhomes' own name, so it can't be another company's spelling.`,
  );
  assert.deepEqual(calls, [], "nothing was sent");

  await add("Website of Knight Frank", "https://www.knightfrank.ae/research", "Add the website to Knight Frank", "knightfrank.ae ×", listed);
  // betterhomes' websites are saved on its own row.
  await screen.until(() => screen.enabled("Remove bhomes.com"), "betterhomes' website to be removable");
  screen.click("Remove bhomes.com");
  await screen.until(() => calls.length === 2, "the removal");
  assert.deepEqual(calls, [
    { name: "updateCompanyAction", args: [1, { sites: ["knightfrank.*", "knightfrank.ae"] }] },
    { name: "updateCompanyAction", args: [5, { sites: [] }] },
  ]);
  stillThere(screen);
});

test("a stored list holding a spelling twice, in two cases, still takes a new one, and refuses the same one again", async (t) => {
  // As migration 0024 stored Haus & Haus, which writes its own name in lower case.
  const haus = row({ id: 3, query: "haus and haus dubai", label: "Haus & Haus", aliases: ["Haus & Haus", "haus & haus", "haus and haus"] });
  const screen = await screenFor(t, { rivals: [haus] });
  answer("updateCompanyAction", async () => ({ ok: true }));

  screen.type("Other spelling of Haus & Haus", "HAUS & HAUS");
  await screen.until(() => screen.enabled("Add the spelling to Haus & Haus"), "Add to be pressable");
  screen.click("Add the spelling to Haus & Haus");
  await screen.until(() => screen.text().includes("That spelling is listed already."), "the refusal");
  assert.deepEqual(calls, []);

  screen.type("Other spelling of Haus & Haus", "Haus and Haus Real Estate");
  await screen.until(() => !screen.text().includes("That spelling is listed already."), "the field to take the new spelling");
  screen.click("Add the spelling to Haus & Haus");
  await screen.until(() => calls.length === 1, "the save");
  // Saved as the server would store it: the same spelling in two cases is one.
  assert.deepEqual(calls, [
    { name: "updateCompanyAction", args: [3, { aliases: ["Haus & Haus", "haus and haus", "Haus and Haus Real Estate"] }] },
  ]);
});

test("a person is added at the card's company, with their role", async (t) => {
  const screen = await screenFor(t);
  answer("addPersonAction", async () => ({ ok: true }));
  screen.type("Name of a new person at Knight Frank", "Faisal Durrani");
  screen.type("Role of the new person at Knight Frank", "Partner, Head of Research");
  await screen.until(() => screen.enabled("Add the person at Knight Frank"), "Add to be pressable");
  screen.click("Add the person at Knight Frank");
  await screen.until(() => calls.length === 1, "the save");
  assert.deepEqual(calls, [
    { name: "addPersonAction", args: [{ name: "Faisal Durrani", company: "Knight Frank", role: "Partner, Head of Research" }] },
  ]);
  stillThere(screen);
});

test("Remove rival asks first, and Cancel leaves it tracked", async (t) => {
  let ok = false;
  const asked = confirming(t, () => ok);
  const screen = await screenFor(t);
  answer("removeKeywordAction", async () => ({ ok: true }));

  screen.click("Remove rival");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Stop tracking Knight Frank\? The bot stops searching for it/);
  assert.deepEqual(calls, []);

  ok = true;
  screen.click("Remove rival");
  await screen.until(() => calls.length === 1, "the removal");
  assert.deepEqual(calls, [{ name: "removeKeywordAction", args: [1] }]);
  stillThere(screen);
});

test("a new rival needs its company name and its search", async (t) => {
  const screen = await screenFor(t);
  answer("addKeywordAction", async () => ({ ok: true }));
  assert.equal(screen.enabled("+ Add rival"), false);
  screen.type("Rival's company name", "Savills");
  await screen.until(() => screen.text().includes("Add a rival"), "the card");
  assert.equal(screen.enabled("+ Add rival"), false);
  screen.type("Google News search for the rival", "savills dubai");
  await screen.until(() => screen.enabled("+ Add rival"), "Add rival to be pressable");
  screen.click("+ Add rival");
  await screen.until(() => calls.length === 1, "the save");
  assert.deepEqual(calls, [{ name: "addKeywordAction", args: ["competitor", "savills dubai", "Savills"] }]);
});

test("companies that could not be read are said so, with nothing to change", async (t) => {
  const screen = await screenFor(t, { error: "permission denied for table tracked_keywords" });
  assert.ok(
    screen.text().includes("The companies could not be read just now, so they can't be shown or changed. Reload the page to try again."),
  );
  assert.ok(screen.text().includes("Reason: permission denied for table tracked_keywords"));
  assert.deepEqual(screen.buttons(), []);
});

test("people who could not be read are said so in each card, never shown as nobody", async (t) => {
  const screen = await screenFor(t, { people: null });
  assert.ok(screen.text().includes("The people could not be read just now. Reload the page to try again."));
  assert.ok(!screen.text().includes("Nobody yet"));
  assert.ok(screen.text().includes("The people's own searches can't be listed until the people can be read."));
});

test("someone current at two companies is flagged, and people at a company no longer tracked are listed apart", async (t) => {
  const screen = await screenFor(t, {
    people: [
      person({ id: 1, name: "Louis Harding", role: "Head of Sales" }),
      person({ id: 2, name: "Louis Harding", company: "Knight Frank", role: "Head of Residential" }),
      person({ id: 3, name: "Ali Khan", company: "Driven Properties", role: null }),
    ],
  });
  const text = screen.text();
  assert.ok(text.includes("Also current at Knight Frank. Mark one of them former."));
  assert.ok(text.includes("Also current at betterhomes. Mark one of them former."));
  assert.ok(text.includes("People at companies no longer tracked"));
  assert.ok(text.includes("Ali Khan at Driven Properties"));
});
