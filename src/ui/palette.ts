/**
 * ⌘K, the keyboard map, and the one place global shortcuts live.
 *
 * It is never on screen until asked for, it lists things a person wants to do
 * rather than things the app can do, and it says plainly when an action is not
 * available instead of hiding it.
 *
 * Three commands belong to whichever view owns the task screen. A view claims
 * one with `bindCommand("stop-task", { run: … })` and calls the returned
 * release on unmount; until then the palette shows them greyed with a plain
 * reason. Every run also fires the `modelbot:command` window event, so a view
 * can listen without importing anything.
 */

import { apiGet } from "./api.ts";
import { attention, modelbotNative, onNative, routeFromNotification } from "./native.ts";
import { currentSession } from "./session.ts";
import type { TaskRow } from "./task-view.ts";
import { navigate, theme, type ThemeChoice } from "./shell.ts";

const DOCS_URL = "https://github.com/sanjaygbhat/bothearth";
const TASKS_TTL_MS = 15_000;

/** Command ⌘ on Apple hardware, Ctrl elsewhere — the platform’s own convention. */
export const IS_APPLE = (): boolean =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

/*
 * A constructable stylesheet rather than a `.css` file: the page is served
 * under `style-src 'self'`, so an inline <style> would be refused, and CSSOM
 * sheets are exempt from CSP and need no build change.
 */
const CSS = `
.mb-layer {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  align-content: start;
  justify-items: center;
  padding: 13vh var(--space-md) var(--space-md);
  background: var(--color-overlay);
  overflow-y: auto;
  animation: mb-fade var(--dur-fast) var(--ease-out-quart) both;
}

.mb-panel {
  width: min(640px, 100%);
  display: flex;
  flex-direction: column;
  background: var(--color-elevated);
  border: var(--hairline) solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl), var(--hairline-top);
  overflow: hidden;
  animation: mb-rise var(--dur-base) var(--ease-out-quart) both;
}

/* --- search row -------------------------------------------------------- */

.mb-search {
  display: flex;
  align-items: center;
  gap: var(--space-2xs);
  height: 56px;
  padding: 0 var(--space-sm);
  border-bottom: var(--hairline) solid var(--color-border);
}
/* A rule under the field rather than a ring round the row: a ring would be
   squared against the panel's rounded head and would fight the selected row. */
.mb-search:focus-within {
  box-shadow: inset 0 -2px 0 var(--color-focus);
}
/* The rule above is this field's focus indicator, so the default ring would be
   a second indicator for one focus. Nothing else here removes an outline. */
.mb-search input:focus-visible {
  outline: none;
}
.mb-search .mb-glyph {
  flex: none;
  color: var(--color-muted);
}
.mb-search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-body);
  line-height: var(--leading-ui);
}
.mb-search input::placeholder {
  color: var(--color-muted);
}
.mb-scope {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 var(--space-2xs);
  border-radius: var(--radius-xs);
  background: var(--color-accent-wash);
  color: var(--color-accent-hover);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}

/* --- results ----------------------------------------------------------- */

.mb-list {
  max-height: min(62vh, 520px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: var(--space-2xs);
}
.mb-group + .mb-group {
  border-top: var(--hairline) solid var(--color-border);
}
.mb-caps {
  padding: var(--space-xs) var(--space-sm) var(--space-3xs);
}
.mb-row {
  display: flex;
  align-items: center;
  gap: var(--space-2xs);
  width: 100%;
  min-height: var(--tap-target);
  padding: var(--space-3xs) var(--space-sm);
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.mb-row-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: transparent;
}
.mb-row-text {
  flex: 1;
  min-width: 0;
}
.mb-row-label {
  display: block;
  font-family: var(--font-ui);
  font-size: var(--text-body);
  line-height: var(--leading-ui);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mb-row-hint {
  display: block;
  margin-top: 1px;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mb-row-keys {
  flex: none;
  display: flex;
  gap: var(--space-3xs);
}
.mb-row em {
  font-style: normal;
  font-weight: var(--weight-semibold);
  color: var(--color-accent);
}
.mb-row:hover {
  background: var(--color-surface);
}
.mb-row[aria-selected="true"] {
  background: var(--color-accent-wash);
}
.mb-row[aria-selected="true"] .mb-row-dot {
  background: var(--color-accent);
}
/* No grey ink on a tinted ground: quiet text becomes a tint of that ground. */
.mb-row[aria-selected="true"] .mb-row-hint {
  color: color-mix(in oklch, var(--color-text) 58%, var(--color-accent-wash));
}
.mb-row[aria-selected="true"] kbd {
  background: color-mix(in oklch, var(--color-accent-wash) 60%, var(--color-elevated));
  border-color: color-mix(in oklch, var(--color-text) 20%, var(--color-accent-wash));
  color: color-mix(in oklch, var(--color-text) 66%, var(--color-accent-wash));
}
.mb-row[aria-disabled="true"] {
  cursor: default;
}
/* Selected but unable to act: keep the position marker, drop the ember, so the
   row never promises that Enter will do something. */
.mb-row[aria-disabled="true"][aria-selected="true"] .mb-row-dot {
  background: color-mix(in oklch, var(--color-text) 45%, var(--color-accent-wash));
}
.mb-row[aria-disabled="true"] .mb-row-label {
  color: var(--color-muted);
}
.mb-row[aria-disabled="true"]:hover {
  background: transparent;
}

.mb-empty {
  padding: var(--space-md) var(--space-sm) var(--space-lg);
}
.mb-empty strong {
  display: block;
  font-family: var(--font-ui);
  font-size: var(--text-body);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}
.mb-empty span {
  display: block;
  margin-top: var(--space-3xs);
  font-size: var(--text-ui);
  line-height: var(--leading-ui);
  color: var(--color-muted);
}

/* --- footer ------------------------------------------------------------ */

.mb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-2xs) var(--space-2xs) var(--space-2xs) var(--space-sm);
  border-top: var(--hairline) solid var(--color-border);
  background: var(--color-surface);
}
.mb-foot-hint {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--text-caption);
  color: var(--color-muted);
  overflow: hidden;
}
.mb-foot-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3xs);
  white-space: nowrap;
}

/* --- keyboard map ------------------------------------------------------ */

.mb-keys {
  width: min(680px, 100%);
}
.mb-keys-head {
  padding: var(--space-md) var(--space-md) var(--space-sm);
}
.mb-keys-head p {
  margin: var(--space-3xs) 0 0;
  font-size: var(--text-ui);
  line-height: var(--leading-ui);
  color: var(--color-muted);
  max-width: none;
}
/* Two columns wherever there is room: the whole list has to be visible at once. */
.mb-keys-body {
  max-height: min(62vh, 520px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 var(--space-md) var(--space-md);
  columns: 2;
  column-gap: var(--space-lg);
}
.mb-keys-group {
  break-inside: avoid;
  margin-bottom: var(--space-md);
}
.mb-keys-group .caps {
  display: block;
  padding-bottom: var(--space-3xs);
}
.mb-key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  min-height: 34px;
  padding: var(--space-3xs) 0;
  border-top: var(--hairline) solid var(--color-border);
  font-size: var(--text-ui);
  line-height: var(--leading-ui);
  color: var(--color-text);
}
.mb-key-caps {
  flex: none;
  display: flex;
  gap: var(--space-3xs);
}

@keyframes mb-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes mb-rise {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}

@media (max-width: 900px) {
  .mb-layer { padding-top: 9vh; }
  .mb-keys-body { columns: 1; }
}
@media (max-width: 620px) {
  .mb-layer {
    padding: calc(var(--titlebar-h) + var(--space-2xs)) var(--gutter-phone) var(--gutter-phone);
  }
  .mb-search { height: 52px; }
  .mb-row { padding-inline: var(--gutter-phone); }
  .mb-keys-head, .mb-keys-body { padding-inline: var(--gutter-phone); }
  .mb-keys-body { columns: 1; }
  .mb-list { max-height: 56vh; }
}
`;

let sheet: CSSStyleSheet | null = null;

function ensureStyles(): void {
  if (sheet || typeof CSSStyleSheet === "undefined") return;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    sheet = null;
  }
}

/* The keyboard map is data, so the sheet and the palette cannot disagree. */

export interface KeyRow {
  keys: string[];
  action: string;
}

export interface KeyGroup {
  where: string;
  rows: KeyRow[];
}

export const KEYBOARD_MAP: KeyGroup[] = [
  {
    where: "Anywhere",
    rows: [
      { keys: ["⌘", "N"], action: "Start a new task" },
      { keys: ["⌘", "K"], action: "Find any command" },
      { keys: ["⌘", ","], action: "Open settings" },
      { keys: ["⌘", "/"], action: "Show this list" },
      { keys: ["⌘", "["], action: "Back" },
      { keys: ["⌘", "]"], action: "Forward" },
    ],
  },
  {
    where: "On home",
    rows: [
      { keys: ["⌘", "L"], action: "Jump to the task box" },
      { keys: ["/"], action: "Search your tasks" },
      { keys: ["⌘", "⏎"], action: "Start the task" },
    ],
  },
  {
    where: "While a task runs",
    rows: [
      { keys: ["⌘", "."], action: "Stop the task" },
      { keys: ["⌘", "⇧", "T"], action: "Take control, or return it" },
      { keys: ["⌘", "⏎"], action: "Give control back" },
      { keys: ["esc"], action: "Leave full screen" },
    ],
  },
  {
    where: "When your bot asks",
    rows: [
      { keys: ["⏎"], action: "Allow once" },
      { keys: ["esc"], action: "Don’t allow" },
    ],
  },
];

export interface CommandBinding {
  run(): void | Promise<void>;
  /** Default true. */
  available?(): boolean;
  /** Shown in place of the shortcut when unavailable. Plain English. */
  unavailableReason?: string;
}

interface Command {
  id: string;
  title: string;
  keywords?: string;
  keys?: string[];
  /** This one changes what the palette is showing rather than leaving it. */
  staysOpen?: boolean;
  /** Only offered when the query matches it — keeps the resting list short. */
  deep?: boolean;
  /** Live subtitle, e.g. the theme currently in use. */
  hint?: () => string;
  run(): void | Promise<void>;
  available?(): boolean;
  unavailableReason?: string;
}

const bindings = new Map<string, CommandBinding>();

/** Claim a command for the view that can actually perform it. */
export function bindCommand(id: string, binding: CommandBinding): () => void {
  bindings.set(id, binding);
  return () => {
    if (bindings.get(id) === binding) bindings.delete(id);
  };
}

function announce(id: string): void {
  window.dispatchEvent(new CustomEvent("modelbot:command", { detail: { command: id } }));
}

/** A command a view owns: it runs if claimed, and says why not if it is not. */
function delegated(
  id: string,
  title: string,
  keys: string[],
  reason: string,
  keywords?: string,
): Command {
  return {
    id,
    title,
    keys,
    ...(keywords ? { keywords } : {}),
    available: () => bindings.get(id)?.available?.() ?? bindings.has(id),
    unavailableReason: reason,
    run: () => {
      announce(id);
      return bindings.get(id)?.run();
    },
  };
}

/** States what is true now, not what the command would switch to. */
const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "Matching your Mac right now",
  light: "Using the light theme",
  dark: "Using the dark theme",
};

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

function setTheme(choice: ThemeChoice): void {
  theme.set(choice);
  announce(`theme-${choice}`);
}

const COMMANDS: Command[] = [
  {
    id: "new-task",
    title: "New task",
    keywords: "start begin write compose ask",
    keys: ["⌘", "N"],
    run: () => {
      navigate("#/");
      announce("new-task");
    },
  },
  {
    id: "go-to-task",
    title: "Go to task…",
    keywords: "open find recent history search",
    staysOpen: true,
    run: () => enterTaskScope(),
  },
  delegated(
    "stop-task",
    "Stop this task",
    ["⌘", "."],
    "Open a task first.",
    "cancel halt end",
  ),
  delegated(
    "take-control",
    "Take control",
    ["⌘", "⇧", "T"],
    "Open a running task first.",
    "drive human takeover sign in login",
  ),
  delegated(
    "give-control-back",
    "Give control back",
    ["⌘", "⏎"],
    "You’re not driving right now.",
    "return hand back resume takeover",
  ),
  {
    id: "settings",
    title: "Open settings",
    keywords: "preferences options ai connection computers devices usage about",
    keys: ["⌘", ","],
    run: () => {
      navigate("#/settings");
      announce("settings");
    },
  },
  {
    id: "switch-theme",
    title: "Switch theme",
    keywords: "appearance dark light mode colour color",
    hint: () => THEME_LABEL[theme.get()],
    run: () => setTheme(NEXT_THEME[theme.get()]),
  },
  {
    id: "theme-light",
    title: "Use the light theme",
    keywords: "appearance day bright",
    deep: true,
    run: () => setTheme("light"),
  },
  {
    id: "theme-dark",
    title: "Use the dark theme",
    keywords: "appearance night",
    deep: true,
    run: () => setTheme("dark"),
  },
  {
    id: "theme-system",
    title: "Match my Mac’s theme",
    keywords: "appearance system auto automatic",
    deep: true,
    run: () => setTheme("system"),
  },
  {
    id: "keyboard",
    title: "Show the keyboard shortcuts",
    keywords: "keys hotkeys map help",
    keys: ["⌘", "/"],
    run: () => openKeys(),
  },
  {
    id: "docs",
    title: "Open the docs",
    keywords: "help handbook guide readme support",
    hint: () => "Opens in your browser",
    run: () => {
      modelbotNative.openExternal(DOCS_URL);
      announce("docs");
    },
  },
];

/** Every command the palette offers, in resting order. */
export function listCommands(): Array<{
  id: string;
  title: string;
  keys: string[];
  deep: boolean;
  available: boolean;
  unavailableReason: string;
}> {
  return COMMANDS.map((command) => ({
    id: command.id,
    title: command.title,
    keys: command.keys ?? [],
    deep: command.deep ?? false,
    available: command.available?.() ?? true,
    unavailableReason: command.unavailableReason ?? "",
  }));
}

export interface FuzzyMatch {
  score: number;
  /** Indices in the matched text, for highlighting. */
  positions: number[];
  /**
   * True when the query appears as one unbroken run. Only those get marked:
   * highlighting a scattered subsequence sprays single letters across a
   * sentence and costs more reading than it saves.
   */
  contiguous: boolean;
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] ?? "";
  return /[\s\-–—_/.,'"(]/.test(previous);
}

/**
 * Scored so that the thing a person meant sorts first.
 *
 * A run of the letters exactly as typed always beats a scattered subsequence —
 * typing "theme" must find "Switch theme" rather than the "the…me" hiding
 * inside "Use the light theme". Failing that, adjacent letters beat scattered
 * ones and a letter that starts a word beats one buried inside it. Shorter
 * labels and earlier matches win ties, because those are the ones a person can
 * see they meant. Returns null when the query does not occur at all.
 */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { score: 0, positions: [], contiguous: false };
  const hay = text.toLowerCase();
  const lengthPenalty = Math.min(10, Math.floor(text.length / 8));

  const run = hay.indexOf(needle);
  if (run !== -1) {
    let score = 60 + needle.length * 2 - Math.min(20, run) - lengthPenalty;
    if (run === 0) score += 25;
    else if (isBoundary(text, run)) score += 15;
    return {
      score,
      positions: Array.from({ length: needle.length }, (_, offset) => run + offset),
      contiguous: true,
    };
  }

  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -2;

  for (const char of needle) {
    if (char === " ") continue;
    const found = hay.indexOf(char, cursor);
    if (found === -1) return null;
    positions.push(found);
    score += 1;
    if (found === previous + 1) score += 8;
    if (isBoundary(text, found)) score += 10;
    score -= Math.min(6, found - cursor);
    previous = found;
    cursor = found + 1;
  }

  return { score: score - lengthPenalty, positions, contiguous: false };
}


let taskCache: TaskRow[] = [];
let taskCacheAt = 0;
let taskLoadFailed = false;

/** The only five status words a person ever sees. */
function statusWord(status: string): string {
  switch (status) {
    case "completed":
      return "Done";
    case "cancelled":
      return "You stopped it";
    case "failed":
      return "Couldn’t finish";
    case "takeover_requested":
    case "pending_approval":
    case "paused":
      return "Waiting for you";
    default:
      return "Working";
  }
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  if (hours < 48) return "yesterday";
  return new Date(then).toLocaleDateString(undefined, { weekday: "short" });
}

async function loadTasks(): Promise<void> {
  if (Date.now() - taskCacheAt < TASKS_TTL_MS) return;
  try {
    const body = (await apiGet("/api/v1/tasks")) as { tasks?: TaskRow[] };
    taskCache = (body.tasks ?? []).filter((task) => typeof task?.id === "string");
    taskCacheAt = Date.now();
    taskLoadFailed = false;
  } catch {
    taskLoadFailed = true;
  }
  if (open === "palette") render();
}

type Overlay = "palette" | "keys" | null;

let open: Overlay = null;
let layer: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let listBox: HTMLElement | null = null;
let restoreFocus: HTMLElement | null = null;
let scope: "all" | "tasks" = "all";
let selected = 0;
/**
 * True once the person has moved the selection themselves. Until then the
 * palette is free to pick the first row that can actually act.
 */
let selectionPinned = false;
let results: Array<{ kind: "command"; command: Command; match: FuzzyMatch } | { kind: "task"; task: TaskRow; match: FuzzyMatch }> = [];

function kbd(text: string): HTMLElement {
  const node = document.createElement("kbd");
  node.textContent = text;
  return node;
}

/** One footer unit: its keys and the words that explain them, kept together. */
function hintItem(keys: string[], text: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "mb-foot-item";
  for (const key of keys) wrap.append(kbd(key));
  wrap.append(document.createTextNode(text));
  return wrap;
}

/**
 * macOS keeps ⌘N and ⌘, for the browser window itself, so in a plain browser
 * those keystrokes never reach the page. The commands still run from here; only
 * the shortcut that cannot fire stops being advertised.
 */
export function shortcutReaches(keys: string[]): boolean {
  if (modelbotNative.isNative) return true;
  return !(keys.length === 2 && keys[0] === "⌘" && (keys[1] === "N" || keys[1] === ","));
}

function keycaps(keys: string[]): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "mb-row-keys";
  for (const key of keys) wrap.append(kbd(key));
  return wrap;
}

function searchGlyph(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "mb-glyph");
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "10.5");
  circle.setAttribute("cy", "10.5");
  circle.setAttribute("r", "6.2");
  const tail = document.createElementNS(ns, "path");
  tail.setAttribute("d", "m15.2 15.2 4.1 4.1");
  svg.append(circle, tail);
  return svg;
}

/** Highlight the matched letters without ever touching innerHTML. */
function highlighted(text: string, positions: number[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const marks = new Set(positions);
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (run === "") return;
    if (runMarked) {
      const em = document.createElement("em");
      em.textContent = run;
      fragment.append(em);
    } else {
      fragment.append(document.createTextNode(run));
    }
    run = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const marked = marks.has(index);
    if (marked !== runMarked) {
      flush();
      runMarked = marked;
    }
    run += text[index];
  }
  flush();
  return fragment;
}

function commandHint(command: Command): string {
  if (command.available && !command.available()) return command.unavailableReason ?? "";
  return command.hint?.() ?? "";
}

function compute(query: string): void {
  const found: typeof results = [];

  if (scope === "all") {
    for (const command of COMMANDS) {
      const target = command.keywords ? `${command.title} ${command.keywords}` : command.title;
      const titleMatch = fuzzy(query, command.title);
      const match = titleMatch ?? (query ? fuzzy(query, target) : null);
      if (!match) continue;
      if (command.deep && query.trim() === "") continue;
      const marks = titleMatch?.contiguous ? titleMatch.positions : [];
      found.push({
        kind: "command",
        command,
        match: { score: match.score + (titleMatch ? 40 : 0), positions: marks, contiguous: true },
      });
    }
    found.sort((a, b) => b.match.score - a.match.score);
  }

  const tasks: typeof results = [];
  for (const task of taskCache) {
    const goal = task.goal || "Untitled task";
    const match = fuzzy(query, goal);
    if (!match) continue;
    tasks.push({
      kind: "task",
      task,
      match: { ...match, positions: match.contiguous ? match.positions : [] },
    });
  }
  tasks.sort((a, b) => b.match.score - a.match.score);

  const taskLimit = scope === "tasks" ? 40 : query.trim() === "" ? 4 : 6;
  results = [...found, ...tasks.slice(0, taskLimit)];
  if (selected >= results.length) selected = Math.max(0, results.length - 1);
  // With a query on screen the top match is what the person aimed at, and
  // quietly selecting something else so that Enter "works" would run a command
  // they did not ask for. Only the resting list gets to skip ahead.
  if (!selectionPinned && query.trim() === "") selected = firstActionable();
}

/**
 * Arrow keys may land on a command that is unavailable — that is how a
 * keyboard-only person hears the reason it cannot run. But Enter on a freshly
 * opened palette must always do something, so the resting selection skips them.
 */
function firstActionable(): number {
  const index = results.findIndex(
    (result) => result.kind === "task" || (result.command.available?.() ?? true),
  );
  return index === -1 ? 0 : index;
}

function groupLabel(node: HTMLElement, text: string): void {
  const caps = document.createElement("div");
  caps.className = "caps mb-caps";
  caps.textContent = text;
  node.append(caps);
}

function render(): void {
  if (!listBox || !input) return;
  compute(input.value);
  listBox.replaceChildren();

  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mb-empty";
    const strong = document.createElement("strong");
    strong.textContent = taskLoadFailed && scope === "tasks"
      ? "Your tasks couldn’t be loaded."
      : `Nothing here matches “${input.value.trim()}”.`;
    const span = document.createElement("span");
    span.textContent = taskLoadFailed && scope === "tasks"
      ? "BotHearth will pick them up again once it reconnects."
      : "Try fewer letters, or press esc and carry on.";
    empty.append(strong, span);
    listBox.append(empty);
    input.removeAttribute("aria-activedescendant");
    return;
  }

  let group: HTMLElement | null = null;
  let groupKind: string | null = null;

  results.forEach((result, index) => {
    const kind = result.kind;
    if (kind !== groupKind) {
      groupKind = kind;
      group = document.createElement("div");
      group.className = "mb-group";
      group.setAttribute("role", "group");
      const label = kind === "command" ? "Commands" : "Your tasks";
      group.setAttribute("aria-label", label);
      if (scope === "all") groupLabel(group, label);
      listBox?.append(group);
    }

    const row = document.createElement("div");
    row.className = "mb-row";
    row.id = `mb-row-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selected));

    const dot = document.createElement("span");
    dot.className = "mb-row-dot";
    dot.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "mb-row-text";
    const label = document.createElement("span");
    label.className = "mb-row-label";

    if (result.kind === "command") {
      const enabled = result.command.available?.() ?? true;
      if (!enabled) row.setAttribute("aria-disabled", "true");
      label.append(highlighted(result.command.title, result.match.positions));
      text.append(label);
      const hint = commandHint(result.command);
      if (hint) {
        const hintNode = document.createElement("span");
        hintNode.className = "mb-row-hint";
        hintNode.textContent = hint;
        text.append(hintNode);
      }
      row.append(dot, text);
      if (enabled && result.command.keys && shortcutReaches(result.command.keys)) {
        row.append(keycaps(result.command.keys));
      }
      row.setAttribute(
        "aria-label",
        hint ? `${result.command.title}. ${hint}` : result.command.title,
      );
    } else {
      const goal = result.task.goal || "Untitled task";
      label.append(highlighted(goal, result.match.positions));
      const hintNode = document.createElement("span");
      hintNode.className = "mb-row-hint";
      const when = relativeTime(result.task.created_at);
      hintNode.textContent = when
        ? `${statusWord(result.task.status)} · ${when}`
        : statusWord(result.task.status);
      text.append(label, hintNode);
      row.append(dot, text);
      row.setAttribute("aria-label", `${goal}. ${hintNode.textContent}`);
    }

    row.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      selected = index;
      run(index);
    });
    row.addEventListener("pointerenter", () => {
      if (selected === index) return;
      selectionPinned = true;
      selected = index;
      paintSelection();
    });
    group?.append(row);
  });

  paintSelection();
}

function paintSelection(): void {
  if (!listBox || !input) return;
  const rows = listBox.querySelectorAll<HTMLElement>(".mb-row");
  rows.forEach((row, index) => {
    row.setAttribute("aria-selected", String(index === selected));
  });
  const active = rows[selected];
  if (active) {
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}

function move(delta: number): void {
  if (results.length === 0) return;
  selectionPinned = true;
  selected = (selected + delta + results.length) % results.length;
  paintSelection();
}

function run(index: number): void {
  const result = results[index];
  if (!result) return;
  if (result.kind === "command") {
    if (result.command.available && !result.command.available()) return;
    // A command that narrows the palette must not be handed a torn-down one.
    if (!result.command.staysOpen) closeOverlay();
    void result.command.run();
    return;
  }
  closeOverlay();
  navigate(`#/tasks/${result.task.id}`);
}

function enterTaskScope(): void {
  if (open !== "palette") openPalette();
  scope = "tasks";
  selected = 0;
  selectionPinned = false;
  if (input) {
    input.value = "";
    input.placeholder = "Search your tasks";
    input.focus();
  }
  const badge = layer?.querySelector<HTMLElement>(".mb-scope");
  if (badge) badge.hidden = false;
  void loadTasks();
  render();
}

function buildLayer(): HTMLElement {
  const node = document.createElement("div");
  node.className = "mb-layer";
  node.addEventListener("pointerdown", (event) => {
    if (event.target === node) closeOverlay();
  });
  return node;
}

/** Tab must not escape an overlay into the page behind it. */
function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  const focusable = [...root.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])")]
    .filter((node) => !node.hasAttribute("disabled") && node.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0] as HTMLElement;
  const last = focusable[focusable.length - 1] as HTMLElement;
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openPalette(): void {
  ensureStyles();
  if (open === "keys") closeOverlay();
  if (open === "palette") {
    input?.select();
    return;
  }
  if (typeof document === "undefined" || !document.body) return;

  restoreFocus = document.activeElement as HTMLElement | null;
  scope = "all";
  selected = 0;
  selectionPinned = false;

  layer = buildLayer();
  const panel = document.createElement("div");
  panel.className = "mb-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Find a command");

  const search = document.createElement("div");
  search.className = "mb-search";
  const field = document.createElement("input");
  field.type = "text";
  field.autocomplete = "off";
  field.spellcheck = false;
  field.placeholder = "What do you want to do?";
  field.setAttribute("role", "combobox");
  field.setAttribute("aria-expanded", "true");
  field.setAttribute("aria-controls", "mb-listbox");
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-label", "Find a command or a task");
  const badge = document.createElement("span");
  badge.className = "mb-scope";
  badge.textContent = "Tasks";
  badge.hidden = true;
  search.append(searchGlyph(), field, badge);

  const list = document.createElement("div");
  list.className = "mb-list";
  list.id = "mb-listbox";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Commands and tasks");

  const foot = document.createElement("div");
  foot.className = "mb-foot";
  const hint = document.createElement("div");
  hint.className = "mb-foot-hint";
  hint.append(hintItem(["↑", "↓"], "to move"), hintItem(["⏎"], "to run"), hintItem(["esc"], "to close"));
  const keysButton = document.createElement("button");
  keysButton.type = "button";
  keysButton.className = "btn ghost sm";
  keysButton.append(document.createTextNode("All keys"), kbd("⌘"), kbd("/"));
  keysButton.addEventListener("click", () => openKeys());
  foot.append(hint, keysButton);

  panel.append(search, list, foot);
  layer.append(panel);
  document.body.append(layer);

  input = field;
  listBox = list;
  open = "palette";

  field.addEventListener("input", () => {
    selected = 0;
    selectionPinned = false;
    render();
  });
  field.addEventListener("keydown", onPaletteKey);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Tab") trapTab(event, panel);
  });

  void loadTasks();
  render();
  field.focus();
}

function onPaletteKey(event: KeyboardEvent): void {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      move(-1);
      break;
    case "Home":
      event.preventDefault();
      selectionPinned = true;
      selected = 0;
      paintSelection();
      break;
    case "End":
      event.preventDefault();
      selectionPinned = true;
      selected = Math.max(0, results.length - 1);
      paintSelection();
      break;
    case "Enter":
      event.preventDefault();
      run(selected);
      break;
    case "Backspace":
      if (scope === "tasks" && input?.value === "") {
        event.preventDefault();
        scope = "all";
        selected = 0;
        selectionPinned = false;
        if (input) input.placeholder = "What do you want to do?";
        const badge = layer?.querySelector<HTMLElement>(".mb-scope");
        if (badge) badge.hidden = true;
        render();
      }
      break;
    default:
      break;
  }
}

export function openKeys(): void {
  ensureStyles();
  if (open === "palette") closeOverlay();
  if (open === "keys") return;
  if (typeof document === "undefined" || !document.body) return;

  restoreFocus = document.activeElement as HTMLElement | null;
  layer = buildLayer();

  const panel = document.createElement("div");
  panel.className = "mb-panel mb-keys";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "mb-keys-title");
  panel.tabIndex = -1;

  const head = document.createElement("div");
  head.className = "mb-keys-head";
  const title = document.createElement("h2");
  title.className = "t-title";
  title.id = "mb-keys-title";
  title.textContent = "Keyboard";
  const sub = document.createElement("p");
  sub.textContent = "Keyboard shortcuts";
  head.append(title, sub);

  const body = document.createElement("div");
  body.className = "mb-keys-body";
  for (const group of KEYBOARD_MAP) {
    const section = document.createElement("section");
    section.className = "mb-keys-group";
    const caps = document.createElement("span");
    caps.className = "caps";
    caps.textContent = group.where;
    section.append(caps);
    for (const item of group.rows) {
      if (!shortcutReaches(item.keys)) continue;
      const row = document.createElement("div");
      row.className = "mb-key-row";
      const action = document.createElement("span");
      action.textContent = item.action;
      const caps2 = document.createElement("span");
      caps2.className = "mb-key-caps";
      for (const key of item.keys) caps2.append(kbd(key));
      row.append(action, caps2);
      section.append(row);
    }
    body.append(section);
  }

  const foot = document.createElement("div");
  foot.className = "mb-foot";
  const hint = document.createElement("div");
  hint.className = "mb-foot-hint";
  hint.append(hintItem(["esc"], "to close"));
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn sm";
  done.textContent = "Done";
  done.addEventListener("click", () => closeOverlay());
  foot.append(hint, done);

  panel.append(head, body, foot);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Tab") trapTab(event, panel);
  });
  layer.append(panel);
  document.body.append(layer);
  open = "keys";
  // Focus a real control rather than the container: the ring then says
  // something true (Enter closes this) instead of outlining the whole sheet.
  done.focus();
}

export function closeOverlay(): boolean {
  if (!open) return false;
  layer?.remove();
  layer = null;
  input = null;
  listBox = null;
  open = null;
  results = [];
  restoreFocus?.focus?.();
  restoreFocus = null;
  return true;
}

export function isOverlayOpen(): Overlay {
  return open;
}

function togglePalette(): void {
  if (open === "palette") closeOverlay();
  else openPalette();
}

function toggleKeys(): void {
  if (open === "keys") closeOverlay();
  else openKeys();
}

/** Run a command by id from anywhere — a menu item, a shortcut, a test. */
export function runCommand(id: string): void {
  const command = COMMANDS.find((candidate) => candidate.id === id);
  if (!command) return;
  if (command.available && !command.available()) return;
  if (!command.staysOpen) closeOverlay();
  void command.run();
}

/* Global shortcuts, in one place. */

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;

  if (event.key === "Escape") {
    // Only ours to consume. An approval card or a settings sheet answers its
    // own Esc, and a person typing in a field must keep theirs.
    if (open && closeOverlay()) event.preventDefault();
    return;
  }

  const modifier = event.metaKey || (!IS_APPLE() && event.ctrlKey);
  if (!modifier || event.altKey) return;

  switch (event.key.toLowerCase()) {
    case "k":
      event.preventDefault();
      togglePalette();
      break;
    case "n":
      if (event.shiftKey) return;
      event.preventDefault();
      runCommand("new-task");
      break;
    case ",":
      event.preventDefault();
      runCommand("settings");
      break;
    case "/":
    case "?":
      event.preventDefault();
      toggleKeys();
      break;
    default:
      break;
  }
}

let installed = false;

/**
 * Idempotent. Wires the shortcuts, the native menu dispatches and the
 * attention loop. Skipped on the chromeless control surface, which is embedded
 * inside another client’s own chrome and owns neither menus nor shortcuts.
 */
function installPalette(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("keydown", onKeyDown);

  // The Mac shell owns ⌘N and ⌘, in its menu bar, so those keystrokes never
  // reach the page — they arrive as events instead. Same action either way.
  onNative("new-task", () => runCommand("new-task"));
  onNative("open-settings", () => runCommand("settings"));
  onNative("open-palette", () => togglePalette());
  onNative("open-keys", () => toggleKeys());
  onNative("notification-click", (detail) => {
    const route = routeFromNotification(detail);
    if (route) navigate(route);
  });
  // Coming back to the window is the moment to re-check what is waiting.
  onNative("focus", () => void attention.reconcile());
}

function boot(): void {
  if (typeof document === "undefined") return;
  if (!document.getElementById("shell")) return;
  if (new URLSearchParams(location.search).get("view") === "control") return;
  ensureStyles();
  installPalette();
  // The event socket needs the session cookie. Opening it first only produces a
  // failed handshake and a console error on every cold start, then reconnects a
  // second later — so wait for the session that is already in flight.
  void currentSession()
    .catch(() => null)
    .then(() => attention.start());
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}
