"use client";

// The live log of a bot run, shared by People Sentiment and Socials
// Performance: the run is posted to its stream route, each line it sends shows
// as it arrives, and the page is refreshed when the run ends so its figures are
// the run's.
import { useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";

/**
 * A run's state and how to start one. `body` is built inside the run, so a
 * failure building it lands in the log like any other failure.
 */
export function useRunLog() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  async function start(url: string, body: () => unknown) {
    setRunning(true);
    setLogs([]);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body()),
      });
      if (!res.body) throw new Error("No stream body returned");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const msg = JSON.parse(line.slice(6)) as string;
                setLogs((prev) => {
                  const next = [...prev, msg].slice(-300);
                  requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
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

  return { running, logs, logRef, start };
}

/** The log box, shown from the moment a run starts. */
export function RunLog({ running, logs, logRef }: { running: boolean; logs: string[]; logRef: RefObject<HTMLDivElement | null> }) {
  if (!running && logs.length === 0) return null;
  return (
    <div className="bot-log-wrap" style={{ marginBottom: 18, borderRadius: 10, border: "1px solid var(--border)" }}>
      <div ref={logRef} className="bot-log">
        {logs.map((line, i) => {
          const isHeader = line.startsWith("─") || line.startsWith("Starting") || line.startsWith("Done");
          const isKept = line.includes("✓");
          const isRejected = line.includes("✗") || line.includes("ERROR") || line.includes("failed");
          const isStep = line.startsWith("▶");
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
  );
}
