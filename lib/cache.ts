// Remembered answers for the slow reads: the CRM through Metabase (10 to 27
// seconds a query), and the SEO and website sources. Each answer is kept in
// Supabase (data_cache, migration 0025) with the time it was worked out, and
// shown straight away the next time anyone asks the same question:
//
// - Younger than FRESH_MS (an hour): returned as it is.
// - Older: returned as it is, at once, and worked out again in the background
//   (after()), so the next look has the new one. One refresh at a time per
//   question (a lock that lapses after REFRESH_LOCK_MS).
// - Not kept yet: worked out now, as before, and kept.
//
// Only a complete answer is kept: one the source answered in full. A failed or
// partial answer is returned as it was, never kept, so a CRM timeout shows the
// last good figures instead of a blank, and never freezes a blank for an hour.
// The numbers are the ones the same queries give; only their age differs, and
// every answer says when it was worked out (`cachedAt`).
//
// Keys carry the deployment's environment, so a preview never serves its
// figures to production, and VERSION, raised when an answer's shape changes.
import { after } from "next/server";
import { errorMessage } from "@/lib/coerce";
import { adminClient } from "@/lib/supabase";

/** How long an answer is shown without being worked out again. */
export const FRESH_MS = 60 * 60_000;
/** How long one refresh holds the question before another may start: longer than any query's timeout. */
export const REFRESH_LOCK_MS = 3 * 60_000;
/** Raised when a kept answer's shape changes, so old ones are not read as new. */
const VERSION = "3";

/** When the answer was worked out, ISO: the "Updated … ago" on the tab. Null when it could not be kept or read. */
export type WithCachedAt<T> = T & { cachedAt: string | null };

/** Where answers are kept. The real one is Supabase's data_cache; tests use one in memory. */
export interface CacheStore {
  /** The kept answer, when it was worked out, and whether it was marked due for a refresh. */
  read(key: string): Promise<{ payload: unknown; computedAt: string; stale: boolean } | null>;
  write(key: string, payload: unknown, computedAt: string): Promise<void>;
  /** Take the right to refresh `key`: true unless another refresh started after `since`. */
  lock(key: string, since: string): Promise<boolean>;
  /** Mark every kept answer as due for a refresh, keeping it to show meanwhile. */
  markAllStale(): Promise<void>;
}

const TABLE = "data_cache";

/** data_cache through the service key. Null without one: the reads then simply run live. */
export function supabaseStore(): CacheStore | null {
  const db = adminClient();
  if (!db) return null;
  return {
    async read(key) {
      const { data, error } = await db.from(TABLE).select("payload,computed_at,stale").eq("key", key).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { payload: data.payload, computedAt: data.computed_at as string, stale: !!data.stale } : null;
    },
    async write(key, payload, computedAt) {
      const { error } = await db.from(TABLE).upsert({ key, payload, computed_at: computedAt, stale: false, refresh_started_at: null });
      if (error) throw new Error(error.message);
    },
    async lock(key, since) {
      const { data, error } = await db
        .from(TABLE)
        .update({ refresh_started_at: new Date().toISOString() })
        .eq("key", key)
        .or(`refresh_started_at.is.null,refresh_started_at.lt.${since}`)
        .select("key");
      if (error) throw new Error(error.message);
      return (data?.length ?? 0) > 0;
    },
    async markAllStale() {
      // Kept to show meanwhile, with the time it was really worked out.
      const { error } = await db.from(TABLE).update({ stale: true }).eq("stale", false);
      if (error) throw new Error(error.message);
    },
  };
}

/** The key for one question: its name and its arguments, as the function settled them. */
export function cacheKey(name: string, args: unknown, env = process.env.VERCEL_ENV || "development"): string {
  return `${VERSION}:${env}:${name}:${JSON.stringify(args)}`;
}

export interface RememberOptions {
  /** Work it out now and keep it, whatever is kept: the morning warm-up and Refresh everything. */
  fresh?: boolean;
  freshMs?: number;
  store?: CacheStore | null;
  now?: () => number;
  /** Runs the background refresh: after() in a request, the work itself in tests. */
  later?: (work: () => Promise<void>) => void;
}

/**
 * The answer to `key`: kept and young, kept and refreshed in the background,
 * or worked out now (see the top of this file). `complete` says whether an
 * answer is whole enough to keep. A store that can't be read or written never
 * stops the answer: it is worked out live, as it was before.
 */
export async function remembered<T extends object>(
  key: string,
  work: () => Promise<T>,
  complete: (answer: T) => boolean,
  opts: RememberOptions = {},
): Promise<WithCachedAt<T>> {
  const store = opts.store === undefined ? supabaseStore() : opts.store;
  const now = opts.now ?? Date.now;
  const later = opts.later ?? ((w: () => Promise<void>) => after(w));
  const iso = () => new Date(now()).toISOString();

  const keep = async (answer: T, at: string) => {
    if (!store || !complete(answer)) return;
    try {
      await store.write(key, answer, at);
    } catch (e) {
      console.error(`[cache] could not keep ${key}: ${errorMessage(e)}`);
    }
  };
  const fresh = async (): Promise<WithCachedAt<T>> => {
    const at = iso();
    const answer = await work();
    await keep(answer, at);
    return { ...answer, cachedAt: complete(answer) ? at : null };
  };

  if (!store || opts.fresh) return fresh();
  let kept: { payload: unknown; computedAt: string; stale: boolean } | null = null;
  try {
    kept = await store.read(key);
  } catch (e) {
    console.error(`[cache] could not read ${key}: ${errorMessage(e)}`);
    return fresh();
  }
  if (!kept) return fresh();

  const freshMs = opts.freshMs ?? FRESH_MS;
  const due = (row: { computedAt: string; stale: boolean }) => row.stale || !(now() - Date.parse(row.computedAt) < freshMs);
  if (due(kept)) {
    // Shown as it is, and worked out again behind it, once at a time, and not
    // again when another look's refresh has just brought it up to date.
    later(async () => {
      try {
        if (!(await store.lock(key, new Date(now() - REFRESH_LOCK_MS).toISOString()))) return;
        const current = await store.read(key);
        if (current && !due(current)) return;
        const at = iso();
        await keep(await work(), at);
      } catch (e) {
        console.error(`[cache] could not refresh ${key}: ${errorMessage(e)}`);
      }
    });
  }
  return { ...(kept.payload as T), cachedAt: kept.computedAt };
}

/** Every kept answer due for a refresh, shown meanwhile: Refresh everything. Never throws. */
export async function markAllStale(store: CacheStore | null = supabaseStore()): Promise<void> {
  if (!store) return;
  try {
    await store.markAllStale();
  } catch (e) {
    console.error(`[cache] could not mark the kept answers stale: ${errorMessage(e)}`);
  }
}
