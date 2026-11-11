import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, calls, h, load, mount, reset, router, throwing } from "@/components/testRender";
import { notFinished } from "@/lib/actionCall";
import type { HandCheckItem } from "@/lib/data";

// Check by hand on PR & Media settings as the PR team sees it: the real
// component, rendered by React DOM into a stand-in document, its buttons
// pressed, its server actions answered by stand-ins (components/testRender.ts).
// Nothing reaches a server.
//
// Run this file on its own: node scripts/test.mjs components/HandCheck.test.ts

const { default: HandCheck } = await load<typeof import("@/components/HandCheck")>("components/HandCheck.tsx");

const item = (over: Partial<HandCheckItem> = {}): HandCheckItem => ({
  id: "na_0123456789abcdef0123",
  date: "2026-11-09",
  outlet: "Arabian Business",
  title: "Dubai rents rise again",
  link: "https://www.arabianbusiness.com/industries/real-estate/dubai-rents-rise-again",
  companies: ["betterhomes", "Knight Frank"],
  why: "The site blocks automated readers",
  ...over,
});

/** `element` mounted for one test, and taken down after it whatever happens. */
async function screenFor(t: { after: (fn: () => void) => void }, element: ReturnType<typeof h>) {
  reset();
  const screen = await mount(element);
  t.after(() => screen.unmount());
  return screen;
}

/** The card is still there: nothing reached the error boundary. */
function stillThere(screen: { caught: unknown[]; text(): string }) {
  assert.deepEqual(screen.caught, []);
  assert.ok(screen.text().includes("Check by hand"));
  assert.ok(!screen.text().includes("Something went wrong"));
}

test("each article shows when and where it ran, whom its searches were for, why the bot could not read it, and a link that opens in a new tab", async (t) => {
  const screen = await screenFor(
    t,
    h(HandCheck, {
      items: [
        item(),
        item({
          id: "na_paywall",
          date: "",
          outlet: null,
          title: "Prime prices hold in Dubai",
          link: null,
          companies: ["Driven Properties"],
          why: "Behind a paywall",
        }),
      ],
    }),
  );
  const text = screen.text();
  assert.ok(text.includes("Check by hand"));
  assert.ok(
    text.includes(
      "The bot could not read these, and they came from a search for betterhomes, a rival or a person. Their websites block automated readers or sit behind a paywall, so open each one in your own browser and decide. Nothing here counts until you say so.",
    ),
  );
  assert.ok(text.includes("Date Outlet Headline Searched for Why Action"));
  assert.ok(text.includes("2026-11-09 Arabian Business Dubai rents rise again betterhomes, Knight Frank The site blocks automated readers"));
  // Empty cells say so in words.
  assert.ok(text.includes("Undated Not given Prime prices hold in Dubai (no link to open) Driven Properties Behind a paywall"));
  // No em dash stands in for a missing value.
  assert.doesNotMatch(text, /\u2014/);
  assert.deepEqual(screen.links(), [
    {
      text: "Dubai rents rise again",
      href: "https://www.arabianbusiness.com/industries/real-estate/dubai-rents-rise-again",
      target: "_blank",
      rel: "noopener noreferrer",
    },
  ]);
  // A Count for each company the searches were for, then Not about them.
  assert.deepEqual(screen.buttons(), [
    "Count for betterhomes",
    "Count for Knight Frank",
    "Not about them",
    "Count for Driven Properties",
    "Not about them",
  ]);
});

test("Count for a company saves it for that company, and the page looks again", async (t) => {
  const screen = await screenFor(t, h(HandCheck, { items: [item()] }));
  answer("keepArticleAction", async () => ({ ok: true }));
  screen.click("Count for Knight Frank");
  await screen.until(() => router.refreshes >= 1, "the page to look again");
  assert.deepEqual(calls, [{ name: "keepArticleAction", args: ["na_0123456789abcdef0123", "Knight Frank"] }]);

  screen.click("Count for betterhomes");
  await screen.until(() => router.refreshes >= 2, "the page to look again");
  assert.deepEqual(calls[1], { name: "keepArticleAction", args: ["na_0123456789abcdef0123", "betterhomes"] });
  stillThere(screen);
});

test("Not about them is the article's Reject", async (t) => {
  const screen = await screenFor(t, h(HandCheck, { items: [item()] }));
  answer("rejectArticleAction", async () => ({ ok: true }));
  screen.click("Not about them");
  await screen.until(() => router.refreshes >= 1, "the page to look again");
  assert.deepEqual(calls, [{ name: "rejectArticleAction", args: ["na_0123456789abcdef0123"] }]);
  stillThere(screen);
});

test("every button waits while a save runs, and the action's error shows in its row", async (t) => {
  const screen = await screenFor(t, h(HandCheck, { items: [item(), item({ id: "na_other", title: "Prime prices hold" })] }));
  let finish: (r: unknown) => void = () => {};
  answer("keepArticleAction", () => new Promise((resolve) => (finish = resolve)));
  screen.click("Count for Knight Frank");
  await screen.until(() => screen.buttons().includes("Saving…"), "the save to show");
  for (const label of ["Count for betterhomes", "Not about them"]) assert.equal(screen.enabled(label), false, label);
  finish({ ok: false, error: "That article is no longer stored." });
  await screen.until(() => screen.text().includes("That article is no longer stored."), "the error");
  // Under the row it was pressed in, before the next row starts.
  const text = screen.text();
  assert.ok(text.indexOf("That article is no longer stored.") < text.indexOf("Prime prices hold"));
  await screen.until(() => screen.enabled("Count for Knight Frank"), "the buttons to be pressable again");
  assert.equal(router.refreshes, 0, "nothing was saved, so the page has no reason to look again");
  stillThere(screen);
});

test("a call that never finishes says it is not known whether it was saved", async (t) => {
  const screen = await screenFor(t, h(HandCheck, { items: [item()] }));
  answer("keepArticleAction", throwing());
  screen.click("Count for betterhomes");
  await screen.until(() => screen.text().includes(notFinished("it was counted for betterhomes")), "the error in the row");
  answer("rejectArticleAction", throwing());
  await screen.until(() => screen.enabled("Not about them"), "the buttons to be pressable again");
  screen.click("Not about them");
  await screen.until(() => screen.text().includes(notFinished("it was set aside as not about them")), "the error in the row");
  stillThere(screen);
});

test("nothing to check, no card", async (t) => {
  // In a box of its own, since a screen waits for something to be drawn.
  const screen = await screenFor(t, h("div", null, h(HandCheck, { items: [] })));
  assert.equal(screen.text(), "");
});
