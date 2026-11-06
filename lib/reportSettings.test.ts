import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REPORT_SETTINGS, readReportSettings } from "@/lib/reportSettings";

// The weekly email's reader, against a stand-in for the one query it makes.
// Nothing here reaches a database.

/** A client whose report_settings read answers `answer`. */
const answering = (answer: { data: unknown; error: { message: string } | null }) =>
  ({
    from: (table: string) => {
      assert.equal(table, "report_settings");
      return { select: () => ({ eq: () => ({ maybeSingle: async () => answer }) }) };
    },
  }) as unknown as Parameters<typeof readReportSettings>[0];

test("a failed read is a failure with its reason, never the defaults", async () => {
  // A statement timeout, as PostgREST answers one: the defaults here would show the email off with nobody on it.
  assert.deepEqual(await readReportSettings(answering({ data: null, error: { message: "canceling statement due to statement timeout" } })), {
    settings: null,
    error: "canceling statement due to statement timeout",
  });
  // No service key: nothing can be read.
  assert.deepEqual(await readReportSettings(null), { settings: null, error: "SUPABASE_SERVICE_ROLE_KEY not set" });
});

test("a missing table is named with the migration that makes it", async () => {
  const fix = "The report_settings table isn't created yet: apply migration 0017.";
  for (const message of [
    'relation "public.report_settings" does not exist',
    "Could not find the table 'public.report_settings' in the schema cache",
  ]) {
    assert.deepEqual(await readReportSettings(answering({ data: null, error: { message } })), { settings: null, error: fix });
  }
});

test("a row never saved gives the defaults, and a saved one is read as stored", async () => {
  assert.deepEqual(await readReportSettings(answering({ data: null, error: null })), {
    settings: DEFAULT_REPORT_SETTINGS,
    error: null,
  });
  const stored = await readReportSettings(
    answering({
      data: {
        payload: {
          ...DEFAULT_REPORT_SETTINGS,
          enabled: true,
          recipients: [{ email: "pr@bhomes.com", name: "PR", role: "to" }],
        },
      },
      error: null,
    }),
  );
  assert.equal(stored.error, null);
  assert.equal(stored.settings?.enabled, true);
  assert.deepEqual(stored.settings?.recipients, [{ email: "pr@bhomes.com", name: "PR", role: "to" }]);
});
