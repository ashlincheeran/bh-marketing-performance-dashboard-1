"use client";

// Keeps a tab's figures live (lib/live.ts). The tab opens on the remembered
// answer, which can be up to an hour old; this asks for the latest as soon as
// what is shown is over a minute old, again every few minutes while the tab is
// in front of someone, and when they come back to it. `refresh` fetches the
// tab's current selection with liveUrl() and swaps the figures in quietly: the
// screen keeps what it shows until the new figures land.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { POLL_MS, isOld } from "@/lib/live";

/**
 * Asks for the latest figures when `cachedAt` (when the shown figures were
 * worked out) is over a minute old, every POLL_MS while the page is visible,
 * and on coming back to the page. One ask at a time; a failed ask is left to
 * the tab to report and is tried again at the next turn. Returns whether an
 * ask is running, for the "updating" note.
 */
export function useLiveRefresh(cachedAt: string | null | undefined, refresh: () => Promise<void>, enabled = true): boolean {
  const [updating, setUpdating] = useState(false);
  const running = useRef(false);

  const ask = useEffectEvent(async () => {
    if (running.current) return;
    running.current = true;
    setUpdating(true);
    try {
      await refresh();
    } catch {
      // The tab reports its own failures; the next turn tries again.
    } finally {
      running.current = false;
      setUpdating(false);
    }
  });
  const comeBack = useEffectEvent(() => {
    if (document.visibilityState === "visible" && isOld(cachedAt)) void ask();
  });

  // Old figures on screen: ask now. New figures (a younger cachedAt) settle it.
  useEffect(() => {
    if (enabled && isOld(cachedAt)) void ask();
  }, [cachedAt, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void ask();
    }, POLL_MS);
    document.addEventListener("visibilitychange", comeBack);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", comeBack);
    };
  }, [enabled]);

  return updating;
}
