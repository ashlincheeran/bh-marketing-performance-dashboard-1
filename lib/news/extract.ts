// Finding an article's words in its page, for the news bot's free reader. lib/news/read.ts fetches the
// page; this reads it, and touches nothing but the HTML it is given.
//
// Pages say where their story is in several ways, some more reliable than others, so the ways are tried
// from the most explicit to the least: the article data publishers write for search engines (JSON-LD),
// the element marked as the article body, the <article> element, the <main> element, any paragraph on
// the page, and last the page's own summary. The first way that finds a whole article's worth of text
// wins. A shorter find is kept in case nothing better turns up, because a teaser or a related-stories
// card often sits in an <article> of its own while the story itself is in plain paragraphs further down.
import { NodeType, TextNode, parse, type HTMLElement, type Node } from "node-html-parser";

export type ExtractSource = "jsonld" | "articlebody" | "article" | "main" | "paragraphs" | "meta" | "none";

export interface ExtractedArticle {
  /** Plain text: entities decoded, whitespace collapsed, one paragraph per line. */
  text: string;
  /** og:title, else <title>. */
  title: string | null;
  /** The way that found `text`. */
  source: ExtractSource;
}

/** A whole article's worth of text: a read this long is "ok" (ReadResult), and a way that finds this much ends the search. */
export const OK_CHARS = 400;

/** With no part of the page marked as the story, shorter paragraphs are captions, bylines and buttons. */
const PARAGRAPH_MIN_CHARS = 40;

/**
 * Script text is kept as written, since the JSON-LD lives there. Style and noscript text is skipped
 * unread: neither is ever part of the story, and noscript is where "please enable JavaScript" lives.
 */
const PARSE_OPTIONS = { blockTextElements: { script: true, style: false, noscript: false } };

/**
 * The parser tidies each tag left open by moving what it holds up a level, which costs the square of
 * their number: 10,000 unclosed tags take it most of a second and 50,000 about seventeen. A page that
 * leaves more than this many open is parsed as written instead, so one broken page can't stall a run.
 */
const MAX_TIDY = 3_000;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const TAG_NAME = /[a-zA-Z][\w:-]*/y;
const SCRIPT_END = /<\/script\s*>/gi;
const STYLE_END = /<\/style\s*>/gi;

/** Opening tags minus closing ones, roughly: void and self-closed tags, comments and script bodies don't count. */
function unclosedTags(html: string): number {
  let open = 0;
  for (let i = html.indexOf("<"); i !== -1; i = html.indexOf("<", i + 1)) {
    if (html.charCodeAt(i + 1) === 47 /* "/" */) {
      open--;
      continue;
    }
    if (html.startsWith("!--", i + 1)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    TAG_NAME.lastIndex = i + 1;
    const name = TAG_NAME.exec(html)?.[0].toLowerCase();
    if (!name || VOID_TAGS.has(name)) continue;
    const end = html.indexOf(">", i);
    if (end === -1) break;
    if (html.charCodeAt(end - 1) !== 47) open++;
    if (name === "script" || name === "style") {
      const closer = name === "script" ? SCRIPT_END : STYLE_END;
      closer.lastIndex = end;
      const close = closer.exec(html);
      if (!close) break;
      // Land just before the closing tag, so the loop counts it.
      i = close.index - 1;
    }
  }
  return open;
}

function parsePage(html: string): HTMLElement {
  return parse(html, unclosedTags(html) > MAX_TIDY ? { ...PARSE_OPTIONS, parseNoneClosedTags: true } : PARSE_OPTIONS);
}

const tagOf = (el: HTMLElement): string => (el.rawTagName || "").toLowerCase();
const isElement = (node: Node): node is HTMLElement => node.nodeType === NodeType.ELEMENT_NODE;

/** Characters that show nothing but would split a name in two: soft hyphens, zero-width spaces, direction marks. */
const INVISIBLE = /[\u00ad\u200b\u200e\u200f\u2060\u202a-\u202e]/g;

/** One paragraph as plain text: entities already decoded, invisible characters dropped, whitespace collapsed. */
const tidy = (s: string): string => s.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();

/** Elements whose content is never the story's words. */
const NOT_TEXT = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "button", "select", "textarea"]);

/** Elements that start a new line of text. */
const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** The page's furniture: menus, mastheads, footers, sidebars, search boxes and sign-up forms. */
const FURNITURE_TAGS = new Set(["nav", "header", "footer", "aside", "form"]);
const FURNITURE_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);
/** What only the page's own content holds. */
const PAGE_PARTS = new Set(["h1", "article", "main"]);

type FurnitureTest = (el: HTMLElement) => boolean;

/** True when an attribute holds `token` among its space-separated values, in any case. */
function hasToken(el: HTMLElement, attr: string, token: string): boolean {
  // The raw check first: most elements have no such attribute, and parsing every element's attributes costs more.
  if (!el.rawAttrs || !el.rawAttrs.toLowerCase().includes(attr)) return false;
  return (el.getAttribute(attr) ?? "").toLowerCase().split(/\s+/).includes(token);
}

/**
 * True when a form holds the page's headline or article. ASP.NET pages wrap the whole page, story and
 * all, in one <form>, and that wrapper is not a sign-up box.
 */
function wrapsPage(form: HTMLElement): boolean {
  const stack: Node[] = [...form.childNodes];
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    const tag = tagOf(node);
    if (PAGE_PARTS.has(tag)) return true;
    // A form inside gets its own check, so a page of nested forms is still looked through once.
    if (tag === "form") continue;
    for (const child of node.childNodes) stack.push(child);
  }
  return false;
}

function furnitureTest(): FurnitureTest {
  const wrappers = new Map<HTMLElement, boolean>();
  return (el) => {
    const tag = tagOf(el);
    if (tag === "form") {
      let wraps = wrappers.get(el);
      if (wraps === undefined) {
        wraps = wrapsPage(el);
        wrappers.set(el, wraps);
      }
      return !wraps;
    }
    if (FURNITURE_TAGS.has(tag)) return true;
    if (!el.rawAttrs || !/role/i.test(el.rawAttrs)) return false;
    return (el.getAttribute("role") ?? "").toLowerCase().split(/\s+/).some((r) => FURNITURE_ROLES.has(r));
  };
}

/** An element's words as one line. Without recursion, so a page nested thousands of tags deep can't overflow the stack. */
function lineOf(el: HTMLElement): string {
  let out = "";
  const stack: Node[] = [el];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === NodeType.TEXT_NODE) {
      out += (node as TextNode).text;
      continue;
    }
    if (!isElement(node)) continue;
    const tag = tagOf(node);
    if (NOT_TEXT.has(tag)) continue;
    if (tag === "br") {
      out += " ";
      continue;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return tidy(out);
}

const END_OF_BLOCK = Symbol("end of block");

/** An element's words, a line per block (paragraph, heading, list item, line break), leaving out the furniture inside it. */
function linesOf(root: HTMLElement, isFurniture: FurnitureTest): string[] {
  const lines: string[] = [];
  let line = "";
  const endLine = () => {
    const text = tidy(line);
    if (text) lines.push(text);
    line = "";
  };
  // A block is passed twice: on the way in, and again by its marker on the way out, to end its line.
  const stack: (Node | typeof END_OF_BLOCK)[] = [root];
  while (stack.length) {
    const item = stack.pop()!;
    if (item === END_OF_BLOCK) {
      endLine();
      continue;
    }
    if (item.nodeType === NodeType.TEXT_NODE) {
      line += (item as TextNode).text;
      continue;
    }
    if (!isElement(item)) continue;
    const tag = tagOf(item);
    if (NOT_TEXT.has(tag) || (item !== root && isFurniture(item))) continue;
    if (tag === "br") {
      endLine();
      continue;
    }
    if (BLOCKS.has(tag)) {
      endLine();
      stack.push(END_OF_BLOCK);
    }
    for (let i = item.childNodes.length - 1; i >= 0; i--) stack.push(item.childNodes[i]);
  }
  endLine();
  return lines;
}

/**
 * The <p> paragraphs under `root`, in page order, leaving out the page's furniture and the landmarks in
 * `others` nested inside it. Comments and related-story cards are often articles of their own, and
 * leaving nested landmarks to themselves means each part of a page is looked through once.
 */
function paragraphsIn(root: HTMLElement, others: Set<HTMLElement>, isFurniture: FurnitureTest): string[] {
  const out: string[] = [];
  const stack: Node[] = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    const tag = tagOf(node);
    if (NOT_TEXT.has(tag) || isFurniture(node) || others.has(node)) continue;
    if (tag === "p") {
      out.push(lineOf(node));
      continue;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return out;
}

/**
 * Lines that are the site talking, not the story: cookie and consent banners, subscription walls,
 * sign-up boxes, links to other stories, advert labels and copyright lines. The phrasings are narrow on
 * purpose, since a line wrongly struck out could be the one that names a company.
 */
const NOTICES: RegExp[] = [
  /\b(?:we|this (?:web)?site|our (?:web)?site|we and our (?:\d+ )?(?:partners|vendors))\b.{0,60}\b(?:use|uses|store|stores|set|sets)\b.{0,40}\bcookies?\b/i,
  /\bcookie (?:policy|settings|preferences|notice|consent|statement)\b|\b(?:accept|allow|reject|decline|manage)(?: all)?(?: the)? cookies\b/i,
  /\bby (?:continuing|using|browsing|clicking)\b.{0,80}\b(?:site|website|page|service)\b.{0,80}\b(?:agree|consent|accept)/i,
  /^(?:please )?(?:subscribe|sign in|log ?in)\b.{0,60}\b(?:to (?:continue|read|access|unlock|keep reading|view)|for (?:full|unlimited) access)\b/i,
  /^already (?:a )?subscriber\b|^already have an account\b|\bsubscribers? only\b|\bexclusive(?:ly)? (?:to|for) (?:our )?subscribers\b/i,
  /\bfree articles?\b|\barticle limit\b|\breached (?:your|the) (?:limit|maximum) of\b/i,
  /\b(?:sign up|subscribe)\b.{0,30}\bnewsletters?\b|\b(?:delivered|straight|direct(?:ly)?) to your inbox\b/i,
  /\benable javascript\b|\bjavascript (?:is )?(?:disabled|required)\b/i,
  /\ball rights reserved\b|^(?:\u00a9|\(c\)|copyright)\s/i,
  /^(?:read more|read also|also read|read next|related(?: articles?| stories| news| content)?|recommended(?: for you)?|you (?:may|might) also like|more from|more on this|must read|don['\u2019]t miss|see also|trending(?: now)?|top stories)\s*(?:[:|\u00bb>\-\u2013\u2014]|$)/i,
  /^(?:advertisement|advert|sponsored(?: content)?|ad|story continues below(?: this)? advertisement|scroll to continue(?: with content)?|continue reading(?: below)?)\W*$/i,
  /^(?:follow|join) us on\b/i,
];

/** Only lines shorter than this are tested: a real paragraph that happens to mention cookies runs longer. */
const NOTICE_MAX_CHARS = 500;

const isNotice = (line: string): boolean => line.length < NOTICE_MAX_CHARS && NOTICES.some((re) => re.test(line));

/** Lines kept as the story: long enough, not a notice, and each only once (pages repeat a standfirst or a pull quote). */
function cleanLines(lines: string[], minChars = 1): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (line.length < minChars || seen.has(line) || isNotice(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** Text from elsewhere (Apify, say) in the shape extractArticle returns: one tidy paragraph per line, notices and repeats dropped. */
export function tidyText(text: string): string {
  return cleanLines(String(text ?? "").split(/\r\n?|\n/).map(tidy)).join("\n");
}

/**
 * JSON as some sites actually write it in ld+json blocks. Browsers never parse these, so nothing makes
 * them valid, and the faults are always the same few: raw line breaks inside strings, stray escapes,
 * trailing commas, comments, CDATA wrappers, and several objects one after another. Google's reader
 * shrugs those off, and so does this. Undefined when the block still can't be read.
 */
function looseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Repaired below.
  }
  const s = raw.replace(/<!\[CDATA\[|\]\]>|<!--|-->/g, "");
  const out: string[] = [];
  const lastMark = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    return j;
  };
  let inString = false;
  let depth = 0;
  let values = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") {
        const next = s[i + 1] ?? "";
        const valid = /["\\/bfnrt]/.test(next) || (next === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6)));
        // An escape JSON doesn't allow, such as \', keeps its character and loses the backslash.
        if (valid) out.push(c, next);
        else out.push(next);
        i++;
      } else if (c === '"') {
        inString = false;
        out.push(c);
      } else if (c < " ") {
        out.push(c === "\n" ? "\\n" : c === "\t" ? "\\t" : " ");
      } else {
        out.push(c);
      }
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const end = s.indexOf("\n", i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    // Between top-level values only an opening bracket matters: a semicolon, a stray comma or a
    // second closing brace is dropped, and the values are joined into one array below.
    if (depth === 0 && c !== "{" && c !== "[") continue;
    if (c === '"') {
      inString = true;
      out.push(c);
    } else if (c === "{" || c === "[") {
      if (depth === 0 && values++ > 0) out.push(",");
      depth++;
      out.push(c);
    } else if (c === "}" || c === "]") {
      const j = lastMark();
      if (out[j] === ",") out.splice(j, 1);
      depth = Math.max(0, depth - 1);
      out.push(c);
    } else {
      out.push(c);
    }
  }
  try {
    const text = out.join("");
    return JSON.parse(values > 1 ? `[${text}]` : text);
  } catch {
    return undefined;
  }
}

/** The five article types the design names, and the other kinds of NewsArticle (Opinion, Background, Review). */
const ARTICLE_TYPE = /^(?:article|blogposting|[a-z]*newsarticle)$/i;

/** True for "NewsArticle", ["Article", "NewsArticle"], or a full name such as "https://schema.org/NewsArticle". */
function isArticleType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === "string" && ARTICLE_TYPE.test(t.split(/[/#:]/).pop() ?? ""));
}

/** Enough for any news page; a block bigger than this is a catalogue, not an article. */
const MAX_JSON_NODES = 20_000;

/** Every articleBody of an article object, wherever it sits: at the top, in an array, in @graph, or under mainEntity. */
function articleBodies(data: unknown): string[] {
  const bodies: string[] = [];
  const stack: unknown[] = [data];
  for (let visited = 0; stack.length && visited < MAX_JSON_NODES; visited++) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const obj = value as Record<string, unknown>;
    if (isArticleType(obj["@type"])) {
      const body = obj.articleBody;
      if (typeof body === "string") bodies.push(body);
      else if (Array.isArray(body)) bodies.push(body.filter((b): b is string => typeof b === "string").join("\n"));
    }
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return bodies;
}

/** Tags that show an articleBody was written as HTML rather than plain text. */
const MARKUP = /<\/?(?:p|br|div|span|a|b|i|em|strong|h[1-6]|ul|ol|li|blockquote|figure|img)\b[^>]*>/i;

/** One articleBody as lines. Publishers write it as plain text, as HTML, or as HTML escaped into entities. */
function bodyLines(body: string): string[] {
  // Some write their line breaks as the two characters "\n", escaped once too often.
  let s = body.replace(/\\r\\n|\\n/g, "\n");
  if (!MARKUP.test(s)) s = new TextNode(s).text;
  if (MARKUP.test(s)) return linesOf(parsePage(s), furnitureTest());
  return s.split(/\r\n?|\n/).map(tidy);
}

function fromJsonLd(blocks: string[]): string {
  let best = "";
  for (const raw of blocks) {
    const data = looseJson(raw);
    if (data === undefined) continue;
    for (const body of articleBodies(data)) {
      const text = cleanLines(bodyLines(body)).join("\n");
      if (text.length > best.length) best = text;
    }
  }
  return best;
}

/** The landmark (<article> or <main>) with the most paragraph text of its own, as its paragraphs. */
function fromLandmarks(landmarks: HTMLElement[], isFurniture: FurnitureTest): string {
  const all = new Set(landmarks);
  let best = "";
  for (const el of landmarks) {
    const text = cleanLines(paragraphsIn(el, all, isFurniture)).join("\n");
    if (text.length > best.length) best = text;
  }
  return best;
}

interface Survey {
  /** The raw text of each ld+json script. */
  jsonLd: string[];
  /** Elements marked itemprop="articleBody", outermost only. */
  bodies: HTMLElement[];
  /** <article> elements outside the page furniture. */
  articles: HTMLElement[];
  /** <main> elements, or role="main", outside the furniture. */
  mains: HTMLElement[];
  /** og:title, description and og:description. */
  meta: Map<string, string>;
  /** The first <title> that isn't an icon's. */
  title: string | null;
}

const META_KEYS = new Set(["og:title", "description", "og:description"]);

/** One pass over the page, noting everything the ways need. */
function survey(root: HTMLElement, isFurniture: FurnitureTest): Survey {
  const found: Survey = { jsonLd: [], bodies: [], articles: [], mains: [], meta: new Map(), title: null };
  type Visit = { node: Node; inFurniture: boolean; inBody: boolean; inSvg: boolean };
  const stack: Visit[] = [{ node: root, inFurniture: false, inBody: false, inSvg: false }];
  while (stack.length) {
    const { node, inFurniture, inBody, inSvg } = stack.pop()!;
    if (!isElement(node)) continue;
    const tag = tagOf(node);
    if (tag === "script") {
      if (/application\/ld\+json/i.test(node.getAttribute("type") ?? "")) found.jsonLd.push(node.childNodes.map((c) => c.rawText).join(""));
      continue;
    }
    if (tag === "meta") {
      const content = tidy(node.getAttribute("content") ?? "");
      for (const name of [node.getAttribute("property"), node.getAttribute("name")]) {
        const key = (name ?? "").trim().toLowerCase();
        if (content && META_KEYS.has(key) && !found.meta.has(key)) found.meta.set(key, content);
      }
      continue;
    }
    if (tag === "title" && !inSvg) {
      if (found.title === null) found.title = lineOf(node) || null;
      continue;
    }
    const furniture = inFurniture || isFurniture(node);
    const body = inBody || hasToken(node, "itemprop", "articlebody");
    if (body && !inBody) found.bodies.push(node);
    if (!furniture && tag === "article") found.articles.push(node);
    if (!furniture && (tag === "main" || hasToken(node, "role", "main"))) found.mains.push(node);
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      stack.push({ node: node.childNodes[i], inFurniture: furniture, inBody: body, inSvg: inSvg || tag === "svg" });
    }
  }
  return found;
}

/** A way that fails on a page it doesn't understand finds nothing, and the next way gets its turn. */
function attempt(find: () => string): string {
  try {
    return find();
  } catch {
    return "";
  }
}

/**
 * The article's text and title from its page. Never throws: a page it can't make sense of gives
 * `source` "none" and empty text, which the read step treats as unread, not as an article about nothing.
 */
export function extractArticle(html: string): ExtractedArticle {
  try {
    const root = parsePage(typeof html === "string" ? html : "");
    const isFurniture = furnitureTest();
    const page = survey(root, isFurniture);
    const title = page.meta.get("og:title") ?? page.title;
    const ways: [ExtractSource, () => string][] = [
      ["jsonld", () => fromJsonLd(page.jsonLd)],
      ["articlebody", () => cleanLines(page.bodies.flatMap((el) => linesOf(el, isFurniture))).join("\n")],
      ["article", () => fromLandmarks(page.articles, isFurniture)],
      ["main", () => fromLandmarks(page.mains, isFurniture)],
      ["paragraphs", () => cleanLines(paragraphsIn(root, new Set(), isFurniture), PARAGRAPH_MIN_CHARS).join("\n")],
    ];
    let best: { text: string; source: ExtractSource } = { text: "", source: "none" };
    for (const [source, find] of ways) {
      const text = attempt(find);
      if (text.length >= OK_CHARS) return { text, title, source };
      // Ties go to the earlier, more explicit way.
      if (text.length > best.text.length) best = { text, source };
    }
    if (best.text) return { ...best, title };
    const summary = page.meta.get("description") ?? page.meta.get("og:description");
    return summary ? { text: summary, title, source: "meta" } : { text: "", title, source: "none" };
  } catch {
    return { text: "", title: null, source: "none" };
  }
}
