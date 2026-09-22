"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import type { IngestRun } from "@/lib/data";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The schedule in vercel.json, stated here so the UI can't drift from it. The
 * cron is "0 4 * * *" UTC; Dubai is UTC+4, so 08:00 local.
 */
const SCHEDULE_LABEL = "daily at 08:00 Dubai";

/**
 * A run older than this marks the bot overdue. 30h gives the daily schedule a
 * 6h grace window for retries and drift.
 *
 * Deliberately just a marker on the title — no banner. An always-visible warning
 * block became wallpaper, and it can't diagnose the cause anyway: the cron has
 * failed before both with the config missing AND with it present.
 */
const STALE_AFTER_H = 30;

/**
 * How far back "Re-read bodies" reaches. May 2026 is where the stored rows
 * start carrying the `hasBody` flag, so it is the earliest point we can tell a
 * headline-only verdict from a real read.
 */
const BACKFILL_FROM = "2026-05-01";
const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3.6e6;

export default function BotStatus({ runs }: { runs: IngestRun[] }) {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const last = runs[0];
  const stale = !!last && hoursSince(last.ran_at) > STALE_AFTER_H;

  /**
   * One reader for both buttons. The ingest and the backfill stream the same
   * SSE line format, so the only thing that differs is the endpoint.
   */
  async function stream(url: string) {
    setRunning(true);
    setLogs([]);

    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.body) throw new Error("No stream body returned");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by \n\n
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const msg = JSON.parse(line.slice(6)) as string;
                setLogs((prev) => {
                  const next = [...prev, msg].slice(-200);
                  requestAnimationFrame(() => {
                    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
                  });
                  return next;
                });
              } catch {}
            }
          }
        }
      }
    } catch (e) {
      setLogs((prev) => [...prev, `ERROR: ${String(e)}`]);
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  return (
    <div className="bot-status-wrap">
      <div className="bot-status">
        <div className="bot-left">
          <span className="pulse-dot" />
          <div>
            <div className="bot-title">
              News bot {last && !last.ok ? "⚠️" : ""}
              {stale ? <span title={`Overdue — no run in over ${STALE_AFTER_H}h.`}> ⏰</span> : null}
            </div>
            <div className="bot-sub">
              {last
                ? `Last run ${ago(last.ran_at)} · +${last.inserted} new · ${last.updated} dated · ${SCHEDULE_LABEL}`
                : `Hasn't run yet · scheduled ${SCHEDULE_LABEL} · or click Run now`}
            </div>
          </div>
        </div>
        <div className="bot-right">
          <button
            className="filter-btn"
            onClick={() => stream("/api/ingest/stream")}
            disabled={running}
          >
            {running ? "Running…" : "▶ Run now"}
          </button>
          {/*
            Re-judges mentions already stored, against their real article text.
            Needed because every row written before the wrapper-link fix was
            decided on its headline, and ingest never revisits a link it has
            already seen. Batched, and safe to click repeatedly: it can only
            promote a rejected row, never demote a kept or reviewed one.
          */}
          <button
            className="filter-btn"
            title="Re-read article bodies for mentions rejected since May and recover any that do name us"
            onClick={() => stream(`/api/pr/backfill/stream?from=${BACKFILL_FROM}&limit=40`)}
            disabled={running}
          >
            {running ? "Working…" : "⟲ Re-read bodies"}
          </button>
        </div>
      </div>

      {(running || logs.length > 0) && (
        <div className="bot-log-wrap">
          <div ref={logRef} className="bot-log">
            {logs.map((line, i) => {
              const isHeader = line.startsWith("─") || line.startsWith("Starting") || line.startsWith("Done");
              const isKept = line.includes("KEPT") || line.includes("RECOVERED");
              const isRejected = line.includes("rejected") || line.includes("ERROR");
              const isStep = /^\[\d+\/\d+\]/.test(line);
              return (
                <div
                  key={i}
                  className={
                    "bot-log-line" +
                    (isHeader ? " bot-log-header" : "") +
                    (isKept ? " bot-log-kept" : "") +
                    (isRejected ? " bot-log-rejected" : "") +
                    (isStep ? " bot-log-step" : "")
                  }
                >
                  {line}
                </div>
              );
            })}
            {running && <div className="bot-log-cursor">▌</div>}
          </div>
        </div>
      )}
    </div>
  );
}
