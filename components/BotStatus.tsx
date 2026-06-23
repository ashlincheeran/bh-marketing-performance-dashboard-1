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

export default function BotStatus({ runs }: { runs: IngestRun[] }) {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const last = runs[0];

  async function run() {
    setRunning(true);
    setLogs([]);

    try {
      const res = await fetch("/api/ingest/stream", { method: "POST" });
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
            <div className="bot-title">News bot {last && !last.ok ? "⚠️" : ""}</div>
            <div className="bot-sub">
              {last
                ? `Last run ${ago(last.ran_at)} · +${last.inserted} new · ${last.updated} dated · runs on demand`
                : "Hasn't run yet · click Run now"}
            </div>
          </div>
        </div>
        <div className="bot-right">
          <button className="filter-btn" onClick={run} disabled={running}>
            {running ? "Running…" : "▶ Run now"}
          </button>
        </div>
      </div>

      {(running || logs.length > 0) && (
        <div className="bot-log-wrap">
          <div ref={logRef} className="bot-log">
            {logs.map((line, i) => {
              const isHeader = line.startsWith("─") || line.startsWith("Starting") || line.startsWith("Done");
              const isKept = line.includes("KEPT");
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
