/**
 * ModelBot app shell — window frame, hash router, view registry, theme, toasts.
 *
 * The frame itself is markup in index.html; a view owns everything inside the
 * content box and nothing outside it. `registerOverlay` claims a route the same
 * way `registerView` does, but mounts over the current view and leaves it
 * mounted, painted and inert underneath — which is what makes `#/settings` a
 * linkable sheet rather than a screen of its own.
 */

export type Tone = "neutral" | "ok" | "run" | "warn" | "danger";
export type RouteParams = Record<string, string>;
export type ToastKind = "info" | "success" | "warn" | "error";
export type ThemeChoice = "system" | "light" | "dark";

export interface ShellView {
  mount(el: HTMLElement, params: RouteParams): void | Promise<void>;
  update?(params: RouteParams): void;
  unmount?(): void;
}

export interface StatusPill {
  /** Leading text, e.g. "Claude · Opus 4.5". */
  text: string;
  /** Muted tail, e.g. "· on your plan". Hidden below 620px. */
  sub?: string;
  tone?: Tone;
  /** Accessible name. Defaults to `text` + `sub`. */
  label?: string;
  onClick?: () => void;
}

export interface TitleOptions {
  dot?: Tone;
  /** Hash to go back to. `undefined`/`null` shows the brand lockup instead. */
  back?: string | null;
  backLabel?: string;
}

export interface ThemeController {
  get(): ThemeChoice;
  set(choice: ThemeChoice): void;
  resolved(): "light" | "dark";
  subscribe(listener: (choice: ThemeChoice) => void): () => void;
}

const THEME_KEY = "modelbot.theme";
const CATCH_ALL = "*";

type Registration = { pattern: string; view: ShellView };

const registrations: Registration[] = [];
const overlays: Registration[] = [];
let mounted: { registration: Registration; params: RouteParams } | null = null;
let mountedOverlay: { registration: Registration; params: RouteParams } | null = null;
/** The last hash that was not an overlay — what an overlay is painted over. */
let baseHash = "#/";
let started = false;

function pathSegments(path: string): string[] {
  if (!path.startsWith("/")) return [];
  return path.split("/").filter((segment) => segment !== "");
}

/** `"#/tasks/x?a=1"` -> `["tasks", "x"]`. A non-path hash is the root route. */
export function hashSegments(hash: string): string[] {
  return pathSegments(hash.replace(/^#/, "").split("?")[0] ?? "");
}

/** Like hashSegments, but `?` marks an optional segment rather than a query. */
function patternSegments(pattern: string): string[] {
  return pathSegments(pattern.replace(/^#/, ""));
}

/**
 * Match one pattern against one hash.
 * Returns the extracted params, or null when the pattern does not apply.
 */
export function matchRoute(pattern: string, hash: string): RouteParams | null {
  if (pattern === CATCH_ALL) return {};
  const expected = patternSegments(pattern);
  const actual = hashSegments(hash);
  const params: RouteParams = {};
  let index = 0;
  for (; index < expected.length; index += 1) {
    const token = expected[index] as string;
    const optional = token.endsWith("?");
    const name = optional ? token.slice(0, -1) : token;
    const value = actual[index];
    if (value === undefined) {
      // Every remaining token must be optional for this to still be a match.
      if (!optional) return null;
      continue;
    }
    if (name.startsWith(":")) {
      // `decodeURIComponent` throws on a malformed escape (`#/tasks/%`), and
      // this runs inside the hashchange handler: one bad link would wedge the
      // router with no view change and no error surface. The raw segment is a
      // worse id than the decoded one and a far better outcome than that.
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        decoded = value;
      }
      params[name.slice(1)] = decoded;
      continue;
    }
    if (name !== value) return null;
  }
  return index >= actual.length ? params : null;
}

function resolveOverlay(hash: string): { registration: Registration; params: RouteParams } | null {
  for (const registration of overlays) {
    const params = matchRoute(registration.pattern, hash);
    if (params) return { registration, params };
  }
  return null;
}

function resolve(hash: string): { registration: Registration; params: RouteParams } | null {
  let fallback: Registration | null = null;
  for (const registration of registrations) {
    if (registration.pattern === CATCH_ALL) {
      fallback ??= registration;
      continue;
    }
    const params = matchRoute(registration.pattern, hash);
    if (params) return { registration, params };
  }
  return fallback ? { registration: fallback, params: {} } : null;
}

function sameParams(a: RouteParams, b: RouteParams): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * `system` removes `data-theme` so tokens.css’s prefers-color-scheme block
 * takes over. Both dark blocks are defined, so switching works in both
 * directions without a reload.
 */
export function normalizeTheme(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

let themeChoice: ThemeChoice = "system";
const themeListeners = new Set<(choice: ThemeChoice) => void>();

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export const theme: ThemeController = {
  get: () => themeChoice,
  set(choice: ThemeChoice) {
    themeChoice = normalizeTheme(choice);
    try {
      if (themeChoice === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, themeChoice);
    } catch {
      // Private mode / disabled storage: the choice still applies to this window.
    }
    applyTheme(themeChoice);
    for (const listener of themeListeners) listener(themeChoice);
  },
  resolved() {
    if (themeChoice !== "system") return themeChoice;
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  },
  subscribe(listener) {
    themeListeners.add(listener);
    return () => themeListeners.delete(listener);
  },
};

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function viewRoot(): HTMLElement {
  const root = el<HTMLElement>("view-root");
  if (!root) throw new Error("#view-root missing");
  return root;
}

/** The slot overlays mount into. Sits above the content box in the frame. */
function overlayRoot(): HTMLElement {
  const root = el<HTMLElement>("overlay-root");
  if (!root) throw new Error("#overlay-root missing");
  return root;
}

function setDot(node: HTMLElement | null, tone: Tone | undefined): void {
  if (!node) return;
  node.className = tone && tone !== "neutral" ? `dot ${tone}` : "dot";
  node.hidden = tone === undefined;
}

/**
 * "Your bot needs you" — the strip under the titlebar, and the title mark.
 *
 * A native notification is not always available: an ad-hoc signed build is
 * refused by macOS outright, and a browser tab may have been denied permission.
 * The app's own window cannot fail that way, so the strip shows on every route
 * and the window title carries a dot for a backgrounded window.
 */
export interface AttentionState {
  /** How many things are waiting. */
  count: number;
  /** "Your bot needs you", or what it needs. */
  text: string;
  /** "0:48 left", when there is a deadline. */
  sub?: string;
  /** Where the button goes. */
  route: string;
}

let attentionState: AttentionState | null = null;
let currentTitle: string | null = null;

/**
 * While something is waiting on a person the title says exactly that and
 * nothing else: the Dock, ⌘Tab and the window list are where a person looks at
 * a backgrounded app, and a route name is worth less there than that fact.
 */
export function documentTitleFor(
  title: string | null, waiting: boolean,
): string {
  if (waiting) return "● Needs you — BotHearth";
  return title ? `${title} — BotHearth` : "BotHearth";
}

/** Views that mirror the title into the native window title. */
const titleListeners = new Set<(title: string) => void>();

export function onDocumentTitle(listener: (title: string) => void): () => void {
  titleListeners.add(listener);
  return () => {
    titleListeners.delete(listener);
  };
}

function applyDocumentTitle(): void {
  const next = documentTitleFor(currentTitle, attentionState !== null);
  document.title = next;
  for (const listener of titleListeners) listener(next);
}

export function setAttention(state: AttentionState | null): void {
  attentionState = state && state.count > 0 ? state : null;
  applyDocumentTitle();

  const strip = el<HTMLElement>("needs-you");
  if (!strip) return;
  if (!attentionState) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }

  const dot = document.createElement("span");
  dot.className = "dot warn";
  const text = document.createElement("strong");
  text.textContent = attentionState.text;
  const sub = document.createElement("span");
  sub.className = "needs-you-sub";
  sub.textContent = attentionState.sub ?? "";
  sub.hidden = !attentionState.sub;
  const go = document.createElement("button");
  go.type = "button";
  go.className = "btn sm primary";
  go.textContent = attentionState.count > 1 ? `Open the first one` : "Open the task";
  const route = attentionState.route;
  go.addEventListener("click", () => navigate(route));

  strip.replaceChildren(dot, text, sub, go);
  strip.hidden = false;
}

export function setTitle(title: string | null, options: TitleOptions = {}): void {
  const brand = el<HTMLElement>("tb-brand");
  const wrap = el<HTMLElement>("tb-title");
  const text = el<HTMLElement>("tb-title-text");
  const back = el<HTMLButtonElement>("tb-back");
  const backTo = options.back ?? null;

  if (text) text.textContent = title ?? "";
  if (wrap) wrap.hidden = title === null;
  if (brand) brand.hidden = title !== null;
  setDot(el<HTMLElement>("tb-title-dot"), options.dot);

  if (back) {
    back.hidden = backTo === null;
    back.setAttribute("aria-label", options.backLabel ?? "All tasks");
    back.dataset.to = backTo ?? "";
  }

  currentTitle = title;
  applyDocumentTitle();
}

export function setStatusPill(pill: StatusPill | null): void {
  const button = el<HTMLButtonElement>("tb-pill");
  if (!button) return;
  if (!pill) {
    button.hidden = true;
    pillHandler = null;
    return;
  }
  button.hidden = false;
  setDot(button.querySelector<HTMLElement>(".dot"), pill.tone ?? "neutral");
  const label = button.querySelector<HTMLElement>(".label");
  const sub = button.querySelector<HTMLElement>(".sub");
  if (label) label.textContent = pill.text;
  if (sub) {
    sub.textContent = pill.sub ?? "";
    sub.hidden = !pill.sub;
  }
  // The sub-label is hidden below 620px, so the accessible name must carry it.
  button.setAttribute(
    "aria-label",
    pill.label ?? [pill.text, pill.sub].filter(Boolean).join(" "),
  );
  pillHandler = pill.onClick ?? null;
}

let pillHandler: (() => void) | null = null;

const TOAST_MS: Record<ToastKind, number> = {
  info: 4500,
  success: 4500,
  warn: 8000,
  error: 8000,
};
const MAX_TOASTS = 3;

export function toast(kind: ToastKind, text: string): () => void {
  const assertive = kind === "warn" || kind === "error";
  const region = el<HTMLElement>(assertive ? "toast-assertive" : "toast-polite");
  if (!region) return () => {};

  while (region.childElementCount >= MAX_TOASTS) region.firstElementChild?.remove();

  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.kind = kind;
  const dot = document.createElement("span");
  dot.className =
    kind === "success" ? "dot ok" : kind === "error" ? "dot danger" : kind === "warn" ? "dot warn" : "dot";
  const body = document.createElement("span");
  body.textContent = text;
  node.append(dot, body);
  region.append(node);

  const timer = setTimeout(() => node.remove(), TOAST_MS[kind]);
  return () => {
    clearTimeout(timer);
    node.remove();
  };
}

export function registerView(pattern: string, view: ShellView): void {
  const existing = registrations.findIndex((r) => r.pattern === pattern);
  const registration: Registration = { pattern, view };
  if (existing >= 0) registrations[existing] = registration;
  else registrations.push(registration);
  // A view registered after boot must claim the current route now. Rendering
  // synchronously would let a view that registers another from inside its own
  // `mount()` re-enter `render()` and overwrite `mounted` with the inner
  // registration; a microtask lets the outer mount finish first.
  if (started) queueMicrotask(() => render());
}

/**
 * Claim a route as an overlay: it mounts over the current view instead of
 * replacing it, and the view underneath stays mounted, painted and inert.
 * Overlay patterns are matched before ordinary ones, and never fall back.
 */
export function registerOverlay(pattern: string, view: ShellView): void {
  const existing = overlays.findIndex((r) => r.pattern === pattern);
  const registration: Registration = { pattern, view };
  if (existing >= 0) overlays[existing] = registration;
  else overlays.push(registration);
  if (started) render();
}

export function navigate(hash: string, options: { replace?: boolean } = {}): void {
  const next = hash.startsWith("#") ? hash : `#${hash}`;
  if (location.hash === next) {
    render();
    return;
  }
  if (options.replace) {
    history.replaceState({}, "", `${location.pathname}${location.search}${next}`);
    render();
    return;
  }
  location.hash = next;
}

function renderBase(hash: string): void {
  const match = resolve(hash);
  if (!match) return;
  if (mounted?.registration === match.registration) {
    if (!sameParams(mounted.params, match.params)) {
      mounted.params = match.params;
      mounted.registration.view.update?.(match.params);
    }
    return;
  }
  const root = viewRoot();
  mounted?.registration.view.unmount?.();
  root.replaceChildren();
  mounted = { registration: match.registration, params: match.params };
  void match.registration.view.mount(root, match.params);
}

/**
 * An open overlay makes the view beneath it unreachable by pointer and by Tab.
 * `inert` is the one thing that does both, and it is what lets a sheet’s own
 * focus trap stay a short loop rather than a fight with the whole page.
 */
function setBaseInert(inert: boolean): void {
  const root = el<HTMLElement>("view-root");
  if (!root) return;
  if (inert) root.setAttribute("inert", "");
  else root.removeAttribute("inert");
  const shell = el<HTMLElement>("shell");
  if (shell) shell.dataset.overlay = inert ? "open" : "";
}

function renderOverlay(
  match: { registration: Registration; params: RouteParams } | null,
): void {
  if (match && mountedOverlay?.registration === match.registration) {
    if (!sameParams(mountedOverlay.params, match.params)) {
      mountedOverlay.params = match.params;
      mountedOverlay.registration.view.update?.(match.params);
    }
    return;
  }
  if (!match && !mountedOverlay) return;
  const root = overlayRoot();
  if (mountedOverlay) {
    setBaseInert(false);
    mountedOverlay.registration.view.unmount?.();
    root.replaceChildren();
    mountedOverlay = null;
  }
  if (!match) return;
  // Inert before mount: the sheet moves focus into itself as it mounts, and it
  // must not be able to land on something behind it on the way.
  setBaseInert(true);
  mountedOverlay = { registration: match.registration, params: match.params };
  void match.registration.view.mount(root, match.params);
}

function render(): void {
  const hash = location.hash;
  const overlay = resolveOverlay(hash);
  if (!overlay) baseHash = hash || "#/";
  renderBase(overlay ? baseHash : hash);
  renderOverlay(overlay);
}

/** Idempotent. Call once, after the views you have are registered. */
export function initShell(): void {
  if (started) return;
  started = true;

  try {
    themeChoice = normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch {
    themeChoice = "system";
  }
  applyTheme(themeChoice);

  // The native and phone clients embed this bundle as a bare control surface
  // and draw their own chrome; do not nest two titlebars.
  const win = el<HTMLElement>("shell");
  if (win && new URLSearchParams(location.search).get("view") === "control") {
    win.dataset.chrome = "none";
  }

  el<HTMLButtonElement>("tb-back")?.addEventListener("click", () => {
    const to = el<HTMLButtonElement>("tb-back")?.dataset.to;
    navigate(to && to !== "" ? to : "#/");
  });

  el<HTMLButtonElement>("tb-pill")?.addEventListener("click", () => {
    if (pillHandler) pillHandler();
    else navigate("#/settings");
  });

  el<HTMLButtonElement>("tb-settings")?.addEventListener("click", () => {
    navigate("#/settings");
  });

  window.addEventListener("hashchange", () => render());

  // Native -> web is a single channel; the router treats it exactly like a
  // hash change (ux-spec §4).
  window.addEventListener("modelbot:native", (event) => {
    const route = (event as CustomEvent<{ route?: string }>).detail?.route;
    if (typeof route === "string" && route !== "") navigate(route);
  });

  render();
}
