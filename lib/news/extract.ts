// Finding an article's words in its page, for the news bot's free reader. lib/news/read.ts fetches the
// page; this reads it, and touches nothing but the HTML it is given.
//
// Pages say where their story is in several ways, some more reliable than others, so the ways are tried
// from the most explicit to the least: the article data publishers write for search engines (JSON-LD),
// the element marked as the article body, the <article> element, the <main> element, any paragraph on
// the page, and last the page's own summary. The first way that finds a whole article's worth of story
// wins, except that a body the publisher declared gives way to a later way that tells the same story at
// clearly greater length, since a declared body is sometimes only the story's opening. A shorter find is
// kept in case nothing better turns up, because a teaser or a related-stories card often sits in an
// <article> of its own while the story itself is in plain paragraphs further down.
//
// Only the story's own paragraphs decide whether the whole article was read. The text handed back holds
// more: every line of the part of the page the story was found in (headings, lists, tables, quotes,
// captions and short lines), and the story's credits (its byline, standfirst and note on the author),
// since a name in any of them still proves a mention. A teaser padded out with them is still a teaser,
// and so is a story the page itself says goes on behind a paywall.
import { NodeType, TextNode, parse, type HTMLElement, type Node } from "node-html-parser";
import { asRecord } from "@/lib/coerce";

export type ExtractSource = "jsonld" | "articlebody" | "article" | "main" | "paragraphs" | "meta" | "none";

export interface ExtractedArticle {
  /** Plain text: entities decoded, whitespace collapsed, one paragraph per line, the story's credits with it. */
  text: string;
  /** og:title, else <title>. */
  title: string | null;
  /** The way that found the story. */
  source: ExtractSource;
  /**
   * The characters of the story's own paragraphs in `text`. Only these decide whether the whole article
   * was read (OK_CHARS): headings, lists, captions and credits can prove a mention, but never pad out a
   * teaser. A summary has none.
   */
  storyChars: number;
  /** The page says the story goes on behind a paywall, and the rest of it is not on the page. */
  walled?: true;
  /** The page calls itself a page-not-found page, whatever status it was sent with. */
  notFound?: true;
}

/** A whole article's worth of story: a read with this much is "ok" (ReadResult), and a way that finds this much ends the search. */
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
  // The next ">" is looked for once and kept until the count passes it. Looked for afresh after every
  // "<", a page of "<b" written a million times over cost the square of its length: forty seconds,
  // with every timer of the run held up behind it.
  let gt = -1;
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
    if (gt < i) gt = html.indexOf(">", i);
    const end = gt;
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

/**
 * Browsers end a script, style or noscript at its closing tag written in any case, with space or more
 * after the name, but the parser looks only for the closing tag exactly as the opening one was written,
 * and without it reads the rest of the page as script. Both tags are put the parser's way first.
 */
const RAW_TEXT_OPEN = /<(script|style|noscript)(?=[\s/>])/gi;
const RAW_TEXT_CLOSE = /<\/(script|style|noscript)(?:[\s/][^<>]*)?>/gi;

function parsePage(html: string): HTMLElement {
  const page = html
    .replace(RAW_TEXT_OPEN, (_tag, name: string) => `<${name.toLowerCase()}`)
    .replace(RAW_TEXT_CLOSE, (_tag, name: string) => `</${name.toLowerCase()}>`);
  return parse(page, unclosedTags(page) > MAX_TIDY ? { ...PARSE_OPTIONS, parseNoneClosedTags: true } : PARSE_OPTIONS);
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
/** The furniture that heads or ends a part of the page. A story's own header and footer hold its credits. */
const END_TAGS = new Set(["header", "footer"]);
const END_ROLES = new Set(["banner", "contentinfo"]);
/** What only the page's own content holds. */
const PAGE_PARTS = new Set(["h1", "article", "main"]);

type FurnitureTest = (el: HTMLElement) => boolean;
/** "end" for a header or footer, "side" for menus, sidebars, search boxes and sign-up forms, null for the rest. */
type FurnitureKind = "end" | "side" | null;

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

/** Which kind of furniture an element is, if any. Each element is judged once: the page is walked several times. */
function furnitureKinds(): (el: HTMLElement) => FurnitureKind {
  const kinds = new Map<HTMLElement, FurnitureKind>();
  const judge = (el: HTMLElement): FurnitureKind => {
    const tag = tagOf(el);
    if (tag === "form") return wrapsPage(el) ? null : "side";
    if (END_TAGS.has(tag)) return "end";
    if (FURNITURE_TAGS.has(tag)) return "side";
    if (!el.rawAttrs || !/role/i.test(el.rawAttrs)) return null;
    const roles = (el.getAttribute("role") ?? "").toLowerCase().split(/\s+/);
    if (roles.some((r) => END_ROLES.has(r))) return "end";
    return roles.some((r) => FURNITURE_ROLES.has(r)) ? "side" : null;
  };
  return (el) => {
    let kind = kinds.get(el);
    if (kind === undefined) {
      kind = judge(el);
      kinds.set(el, kind);
    }
    return kind;
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
const END_OF_LINK = Symbol("end of link");

/** Words, not just punctuation or space: a line with some outside its links is more than a link. */
const WORDS = /[\p{L}\p{N}]/u;

/**
 * An element's words, a line per block (paragraph, heading, list item, line break), leaving out the
 * furniture inside it. Given `links`, a line outside a paragraph that is nothing but the words of its
 * links goes there instead: the related stories, tags, share buttons and page numbers a site puts beside
 * a story, whose headlines are other stories' and must not reach the AI as this one's sentences. A
 * paragraph is always kept, as it always was.
 */
function linesOf(root: HTMLElement, isFurniture: FurnitureTest, links?: string[]): string[] {
  const lines: string[] = [];
  let line = "";
  let inLink = 0;
  let linked = false;
  let plain = false;
  // The blocks the walk is inside, innermost last: a line belongs to the innermost.
  const open: string[] = [];
  const endLine = () => {
    const text = tidy(line);
    const onlyLinks = links && linked && !plain && open[open.length - 1] !== "p";
    if (text) (onlyLinks ? links : lines).push(text);
    line = "";
    linked = false;
    plain = false;
  };
  // A block is passed twice: on the way in, and again by its marker on the way out, to end its line. A
  // link's marker on the way out says its words have ended.
  const stack: (Node | typeof END_OF_BLOCK | typeof END_OF_LINK)[] = [root];
  while (stack.length) {
    const item = stack.pop()!;
    if (item === END_OF_BLOCK) {
      endLine();
      open.pop();
      continue;
    }
    if (item === END_OF_LINK) {
      inLink--;
      continue;
    }
    if (item.nodeType === NodeType.TEXT_NODE) {
      const text = (item as TextNode).text;
      line += text;
      if (inLink > 0) {
        if (/\S/.test(text)) linked = true;
      } else if (WORDS.test(text)) {
        plain = true;
      }
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
      open.push(tag);
      stack.push(END_OF_BLOCK);
    }
    if (links && tag === "a") {
      inLink++;
      stack.push(END_OF_LINK);
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
function paragraphsIn(root: HTMLElement, others: Set<HTMLElement>, isFurniture: FurnitureTest): HTMLElement[] {
  const out: HTMLElement[] = [];
  const stack: Node[] = [...root.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    const tag = tagOf(node);
    if (NOT_TEXT.has(tag) || isFurniture(node) || others.has(node)) continue;
    if (tag === "p") {
      out.push(node);
      continue;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return out;
}

/** The outermost of `marked` under `root`, in page order. The walk stops at each one, so nothing is looked through twice. */
function outermost(root: HTMLElement, marked: Set<HTMLElement>, isFurniture: FurnitureTest): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (!marked.size) return out;
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    if (marked.has(node)) {
      out.push(node);
      continue;
    }
    if (NOT_TEXT.has(tagOf(node)) || (node !== root && isFurniture(node))) continue;
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return out;
}

/**
 * A paywall's own lines: what a site shows where the rest of the story would be. Like the notices below
 * they are struck out of the story, and seen among the story's lines they also mean the story stops there.
 */
const WALL_LINES: RegExp[] = [
  /^(?:please )?(?:subscribe|sign in|sign up|log ?in|register|create (?:a )?(?:free )?account)\b.{0,60}\b(?:to (?:continue|read|access|unlock|keep reading|view)|for (?:full|unlimited) access)\b/i,
  /^to (?:continue|keep) reading\b.{0,60}\b(?:subscribe|subscription|subscriber|sign in|log ?in|register|account)\b/i,
  /^already (?:a )?(?:subscriber|member)\b|\bsubscribers? only\b|\bexclusive(?:ly)? (?:to|for) (?:our )?subscribers\b/i,
  /\b(?:this|the) (?:article|story) is (?:only )?(?:for|available (?:only )?to|reserved for) (?:our )?(?:paying )?(?:subscribers|members)\b/i,
  /\breached (?:your|the) (?:limit|maximum) of\b|\b(?:free )?article limit\b|\bused (?:up )?(?:all )?(?:of )?your free articles?\b/i,
];

/**
 * Lines that are the site talking, not the story: cookie and consent banners, subscription walls,
 * sign-up boxes, links to other stories, advert labels and copyright lines. The phrasings are narrow on
 * purpose, since a line wrongly struck out could be the one that names a company.
 */
const NOTICES: RegExp[] = [
  /\b(?:we|this (?:web)?site|our (?:web)?site|we and our (?:\d+ )?(?:partners|vendors))\b.{0,60}\b(?:use|uses|store|stores|set|sets)\b.{0,40}\bcookies?\b/i,
  /\bcookie (?:policy|settings|preferences|notice|consent|statement)\b|\b(?:accept|allow|reject|decline|manage)(?: all)?(?: the)? cookies\b/i,
  /\bby (?:continuing|using|browsing|clicking)\b.{0,80}\b(?:site|website|page|service)\b.{0,80}\b(?:agree|consent|accept)/i,
  ...WALL_LINES,
  /^already have an account\b|\bfree articles?\b|\barticle limit\b|\breached (?:your|the) (?:limit|maximum) of\b/i,
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
const isWallLine = (line: string): boolean => line.length < NOTICE_MAX_CHARS && WALL_LINES.some((re) => re.test(line));

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

/** True when a line of text from elsewhere (Apify, say) is a paywall's own, such as "Subscribe to continue reading". */
export function wallLineIn(text: string): boolean {
  return String(text ?? "").split(/\r\n?|\n/).some((line) => isWallLine(tidy(line)));
}

/** What a page-not-found page calls itself, in its title or its heading. */
const NOT_FOUND =
  /^(?:(?:error )?404(?: error)?(?: not found)?|(?:(?:oops|sorry|error|404)[!.,:]* )?(?:(?:the |this |that )?(?:page|article|story|content)(?: you (?:are|were|'re) looking for| you requested)? (?:(?:is|was|has been) )?(?:not found|(?:cannot|can not|can't|could not|couldn't) be found|no longer exists|(?:does not|doesn't) exist)|not found|we (?:cannot|can not|can't|could not|couldn't) find (?:the|this|that) (?:page|article|story)(?: you (?:are|were|'re) looking for)?))[.!]*$/;

/**
 * True for a title or heading that says the page is not there ("Page not found", "404", "Sorry, we
 * couldn't find that page"), perhaps with the site's name beside it. A headline that merely starts the
 * same way is a story ("Not found: the missing millions"), so the words must be all there is.
 */
export function saysNotFound(title: string | null | undefined): boolean {
  const t = tidy(String(title ?? "")).toLowerCase().replace(/[\u2018\u2019]/g, "'");
  if (!t || t.length > 160) return false;
  return t.split(/\s+[|\u2013\u2014\u2022-]+\s+|\s*\|\s*/).some((part) => NOT_FOUND.test(part.trim()));
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
/** The other objects that can mark a story as not free: its web page, and the page's parts. */
const PAGE_TYPE = /^(?:[a-z]*page|webpageelement|creativework)$/i;

/** The names in an @type: "NewsArticle", ["Article", "NewsArticle"], or a full name such as "https://schema.org/NewsArticle". */
const typeNames = (type: unknown): string[] =>
  (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === "string").map((t) => t.split(/[/#:]/).pop() ?? "");

const isArticleType = (type: unknown): boolean => typeNames(type).some((t) => ARTICLE_TYPE.test(t));

/** An object with no type, as a page's parts often are, or an article or web page, can say the story is not free. */
const speaksForPage = (type: unknown): boolean => type === undefined || typeNames(type).some((t) => ARTICLE_TYPE.test(t) || PAGE_TYPE.test(t));

/** isAccessibleForFree as publishers write it: false, or "false" in any case. */
const notFree = (v: unknown): boolean => v === false || (typeof v === "string" && v.trim().toLowerCase() === "false");

/** Enough for any news page; a block bigger than this is a catalogue, not an article. */
const MAX_JSON_NODES = 20_000;

/** The most credits read: authors from the article data, and elements on the page marked as bylines. */
const MAX_CREDITS = 12;

/** What the page's article data says. */
interface ArticleData {
  /** Every articleBody of an article object, wherever it sits: at the top, in an array, in @graph, or under mainEntity. */
  bodies: string[];
  /** A line for each author an article object names: "By <name>, <job>, <employer>". */
  authors: string[];
  /** Some part of the page is marked as not free to read (isAccessibleForFree false). */
  paywalled: boolean;
  /** The CSS selectors of the parts so marked, when the data names them. */
  paidParts: string[];
}

/** A name as the article data gives it: the string itself, or the name of a person or organisation, the first of a list. */
function nameIn(value: unknown): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v === "string") return tidy(v);
  const name = v && typeof v === "object" ? (v as Record<string, unknown>).name : undefined;
  return typeof name === "string" ? tidy(name) : "";
}

/** "By <name>, <job>, <employer>" for one author of an article, or null when the data gives no name. */
function authorLine(author: unknown): string | null {
  const name = nameIn(author);
  if (!name) return null;
  const o = asRecord(author);
  const parts = [name, typeof o.jobTitle === "string" ? tidy(o.jobTitle) : "", nameIn(o.worksFor), nameIn(o.affiliation)].filter(Boolean);
  return `By ${[...new Set(parts)].join(", ")}`.slice(0, 300);
}

/** One pass over each ld+json block, noting the bodies, authors and paywall marks of its objects. */
function articleData(blocks: string[]): ArticleData {
  const found: ArticleData = { bodies: [], authors: [], paywalled: false, paidParts: [] };
  for (const raw of blocks) {
    const data = looseJson(raw);
    if (data === undefined) continue;
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
        if (typeof body === "string") found.bodies.push(body);
        else if (Array.isArray(body)) found.bodies.push(body.filter((b): b is string => typeof b === "string").join("\n"));
        for (const author of ([] as unknown[]).concat(obj.author ?? [], obj.creator ?? [])) {
          const line = authorLine(author);
          if (line && found.authors.length < MAX_CREDITS && !found.authors.includes(line)) found.authors.push(line);
        }
      }
      if (notFree(obj.isAccessibleForFree) && speaksForPage(obj["@type"])) {
        found.paywalled = true;
        for (const selector of ([] as unknown[]).concat(obj.cssSelector ?? [])) {
          if (typeof selector === "string" && selector.trim()) found.paidParts.push(selector.trim());
        }
      }
      for (const key of Object.keys(obj)) {
        const child = obj[key];
        if (child && typeof child === "object") stack.push(child);
      }
    }
  }
  return found;
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

/** A plain furniture test, for HTML that is not the page itself. */
function furnitureTest(): FurnitureTest {
  const kindOf = furnitureKinds();
  return (el) => kindOf(el) !== null;
}

/** What one way found. */
interface Found {
  /** Every line of the part of the page the story was found in, tidied, one per line. */
  text: string;
  /** The characters of the story's own paragraphs among them. */
  storyChars: number;
  /** A paywall's own line was among them. */
  wall: boolean;
  /** The landmark (<article> or <main>) the story was found in, if it was found in one. */
  landmark?: HTMLElement;
}

const NOTHING: Found = { text: "", storyChars: 0, wall: false };

/** The longest articleBody in the article data. A body the publisher wrote is the story, every line of it. */
function fromJsonLd(bodies: string[]): Found {
  let best = NOTHING;
  for (const body of bodies) {
    const lines = bodyLines(body);
    const text = cleanLines(lines).join("\n");
    if (text.length > best.text.length) best = { text, storyChars: text.length, wall: lines.some(isWallLine) };
  }
  return best;
}

/** The elements marked as the article body, a line per block, without the furniture inside them. */
function fromBodies(bodies: HTMLElement[], landmark: HTMLElement | null, isFurniture: FurnitureTest): Found {
  const lines = bodies.flatMap((el) => linesOf(el, isFurniture));
  const text = cleanLines(lines).join("\n");
  return { text, storyChars: text.length, wall: lines.some(isWallLine), ...(landmark ? { landmark } : {}) };
}

/**
 * The landmark (<article> or <main>) with the most paragraph text of its own, and every line of it: its
 * paragraphs decide, and its headings, lists, tables, quotes and captions come with them, though not
 * its lines of links. A landmark with no paragraphs at all, such as a list of the year's busiest
 * agencies, is judged by its other lines.
 */
function fromLandmarks(landmarks: HTMLElement[], isFurniture: FurnitureTest): Found {
  const all = new Set(landmarks);
  const notOwn: FurnitureTest = (el) => all.has(el) || isFurniture(el);
  let best = NOTHING;
  for (const el of landmarks) {
    const storyChars = cleanLines(paragraphsIn(el, all, isFurniture).map(lineOf)).join("\n").length;
    if (storyChars < best.storyChars) continue;
    const links: string[] = [];
    const lines = linesOf(el, notOwn, links);
    const text = cleanLines(lines).join("\n");
    // Ties go to the earlier landmark, unless it holds less text.
    if (storyChars > best.storyChars || text.length > best.text.length) {
      best = { text, storyChars, wall: lines.some(isWallLine) || links.some(isWallLine), landmark: el };
    }
  }
  return best;
}

/**
 * The page's paragraphs of 40 characters or more decide, and every line of the elements that hold them
 * is the text, so the short lines, lists, headings and quotes beside the story are read with it, though
 * not its lines of links.
 */
function fromParagraphs(root: HTMLElement, isFurniture: FurnitureTest): Found {
  const paragraphs = paragraphsIn(root, new Set(), isFurniture);
  const lines = paragraphs.map(lineOf);
  const holders = new Set<HTMLElement>();
  lines.forEach((line, i) => {
    const holder = paragraphs[i].parentNode;
    if (holder && line.length >= PARAGRAPH_MIN_CHARS && !isNotice(line)) holders.add(holder);
  });
  const links: string[] = [];
  const near = outermost(root, holders, isFurniture).flatMap((el) => linesOf(el, isFurniture, links));
  return {
    text: cleanLines(near).join("\n"),
    storyChars: cleanLines(lines, PARAGRAPH_MIN_CHARS).join("\n").length,
    wall: lines.some(isWallLine) || near.some(isWallLine) || links.some(isWallLine),
  };
}

interface Survey {
  /** The raw text of each ld+json script. */
  jsonLd: string[];
  /** Elements marked itemprop="articleBody", outermost only. */
  bodies: HTMLElement[];
  /** The landmark the first of them sits in, if any. */
  bodyLandmark: HTMLElement | null;
  /** <article> elements outside the page furniture. */
  articles: HTMLElement[];
  /** Those of them inside a <main>, or role="main". */
  articlesInMain: HTMLElement[];
  /** <main> elements, or role="main", outside the furniture. */
  mains: HTMLElement[];
  /** The landmark each landmark sits in, if any. */
  around: Map<HTMLElement, HTMLElement | null>;
  /** Each landmark's own headers and footers: not a sidebar's, and not those of a landmark inside it. */
  ends: Map<HTMLElement, { el: HTMLElement; head: boolean }[]>;
  /** Elements marked as a byline or an author, outside the menus, sidebars and forms, with the landmark each sits in. */
  bylines: { el: HTMLElement; landmark: HTMLElement | null }[];
  /** og:title, description, og:description and author. */
  meta: Map<string, string>;
  /** The first <title> that isn't an icon's. */
  title: string | null;
  /** The first few <h1> headings outside the menus and sidebars. */
  headings: string[];
}

const META_KEYS = new Set(["og:title", "description", "og:description", "author"]);
const MAX_HEADINGS = 5;

/** What marks an element as a byline or an author's: its class, id, rel or itemprop, or a link to an author's page. */
const BYLINE_MARK = /byline|author(?!it)|contributor/i;
const AUTHOR_PAGE = /\/(?:authors?|contributors?|columnists?)\//i;

function marksByline(el: HTMLElement): boolean {
  if (!el.rawAttrs || !/byline|author|contributor|columnist/i.test(el.rawAttrs)) return false;
  if (["class", "id", "rel", "itemprop"].some((name) => BYLINE_MARK.test(el.getAttribute(name) ?? ""))) return true;
  return tagOf(el) === "a" && AUTHOR_PAGE.test(el.getAttribute("href") ?? "");
}

/** One pass over the page, noting everything the ways and the credits need. */
function survey(root: HTMLElement, kindOf: (el: HTMLElement) => FurnitureKind): Survey {
  const found: Survey = {
    jsonLd: [],
    bodies: [],
    bodyLandmark: null,
    articles: [],
    articlesInMain: [],
    mains: [],
    around: new Map(),
    ends: new Map(),
    bylines: [],
    meta: new Map(),
    title: null,
    headings: [],
  };
  type Visit = {
    node: Node;
    inFurniture: boolean;
    inSide: boolean;
    inEnd: boolean;
    inBody: boolean;
    inSvg: boolean;
    inMain: boolean;
    landmark: HTMLElement | null;
  };
  const stack: Visit[] = [{ node: root, inFurniture: false, inSide: false, inEnd: false, inBody: false, inSvg: false, inMain: false, landmark: null }];
  while (stack.length) {
    const visit = stack.pop()!;
    const { node, inFurniture, inSide, inEnd, inBody, inSvg, inMain } = visit;
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
    const kind = kindOf(node);
    const furniture = inFurniture || kind !== null;
    const side = inSide || kind === "side";
    const body = inBody || hasToken(node, "itemprop", "articlebody");
    if (body && !inBody) {
      if (!found.bodies.length) found.bodyLandmark = visit.landmark;
      found.bodies.push(node);
    }
    const isArticle = !furniture && tag === "article";
    const isMain = !furniture && (tag === "main" || hasToken(node, "role", "main"));
    if (isArticle) found.articles.push(node);
    if (isArticle && inMain) found.articlesInMain.push(node);
    if (isMain) found.mains.push(node);
    let landmark = visit.landmark;
    if (isArticle || isMain) {
      found.around.set(node, visit.landmark);
      landmark = node;
    }
    // A landmark's own header and footer hold its credits, but not a sidebar's inside it.
    const end = kind === "end" && !inEnd && !side && visit.landmark !== null;
    if (end && visit.landmark) {
      const ends = found.ends.get(visit.landmark) ?? [];
      ends.push({ el: node, head: tag !== "footer" && !hasToken(node, "role", "contentinfo") });
      found.ends.set(visit.landmark, ends);
    }
    if (!side && !isArticle && !isMain && tag !== "body" && tag !== "html" && found.bylines.length < MAX_CREDITS && marksByline(node)) {
      found.bylines.push({ el: node, landmark });
    }
    if (tag === "h1" && !side && found.headings.length < MAX_HEADINGS) {
      const heading = lineOf(node);
      if (heading) found.headings.push(heading);
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      stack.push({
        node: node.childNodes[i],
        inFurniture: furniture,
        inSide: side,
        inEnd: inEnd || end,
        inBody: body,
        inSvg: inSvg || tag === "svg",
        inMain: inMain || isMain,
        landmark,
      });
    }
  }
  return found;
}

/** A credit longer than this is a container that happens to be marked, not a byline or a note on the author. */
const CREDIT_MAX_CHARS = 1_500;

/**
 * The story's credits, as lines that come before the story and lines that come after it: the authors
 * its article data names, the header and footer of the landmark the story was found in, the headers of
 * the landmarks around that one (where a page often puts the headline and byline), and what the page
 * marks as the byline or the author. A byline inside another landmark belongs to another story, unless
 * no landmark could be told apart (`anywhere`), as on a page that gave up nothing else.
 */
function creditsFor(page: Survey, data: ArticleData, story: HTMLElement | undefined, anywhere: boolean, isFurniture: FurnitureTest) {
  const around = new Set<HTMLElement>();
  for (let el: HTMLElement | null | undefined = story; el; el = page.around.get(el)) around.add(el);
  // A header or footer leaves out its lines of links (related stories, tags and share buttons) like
  // the story's own lines do. A byline that is only a link is marked, and read whole as a byline.
  const read = (el: HTMLElement, links?: string[]): string[] => {
    const lines = linesOf(el, isFurniture, links);
    return lines.reduce((n, line) => n + line.length, 0) > CREDIT_MAX_CHARS ? [] : lines;
  };
  const author = page.meta.get("author");
  const before = [...data.authors, ...(author && !/^https?:/i.test(author) ? [`By ${author}`] : [])];
  const after: string[] = [];
  // The outermost landmark first, so a page's headline and byline come before the story's own.
  for (const el of [...around].reverse()) {
    for (const end of page.ends.get(el) ?? []) {
      if (end.head) before.push(...read(end.el, []));
      else if (el === story) after.push(...read(end.el, []));
    }
  }
  for (const { el, landmark } of page.bylines) {
    if (landmark === null || around.has(landmark) || (!story && anywhere)) before.push(...read(el));
  }
  return { before, after };
}

/** Selectors as publishers write them for a paywalled part: classes and ids, nothing that could make the match slow. */
const PART_SELECTOR = /^[\w\s.#,>-]{1,120}$/;
/** The most paywalled parts looked for on a page. */
const MAX_PAID_PARTS = 3;

/**
 * True when the page holds a part its article data marks as not free. A soft paywall sends the whole
 * story and hides it in the browser, so the story was all there to read.
 */
function servesPaidPart(root: HTMLElement, selectors: string[], isFurniture: FurnitureTest): boolean {
  const usable = [...new Set(selectors)].filter((s) => PART_SELECTOR.test(s) && /[.#]/.test(s)).slice(0, MAX_PAID_PARTS);
  for (const selector of usable) {
    let parts: HTMLElement[];
    try {
      parts = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    const lines = outermost(root, new Set(parts), isFurniture).flatMap((el) => linesOf(el, isFurniture));
    if (!lines.some(isWallLine) && cleanLines(lines).join("\n").length >= OK_CHARS) return true;
  }
  return false;
}

/** What `work` gives, or `fallback` if it fails on a page it doesn't understand. */
function safely<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

/** A way that fails on a page it doesn't understand finds nothing, and the next way gets its turn. */
const attempt = (find: () => Found): Found => safely(find, NOTHING);

/** Text as one run of words in one case, with one kind of quote and no ellipsis, for telling whether two finds are one story. */
const flat = (s: string): string =>
  s.replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2026|\.{3}/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/** The ways whose text the publisher declared to be the story. */
const DECLARED = new Set<ExtractSource>(["jsonld", "articlebody"]);
/** A declared body that ends on an ellipsis says itself that it stops short. */
const ENDS_SHORT = /(?:\u2026|\.{3}|\[(?:\u2026|\.{3})\])\s*$/;

/**
 * The article's text and title from its page. Never throws: a page it can't make sense of gives
 * `source` "none" and empty text, which the read step treats as unread, not as an article about nothing.
 */
export function extractArticle(html: string): ExtractedArticle {
  try {
    const root = parsePage(typeof html === "string" ? html : "");
    const kindOf = furnitureKinds();
    const isFurniture: FurnitureTest = (el) => kindOf(el) !== null;
    const page = survey(root, kindOf);
    const data = articleData(page.jsonLd);
    const title = page.meta.get("og:title") ?? page.title;
    const ways: [ExtractSource, () => Found][] = [
      ["jsonld", () => fromJsonLd(data.bodies)],
      ["articlebody", () => fromBodies(page.bodies, page.bodyLandmark, isFurniture)],
      // A page with a <main> says its own content is in it, so an <article> outside it, however long, is
      // a card for another story or the like. The main and the page's paragraphs still read everything.
      ["article", () => fromLandmarks(page.mains.length ? page.articlesInMain : page.articles, isFurniture)],
      ["main", () => fromLandmarks(page.mains, isFurniture)],
      ["paragraphs", () => fromParagraphs(root, isFurniture)],
    ];
    // Each way is run once at most, and only when it is needed.
    const finds = ways.map(([, find]) => {
      let found: Found | undefined;
      return () => (found ??= attempt(find));
    });

    let story: { source: ExtractSource; found: Found } = { source: "none", found: NOTHING };
    for (let i = 0; i < ways.length; i++) {
      const found = finds[i]();
      const source = ways[i][0];
      if (found.storyChars >= OK_CHARS) {
        story = { source, found };
        if (DECLARED.has(source)) {
          // A declared body can be only the story's opening. A later way that holds the same opening and
          // tells clearly more of the story has read it further, and wins.
          const opening = flat(found.text).slice(0, 150);
          const margin = ENDS_SHORT.test(found.text) ? 1 : OK_CHARS / 2;
          for (let j = i + 1; j < ways.length; j++) {
            const later = finds[j]();
            if (later.storyChars >= found.storyChars + margin && flat(later.text).includes(opening)) {
              story = { source: ways[j][0], found: later };
              break;
            }
          }
        }
        break;
      }
      // Short of a whole article, the most story wins, then the most text. Ties go to the earlier, more explicit way.
      if (found.storyChars > story.found.storyChars || (found.storyChars === story.found.storyChars && found.text.length > story.found.text.length)) {
        story = { source, found };
      }
    }

    let { source } = story;
    let text = story.found.text;
    const storyChars = text ? story.found.storyChars : 0;
    const summary = page.meta.get("description") ?? page.meta.get("og:description") ?? "";
    if (!text) {
      source = summary ? "meta" : "none";
      text = summary;
    }
    // Article data that marks part of the page as not free says the story stops at a paywall, unless
    // that part is on the page after all. Without it, a paywall's own line among the story's says so.
    const walled = data.paywalled ? !safely(() => servesPaidPart(root, data.paidParts, isFurniture), false) : story.found.wall;
    const notFound = [page.title, page.meta.get("og:title"), ...page.headings].some(saysNotFound);
    // The landmark the story was found in holds its header and footer. A body from the article data
    // has none of its own, but the landmark that tells the same story is its home.
    let landmark = story.found.landmark;
    if (source === "jsonld") {
      const opening = flat(text).slice(0, 60);
      landmark = [finds[2](), finds[3]()].find((f) => f.landmark && flat(f.text).includes(opening))?.landmark;
    }
    // Credits that can't be made out are left out, and the story stands without them.
    const credits = safely(() => creditsFor(page, data, landmark, source === "meta" || source === "none", isFurniture), { before: [], after: [] });
    // Short of the whole story, what the other ways found, and the page's summary, are kept too: none of
    // it can make the read whole, but any of it can prove a mention, such as a story written in <div>s
    // whose article data holds only its opening. The article data and the marked body are always the
    // story's own words. The <article> and <main> ways are added only when the story was not found in
    // the page's markup: when it was, they hold other stories' cards or the page around the story. The
    // page's paragraphs, which cross every landmark, comments included, never are.
    const partial = storyChars < OK_CHARS || walled;
    const inMarkup = source === "article" || source === "main" || source === "paragraphs";
    const others = partial ? finds.slice(0, inMarkup ? 2 : 4).map((find) => find()).filter((f) => f !== story.found) : [];
    const more = partial ? [...others.map((f) => f.text), summary] : [];
    const lines = cleanLines([...credits.before, ...[text, ...more].join("\n").split("\n"), ...credits.after]);
    return {
      text: lines.join("\n"),
      title,
      source,
      storyChars,
      ...(walled ? { walled: true as const } : {}),
      ...(notFound ? { notFound: true as const } : {}),
    };
  } catch {
    return { text: "", title: null, source: "none", storyChars: 0 };
  }
}
