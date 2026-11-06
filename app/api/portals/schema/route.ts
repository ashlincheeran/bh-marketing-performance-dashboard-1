// Schema explorer for the Portals tab.
//
// Two questions the tab can't answer on its own: which column holds a property's
// AREA, and whether the CRM records portal SPEND anywhere. Both are facts about
// the database, and guessing either produces a query that silently groups or
// sums the wrong thing. So this reads information_schema and reports.
//
//   /api/portals/schema             → areas, spend candidates, portal fields
//   /api/portals/schema?table=listings   → every column on one table
//   /api/portals/schema?q=commission     → any column whose name matches
//
// Read-only by construction: information_schema plus SHOW-style lookups only,
// and the `table`/`q` inputs are pattern-escaped rather than interpolated raw.
import { mbQueryEx } from "@/lib/metabase";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * A value for inside a single-quoted SQL string. Cut BEFORE escaping, so the
 * cut can't split an escape and leave a trailing backslash on the quote.
 */
const str = (s: string) => s.slice(0, 80).replace(/['\\]/g, (c) => `\\${c}`);
/**
 * The same for a LIKE pattern, where % and _ are wildcards and need escaping
 * too. Only there: in an `=` comparison '\_' stays two characters, so
 * ?table=listing_portals matched no table at all.
 */
const lit = (s: string) => s.slice(0, 80).replace(/['\\%_]/g, (c) => `\\${c}`);

async function q(sql: string) {
  const r = await mbQueryEx(sql, true, 20000);
  return "rows" in r ? r.rows : { error: r.error };
}

export async function GET(req: Request) {
  if (!process.env.METABASE_URL) {
    return Response.json({ error: "METABASE_URL not set" }, { status: 500 });
  }
  const sp = new URL(req.url).searchParams;
  const table = sp.get("table");
  const search = sp.get("q");

  if (table) {
    return Response.json(
      {
        table,
        columns: await q(`
          SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${str(table)}'
          ORDER BY ORDINAL_POSITION`),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (search) {
    return Response.json(
      {
        search,
        matches: await q(`
          SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND LOWER(COLUMN_NAME) LIKE '%${lit(search.toLowerCase())}%'
          ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 200`),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const [tables, areaish, spendish, portalish] = await Promise.all([
    q(`SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_ROWS DESC LIMIT 120`),
    q(`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND (LOWER(COLUMN_NAME) LIKE '%communit%' OR LOWER(COLUMN_NAME) LIKE '%area%'
           OR LOWER(COLUMN_NAME) LIKE '%location%' OR LOWER(COLUMN_NAME) LIKE '%district%'
           OR LOWER(COLUMN_NAME) LIKE '%neighb%'  OR LOWER(COLUMN_NAME) LIKE '%city%'
           OR LOWER(COLUMN_NAME) LIKE '%tower%'   OR LOWER(COLUMN_NAME) LIKE '%building%')
       ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 200`),
    q(`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND (LOWER(COLUMN_NAME) LIKE '%spend%'   OR LOWER(COLUMN_NAME) LIKE '%budget%'
           OR LOWER(COLUMN_NAME) LIKE '%invoice%' OR LOWER(COLUMN_NAME) LIKE '%expense%'
           OR LOWER(COLUMN_NAME) LIKE '%cost%'    OR LOWER(COLUMN_NAME) LIKE '%subscription%'
           OR LOWER(TABLE_NAME)  LIKE '%invoice%' OR LOWER(TABLE_NAME)  LIKE '%expense%'
           OR LOWER(TABLE_NAME)  LIKE '%budget%'  OR LOWER(TABLE_NAME)  LIKE '%subscription%')
       ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 200`),
    q(`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND (LOWER(TABLE_NAME) LIKE '%portal%' OR LOWER(COLUMN_NAME) LIKE '%portal%'
           OR LOWER(COLUMN_NAME) LIKE '%publish%' OR LOWER(COLUMN_NAME) LIKE '%bayut%'
           OR LOWER(COLUMN_NAME) LIKE '%dubizzle%' OR LOWER(COLUMN_NAME) LIKE '%finder%')
       ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 200`),
  ]);

  return Response.json(
    {
      note: "TABLE_ROWS is InnoDB's estimate, not an exact count — fine for spotting the big tables, not for reporting.",
      tables,
      areaCandidates: areaish,
      spendCandidates: spendish,
      portalCandidates: portalish,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
