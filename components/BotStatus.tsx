"use client";

// The news bot's status line: when it last ran, what that run added, and
// whether it is overdue.
//
// It used to carry two buttons as well. "Run now" streamed the old bot
// (lib/ingest.ts) through /api/ingest/stream, and "Re-read bodies" re-judged
// rejected rows through /api/pr/backfill/stream, which undid people's Rejects.
// The new news bot replaces both (docs/news-pipeline.md): it has its own Run
// now button, tries unreadable articles again by itself and re-checks older
// stories itself, so both routes now answer 410.
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

const hoursSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3.6e6;

export default function BotStatus({ runs }: { runs: IngestRun[] }) {
  const last = runs[0];
  const stale = !!last && hoursSince(last.ran_at) > STALE_AFTER_H;

  return (
    <div className="bot-status-wrap">
      <div className="bot-status">
        <div className="bot-left">
          <span className="pulse-dot" />
          <div>
            <div className="bot-title">
              News bot {last && !last.ok ? "⚠️" : ""}
              {stale ? <span title={`Overdue: no run in over ${STALE_AFTER_H}h.`}> ⏰</span> : null}
            </div>
            <div className="bot-sub">
              {last
                ? `Last run ${ago(last.ran_at)} · +${last.inserted} new · ${last.updated} dated · ${SCHEDULE_LABEL}`
                : `Hasn't run yet · scheduled ${SCHEDULE_LABEL} · or click Run now`}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
