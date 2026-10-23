// Re-runs the fact check on press mentions the bot has already stored.
//
// Until October 2026 the bot counted a story when its loose name match and a
// one-word AI answer said so, or on the headline alone when the article could
// not be read: of 122 stories it kept, 16 had been judged with the article in
// hand. This re-reads each one and applies the same two steps as the nightly
// run (findBrandSentences, then verifyMention), so every bot-found mention
// either carries the sentence that proves it or stops counting.
//
// Only rows the bot kept and nobody has reviewed: a person's Keep stands. A
// failure moves to "rejected" with the reason and the status it had, so the PR
// team can restore it from Bot Activity. A row whose article cannot be read
// counts only if its headline names us and passes the same check; otherwise it
// stops counting as pending re-read, the way the nightly run stores an unread
// story. It keeps the failed body status, so the backfill reads it again.
import { adminClient } from "@/lib/supabase";
import { fetchArticleBody } from "@/lib/apify";
import { findBrandSentences } from "@/lib/match";
import { verifyMention } from "@/lib/sentiment";

export interface FactcheckResult {
  scanned: number;
  passed: number;
  failed: number;
  unread: number;
  /** The AI did not answer; left for the next call. */
  noAnswer: number;
  /** Why it did not, one line per story. */
  noAnswerWhy: string[];
  /** Set when the AI itself is failing: the batch stopped reading articles. */
  aiError: string | null;
  remaining: number;
  failures: { title: string; outlet: string | null; date: string | null; why: string; quote: string | null }[];
}

type Row = {
  id: string;
  title: string | null;
  outlet_name: string | null;
  url: string | null;
  status: string;
  published_on: string | null;
  metadata: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
};

/** Rows per call, and the time a call may spend, inside the route's 300 s. */
export async function recheckStoredMentions(limit = 12, budgetMs = 230_000): Promise<FactcheckResult> {
  const db = adminClient();
  if (!db) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  if (!process.env.APIFY_TOKEN) throw new Error("APIFY_TOKEN not set: articles cannot be read, so nothing was checked");
  const t0 = Date.now();

  const { data, count, error } = await db
    .from("mentions")
    .select("id,title,outlet_name,url,status,published_on,metadata,raw", { count: "exact" })
    .eq("source", "googlenews")
    .eq("status", "new")
    .is("metadata->factCheck", null)
    .order("published_on", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`fact check query failed: ${error.message}`);
  const rows = (data ?? []) as Row[];

  const res: FactcheckResult = {
    scanned: rows.length, passed: 0, failed: 0, unread: 0, noAnswer: 0, noAnswerWhy: [], aiError: null,
    remaining: 0, failures: [],
  };
  const save = async (id: string, patch: Record<string, unknown>) => {
    const { error: e } = await db.from("mentions").update(patch).eq("id", id);
    if (e) throw new Error(`update failed for ${id}: ${e.message}`);
  };

  const queue = [...rows];
  const worker = async () => {
    for (;;) {
      // Stop taking rows that could not finish inside the route's limit, or
      // whose article would be read for an AI that is not answering.
      if (Date.now() - t0 > budgetMs - 60_000 || res.aiError) return;
      const row = queue.shift();
      if (!row) return;
      const meta = row.metadata ?? {};
      const checkedAt = new Date().toISOString();
      const link = row.url || (typeof row.raw?.link === "string" ? row.raw.link : "");
      const title = row.title ?? "";
      const body = link ? await fetchArticleBody(link) : null;
      // The read itself, in the fields the nightly run and the backfill write:
      // the backfill re-reads any rejected row whose bodyStatus is not ok.
      const evidence = {
        ...meta,
        bodyStatus: body?.status ?? "no link",
        resolveStatus: body?.resolveStatus ?? null,
        bodyChars: body?.text.length ?? 0,
      };
      // When the article was not read, the headline and whatever text came back
      // are all there is: a sentence there that names us still proves the story,
      // but finding none proves nothing, so the story waits for a read.
      const bodyOk = body?.status === "ok";
      const article = `${title}\n${body?.text ?? ""}`;
      const sentences = findBrandSentences(article);
      const verdict = sentences.length
        ? await verifyMention(title, row.outlet_name ?? "", sentences, (why) => {
            res.noAnswerWhy.push(`${row.outlet_name ?? "?"} · ${title.slice(0, 60)}: ${why}`);
            if (/^Gemini (HTTP|unreachable)/.test(why)) res.aiError = why;
          })
        : null;
      if (sentences.length && !verdict) {
        res.noAnswer++;
        continue;
      }
      if (verdict?.relevant) {
        res.passed++;
        await save(row.id, {
          metadata: { ...evidence, factCheck: { result: "pass", role: verdict.role, quote: verdict.quote, checkedAt } },
        });
        continue;
      }
      if (!bodyOk) {
        res.unread++;
        await save(row.id, {
          status: "rejected",
          metadata: {
            ...evidence,
            reason: `pending re-read: article not read (${evidence.bodyStatus}), so not counted`,
            factCheck: { result: "unread", bodyStatus: evidence.bodyStatus, prevStatus: row.status, checkedAt },
          },
        });
        continue;
      }
      const why = verdict?.why ?? "our name is not in the article";
      res.failed++;
      res.failures.push({ title, outlet: row.outlet_name, date: row.published_on, why, quote: verdict?.quote ?? null });
      await save(row.id, {
        status: "rejected",
        metadata: {
          ...evidence,
          reason: `fact check: ${why}`,
          factCheck: { result: "fail", why, quote: verdict?.quote ?? null, prevStatus: row.status, checkedAt },
        },
      });
    }
  };
  // Three at a time: Apify's memory ceiling allows three crawls together.
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker));
  // Rows the time budget or a missing AI answer left behind are still owed one.
  res.remaining = Math.max(0, (count ?? rows.length) - res.passed - res.failed - res.unread);
  return res;
}
