// Re-judge stored press mentions now that article bodies can actually be read.
//
// WHY — until the wrapper-link fix, every row was decided on `title + outlet`.
// Anything naming betterhomes only in its text was filed "no brand in text".
// Across Aug–Sep 2026 that was nine of the ten articles the bot considered,
// every one of them on the PR team's own coverage sheet. Those rows are still
// in the table, still marked rejected, and no future run will revisit them:
// ingest only ever looks at links it has never seen.
//
// So they have to be re-judged in place.
//
// ONE-WAY BY DESIGN — this can promote `rejected` to kept, and nothing else.
// It never flips a kept or human-`reviewed` row to rejected. The point is to
// recover coverage that was wrongly dropped, and a re-run must not be able to
// undo someone's manual review, or to delete a real mention because Apify
// happened to time out the second time round.
import { adminClient } from "@/lib/supabase";
import { assessMention } from "@/lib/sentiment";
import { fetchArticleBody, type BodyStatus } from "@/lib/apify";
import { mentionsBetterhomes } from "@/lib/match";
import { notify } from "@/lib/notify";
import type { Tier } from "@/lib/types";

export interface BackfillResult {
  scanned: number;
  skippedNoise: number;  // unrelated US homeware brand, never crawled
  reread: number;        // bodies successfully retrieved this pass
  recovered: number;     // rejected → kept
  stillRejected: number;
  unreadable: number;    // body still could not be retrieved
  remaining: number;     // rows in range left to process after this batch
  recoveredTitles: string[];
}

/**
 * The unrelated US homeware brand, which Google News returns constantly:
 * Walmart patio sets, Amazon storefronts, Prime Day round-ups. lib/match.ts
 * already strips "Better Homes & Gardens" before looking for us, so these can
 * never be recovered — and the first backfill pass spent a quarter of its
 * Apify budget crawling them. Skipped on the title alone, and only when
 * nothing brand-like survives removing that name.
 */
function isUsHomewareNoise(title: string): boolean {
  const t = (title || "").toLowerCase().replace(/['\u2019]/g, "");
  if (!/better ?homes (?:&|and) gardens|\bbhg\b/.test(t)) return false;
  const stripped = t.replace(/better ?homes (?:&|and) gardens/g, " ").replace(/\bbhg\b/g, " ");
  return !/\bbetter ?homes\b|\bbhomes\b|dubai|uae|emirat/.test(stripped);
}

/** Concurrency cap: Apify bills memory across simultaneous runs and 402s past it. */
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || 4);

interface Row {
  id: string;
  title: string;
  url: string | null;
  outlet_name: string | null;
  published_on: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Rows still owed a real read: rejected, in range, and never yet judged from a
 * retrieved body. `bodyStatus = 'ok'` is the marker the new pipeline writes, so
 * anything without it is either pre-fix or a read that failed.
 */
async function pending(from: string, to: string, limit: number) {
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  const { data, error, count } = await db
    .from("mentions")
    .select("id,title,url,outlet_name,published_on,status,metadata", { count: "exact" })
    .eq("status", "rejected")
    .gte("published_on", from)
    .lte("published_on", to)
    .or("metadata->>bodyStatus.is.null,metadata->>bodyStatus.neq.ok")
    .order("published_on", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`backfill query failed: ${error.message}`);
  return { rows: (data ?? []) as Row[], total: count ?? 0 };
}

export async function runPrBackfill(
  from: string,
  to: string,
  limit = 40,
  onProgress?: (msg: string) => void,
): Promise<BackfillResult> {
  const p = onProgress ?? (() => {});
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

  const { rows, total } = await pending(from, to, limit);
  const res: BackfillResult = {
    scanned: rows.length, skippedNoise: 0, reread: 0, recovered: 0, stillRejected: 0,
    unreadable: 0, remaining: Math.max(0, total - rows.length), recoveredTitles: [],
  };

  p(`Backfill ${from} → ${to}`);
  p(`${total} rejected rows never judged from a body · processing ${rows.length} this batch`);
  if (!rows.length) { p(`Nothing to do.`); return res; }

  const { data: outlets } = await db.from("outlets").select("id,name,tier");
  const byName = new Map((outlets ?? []).map((o) => [String(o.name).toLowerCase(), o]));

  const queue = [...rows];
  let done = 0;
  const updates: Record<string, unknown>[] = [];

  const worker = async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const n = ++done;
      const short = row.title.length > 55 ? row.title.slice(0, 55) + "…" : row.title;

      if (isUsHomewareNoise(row.title)) {
        res.skippedNoise++;
        // Marked so the next pass doesn't queue it again.
        updates.push({
          id: row.id,
          metadata: { ...(row.metadata ?? {}), bodyStatus: "ok", verdict: "title", reason: "Better Homes & Gardens — unrelated US brand" },
        });
        p(`[${n}/${rows.length}] US homeware brand · skipped — "${short}"`);
        continue;
      }

      if (!row.url) {
        res.unreadable++;
        p(`[${n}/${rows.length}] no stored URL · skipped — "${short}"`);
        continue;
      }

      const body = await fetchArticleBody(row.url);
      const bodyOk = body.status === "ok";
      if (bodyOk) res.reread++; else res.unreadable++;

      const evidence = {
        ...(row.metadata ?? {}),
        bodyStatus: body.status as BodyStatus,
        resolveStatus: body.resolveStatus,
        bodyChars: body.text.length,
        backfilledAt: new Date().toISOString(),
      };

      if (!bodyOk) {
        // Record what happened so the next pass can tell a paywall from a bug,
        // but leave the verdict alone: we still haven't read it.
        updates.push({ id: row.id, metadata: { ...evidence, reason: `body unavailable (${body.status}) — verdict withheld` } });
        p(`[${n}/${rows.length}] unreadable (${body.status}${body.note ? `: ${body.note.slice(0, 60)}` : ""}) — "${short}"`);
        continue;
      }

      if (!mentionsBetterhomes(`${row.title} ${row.outlet_name ?? ""} ${body.text}`)) {
        res.stillRejected++;
        updates.push({ id: row.id, metadata: { ...evidence, reason: "no brand in text", verdict: "body" } });
        p(`[${n}/${rows.length}] read ${body.text.length} chars · genuinely no mention — "${short}"`);
        continue;
      }

      const a = await assessMention(row.title, row.outlet_name ?? "", body.text, true);
      if (!a.relevant) {
        res.stillRejected++;
        updates.push({ id: row.id, metadata: { ...evidence, reason: "Gemini: not the Dubai brokerage", verdict: "body" } });
        p(`[${n}/${rows.length}] brand present but Gemini says no — "${short}"`);
        continue;
      }

      const match = byName.get(String(row.outlet_name ?? "").toLowerCase()) as { id?: number; tier?: string } | undefined;
      res.recovered++;
      res.recoveredTitles.push(`${row.published_on} · ${row.outlet_name} · ${row.title}`);
      updates.push({
        id: row.id,
        status: "new",
        brand: "betterhomes",
        sentiment: a.sentiment,
        tier: (match?.tier as Tier) ?? "Other",
        outlet_id: match?.id ?? null,
        url: body.resolvedUrl ?? row.url,
        metadata: { ...evidence, verdict: "body", recoveredBy: "backfill" },
      });
      p(`[${n}/${rows.length}] ★ RECOVERED (${a.sentiment ?? "—"}) — "${short}"`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  // Patch column-by-column: an upsert would need every NOT NULL column restated
  // and would silently blank anything omitted.
  for (const u of updates) {
    const { id, ...patch } = u as { id: string } & Record<string, unknown>;
    const { error } = await db.from("mentions").update(patch).eq("id", id);
    if (error) p(`  ! update failed for ${id}: ${error.message}`);
  }

  p(`─────────────────────────────────────`);
  p(`Read ${res.reread}/${rows.length - res.skippedNoise} bodies · ${res.recovered} recovered · ${res.stillRejected} confirmed not ours · ${res.unreadable} unreadable · ${res.skippedNoise} US-brand noise skipped`);
  if (res.remaining > 0) p(`${res.remaining} rows still queued — run again to continue.`);

  if (res.recovered > 0) {
    await notify(
      "success",
      "news",
      `${res.recovered} press ${res.recovered === 1 ? "mention" : "mentions"} recovered`,
      `Backfill ${from} → ${to} re-read article bodies and recovered coverage previously rejected as "no brand in text".`,
      `news:backfill:${from}`,
    );
  }
  return res;
}
