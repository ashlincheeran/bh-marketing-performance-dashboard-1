import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { claudeClient, claudeConfigured, describeAiError, type AiFailure } from "@/lib/claude";
import { UNREADABLE, buildArticleMessage, buildSystemPrompt, checkAnswer, classifyArticle } from "@/lib/news/classify";
import { COMPANY_ALIASES, buildRegistry } from "@/lib/news/registry";
import type { Candidate, Person } from "@/lib/news/types";

const person = (name: string, company: string, role: string | null, active = true, note: string | null = null): Person => ({
  name,
  company,
  role,
  aliases: [],
  active,
  note,
});

// Every rival with its real spellings, and real people, the two who moved included.
const reg = buildRegistry(
  Object.keys(COMPANY_ALIASES).map((label) => ({ label, query: `${label} dubai` })),
  [
    person("Richard Waind", "betterhomes", "CEO"),
    person("Linda Mahoney", "betterhomes", null),
    person("Louis Harding", "betterhomes", "Former CEO", false, "Left in 2026 to be Partner and Head of Residential, Knight Frank UAE"),
    person("Louis Harding", "Knight Frank", "Partner and Head of Residential, UAE"),
    person("Faisal Durrani", "Knight Frank", "Partner and Head of Research, MENA"),
    person("Jacob Fletcher", "betterhomes", "Former broker", false, "Now Head of Residential Leasing at Engel & Völkers"),
    person("Jacob Fletcher", "Engel & Völkers", "Head of Residential Leasing"),
  ],
);

const MODEL = "claude-haiku-5-5";
const AT = "2026-11-05T04:00:00.000Z";
const cand = (n: number, text: string, companies: string[], people: string[] = []): Candidate => ({ n, text, companies, people });
const claim = (company: string, sentence: number, role = "news", sentiment = "neutral") => ({ company, sentence, role, sentiment });
const answer = (mentions: unknown[], extra: Record<string, unknown> = {}) => ({ mentions, irrelevant_reason: null, possible_moves: [], ...extra });
const check = (raw: unknown, candidates: Candidate[], companiesNamed: string[] = []) =>
  checkAnswer(raw, candidates, { companiesNamed }, reg, MODEL, AT);

// ── The instructions ─────────────────────────────────────────────────────

test("the instructions name every company and every current person, and list former people as former", () => {
  const prompt = buildSystemPrompt(reg);
  for (const c of reg.companies) assert.ok(prompt.includes(`\n- ${c.label}`), `missing ${c.label}`);
  const current = prompt.slice(prompt.indexOf("Current people"), prompt.indexOf("Former people"));
  const former = prompt.slice(prompt.indexOf("Former people"), prompt.indexOf("Each article comes"));
  for (const p of reg.people.filter((p) => p.active)) assert.ok(current.includes(p.name), `missing ${p.name}`);
  assert.ok(current.includes("- betterhomes: Richard Waind (CEO); Linda Mahoney\n"));
  assert.ok(current.includes("- Knight Frank: Louis Harding (Partner and Head of Residential, UAE); Faisal Durrani"));
  // Louis Harding speaks for Knight Frank now, so betterhomes' current line must not claim him.
  assert.ok(!current.match(/- betterhomes:.*Louis Harding/));
  assert.ok(former.includes("- Louis Harding, formerly at betterhomes (Former CEO): Left in 2026 to be Partner and Head of Residential, Knight Frank UAE"));
  assert.ok(former.includes("- Jacob Fletcher, formerly at betterhomes (Former broker): Now Head of Residential Leasing at Engel & Völkers"));
});

test("the instructions spell the companies the way the program matches them", () => {
  const prompt = buildSystemPrompt(reg);
  assert.ok(prompt.includes("- betterhomes: written betterhomes, Betterhomes, bhomes, Better Homes as a company name, PRIME by betterhomes"));
  // The bare word is left out on purpose, as in the name spotter: it is also "the metropolitan area".
  assert.ok(prompt.includes("- Metropolitan: written Metropolitan Premium Properties, Metropolitan Group, Metropolitan Homes\n"));
  // One spelling in two cases is shown once.
  assert.ok(prompt.includes("- Haus & Haus: written Haus & Haus, haus and haus\n"));
  for (const rule of ["Better Homes & Gardens", "BetterHome Group", "auction house", "white collar", "possible_moves", "When unsure"]) {
    assert.ok(prompt.includes(rule), `missing ${rule}`);
  }
});

test("a registry with no people leaves the people out of the instructions", () => {
  const prompt = buildSystemPrompt(buildRegistry([{ label: "Knight Frank", query: "knight frank dubai" }], []));
  assert.ok(prompt.includes("- Knight Frank: written Knight Frank"));
  assert.ok(!prompt.includes("Current people") && !prompt.includes("Former people"));
});

test("the article message gives headline, outlet and date, then each numbered sentence with its names", () => {
  const message = buildArticleMessage({ title: "Knight Frank  hires a new head", outlet: "Gulf News", publishedOn: "2026-11-04" }, [
    cand(1, "Knight Frank has appointed Louis Harding, who joins from betterhomes.", ["Knight Frank", "betterhomes"], ["Louis Harding"]),
    cand(2, "Prices rose,\nsaid Faisal Durrani.", [], ["Faisal Durrani"]),
  ]);
  assert.equal(
    message,
    [
      "Headline: Knight Frank hires a new head",
      "Outlet: Gulf News",
      "Date: 2026-11-04",
      "",
      "Sentences:",
      "1. Knight Frank has appointed Louis Harding, who joins from betterhomes.",
      "   Companies: Knight Frank, betterhomes. People: Louis Harding.",
      "2. Prices rose, said Faisal Durrani.",
      "   People: Faisal Durrani.",
    ].join("\n"),
  );
  const bare = buildArticleMessage({ title: "", outlet: null, publishedOn: null }, [cand(1, "Betterhomes opened.", ["betterhomes"])]);
  assert.ok(bare.startsWith("Headline: (none)\nOutlet: unknown\nDate: unknown\n"));
});

// ── Checking the answer ──────────────────────────────────────────────────

test("a valid mention is kept, quoted from our copy of the sentence", () => {
  const candidates = [cand(1, "Rents rose 4 per cent, according to an analysis by Betterhomes.", ["betterhomes"])];
  // A quote of the AI's own is not part of the answer and never replaces ours.
  const raw = answer([{ ...claim("betterhomes", 1, "data"), quote: "Rents rose 40 per cent, says Betterhomes." }]);
  assert.deepEqual(check(raw, candidates, ["betterhomes"]), {
    mentions: [{ company: "betterhomes", sentence: 1, quote: candidates[0].text, role: "data", sentiment: "neutral" }],
    irrelevantReason: null,
    possibleMoves: [],
    dropped: [],
    model: MODEL,
    checkedAt: AT,
  });
});

test("a company the sentence doesn't name is dropped, with the reason", () => {
  const candidates = [cand(1, "Knight Frank said prices rose.", ["Knight Frank"]), cand(2, "Betterhomes opened an office.", ["betterhomes"])];
  const d = check(answer([claim("Knight Frank", 2), claim("betterhomes", 2)]), candidates, ["Knight Frank", "betterhomes"]);
  assert.deepEqual(d.mentions.map((m) => m.company), ["betterhomes"]);
  assert.deepEqual(d.dropped, [{ company: "Knight Frank", sentence: 2, why: "sentence 2 does not name Knight Frank or any of its current people" }]);
});

test("a current person proves their company without the company's name", () => {
  const candidates = [cand(1, '"Demand is strong," said Faisal Durrani.', [], ["Faisal Durrani"]), cand(2, "Richard Waind expects calm.", [], ["Richard Waind"])];
  const d = check(answer([claim("Knight Frank", 1, "spokesperson", "positive"), claim("betterhomes", 2, "spokesperson")]), candidates);
  assert.deepEqual(
    d.mentions.map((m) => [m.company, m.sentence, m.role, m.sentiment, m.quote]),
    [
      ["Knight Frank", 1, "spokesperson", "positive", candidates[0].text],
      ["betterhomes", 2, "spokesperson", "neutral", candidates[1].text],
    ],
  );
  assert.deepEqual(d.dropped, []);
});

test("a former person proves their old company only when the article names it", () => {
  const candidates = [cand(1, "Louis Harding said the market was cooling.", [], ["Louis Harding"])];
  const raw = answer([claim("betterhomes", 1, "spokesperson"), claim("Knight Frank", 1, "spokesperson")]);

  const unnamed = check(raw, candidates, []);
  assert.deepEqual(unnamed.mentions.map((m) => m.company), ["Knight Frank"]);
  assert.deepEqual(unnamed.dropped, [
    {
      company: "betterhomes",
      sentence: 1,
      why: "sentence 1 names Louis Harding, who has left betterhomes, and the article never names betterhomes",
    },
  ]);

  const named = check(raw, candidates, ["betterhomes"]);
  assert.deepEqual(named.mentions.map((m) => m.company), ["betterhomes", "Knight Frank"]);
  assert.deepEqual(named.dropped, []);
});

test("one mention per company: the first claim that holds", () => {
  const candidates = [
    cand(1, "Betterhomes data shows rents rose.", ["betterhomes"]),
    cand(2, "Richard Waind, CEO of Betterhomes, said rents rose.", ["betterhomes"], ["Richard Waind"]),
  ];
  const d = check(answer([claim("betterhomes", 9, "data"), claim("betterhomes", 2, "spokesperson"), claim("betterhomes", 1, "data")]), candidates, ["betterhomes"]);
  assert.deepEqual(d.mentions, [{ company: "betterhomes", sentence: 2, quote: candidates[1].text, role: "spokesperson", sentiment: "neutral" }]);
  assert.deepEqual(d.dropped, [{ company: "betterhomes", sentence: 9, why: "sentence 9 is not one of the numbered sentences" }]);
});

test("an answer whose claims all fail is rejected, and says why", () => {
  const candidates = [cand(1, "Betterhomes opened an office.", ["betterhomes"])];
  const d = check(answer([claim("Sotheby's", 1), claim("Knight Frank", 1), claim("Sotheby's", 1)]), candidates, ["betterhomes"]);
  assert.deepEqual(d.mentions, []);
  assert.equal(d.dropped.length, 3);
  assert.equal(d.irrelevantReason, "the AI's sentences did not name the companies it claimed (Sotheby's, Knight Frank)");
});

test("the AI's own reason for a rejection is kept, and possible moves are kept as given", () => {
  const candidates = [cand(1, "Jacob Fletcher, a broker at Better Homes & Gardens, said...", [], ["Jacob Fletcher"])];
  const d = check(
    answer([], {
      irrelevant_reason: " Better Homes & Gardens is a US real estate brand. ",
      possible_moves: [{ person: "Jacob Fletcher", company_in_article: "Better Homes & Gardens" }],
    }),
    candidates,
  );
  assert.deepEqual(d.mentions, []);
  assert.equal(d.irrelevantReason, "Better Homes & Gardens is a US real estate brand.");
  assert.deepEqual(d.possibleMoves, [{ person: "Jacob Fletcher", companyInArticle: "Better Homes & Gardens" }]);
  assert.equal(check(answer([]), candidates).irrelevantReason, "the AI found no tracked company in it");
});

test("a company written another way is the company it plainly means", () => {
  const candidates = [
    cand(1, "Knight Frank said prime prices held.", ["Knight Frank"]),
    cand(2, "Engel & Völkers opened a new office.", ["Engel & Völkers"]),
    cand(3, "Allsopp & Allsopp reported record rents.", ["Allsopp & Allsopp"]),
    cand(4, "Agents at Metropolitan Premium Properties agreed.", ["Metropolitan"]),
    cand(5, "Rents rose, according to Betterhomes.", ["betterhomes"]),
  ];
  const d = check(
    answer([
      claim("knight frank", 1),
      claim("Engel and Volkers", 2),
      claim("Allsopp and Allsopp", 3),
      claim("Metropolitan Premium Properties", 4),
      claim(" Better Homes ", 5, "data"),
    ]),
    candidates,
    ["Knight Frank", "Engel & Völkers", "Allsopp & Allsopp", "Metropolitan", "betterhomes"],
  );
  assert.deepEqual(
    d.mentions.map((m) => [m.company, m.sentence]),
    [
      ["Knight Frank", 1],
      ["Engel & Völkers", 2],
      ["Allsopp & Allsopp", 3],
      ["Metropolitan", 4],
      ["betterhomes", 5],
    ],
  );
  assert.deepEqual(d.dropped, []);
  // Spelt without the accent the German way, too.
  assert.deepEqual(check(answer([claim("Engel & Voelkers", 2)]), candidates).mentions.map((m) => m.company), ["Engel & Völkers"]);
  assert.deepEqual(check(answer([claim("ENGEL VOLKERS", 2)]), candidates).mentions.map((m) => m.company), ["Engel & Völkers"]);
});

test("a company the bot does not track is refused on its own, and the rest of the answer stands", () => {
  const candidates = [cand(1, "Knight Frank and Bayut both said prices rose.", ["Knight Frank"])];
  const d = check(answer([claim("Bayut", 1), claim("Knight Frank", 1, "data")]), candidates, ["Knight Frank"]);
  assert.deepEqual(d.mentions.map((m) => m.company), ["Knight Frank"]);
  assert.deepEqual(d.dropped, [{ company: "Bayut", sentence: 1, why: "Bayut is not a tracked company" }]);
  assert.equal(d.irrelevantReason, null);

  // Only untracked companies: rejected, saying so.
  const only = check(answer([claim("Bayut", 1), claim("Better Homes & Gardens", 1)]), candidates, ["Knight Frank"]);
  assert.deepEqual(only.mentions, []);
  assert.equal(only.irrelevantReason, "the AI named only companies the bot does not track (Bayut, Better Homes & Gardens)");
  // A claim with no company is refused without standing for the whole answer, which an empty company means.
  const blank = check(answer([claim("  ", 1)]), candidates, ["Knight Frank"]);
  assert.deepEqual(blank.dropped, [{ company: "(no company)", sentence: 1, why: "the claim names no company" }]);
});

test("a role or tone off the list counts as named in passing, or neutral, and never costs the claim", () => {
  const candidates = [cand(1, "Richard Waind, CEO of Betterhomes, said rents rose.", ["betterhomes"], ["Richard Waind"])];
  const one = (role: string, tone: string) => check(answer([claim("betterhomes", 1, role, tone)]), candidates, ["betterhomes"]).mentions[0];
  assert.deepEqual([one("quoted", "upbeat").role, one("quoted", "upbeat").sentiment], ["passing", "neutral"]);
  // The listed words in another case, or with spaces, are still themselves.
  assert.deepEqual([one(" Spokesperson ", "POSITIVE").role, one(" Spokesperson ", "POSITIVE").sentiment], ["spokesperson", "positive"]);
  assert.deepEqual([one("data", "mixed").role, one("data", "mixed").sentiment], ["data", "mixed"]);
  assert.deepEqual([one("", "").role, one("", "").sentiment], ["passing", "neutral"]);
});

test("a malformed answer is rejected as unreadable, with the problem recorded", () => {
  const candidates = [cand(1, "Betterhomes opened an office.", ["betterhomes"])];
  const malformed: [unknown, string][] = [
    [null, "answer:"],
    ["not an answer", "answer:"],
    [{ mentions: [claim("betterhomes", 1)] }, "irrelevant_reason"],
    [answer([{ ...claim("betterhomes", 1), company: 42 }]), "mentions.0.company"],
    [answer([claim("betterhomes", 1.5)]), "mentions.0.sentence"],
    [answer([{ ...claim("betterhomes", 1), role: null }]), "mentions.0.role"],
    [answer([{ company: "betterhomes", sentence: 1, role: "news" }]), "mentions.0.sentiment"],
  ];
  for (const [raw, where] of malformed) {
    const d = check(raw, candidates, ["betterhomes"]);
    assert.deepEqual(d.mentions, []);
    assert.equal(d.irrelevantReason, UNREADABLE);
    assert.equal(d.irrelevantReason, "the AI's answer could not be read");
    assert.equal(d.dropped.length, 1);
    assert.equal(d.dropped[0].company, "");
    assert.ok(d.dropped[0].why.startsWith("the answer did not have the expected shape: "), d.dropped[0].why);
    assert.ok(d.dropped[0].why.includes(where), `${d.dropped[0].why} should point at ${where}`);
    assert.equal(d.model, MODEL);
  }
});

// ── Asking Claude, with the network stubbed ──────────────────────────────

type Sent = { url: string; body: Record<string, unknown> };
let fakeKeys = 0;

/**
 * Runs `fn` with `reply` standing in for the Claude API. Each run sets a key of
 * its own, so claudeClient builds a new client, and the SDK takes the stubbed
 * fetch when a client is built. Nothing here reaches the network.
 */
async function withFakeClaude<T>(reply: (sent: Sent) => Response, fn: () => Promise<T>, opts: { key?: string | null } = {}) {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  const key = opts.key === undefined ? `sk-ant-test-${++fakeKeys}` : opts.key;
  if (key === null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = key;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
    sent.push(call);
    return reply(call);
  }) as typeof fetch;
  try {
    return { result: await fn(), sent };
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test", ...headers } });
const reply = (content: unknown[], stop_reason = "end_turn", stop_details: unknown = null) =>
  json(200, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details,
    usage: { input_tokens: 900, output_tokens: 120 },
  });
// The SDK would retry a 429 or a 5xx; the header tells it not to, so a test never waits.
const apiError = (status: number, type: string, message: string) =>
  json(status, { type: "error", error: { type, message }, request_id: "req_test" }, { "x-should-retry": "false" });
const unexpected = () => {
  throw new Error("this test must not call Claude");
};

const article = { title: "Knight Frank appoints Louis Harding", outlet: "Gulf News", publishedOn: "2026-11-04" };
const moveCandidates = [
  cand(1, "Knight Frank has appointed Louis Harding, who joins from betterhomes.", ["Knight Frank", "betterhomes"], ["Louis Harding"]),
  cand(2, "Prices rose, said Faisal Durrani.", [], ["Faisal Durrani"]),
];
const moveSpot = { companiesNamed: ["Knight Frank", "betterhomes"] };

test("an article with no candidates is decided without asking Claude", async () => {
  const { result, sent } = await withFakeClaude(unexpected, () => classifyArticle(article, [], { companiesNamed: [] }, reg, MODEL));
  assert.equal(sent.length, 0);
  assert.ok("decision" in result);
  assert.deepEqual(result.decision.mentions, []);
  assert.match(result.decision.irrelevantReason ?? "", /not asked/);
  // Even with no key: there is nothing to ask about, so nothing is missing.
  const noKey = await withFakeClaude(unexpected, () => classifyArticle(article, [], { companiesNamed: [] }, reg, MODEL), { key: null });
  assert.ok("decision" in noKey.result);
});

test("with no key there is no call, and the run stops", async () => {
  const { result, sent } = await withFakeClaude(unexpected, () => classifyArticle(article, moveCandidates, moveSpot, reg, MODEL), { key: null });
  assert.equal(sent.length, 0);
  assert.ok("failure" in result);
  assert.equal(result.failure.kind, "no_key");
  assert.equal(result.failure.stopRun, true);
});

test("one request, without sampling settings, and the answer checked before it is used", async () => {
  const text = JSON.stringify(
    answer([claim("Knight Frank", 1, "news", "positive"), claim("betterhomes", 2, "passing"), claim("Knight Frank", 2, "spokesperson")]),
  );
  const { result, sent } = await withFakeClaude(
    () => reply([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }]),
    () => classifyArticle(article, moveCandidates, moveSpot, reg, MODEL),
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/v1\/messages$/);
  const body = sent[0].body;
  assert.equal(body.model, MODEL);
  assert.equal(body.max_tokens, 1500);
  assert.equal(body.system, buildSystemPrompt(reg));
  assert.deepEqual(body.messages, [{ role: "user", content: buildArticleMessage(article, moveCandidates) }]);
  type Field = { type: string; description?: string; enum?: unknown };
  const config = body.output_config as {
    effort: string;
    format: { type: string; schema: { required: string[]; properties: { mentions: { items: { properties: Record<string, Field> } } } } };
  };
  assert.equal(config.effort, "low");
  assert.equal(config.format.type, "json_schema");
  assert.deepEqual(config.format.schema.required, ["mentions", "irrelevant_reason", "possible_moves"]);
  for (const refused of ["temperature", "top_p", "top_k", "thinking"]) assert.ok(!(refused in body), `${refused} was sent`);
  // The company, role and tone go as plain strings, the allowed values in their descriptions.
  const fields = config.format.schema.properties.mentions.items.properties;
  for (const name of ["company", "role", "sentiment"]) {
    assert.equal(fields[name].type, "string", name);
    assert.ok(!JSON.stringify(fields[name]).includes("enum"), `${name} carries an enum`);
  }
  for (const c of reg.companies) assert.ok(fields.company.description?.includes(c.label), `the description leaves out ${c.label}`);
  assert.match(fields.role.description ?? "", /spokesperson, data, news or passing$/);
  assert.match(fields.sentiment.description ?? "", /positive, neutral, negative or mixed$/);
  assert.equal(fields.sentence.type, "integer");

  assert.ok("decision" in result);
  const d = result.decision;
  assert.deepEqual(
    d.mentions.map((m) => [m.company, m.sentence, m.role, m.quote]),
    [["Knight Frank", 1, "news", moveCandidates[0].text]],
  );
  assert.deepEqual(
    d.dropped.map((x) => [x.company, x.sentence]),
    [["betterhomes", 2]],
  );
  assert.equal(d.model, MODEL);
  assert.ok(!Number.isNaN(Date.parse(d.checkedAt)));
});

test("a refusal, a cut-off answer, no answer and an answer of the wrong shape are failures that don't stop the run", async () => {
  const cases: [string, () => Response, AiFailure["kind"], RegExp][] = [
    ["refusal", () => reply([], "refusal", { type: "refusal", category: "cyber", explanation: "Declined." }), "refusal", /^Claude declined to sort this article \(cyber: Declined\)\.$/],
    ["cut off in the JSON", () => reply([{ type: "text", text: '{"mentions": [' }], "max_tokens"), "bad_answer", /could not be used/],
    ["cut off while thinking", () => reply([{ type: "thinking", thinking: "", signature: "sig" }], "max_tokens"), "bad_answer", /cut off at 1500/],
    ["no answer", () => reply([]), "bad_answer", /no answer/],
  ];
  for (const [what, respond, kind, message] of cases) {
    const { result, sent } = await withFakeClaude(respond, () => classifyArticle(article, moveCandidates, moveSpot, reg, MODEL));
    assert.equal(sent.length, 1, what);
    assert.ok("failure" in result, what);
    assert.equal(result.failure.kind, kind, what);
    assert.equal(result.failure.stopRun, false, what);
    assert.match(result.failure.message, message, what);
  }
});

test("a company, role or tone off the list in Claude's answer no longer fails the article", async () => {
  // What failed the SDK's own reading of the answer before: one word off the lists.
  const text = JSON.stringify(
    answer([claim("knight frank", 1, "quoted", "upbeat"), claim("Bayut", 1), claim("Faisal Durrani", 2, "spokesperson", "positive")]),
  );
  const { result, sent } = await withFakeClaude(
    () => reply([{ type: "text", text }]),
    () => classifyArticle(article, moveCandidates, moveSpot, reg, MODEL),
  );
  assert.equal(sent.length, 1);
  assert.ok("decision" in result);
  assert.deepEqual(
    result.decision.mentions.map((m) => [m.company, m.sentence, m.role, m.sentiment]),
    [["Knight Frank", 1, "passing", "neutral"]],
  );
  // A person's name is not a company, and Bayut is not tracked: each refused on its own.
  assert.deepEqual(
    result.decision.dropped.map((x) => [x.company, x.why]),
    [
      ["Bayut", "Bayut is not a tracked company"],
      ["Faisal Durrani", "Faisal Durrani is not a tracked company"],
    ],
  );
});

test("an API error reply becomes the failure its kind calls for", async () => {
  const cases: [Response, AiFailure["kind"], boolean][] = [
    [apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), "credit", true],
    [apiError(401, "authentication_error", "invalid x-api-key"), "auth", true],
    [apiError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"), "rate", false],
    [apiError(529, "overloaded_error", "Overloaded"), "server", false],
    [apiError(404, "not_found_error", "model: claude-haiku-5-5"), "model", true],
  ];
  for (const [response, kind, stopRun] of cases) {
    const { result, sent } = await withFakeClaude(() => response, () => classifyArticle(article, moveCandidates, moveSpot, reg, MODEL));
    assert.equal(sent.length, 1, kind);
    assert.ok("failure" in result, kind);
    assert.deepEqual([result.failure.kind, result.failure.stopRun], [kind, stopRun]);
  }
});

// ── What an error means ──────────────────────────────────────────────────

const headers = new Headers({ "request-id": "req_test" });
const errorBody = (type: string, message: string, extra: Record<string, unknown> = {}) => ({
  type: "error",
  error: { type, message, ...extra },
  request_id: "req_test",
});

test("describeAiError maps each SDK error to its kind", () => {
  const cases: [string, unknown, AiFailure["kind"], boolean, RegExp][] = [
    ["a refused key", new AuthenticationError(401, errorBody("authentication_error", "invalid x-api-key"), undefined, headers, "authentication_error"), "auth", true, /refused \(HTTP 401\): invalid x-api-key$/],
    ["a key without permission", new PermissionDeniedError(403, errorBody("permission_error", "Not allowed"), undefined, headers, "permission_error"), "auth", true, /HTTP 403/],
    ["an empty balance", new BadRequestError(400, errorBody("invalid_request_error", "Your credit balance is too low to access the Anthropic API."), undefined, headers, "invalid_request_error"), "credit", true, /credit balance is too low/],
    ["a reached usage limit", new BadRequestError(400, errorBody("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."), undefined, headers, "invalid_request_error"), "credit", true, /usage limits/],
    ["any other bad request", new BadRequestError(400, errorBody("invalid_request_error", "max_tokens: 999999 > 128000"), undefined, headers, "invalid_request_error"), "bad_answer", false, /HTTP 400\): max_tokens/],
    ["a spend limit, by its code", new RateLimitError(429, errorBody("rate_limit_error", "Request blocked.", { code: "enforced_spend_limit_reached" }), undefined, headers, "rate_limit_error"), "credit", true, /spend limit/],
    ["a usage limit, in words", new RateLimitError(429, errorBody("rate_limit_error", "You have reached your usage limits for this month."), undefined, headers, "rate_limit_error"), "credit", true, /usage limits/],
    ["an ordinary rate limit", new RateLimitError(429, errorBody("rate_limit_error", "Number of requests has exceeded your per-minute rate limit"), undefined, headers, "rate_limit_error"), "rate", false, /HTTP 429/],
    ["a billing error", new APIError(402, errorBody("billing_error", "Payment required"), undefined, headers, "billing_error"), "credit", true, /billing/],
    ["an overload", new InternalServerError(529, errorBody("overloaded_error", "Overloaded"), undefined, headers, "overloaded_error"), "server", false, /HTTP 529\): Overloaded$/],
    ["any other 5xx", new APIError(503, errorBody("api_error", "Service unavailable"), undefined, headers, "api_error"), "server", false, /HTTP 503/],
    ["a dropped connection", new APIConnectionError({ message: "Connection error.", cause: new Error("fetch failed") }), "network", false, /reached: Connection error: fetch failed$/],
    ["a timeout", new APIConnectionTimeoutError(), "network", false, /timed out/],
    ["a model the key can't use", new NotFoundError(404, errorBody("not_found_error", "model: claude-nope"), undefined, headers, "not_found_error"), "model", true, /^The Claude model chosen in Settings is not available to this key \(HTTP 404\): model: claude-nope$/],
    ["a 404 without its class", new APIError(404, errorBody("not_found_error", "Not found"), undefined, headers, "not_found_error"), "model", true, /not available to this key \(HTTP 404\)/],
    ["an answer the SDK could not read", new AnthropicError("Failed to parse structured output as JSON: Unexpected end of JSON input"), "bad_answer", false, /Unexpected end of JSON input/],
    ["something thrown that is not an error", "boom", "bad_answer", false, /boom$/],
  ];
  for (const [what, error, kind, stopRun, message] of cases) {
    const f = describeAiError(error);
    assert.deepEqual([f.kind, f.stopRun], [kind, stopRun], what);
    assert.match(f.message, message, `${what}: ${f.message}`);
  }
});

test("describeAiError never repeats the API key", () => {
  const key = `sk-ant-api03-${"k".repeat(40)}`;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = key;
  try {
    const failures = [
      describeAiError(new APIConnectionError({ message: `Connection error for ${key}` })),
      describeAiError(new AuthenticationError(401, errorBody("authentication_error", `invalid key ${key}`), undefined, headers)),
      describeAiError(new Error(`odd: ${key}`)),
      // A key that isn't this deployment's is struck out by its shape.
      describeAiError(new Error("leaked sk-ant-admin01-abcdefghijklmnop")),
    ];
    for (const f of failures) assert.ok(!f.message.includes("sk-ant-"), f.message);
  } finally {
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
});

test("claudeClient is null without a key, and one client is built per key", () => {
  const realKey = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(claudeClient(), null);
    assert.equal(claudeConfigured(), false);
    process.env.ANTHROPIC_API_KEY = "   ";
    assert.equal(claudeClient(), null);
    assert.equal(claudeConfigured(), false);

    process.env.ANTHROPIC_API_KEY = "sk-ant-test-one";
    const first = claudeClient();
    assert.ok(first);
    assert.equal(claudeConfigured(), true);
    assert.equal(claudeClient(), first);
    assert.equal(first.maxRetries, 2);
    assert.equal(first.timeout, 60_000);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-two";
    assert.notEqual(claudeClient(), first);
  } finally {
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
});
