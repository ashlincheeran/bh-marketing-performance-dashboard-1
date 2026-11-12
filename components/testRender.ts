// Test support for the client components, never imported by the app. The
// real components are rendered by React DOM into a stand-in document, so a
// test can read what a screen says and press its buttons. No browser and no
// network: the server actions, the router and Link are stand-ins as well.
//
// A test file that uses this runs on its own, for example
// node scripts/test.mjs components/BotActivity.test.ts: it puts a stand-in
// window and document on globalThis, which code that checks for a browser
// would then find.
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import type { ReactElement, ReactNode } from "react";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── A document, as much of one as React DOM uses ─────────────────────────

type Node = FakeNode;

class FakeNode {
  parentNode: Node | null = null;
  childNodes: Node[] = [];
  nodeValue: string | null = null;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  attributes: Record<string, string> = {};
  style: Record<string, unknown> = {
    setProperty(name: string, value: string) {
      this[name] = value;
    },
    removeProperty(name: string) {
      delete this[name];
    },
  };
  [key: string]: unknown;

  constructor(
    public nodeType: number,
    public nodeName: string,
    public ownerDocument: FakeDocument | null,
  ) {}

  get tagName() {
    return this.nodeName;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  /** A select's options, which React DOM marks selected. */
  get options() {
    return this.childNodes.filter((c) => c.nodeName === "OPTION");
  }
  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? "";
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(text: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(this.ownerDocument!.createTextNode(String(text)));
  }
  appendChild(child: Node) {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: Node, before: Node | null) {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: Node) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(other: Node | null) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  getAttribute(name: string) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  hasAttribute(name: string) {
    return name in this.attributes;
  }
  setAttributeNS(_ns: string, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  removeAttributeNS(_ns: string, name: string) {
    this.removeAttribute(name);
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}
}

class FakeDocument extends FakeNode {
  body: Node;
  documentElement: Node;
  defaultView: unknown = null;
  activeElement: Node | null = null;

  constructor() {
    super(9, "#document", null);
    this.documentElement = this.appendChild(this.createElement("html"));
    this.body = this.documentElement.appendChild(this.createElement("body"));
  }
  createElement(tag: string) {
    return new FakeNode(1, tag.toUpperCase(), this);
  }
  createElementNS(_ns: string, tag: string) {
    return this.createElement(tag);
  }
  createTextNode(text: string) {
    const node = new FakeNode(3, "#text", this);
    node.nodeValue = text;
    return node;
  }
  createComment(text: string) {
    const node = new FakeNode(8, "#comment", this);
    node.nodeValue = text;
    return node;
  }
}

// Installed before React DOM loads: it decides once, then, whether it is in a browser.
const document = new FakeDocument();
const browser = globalThis as Record<string, unknown>;
browser.window = globalThis;
browser.document = document;
browser.HTMLIFrameElement = class {};
document.defaultView = globalThis;

// ── The server actions, the router and Link ──────────────────────────────

/** Every server action the components call. */
const ACTIONS = [
  "addKeywordAction",
  "removeKeywordAction",
  "runNewsBotAction",
  "manualCheckAction",
  "keepArticleAction",
  "rejectArticleAction",
  "setMentionStatusAction",
  "addPersonAction",
  "removePersonAction",
  "setPersonActiveAction",
  "updateCompanyAction",
  "setNewsSettingsAction",
  "setSeoSourceAction",
  "setSupermetricsEnabledAction",
  "saveReportSettingsAction",
] as const;

export type ActionName = (typeof ACTIONS)[number];
type Answer = (...args: unknown[]) => Promise<unknown>;

const answers = new Map<ActionName, Answer>();

/** Each call a component made to a server action, in order. */
export const calls: { name: ActionName; args: unknown[] }[] = [];

/** How the stand-in for `name` answers from now on. */
export function answer(name: ActionName, reply: Answer): void {
  answers.set(name, reply);
}

/** A call that never reaches the server, as a dropped connection or a stale page makes it: Next's fetch rejects. */
export const throwing =
  (message = "Failed to fetch"): Answer =>
  async () => {
    throw new TypeError(message);
  };

/** How many times a component asked the router to look again. */
export const router = { refreshes: 0 };

/** Put the stand-ins back as they were. */
export function reset(): void {
  answers.clear();
  calls.length = 0;
  router.refreshes = 0;
}

let createElement: typeof import("react").createElement;

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  alias: { "@": ROOT },
  virtualModules: {
    "@/app/actions": Object.fromEntries(
      ACTIONS.map((name) => [
        name,
        (...args: unknown[]) => {
          calls.push({ name, args });
          const answered = answers.get(name);
          return answered ? answered(...args) : Promise.reject(new Error(`the test gave ${name} no answer`));
        },
      ]),
    ),
    "next/navigation": {
      useRouter: () => ({
        refresh: () => void router.refreshes++,
        push() {},
        replace() {},
        back() {},
        prefetch() {},
      }),
    },
    "next/link": {
      __esModule: true,
      default: (props: { href: string; children?: ReactNode }) => createElement("a", { href: props.href }, props.children),
    },
  },
});

const ready = (async () => {
  const React = (await jiti.import("react")) as typeof import("react");
  const { createRoot } = (await jiti.import("react-dom/client")) as typeof import("react-dom/client");
  createElement = React.createElement;

  /** What app/error.tsx does for a tab: the whole thing replaced by an error. */
  class Boundary extends React.Component<{ children?: ReactNode }, { error: unknown }> {
    state = { error: null as unknown };
    static getDerivedStateFromError(error: unknown) {
      return { error };
    }
    render() {
      return this.state.error ? createElement("p", null, `Something went wrong: ${String(this.state.error)}`) : this.props.children;
    }
  }
  return { createRoot, Boundary };
})();

/** A component module, compiled the way the app compiles it, with the stand-ins above. */
export async function load<T>(path: string): Promise<T> {
  await ready;
  return (await jiti.import(`${ROOT}${path}`)) as T;
}

/** React's createElement, for a test to build what it mounts once a component module has been loaded. */
export function h(type: unknown, props?: object | null, ...children: ReactNode[]): ReactElement {
  return (createElement as (...a: unknown[]) => ReactElement)(type, props ?? null, ...children);
}

// ── A screen to read and press ───────────────────────────────────────────

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Elements a browser starts on a line of their own, or sets apart: their words never run into the next ones. */
const SET_APART = new Set(["DIV", "P", "H3", "UL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "BR", "BUTTON", "LABEL", "INPUT", "SELECT", "OPTION", "TEXTAREA"]);

/** What a node says, read the way a person reads the page. */
function words(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";
  const inside = node.childNodes.map(words).join("");
  return SET_APART.has(node.nodeName) ? ` ${inside} ` : inside;
}

function all(node: Node, keep: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (keep(node)) out.push(node);
  for (const child of node.childNodes) all(child, keep, out);
  return out;
}

/** The props React DOM keeps on a node it rendered: its event handlers among them. */
function propsOf(node: Node): Record<string, (event: unknown) => void> {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  if (!key) throw new Error(`${node.nodeName} was not rendered by React`);
  return node[key] as Record<string, (event: unknown) => void>;
}

const event = (target: unknown) => ({ target, currentTarget: target, preventDefault() {}, stopPropagation() {}, key: "" });

export interface Screen {
  /** Everything the screen says, as one line. */
  text(): string;
  /** The words on every button. */
  buttons(): string[];
  /** Every link, with its words, where it goes, and where it opens (target and rel, as written). */
  links(): { text: string; href: string | null; target: string | null; rel: string | null }[];
  /** Press the first button whose words are `label` (or, failing that, contain it, or whose title is it). It must be enabled. */
  click(label: string): void;
  /** Whether that button is shown and can be pressed. */
  enabled(label: string): boolean;
  /** Type `value` into the input labelled `label`. */
  type(label: string, value: string): void;
  /** Press `key` (such as "Enter") in the input labelled `label`. */
  press(label: string, key: string): void;
  /** Wait until `check` holds, or fail saying what was waited for and what the screen says. */
  until(check: () => boolean, what: string): Promise<void>;
  /** Errors that reached the error boundary: none means the tab was never replaced. */
  caught: unknown[];
  /** What the components wrote to console.error while the screen was up. */
  logged: unknown[][];
  unmount(): void;
}

/** Render `element` inside an error boundary and wait for it to show. */
export async function mount(element: ReactElement): Promise<Screen> {
  const { createRoot, Boundary } = await ready;
  const container = document.body.appendChild(document.createElement("div"));
  const caught: unknown[] = [];
  const logged: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  const root = createRoot(container as unknown as Element, {
    onCaughtError: (error) => void caught.push(error),
    onUncaughtError: (error) => void caught.push(error),
  });
  root.render(createElement(Boundary, null, element));

  const text = () => squash(words(container));
  const buttons = () => all(container, (n) => n.nodeName === "BUTTON");
  const button = (label: string) =>
    buttons().find((b) => squash(b.textContent) === label) ??
    buttons().find((b) => squash(b.textContent).includes(label) || b.getAttribute("title") === label);
  const screen: Screen = {
    text,
    buttons: () => buttons().map((b) => squash(b.textContent)),
    links: () =>
      all(container, (n) => n.nodeName === "A").map((a) => ({
        text: squash(a.textContent),
        href: a.getAttribute("href"),
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel"),
      })),
    click(label) {
      const found = button(label);
      if (!found) throw new Error(`No button "${label}". The buttons: ${screen.buttons().join(" | ")}`);
      if (found.hasAttribute("disabled")) throw new Error(`The button "${label}" is disabled`);
      propsOf(found).onClick(event(found));
    },
    enabled: (label) => {
      const found = button(label);
      return !!found && !found.hasAttribute("disabled");
    },
    type(label, value) {
      const input = all(container, (n) => n.getAttribute("aria-label") === label)[0];
      if (!input) throw new Error(`No input labelled "${label}"`);
      propsOf(input).onChange(event({ value }));
    },
    press(label, key) {
      const input = all(container, (n) => n.getAttribute("aria-label") === label)[0];
      if (!input) throw new Error(`No input labelled "${label}"`);
      propsOf(input).onKeyDown?.({ ...event(input), key });
    },
    async until(check, what) {
      const by = Date.now() + 2000;
      while (!check()) {
        if (Date.now() > by) throw new Error(`Waited in vain for ${what}. The screen says: ${text()}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    caught,
    logged,
    unmount() {
      root.unmount();
      container.parentNode?.removeChild(container);
      console.error = consoleError;
    },
  };
  await screen.until(() => container.childNodes.length > 0, "the first render");
  return screen;
}
