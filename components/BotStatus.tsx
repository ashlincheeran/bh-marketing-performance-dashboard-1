"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { triggerIngestAction } from "@/app/actions";
import type { IngestRun } from "@/lib/data";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function BotStatus({ runs }: { runs: IngestRun[] }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const last = runs[0];

  function run() {
    setMsg(null);
    startTransition(async () => {
      const r = await triggerIngestAction();
      setMsg(
        r.ok
          ? `Done — ${r.inserted} new, ${r.updated} updated (from ${r.found} found)`
          : `Error: ${r.error}`,
      );
      router.refresh();
    });
  }

  return (
    <div className="bot-status">
      <div className="bot-left">
        <span className="pulse-dot" />
        <div>
          <div className="bot-title">News bot {last && !last.ok ? "⚠️" : ""}</div>
          <div className="bot-sub">
            {last
              ? `Last run ${ago(last.ran_at)} · +${last.inserted} new · ${last.updated} dated · runs on demand`
              : "Hasn't run yet · click Run now"}
          </div>
        </div>
      </div>
      <div className="bot-right">
        {msg && <span className="bot-msg">{msg}</span>}
        <button className="filter-btn" onClick={run} disabled={pending}>
          {pending ? "Running…" : "▶ Run now"}
        </button>
      </div>
    </div>
  );
}
