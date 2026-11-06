import { test } from "node:test";
import assert from "node:assert/strict";
import { callAction, notFinished } from "@/lib/actionCall";

// What a button gets back from a server action call. Nothing here reaches the
// network: the calls are stand-ins that answer, fail or throw.

/** console.error, quiet for the length of one call, with what it was given. */
async function quietly<T>(run: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    return { result: await run(), logged };
  } finally {
    console.error = original;
  }
}

test("an action's own answer comes back as it is, success or failure", async () => {
  assert.deepEqual(await callAction(async () => ({ ok: true as const, runId: "nr_1" }), "x"), { ok: true, runId: "nr_1" });
  assert.deepEqual(await callAction(async () => ({ ok: false as const, error: "That article is no longer stored." }), "x"), {
    ok: false,
    error: "That article is no longer stored.",
  });
});

test("a call that throws is an error for the panel, never a rejection", async () => {
  const failed = notFinished("the Reject was saved");
  const dropped = await quietly(() =>
    callAction(async (): Promise<{ ok: true }> => {
      throw new TypeError("Failed to fetch");
    }, failed),
  );
  assert.deepEqual(dropped.result, { ok: false, error: failed, unfinished: true });
  // The real error goes to the browser's console, for whoever looks into it.
  assert.equal(dropped.logged.length, 1);
  assert.ok(dropped.logged[0].some((x) => x instanceof TypeError));

  // Thrown before any promise exists, as a call can be.
  const early = await quietly(() =>
    callAction((): Promise<{ ok: true }> => {
      throw new Error("An unexpected response was received from the server.");
    }, failed),
  );
  assert.deepEqual(early.result, { ok: false, error: failed, unfinished: true });
});

test("the panel says the change may or may not have been made, and to look before trying again", () => {
  assert.equal(
    notFinished("the Keep was saved"),
    "The request did not finish, so it is not known whether the Keep was saved. Reload the page to see what was saved before trying again.",
  );
  assert.equal(
    notFinished("the Supermetrics switch was changed", "Settings"),
    "The request did not finish, so it is not known whether the Supermetrics switch was changed. Reload Settings to see what was saved before trying again.",
  );
});
