/**
 * The DOM stand-in every `src/ui` test runs against.
 *
 * The repo has no jsdom and the UI must stay dependency-free, so this is the
 * smallest tree the UI modules actually touch: elements with attributes, a
 * class list, a dataset, children, listeners, focus, and a selector engine that
 * covers what the views and the settings focus trap ask for. It is deliberately
 * not a browser — it exists so *behaviour* can be asserted (what is in the DOM,
 * what is not, what a click does); layout is verified in a real browser.
 *
 * Where the DOM is stricter than a stand-in needs to be, this follows the DOM:
 * `tagName` is upper case for `createElement` and verbatim for
 * `createElementNS`, `className` is the `class` attribute, `id`/`href`/`rel`/
 * `target`/`download`/`tabIndex` reflect to attributes, and `location.hash =`
 * fires `hashchange`.
 */

export type Listener = (event: any) => void;

export type FakeNode = FakeElement | FakeText;

export class FakeText {
  nodeType = 3 as const;
  parentNode: FakeElement | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = value;
  }
}

const CAMEL = /([a-z0-9])([A-Z])/g;

function dataAttr(key: string): string {
  return `data-${key.replace(CAMEL, "$1-$2").toLowerCase()}`;
}

function camel(name: string): string {
  return name.replace(/^data-/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

class ClassList {
  private readonly owner: FakeElement;
  constructor(owner: FakeElement) {
    this.owner = owner;
  }
  private parts(): string[] {
    return this.owner.className.split(/\s+/).filter(Boolean);
  }
  add(...names: string[]): void {
    const list = this.parts();
    for (const name of names) if (name && !list.includes(name)) list.push(name);
    this.owner.className = list.join(" ");
  }
  remove(...names: string[]): void {
    this.owner.className = this.parts().filter((p) => !names.includes(p)).join(" ");
  }
  contains(name: string): boolean {
    return this.parts().includes(name);
  }
  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.contains(name);
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
  values(): string[] {
    return this.parts();
  }
}

export class FakeElement {
  nodeType = 1 as const;
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  readonly classList = new ClassList(this);
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  readonly dataset: Record<string, string>;
  hidden = false;
  disabled = false;
  readOnly = false;
  checked = false;
  value = "";
  rows = 0;
  type = "";
  placeholder = "";
  selectionStart = 0;
  selectionEnd = 0;
  width = 0;
  height = 0;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;

  readonly tagName: string;
  readonly ownerDocument: FakeDocument;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    const bag: Record<string, string> = {};
    this.style = Object.assign(bag, {
      setProperty(name: string, value: string) {
        bag[name] = value;
      },
    }) as FakeElement["style"];
    this.dataset = new Proxy({} as Record<string, string>, {
      set: (_t, key: string, value: string) => {
        this.attributes.set(dataAttr(key), String(value));
        return true;
      },
      get: (_t, key: string) => this.attributes.get(dataAttr(key)),
      has: (_t, key: string) => this.attributes.has(dataAttr(key)),
      deleteProperty: (_t, key: string) => this.attributes.delete(dataAttr(key)) || true,
      ownKeys: () =>
        [...this.attributes.keys()]
          .filter((name) => name.startsWith("data-"))
          .map((name) => camel(name)),
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    });
  }

  /* ---- attributes ---- */

  get className(): string {
    return this.attributes.get("class") ?? "";
  }
  set className(value: string) {
    this.attributes.set("class", String(value));
  }
  get id(): string {
    return this.attributes.get("id") ?? "";
  }
  set id(value: string) {
    this.attributes.set("id", String(value));
  }
  get href(): string {
    return this.attributes.get("href") ?? "";
  }
  set href(value: string) {
    this.attributes.set("href", String(value));
  }
  get rel(): string {
    return this.attributes.get("rel") ?? "";
  }
  set rel(value: string) {
    this.attributes.set("rel", String(value));
  }
  get target(): string {
    return this.attributes.get("target") ?? "";
  }
  set target(value: string) {
    this.attributes.set("target", String(value));
  }
  get download(): string {
    return this.attributes.get("download") ?? "";
  }
  set download(value: string) {
    this.attributes.set("download", String(value));
  }
  get tabIndex(): number {
    return Number(this.attributes.get("tabindex") ?? -1);
  }
  set tabIndex(value: number) {
    this.attributes.set("tabindex", String(value));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  /* ---- tree ---- */

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n.nodeType === 1);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): FakeElement | null {
    const kids = this.children;
    return kids[kids.length - 1] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    if (value !== "") this.appendChild(new FakeText(value));
  }

  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      this.appendChild(typeof node === "string" ? new FakeText(node) : node);
    }
  }
  prepend(...nodes: Array<FakeNode | string>): void {
    for (const node of [...nodes].reverse()) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.unshift(child);
    }
  }
  insertBefore<T extends FakeNode>(node: T, before: FakeNode | null): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    return node;
  }
  removeChild<T extends FakeNode>(node: T): T {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }

  get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node) {
      if (node === this.ownerDocument.documentElement) return true;
      node = node.parentNode;
    }
    return false;
  }

  /** The settings focus trap uses this to skip anything that is not painted. */
  get offsetParent(): FakeElement | null {
    if (this.hidden) return null;
    let node: FakeElement | null = this.parentNode;
    while (node) {
      if (node.hidden) return null;
      node = node.parentNode;
    }
    return this.parentNode;
  }

  /** Depth-first, including this node. */
  walk(): FakeElement[] {
    const out: FakeElement[] = [this];
    for (const child of this.children) out.push(...child.walk());
    return out;
  }
  /** Depth-first, excluding this node. */
  descendants(): FakeElement[] {
    return this.walk().slice(1);
  }
  contains(node: unknown): boolean {
    let current = node as FakeElement | null;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  /* ---- selectors ---- */

  matches(selector: string): boolean {
    return selector.split(",").some((part) => part.trim() && matchesComplex(this, part.trim()));
  }
  querySelectorAll(selector: string): FakeElement[] {
    const pool = this.descendants();
    const seen = new Set<FakeElement>();
    const out: FakeElement[] = [];
    for (const node of pool) {
      if (seen.has(node) || !node.matches(selector)) continue;
      seen.add(node);
      out.push(node);
    }
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /* ---- events ---- */

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  }
  /** Fire one listener set. No bubbling — nothing under test relies on it. */
  fire(type: string, event: Record<string, unknown> = {}): any {
    const payload = {
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(payload);
    return payload;
  }
  click(): void {
    this.fire("click");
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  select(): void {
    /* no selection model needed */
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  getContext(): null {
    return null;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}

/** One compound selector: `*`, `tag`, `.cls`, `#id`, `[attr]`, `[attr=v]`, `:not(...)`. */
function matchesCompound(node: FakeElement, selector: string): boolean {
  let rest = selector.trim();
  if (rest === "*") return true;
  while (rest.length > 0) {
    const not = /^:not\(([^)]*)\)/.exec(rest);
    if (not) {
      if (matchesCompound(node, not[1] as string)) return false;
      rest = rest.slice(not[0].length);
      continue;
    }
    const attr = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/.exec(rest);
    if (attr) {
      const name = attr[1] as string;
      const want = attr[2];
      const actual =
        name === "disabled"
          ? node.disabled
            ? ""
            : null
          : name === "hidden"
            ? node.hidden
              ? ""
              : null
            : (node.getAttribute(name) ?? node.dataset[camel(name)] ?? null);
      if (actual === null || actual === undefined) return false;
      if (want !== undefined && actual !== want) return false;
      rest = rest.slice(attr[0].length);
      continue;
    }
    const id = /^#([\w-]+)/.exec(rest);
    if (id) {
      if (node.id !== id[1]) return false;
      rest = rest.slice(id[0].length);
      continue;
    }
    const cls = /^\.([\w-]+)/.exec(rest);
    if (cls) {
      if (!node.classList.contains(cls[1] as string)) return false;
      rest = rest.slice(cls[0].length);
      continue;
    }
    const tag = /^[\w-]+/.exec(rest);
    if (tag) {
      if (node.tagName.toLowerCase() !== (tag[0] as string).toLowerCase()) return false;
      rest = rest.slice(tag[0].length);
      continue;
    }
    return false;
  }
  return true;
}

/** A selector with descendant and child combinators, matched right to left. */
function matchesComplex(node: FakeElement, selector: string): boolean {
  const steps: Array<{ child: boolean; compound: string }> = [];
  const token = /\s*(>)?\s*((?:\[[^\]]*\]|:not\([^)]*\)|[^\s>])+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(selector)) !== null) {
    steps.push({ child: match[1] === ">", compound: match[2] as string });
  }
  if (steps.length === 0) return false;
  if (!matchesCompound(node, steps[steps.length - 1]!.compound)) return false;

  let current: FakeElement | null = node;
  for (let i = steps.length - 1; i > 0; i -= 1) {
    const parent = steps[i - 1]!.compound;
    if (steps[i]!.child) {
      current = current!.parentNode;
      if (!current || !matchesCompound(current, parent)) return false;
    } else {
      let up = current!.parentNode;
      while (up && !matchesCompound(up, parent)) up = up.parentNode;
      if (!up) return false;
      current = up;
    }
  }
  return true;
}

export class FakeDocument {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly listeners = new Map<string, Listener[]>();
  activeElement: FakeElement | null = null;
  hidden = false;

  constructor() {
    this.documentElement = new FakeElement("HTML", this);
    this.head = new FakeElement("HEAD", this);
    this.body = new FakeElement("BODY", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toUpperCase(), this);
  }
  /** Namespaced tags keep their case, the way the real DOM reports `svg`. */
  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createTextNode(data: string): FakeText {
    return new FakeText(data);
  }
  getElementById(id: string): FakeElement | null {
    return this.documentElement.descendants().find((node) => node.id === id) ?? null;
  }
  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  }
  fire(type: string, event: Record<string, unknown> = {}): any {
    const payload = { type, preventDefault() {}, stopPropagation() {}, ...event };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(payload);
    return payload;
  }
}

export interface DomOptions {
  /** Starting `location.hash`. */
  hash?: string;
  /** Installed as the global `fetch` when given. */
  fetch?: (path: string, init?: any) => Promise<Response>;
  /**
   * Drive timers from the test instead of the clock, so that "polls exactly
   * once" is a real assertion. Without it the real timers run.
   */
  timers?: "manual";
}

export interface Dom {
  document: FakeDocument;
  /** The mount point tests hand to a view. */
  root: FakeElement;
  windowListeners: Map<string, Listener[]>;
  storage: Map<string, string>;
  hash(): string;
  /** Every element under `root`, in document order. */
  all(): FakeElement[];
  find(selector: string): FakeElement | null;
  findAll(selector: string): FakeElement[];
  /** The outermost element whose text is exactly `text`. */
  byText(text: string): FakeElement | null;
  /** Manual timers only: run every pending callback. */
  runTimers(): void;
  pendingTimers(): number;
  restore(): void;
}

const GLOBALS = [
  "document",
  "window",
  "location",
  "history",
  "navigator",
  "localStorage",
  "fetch",
  "HTMLElement",
  "WebSocket",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

/** Installs the globals `src/ui` reaches for, and hands back a restore. */
export function installDom(options: DomOptions = {}): Dom {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of GLOBALS) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const document = new FakeDocument();
  const root = document.createElement("div");
  document.body.appendChild(root);

  const windowListeners = new Map<string, Listener[]>();
  const storage = new Map<string, string>();
  let hash = options.hash ?? "";

  const fireWindow = (type: string, event: Record<string, unknown> = {}): any => {
    const payload = { type, preventDefault() {}, stopPropagation() {}, ...event };
    for (const listener of [...(windowListeners.get(type) ?? [])]) listener(payload);
    return payload;
  };

  const location = {
    get href() {
      return `http://127.0.0.1:7801/${hash}`;
    },
    get hash() {
      return hash;
    },
    set hash(value: string) {
      const next = value === "" || value.startsWith("#") ? value : `#${value}`;
      if (next === hash) return;
      hash = next;
      fireWindow("hashchange");
    },
    origin: "http://127.0.0.1:7801",
    protocol: "http:",
    host: "127.0.0.1:7801",
    pathname: "/",
    search: "",
    reload() {},
  };

  // Manual timers are driven by the test, never by the clock.
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const manual = options.timers === "manual";
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const set = manual
    ? (fn: () => void) => {
        const id = nextTimer++;
        timers.set(id, fn);
        return id;
      }
    : (fn: () => void, ms?: number) => realSetTimeout(fn, ms) as unknown as number;
  const clear = manual
    ? (id: number) => void timers.delete(id)
    : (id: number) => realClearTimeout(id as never);

  const win = {
    document,
    location,
    addEventListener(type: string, listener: Listener) {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
    removeEventListener(type: string, listener: Listener) {
      const list = windowListeners.get(type) ?? [];
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent(event: { type: string }) {
      fireWindow(event.type, event as unknown as Record<string, unknown>);
      return true;
    },
    /** Test-facing: fire a window event by name. */
    dispatch: fireWindow,
    matchMedia: () => ({ matches: false }),
    setTimeout: set,
    clearTimeout: clear,
    setInterval: set,
    clearInterval: clear,
    open: () => null,
    focus() {},
  };

  // Anything the fake window does not name — `webkit`, `modelbotNative`, the
  // globals a test installs itself — falls through to the real global object.
  const windowProxy = new Proxy(win as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : (globalThis as any)[key]),
    set: (target, key: string, value) => {
      target[key] = value;
      return true;
    },
    has: (target, key: string) => key in target || key in globalThis,
  });

  define("document", document);
  define("window", windowProxy);
  define("location", location);
  define("history", { replaceState() {} });
  define("navigator", { userAgent: "test", clipboard: { writeText: async () => {} } });
  define("HTMLElement", FakeElement);
  define("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, String(value)),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  });
  define("WebSocket", class {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = "";
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  });
  if (options.fetch) {
    const impl = options.fetch;
    define("fetch", (path: any, init: any) => impl(String(path), init));
  }
  if (manual) {
    define("setTimeout", set);
    define("clearTimeout", clear);
    define("setInterval", set);
    define("clearInterval", clear);
  }

  return {
    document,
    root,
    windowListeners,
    storage,
    hash: () => hash,
    all: () => root.descendants(),
    find: (selector) => root.querySelector(selector),
    findAll: (selector) => root.querySelectorAll(selector),
    byText: (text) => root.descendants().find((node) => node.textContent === text) ?? null,
    pendingTimers: () => timers.size,
    runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

/** Let queued microtasks and zero-delay timers settle. */
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** `root` and every element under it, depth-first. */
export function all(root: FakeElement): FakeElement[] {
  return root.walk();
}

/**
 * The innermost element whose visible text is exactly `text`. Depth-first order
 * puts a wrapper before its only child, so the last match is the real control.
 */
export function byText(root: FakeElement, text: string): FakeElement | undefined {
  return all(root).filter((node) => node.textContent === text).pop();
}

/** Every button and link under a node, in document order. */
export function actionable(root: FakeElement): FakeElement[] {
  return root.walk().filter((node) => node.tagName === "BUTTON" || node.tagName === "A");
}
