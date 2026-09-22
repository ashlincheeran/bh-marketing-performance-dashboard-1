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

/**
 * Strip credentials out of anything on the way to the screen.
 *
 * Applied centrally and last, because the per-command promise not to echo
 * secrets was already broken once: apify.whoami printed the account payload
 * verbatim and Apify includes the proxy password in it. A rule that depends on
 * each command remembering is not a rule. Anything whose KEY looks like a
 * credential is masked whatever its value, and known token shapes are masked
 * wherever they appear in free text.
 */
const SECRET_KEY = /pass|secret|token|apikey|api_key|credential|privatekey|authorization/i;

function redact(text: string): string {
  let out = text;
  // "password": "…"  →  "password": "[redacted]"
  out = out.replace(
    /("(?:[A-Za-z_]*(?:pass|secret|token|apiKey|api_key|credential|privateKey)[A-Za-z_]*)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  );
  // bare token shapes, in case they appear outside a JSON pair
  out = out.replace(/\bapify_[A-Za-z0-9_]{10,}\b/g, "[redacted]");
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  // any env value this deployment holds, should one slip through verbatim
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 12 || !SECRET_KEY.test(k)) continue;
    out = out.split(v).join("[redacted]");
  }
  return out;
}
const clip = (s: string, n = 1200) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length} chars total]` : s);
const j = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * Unwrap the chain Node hides under `cause`.
 *
 * `fetch failed` is what undici reports for every connection-level problem —
 * DNS, TLS, refused, reset, timeout — and the actual reason is one or two
 * `cause` levels down. Printing only `message` turns five distinct faults into
 * one useless string, which is the same mistake that hid the Supermetrics quota
 * error and the Apify run-failed reason.
 */
function describeError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error) {
      const code = (cur as { code?: string }).code;
      const errno = (cur as { errno?: number }).errno;
      parts.push(
        `${cur.name}: ${cur.message}` +
          (code ? ` (code ${code}${errno !== undefined ? `, errno ${errno}` : ""})` : ""),
      );
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join("\n  caused by → ");
}

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
    help: "Apify plan, usage and which proxy groups are actually usable.",
    run: async () => {
      if (!apifyToken()) return "APIFY_TOKEN is not set on this deployment.";
      const r = await timedFetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(apifyToken())}`);
      if (!r.ok) return `HTTP ${r.status}\n${clip(r.text)}`;
      const d = JSON.parse(r.text)?.data ?? {};
      const plan = d.plan ?? {};

      // availableCount is the number that decides whether a crawl will run.
      // A group can be listed, and even appear in enabledPlatformFeatures,
      // while being unusable on this plan.
      const groups: { name: string; availableCount?: number }[] = d.proxy?.groups ?? [];
      const usable = groups.filter((g) => (g.availableCount ?? 0) > 0);

      return [
        `username           ${d.username ?? "?"}`,
        `plan               ${plan.id ?? "?"} · $${plan.maxMonthlyUsageUsd ?? "?"}/month`,
        `compute units      ${plan.maxMonthlyActorComputeUnits ?? "?"} per month`,
        `max concurrent     ${plan.maxConcurrentActorRuns ?? "?"} runs`,
        `data retention     ${plan.dataRetentionDays ?? "?"} days`,
        ``,
        `PROXY GROUPS (availableCount is what decides whether a run starts)`,
        ...groups.map((g) => `  ${(g.availableCount ?? 0) > 0 ? "USABLE " : "  none "} ${g.name} (${g.availableCount ?? 0})`),
        ``,
        usable.length
          ? `Crawls should request: ${usable.map((g) => g.name).join(", ")}`
          : `No proxy group is usable — crawl without a proxy group.`,
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
      const target =
        `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(args.trim())}` +
        `&mode=artlist&maxrecords=50&format=json&sort=datedesc&timespan=3months`;
      let r;
      try {
        // A default Node user-agent is refused by some public APIs, and GDELT
        // is served through a front end that has done so before.
        r = await timedFetch(target, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; bh-dashboard/1.0)", accept: "application/json" },
        }, 45_000);
      } catch (e) {
        return [
          `Could not reach api.gdeltproject.org.`,
          ``,
          describeError(e),
          ``,
          `url: ${target}`,
          ``,
          `A connection-level failure, not an API error — the request never got a`,
          `reply. ENOTFOUND is DNS, ECONNREFUSED/ECONNRESET is the host refusing`,
          `(cloud IP ranges are sometimes blocked), and a timeout means it hung.`,
          `Try: fetch https://api.gdeltproject.org/api/v2/doc/doc?query=test&format=json`,
        ].join("\n");
      }
      /**
       * GDELT allows one request every 5 seconds and says so in a 429 body.
       * That is a throttle, not a refusal — and a workable one: a daily run of
       * ~20 keyword queries spaced 5s apart finishes in under two minutes.
       */
      for (let attempt = 0; r.status === 429 && attempt < 3; attempt++) {
        await new Promise((res) => setTimeout(res, 6000));
        r = await timedFetch(target, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; bh-dashboard/1.0)", accept: "application/json" },
        }, 45_000);
      }
      if (r.status === 429) {
        return `Still rate limited after 3 retries.\nGDELT allows one request every 5 seconds — space calls out rather than retrying harder.`;
      }
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
    return { ok: true, output: redact(output).slice(0, MAX_OUT) };
  } catch (e) {
    return { ok: false, output: redact(`Command threw:\n${describeError(e)}`) };
  }
}
