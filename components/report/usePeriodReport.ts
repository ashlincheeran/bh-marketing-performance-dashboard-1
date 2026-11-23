"use client";

// How a report tab (SEO, Website) loads its figures: the half that arrives with
// the page, for the period picked in the header (lib/growthPeriod.ts), and the
// CRM half, asked for once the page is open. Both keep themselves current
// (useLiveRefresh). Shared so the two tabs pick, load, retry and refresh alike.
import { useCallback, useEffect, useState } from "react";
import { useLiveRefresh } from "@/components/useLiveRefresh";
import { periodQuery, type GrowthPeriod, type PeriodPreset } from "@/lib/growthPeriod";
import { liveUrl } from "@/lib/live";

/** A period picked in the header: a rolling preset, or two months. */
export type Choice = { preset: PeriodPreset; from: string; to: string };

/** How often the CRM half is asked before the page says it is unavailable, and the wait before each retry (doubling). */
const CRM_ATTEMPTS = 3;
const CRM_RETRY_MS = 20_000;

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const d = await res.json().catch(() => null);
  if (!res.ok || !d) throw new Error(d?.error ?? `HTTP ${res.status}`);
  return d as T;
}

/**
 * The figures that arrive with the page, for the period picked. Picking
 * fetches `api?<period>`, and the figures on screen stay, dimmed (`loading`),
 * until the new ones land; the page's address follows (`page?<period>`).
 */
export function usePeriodReport<R extends { period: GrowthPeriod; cachedAt?: string | null }>(initial: R, api: string, page: string) {
  const [report, setReport] = useState<R>(initial);
  const [choice, setChoice] = useState<Choice>({ preset: initial.period.preset, from: initial.period.from, to: initial.period.to });
  const [loadError, setLoadError] = useState<string | null>(null);
  const wanted = periodQuery(choice);
  const loading = wanted !== periodQuery(report.period);

  useEffect(() => {
    if (wanted === periodQuery(report.period)) return;
    let alive = true;
    getJson<R>(`${api}?${wanted}`)
      .then((d) => {
        if (!alive) return;
        setReport(d);
        // The months the server settled on, so the picker never describes figures not on screen.
        setChoice({ preset: d.period.preset, from: d.period.from, to: d.period.to });
        setLoadError(null);
        window.history?.replaceState(null, "", `${page}?${periodQuery(d.period)}${window.location?.hash ?? ""}`);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setChoice({ preset: report.period.preset, from: report.period.from, to: report.period.to });
      });
    return () => {
      alive = false;
    };
  }, [wanted, report.period, api, page]);

  /**
   * The latest figures for what is on screen. An answer that lands after the
   * period has changed is dropped, and a failed look keeps the figures shown;
   * the next turn asks again.
   */
  const refresh = useCallback(async () => {
    const asked = periodQuery(report.period);
    const d = await getJson<R>(liveUrl(`${api}?${asked}`));
    setReport((was) => (periodQuery(was.period) === asked ? d : was));
  }, [report.period, api]);
  const updating = useLiveRefresh(report.cachedAt, refresh, !loading);

  return { report, choice, setChoice, loading, loadError, updating };
}

/**
 * The CRM half, asked for the very months the page shows (`api?part=crm&from&to`),
 * so the two halves never cover different months. A CRM that timed out, often
 * while other tabs were asking it too, is asked again a little later, twice,
 * rather than left saying "unavailable" until the page is reloaded.
 */
export function useCrmHalf<C extends { cachedAt?: string | null; error?: string }>(api: string, period: { from: string; to: string }, enabled = true) {
  const key = `from=${period.from}&to=${period.to}`;
  const [state, setState] = useState<{ key: string; data?: C; error?: string } | null>(null);
  const now = state?.key === key ? state : null;

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number) => {
      const again = () => {
        if (attempt < CRM_ATTEMPTS) retry = setTimeout(() => ask(attempt + 1), CRM_RETRY_MS * attempt);
      };
      getJson<C>(`${api}?part=crm&${key}`)
        .then((d) => {
          if (!alive) return;
          setState({ key, data: d });
          if (d.error) again();
        })
        .catch((e) => {
          if (!alive) return;
          setState({ key, error: e instanceof Error ? e.message : String(e) });
          again();
        });
    };
    ask(1);
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [api, key]);

  const refresh = useCallback(async () => {
    const d = await getJson<C>(liveUrl(`${api}?part=crm&${key}`));
    setState((was) => (was && was.key !== key ? was : { key, data: d }));
  }, [api, key]);
  const crm = now?.data ?? null;
  const updating = useLiveRefresh(crm?.cachedAt, refresh, !!crm && enabled);

  return { crm, failed: now?.error ?? null, updating };
}
