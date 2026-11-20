// The ad accounts the Digital tab's picker offers, read from Supermetrics'
// account list (its "Get accounts" call: each login's accounts) instead of a
// typed snapshot, so a new ad account can be picked without a code change.
// Only the picker reads it: how rows are pulled is unchanged. Kept for an hour
// (lib/cache.ts).
//
// Supermetrics marks no account closed or unlicensed in this list. An account
// it files in a closed or disabled group is marked closed; "not licensed"
// comes from the last pull's own errors, on the page.
import { cacheKey, remembered } from "@/lib/cache";
import { getAppSettings } from "@/lib/appSettings";
import { errorMessage } from "@/lib/coerce";
import { PLATFORMS, type PaidPlatform } from "@/lib/paid";

export interface CatalogAccount {
  id: string;
  name: string;
  /** Filed by Supermetrics in a closed or disabled group. */
  disabled?: boolean;
}

export interface AccountCatalog {
  accounts: Record<PaidPlatform, CatalogAccount[]>;
  /** Why a platform's list could not be read, when one could not. */
  error?: string;
}

const BASE = "https://api.supermetrics.com";

/** The documented path, then the older enterprise one: whichever this key answers. */
const accountUrls = (dsId: string) => [
  `${BASE}/query/accounts?ds_id=${encodeURIComponent(dsId)}`,
  `${BASE}/enterprise/v2/query/accounts?json=${encodeURIComponent(JSON.stringify({ ds_id: dsId }))}`,
];

/** One platform's accounts across every login the team has for it, by name. */
async function listAccounts(dsId: string, key: string): Promise<CatalogAccount[]> {
  let why = "";
  for (const url of accountUrls(dsId)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, cache: "no-store", signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.data)) {
        const out = new Map<string, CatalogAccount>();
        for (const login of body.data) {
          for (const a of Array.isArray(login?.accounts) ? login.accounts : []) {
            const id = String(a?.account_id ?? "").trim();
            if (!id || out.has(id)) continue;
            const closed = /closed|disabled/i.test(String(a?.group_name ?? ""));
            out.set(id, { id, name: String(a?.account_name || id), ...(closed ? { disabled: true } : {}) });
          }
        }
        return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
      }
      why = body?.error?.message ?? `HTTP ${res.status}`;
      // Only a path this key doesn't know is worth the other one.
      if (res.status !== 404) break;
    } catch (e) {
      why = errorMessage(e);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(why || "no answer");
}

async function computeCatalog(): Promise<AccountCatalog> {
  const accounts: Record<PaidPlatform, CatalogAccount[]> = { google: [], meta: [], linkedin: [] };
  const key = process.env.SUPERMETRICS_API_KEY;
  if (!key) return { accounts, error: "SUPERMETRICS_API_KEY is not set" };
  if (!(await getAppSettings()).supermetricsEnabled) return { accounts, error: "Supermetrics is switched off in Settings" };
  const platforms = Object.keys(PLATFORMS) as PaidPlatform[];
  const results = await Promise.allSettled(platforms.map((p) => listAccounts(PLATFORMS[p].dsId, key)));
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") accounts[platforms[i]] = r.value;
    else errors.push(`${PLATFORMS[platforms[i]].label}: ${errorMessage(r.reason)}`);
  });
  return { accounts, ...(errors.length ? { error: errors.join("; ") } : {}) };
}

/** The accounts to pick from, kept for an hour; kept only when every platform's list came back. */
export async function getAccountCatalog(): Promise<AccountCatalog> {
  return remembered(cacheKey("paidCatalog", {}), computeCatalog, (c) => !c.error, {});
}
