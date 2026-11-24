import { test } from "node:test";
import assert from "node:assert/strict";
import { h, load, mount } from "@/components/testRender";

// The note a preview build shows at the top of every page, and nowhere else.
//
// Run this file on its own: node scripts/test.mjs components/PreviewBanner.test.ts

const { default: PreviewBanner } = await load<typeof import("@/components/PreviewBanner")>("components/PreviewBanner.tsx");

test("a preview build says so and links to the live dashboard", async () => {
  const screen = await mount(h(PreviewBanner, { env: { VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "dashboard.example.com" } }));
  assert.match(screen.text(), /^Preview copy for checking changes before they go live\. Figures here can be slow or incomplete\./);
  assert.deepEqual(
    screen.links().map((l) => [l.text, l.href]),
    [["Open the live dashboard", "https://dashboard.example.com"]],
  );
  screen.unmount();
});

test("the live build, and a machine running it locally, show nothing", async () => {
  for (const env of [{ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "dashboard.example.com" }, {}]) {
    // Beside a stand-in page, as in app/layout.tsx: only the page's own words show.
    const screen = await mount(h("main", null, h(PreviewBanner, { env }), h("p", null, "The tab")));
    assert.equal(screen.text(), "The tab");
    assert.deepEqual(screen.links(), []);
    screen.unmount();
  }
});

test("a preview without a known live address still says so, with no broken link", async () => {
  const screen = await mount(h(PreviewBanner, { env: { VERCEL_ENV: "preview" } }));
  assert.match(screen.text(), /^Preview copy/);
  assert.deepEqual(screen.links(), []);
  screen.unmount();
});
