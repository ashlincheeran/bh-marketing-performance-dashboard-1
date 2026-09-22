"use client";

import { useRef, useState } from "react";

/**
 * A diagnostics console for admin.
 *
 * The dev sandbox this app is written in cannot reach Apify, Google News, GDELT
 * or the preview deployment — every one is blocked by network policy. That has
 * already caused two fixes to ship on a guess. This box runs the same request
 * from the deployed app, on the real credentials, and hands back output that
 * can be pasted straight into a conversation.
 *
 * It is NOT a shell. The server accepts a fixed list of commands and refuses
 * anything else by name; there is no eval, no exec and no arbitrary SQL. Read
 * lib/console.ts for the whole surface.
 */

const QUICK: { label: string; command: string }[] = [
  { label: "credentials", command: "env" },
  { label: "apify account", command: "apify.whoami" },
  { label: "google news", command: "news.rss betterhomes dubai" },
  { label: "gdelt", command: "gdelt betterhomes" },
  { label: "actor schema", command: "apify.schema memo23/google-news-scraper" },
];

export default function DiagnosticsConsole() {
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const history = useRef<string[]>([]);
  const historyAt = useRef<number>(-1);

  async function run(line: string) {
    const cmd = line.trim();
    if (!cmd || running) return;
    setRunning(true);
    setCopied(false);
    setOutput(`$ ${cmd}\n\nrunning…`);
    history.current = [cmd, ...history.current.filter((h) => h !== cmd)].slice(0, 50);
    historyAt.current = -1;
    try {
      const res = await fetch("/api/console", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      // A gate redirect arrives as HTML, which would otherwise surface as an
      // unhelpful JSON parse error.
      const text = await res.text();
      let body: { ok?: boolean; output?: string; ms?: number };
      try {
        body = JSON.parse(text);
      } catch {
        body = {
          ok: false,
          output:
            res.status === 401 || res.status === 403 || text.includes("<!DOCTYPE")
              ? "Session expired — reload Settings and enter the PIN again."
              : `Unexpected reply (HTTP ${res.status}):\n${text.slice(0, 600)}`,
        };
      }
      const took = body.ms === undefined ? "" : `\n\n[${(body.ms / 1000).toFixed(1)}s]`;
      setOutput(`$ ${cmd}\n\n${body.output ?? "(no output)"}${took}`);
    } catch (e) {
      setOutput(`$ ${cmd}\n\nRequest failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  /** Up/down walks previous commands, as a terminal would. */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void run(command);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!history.current.length) return;
      e.preventDefault();
      const next =
        e.key === "ArrowUp"
          ? Math.min(historyAt.current + 1, history.current.length - 1)
          : Math.max(historyAt.current - 1, -1);
      historyAt.current = next;
      setCommand(next === -1 ? "" : history.current[next]);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="chart-card">
      <h3 style={{ marginBottom: 4 }}>Diagnostics console</h3>
      <p style={{ fontSize: 12, opacity: 0.7, margin: 0, lineHeight: 1.6 }}>
        Runs a request from this deployment, on its real credentials, and shows exactly what comes
        back. Type <code>help</code> for the full list. A fixed set of commands, not a shell.
      </p>

      <div className="console-quick">
        {QUICK.map((q) => (
          <button
            key={q.command}
            className="filter-btn"
            disabled={running}
            onClick={() => {
              setCommand(q.command);
              void run(q.command);
            }}
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="console-input-row">
        <span className="console-prompt">$</span>
        <input
          className="console-input"
          value={command}
          spellCheck={false}
          autoComplete="off"
          placeholder="help"
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={running}
        />
        <button className="filter-btn" onClick={() => void run(command)} disabled={running || !command.trim()}>
          {running ? "Running…" : "Run"}
        </button>
      </div>

      {output && (
        <>
          <div className="bot-log-wrap">
            <div className="bot-log console-out">{output}</div>
          </div>
          <div className="console-actions">
            <button className="filter-btn" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy output"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
