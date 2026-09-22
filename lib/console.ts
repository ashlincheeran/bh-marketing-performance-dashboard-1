// A diagnostics console for the Settings page.
//
// WHY IT EXISTS — this app talks to Apify, Google News, GDELT and Metabase, and
// when one of them misbehaves the only evidence is whatever the pipeline
// happened to log. Twice in this project a fix shipped on a guess because the
// service could not be reached from where the code was being written, and both
// times the guess was wrong. A box that runs a real request against the real
// credentials, from the deployed app, turns those guesses into answers.
//
// DELIBERATELY NOT A SHELL. There is no eval, no exec, no arbitrary SQL, and no
// way to reach the filesystem. Commands are a fixed registry with typed
// arguments, because an arbitrary-code box on a public URL behind a four-digit
// PIN is remote code execution, whatever it is called in the UI. Adding a
// capability means adding a command here, on purpose, in a commit someone can
// read.
//
// Secrets are never echoed: tokens are read from the environment and reported
// only as present or absent.
import { resolveArticleUrl } from "@/lib/googleNews";
import { fetchArticleBody } from "@/lib/apify";
import { mentionsBetterhomes } from "@/lib/match";

export interface CommandResult {
  ok: boolean;
  output: string;
}

const MAX_OUT = 12_000;
const clip = (s: string, n = 1200) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length} chars total]` : s);
const j = (v: unknown) => JSON.stringify(v, null, 2);

async function timedFetch(url: string, init: RequestInit = {}, ms = 60_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const started = Date.now();
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, ms: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

const apifyToken = () => process.env.APIFY_TOKEN ?? "";

interface Command {
  usage: string;
  help: string;
  run: (args: string, rest: string) => Promise<string>;
}

const COMMANDS: Record<string, Command> = {
  help: {
    usage: "help",
    help: "List every command.",
    run: async () =>
      Object.entries(COMMANDS)
        .map(([name, c]) => `${name.padEnd(16)} ${c.usage}\n${"".padEnd(16)} ${c.help}`)
        .join("\n\n"),
  },

  env: {
    usage: "env",
    help: "Which credentials this deployment actually has. Never prints a value.",
    run: async () => {
      const keys = [
        "APIFY_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
        "CRON_SECRET", "SESSION_SECRET", "DASHBOARD_PIN", "SETTINGS_PIN", "METABASE_URL",
      ];
      return keys.map((k) => `${(process.env[k] ? "set  " : "MISSING")} ${k}`).join("\n");
    },
  },

  "apify.whoami": {
    usage: "apify.whoami",
    help: "Apify account, plan and usage. Shows whether residential proxy is still available.",
    run: async () => {
      if (!apifyToken()) return "APIFY_TOKEN is not set on this deployment.";
      const r = await timedFetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(apifyToken())}`);
      if (!r.ok) return `HTTP ${r.status}\n${clip(r.text)}`;
      const d = JSON.parse(r.text)?.data ?? {};
      return [
        `username        ${d.username ?? "?"}`,
        `plan            ${d.plan?.id ?? d.plan?.name ?? "?"}`,
        `monthly usage   ${j(d.plan?.monthlyUsageCreditsUsd ?? d.currentBillingPeriod ?? "?")}`,
        `proxy groups    ${j(d.proxy?.groups?.map((g: { name: string }) => g.name) ?? "?")}`,
        ``,
        `Full payload:\n${clip(j(d), 4000)}`,
      ].join("\n");
    },
  },

  "apify.schema": {
    usage: "apify.schema <actor>          e.g. apify.schema memo23/google-news-scraper",
    help: "The actor's declared input fields. An actor with NO required fields drops unknown keys and returns zero rows, which looks identical to finding nothing.",
    run: async (args) => {
      if (!args) return "Usage: apify.schema <owner/actor>";
      if (!apifyToken()) return "APIFY_TOKEN is not set.";
      const r = await timedFetch(
        `https://api.apify.com/v2/acts/${args.trim().replace("/", "~")}/builds/default?token=${encodeURIComponent(apifyToken())}`,
      );
      if (!r.ok) return `HTTP ${r.status} — actor may be private, renamed, or misspelled\n${clip(r.text)}`;
      const raw = JSON.parse(r.text)?.data?.inputSchema;
      const schema = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!schema) return "This build declares no input schema at all.";
      const props = schema.properties ?? {};
      const required: string[] = schema.required ?? [];
      const lines = Object.entries(props).map(
        ([k, v]) => `  ${k.padEnd(24)} ${(v as { type?: string }).type ?? "?"}${required.includes(k) ? "  (REQUIRED)" : ""}`,
      );
      return [
        `required: ${required.length ? required.join(", ") : "(none — wrong keys will FAIL SILENTLY)"}`,
        ``,
        ...lines,
      ].join("\n");
    },
  },

  "apify.run": {
    usage: 'apify.run <actor> <json>      e.g. apify.run memo23/google-news-scraper {"query":"betterhomes"}',
    help: "Run an actor with exactly this input and show what comes back. The direct connector.",
    run: async (args, rest) => {
      const actor = args.trim();
      if (!actor) return "Usage: apify.run <owner/actor> <json input>";
      if (!apifyToken()) return "APIFY_TOKEN is not set.";
      let input: unknown = {};
      if (rest.trim()) {
        try {
          input = JSON.parse(rest);
        } catch (e) {
          return `Input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const r = await timedFetch(
        `https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items` +
          `?token=${encodeURIComponent(apifyToken())}&timeout=120&memory=2048`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
        150_000,
      );
      if (!r.ok) return `HTTP ${r.status} in ${r.ms}ms\n${clip(r.text, 2000)}`;
      const items = JSON.parse(r.text);
      const arr = Array.isArray(items) ? items : [];
      if (!arr.length) {
        return `0 rows in ${r.ms}ms.\nThat is NOT proof the actor found nothing — run apify.schema first; unknown input keys are dropped without error.`;
      }
      return [
        `${arr.length} rows in ${r.ms}ms`,
        `keys: ${Object.keys(arr[0]).join(", ")}`,
        ``,
        `first row:\n${clip(j(arr[0]), 3000)}`,
      ].join("\n");
    },
  },

  "apify.crawl": {
    usage: "apify.crawl <url>",
    help: "Read one page with the exact config the news bot uses, including the proxy fallback.",
    run: async (args) => {
      if (!args) return "Usage: apify.crawl <url>";
      const b = await fetchArticleBody(args.trim());
      return [
        `status        ${b.status}`,
        `resolved via  ${b.resolveStatus ?? "-"}`,
        `proxy used    ${b.via ?? "-"}`,
        `final url     ${b.resolvedUrl ?? "-"}`,
        `chars         ${b.text.length}`,
        `brand found   ${mentionsBetterhomes(b.text)}`,
        b.note ? `note          ${b.note}` : "",
        ``,
        b.text ? `text:\n${clip(b.text, 2500)}` : "(no text)",
      ].filter(Boolean).join("\n");
    },
  },

  "news.resolve": {
    usage: "news.resolve <google news url>",
    help: "Unwrap a Google News link to the publisher URL, and say which method worked.",
    run: async (args) => {
      if (!args) return "Usage: news.resolve <url>";
      const r = await resolveArticleUrl(args.trim());
      return `status ${r.status}\nurl    ${r.url ?? "(none)"}\n${r.note ? `note   ${r.note}` : ""}`;
    },
  },

  "news.rss": {
    usage: "news.rss <keyword>",
    help: "Raw Google News RSS for a keyword: how many results, and their titles and dates.",
    run: async (args) => {
      if (!args) return "Usage: news.rss <keyword>";
      const edition = process.env.NEWS_EDITION || "hl=en-AE&gl=AE&ceid=AE:en";
      const r = await timedFetch(
        `https://news.google.com/rss/search?q=${encodeURIComponent(args.trim())}&${edition}`,
      );
      if (!r.ok) return `HTTP ${r.status}\n${clip(r.text)}`;
      const items = r.text.split("<item>").slice(1);
      const rows = items.map((b) => {
        const t = b.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
        const d = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "";
        const date = d ? new Date(d).toISOString().slice(0, 10) : "?";
        return `${date}  ${t.replace(/&amp;/g, "&").slice(0, 110)}`;
      });
      return `${rows.length} results in ${r.ms}ms (edition ${edition})\n\n${rows.join("\n")}`;
    },
  },

  gdelt: {
    usage: "gdelt <query>",
    help: "GDELT DOC 2.0 search. Free, no key, and returns publisher URLs directly — the candidate replacement for Google News.",
    run: async (args) => {
      if (!args) return "Usage: gdelt <query>";
      const r = await timedFetch(
        `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(args.trim())}` +
          `&mode=artlist&maxrecords=50&format=json&sort=datedesc&timespan=3months`,
      );
      if (!r.ok) return `HTTP ${r.status}\n${clip(r.text)}`;
      let arts: { title?: string; url?: string; domain?: string; seendate?: string }[] = [];
      try {
        arts = JSON.parse(r.text)?.articles ?? [];
      } catch {
        return `Response was not JSON (GDELT does this for malformed queries):\n${clip(r.text, 800)}`;
      }
      const wrapped = arts.filter((a) => /news\.google\.com/i.test(a.url ?? "")).length;
      return [
        `${arts.length} articles in ${r.ms}ms · ${wrapped} wrapper URLs (want 0)`,
        ``,
        ...arts.slice(0, 40).map((a) => `${(a.seendate ?? "").slice(0, 8)}  ${(a.domain ?? "").padEnd(24)} ${(a.title ?? "").slice(0, 90)}`),
      ].join("\n");
    },
  },

  fetch: {
    usage: "fetch <url>",
    help: "Plain GET. Status, content type, size and the first part of the body.",
    run: async (args) => {
      if (!args) return "Usage: fetch <url>";
      const url = args.trim();
      if (!/^https?:\/\//i.test(url)) return "Only http(s) URLs.";
      const r = await timedFetch(url, { headers: { "user-agent": "Mozilla/5.0 (bh-console)" } });
      return `HTTP ${r.status} in ${r.ms}ms · ${r.text.length} bytes\n\n${clip(r.text, 2000)}`;
    },
  },
};

export function commandNames(): string[] {
  return Object.keys(COMMANDS);
}

export async function runCommand(line: string): Promise<CommandResult> {
  const trimmed = (line ?? "").trim();
  if (!trimmed) return { ok: false, output: "Type a command. `help` lists them." };

  const [name, ...parts] = trimmed.split(/\s+/);
  const cmd = COMMANDS[name];
  if (!cmd) {
    return {
      ok: false,
      output: `Unknown command "${name}".\n\nAvailable: ${commandNames().join(", ")}\nThis is a fixed list, not a shell — there is no way to run anything else.`,
    };
  }

  // First token is the argument; everything after it is passed through whole so
  // a JSON blob survives intact.
  const args = parts[0] ?? "";
  const rest = trimmed.slice(trimmed.indexOf(name) + name.length).trim().slice(args.length).trim();

  try {
    const output = await cmd.run(args, rest);
    return { ok: true, output: output.slice(0, MAX_OUT) };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, output: `Command threw:\n${msg}` };
  }
}
