/**
 * Home — `#/`. The task box IS the page (ux-spec §2.1, owner ruling).
 *
 * Everything on this screen exists to get one sentence typed and started:
 * the display heading, the box (focused on arrival), three examples that fill
 * it, the Recent column, and — only when something is genuinely in the way —
 * one calm blocker card above the box. The box never stops accepting text, and
 * nothing here is ever a modal.
 */

import { apiGet, apiPost, ApiError } from "./api.ts";
import {
  aiIdentity,
  createRuntimeWatcher,
  isPreparing,
  isSettling,
  primaryBlocker,
  shouldAutoPrepare,
  startPrepare,
  type RuntimeBlocker,
  type RuntimeStatus,
  type RuntimeWatcher,
} from "./runtime.ts";
import { element } from "./safe.ts";
import { currentSession, PAIR_AGAIN, type SessionInfo } from "./session.ts";
import { attention, modelbotNative, type AttentionItem } from "./native.ts";
import { countdownText } from "./needs-you.ts";
import { navigate, registerView, setStatusPill, setTitle } from "./shell.ts";
import { markTaskStarted } from "./task.ts";
import { budgetRejected, readBudgetPreference } from "./usage.ts";
import type { TaskRow } from "./task-view.ts";

/* -------------------------------------------------------------------------
 * Copy and constants — ux-spec §2.1 / §2.2, design-brief §5.
 * ---------------------------------------------------------------------- */

const HEADING_LINES = ["What should your bot", "get done?"] as const;

export const EXAMPLES = [
  "Pull last month’s invoices off my billing page into a spreadsheet",
  "Check every link on my site and list the ones that are broken",
  "Watch this listing and tell me the moment the price drops",
] as const;

/**
 * The Mac shell is an app you reopen; a browser is a link the daemon minted,
 * and the daemon may not even be on a Mac. Both surfaces load this same file.
 */
function thisMachine(): string {
  return modelbotNative.isNative ? "this Mac" : "this computer";
}

function reconnectHelp(): string {
  return modelbotNative.isNative
    ? "Open ModelBot from your Applications folder again — your draft is still here."
    : `${PAIR_AGAIN} Your draft is still here.`;
}

export const EMPTY_RECENT =
  "No tasks yet. Start with something small you can check — like finding last month’s invoice on a site you already use.";

const PLACEHOLDER = "Describe it the way you’d say it to a person";

const DRAFT_KEY = "modelbot.draft";
const REVEALED_KEY = "modelbot.revealed";
const RECENT_SHOWN = 4;

const ORBSTACK_URL = "https://orbstack.dev/download";
const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";

const ENGINE_LABEL: Record<string, string> = {
  "docker-desktop": "Docker Desktop",
  orbstack: "OrbStack",
  colima: "Colima",
  unknown: "Docker",
};

/** macOS URL schemes, so "Open OrbStack" actually opens it from the browser. */
const ENGINE_SCHEME: Record<string, string> = {
  "docker-desktop": "docker-desktop://",
  orbstack: "orbstack://",
  colima: "",
  unknown: "",
};

/* -------------------------------------------------------------------------
 * Pure helpers — unit tested without a DOM.
 * ---------------------------------------------------------------------- */

export type StatusTone = "ok" | "run" | "warn" | "danger" | "neutral";

/**
 * Task id -> the deadline it is waiting on. A row for a task that is waiting on
 * a person says so and counts down, whatever its stored status says — the
 * status is written when the task starts waiting, the deadline is live.
 */
export function waitingByTask(items: AttentionItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    if (!item.taskId || !item.expiresAt) continue;
    const at = Date.parse(item.expiresAt);
    if (!Number.isFinite(at)) continue;
    const existing = out.get(item.taskId);
    if (existing === undefined || at < existing) out.set(item.taskId, at);
  }
  return out;
}

export function recentStatus(status: string): { word: string; tone: StatusTone } {
  switch (status) {
    case "running":
      return { word: "Working", tone: "run" };
    case "paused":
    case "pending_approval":
    case "takeover_requested":
      return { word: "Waiting for you", tone: "warn" };
    case "completed":
      return { word: "Done", tone: "ok" };
    case "cancelled":
      return { word: "You stopped it", tone: "neutral" };
    case "failed":
      return { word: "Couldn’t finish", tone: "danger" };
    default: {
      const words = status.replaceAll("_", " ");
      return { word: words.charAt(0).toUpperCase() + words.slice(1), tone: "neutral" };
    }
  }
}

/** "2 min", "yesterday", "Tue" — the shortest true thing (mock 03). */
export function relativeTime(value: string, now: number = Date.now()): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;

  const date = new Date(then);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (then >= midnight) {
    const hours = Math.max(1, Math.round(seconds / 3600));
    return `${hours} hr`;
  }
  if (then >= midnight - 86_400_000) return "yesterday";
  if (then >= midnight - 6 * 86_400_000) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The titlebar chip answers "which model is this, and what will it cost me" on
 * screen one (ux-spec §2.1). It states only what was actually reported: the
 * provider and the model it named, never a model we guessed.
 */
export function publishStatusPill(input: Parameters<typeof aiIdentity>[0]): void {
  const identity = aiIdentity(input);
  setStatusPill({
    text: identity.text,
    ...(identity.sub ? { sub: identity.sub } : {}),
    tone: identity.tone,
    label: identity.label,
    onClick: () => navigate("#/settings/ai"),
  });
}

export type BlockerAction = {
  label: string;
  kind: "primary" | "secondary" | "ghost";
  /** An href opens something outside the app; onClick stays inside it. */
  href?: string;
  intent?: "settings" | "prepare" | "disclose";
};

export interface BlockerCard {
  /** Stable identity, so an unchanged card is never re-rendered or re-announced. */
  key: string;
  glyph: "computer" | "key" | "cube" | "alert";
  heading: string;
  body: string;
  actions: BlockerAction[];
  /** The reassurance line under the actions, with its dot tone. */
  watch: { text: string; tone: StatusTone };
  /** Present only while a build is running. */
  progress?: { percent: number; step: string };
  /** Expanded by the card’s ghost button; never a modal. */
  detail?: { label: string; text: string };
}

const WATCH_CHECKING = {
  text: "Checking every couple of seconds — this page moves on by itself.",
  tone: "run" as StatusTone,
};
const WATCH_TRUST = {
  text: "No other setup on your Mac — no screen recording, no accessibility access, ever.",
  tone: "ok" as StatusTone,
};

/**
 * Turn the readiness ladder into the one card ux-spec §2.2 describes.
 * The daemon’s own `title`/`detail` are a fallback: for the states the spec
 * writes copy for, the spec wins, because that copy was written for this screen
 * (and stays clear of the banned marketing claims).
 */
export function blockerCard(status: RuntimeStatus | null): BlockerCard | null {
  if (!status) return null;
  const prepare = status.images.prepare;

  if (prepare.state === "failed") {
    return {
      key: "prepare_failed",
      glyph: "alert",
      heading: "Setup didn’t finish",
      body:
        "The one-time setup stopped partway. Nothing was lost and nothing was changed on your Mac — " +
        "you can run it again.",
      actions: [
        { label: "Try again", kind: "primary", intent: "prepare" },
        ...(prepare.error
          ? [{ label: "What happened?", kind: "ghost" as const, intent: "disclose" as const }]
          : []),
      ],
      watch: WATCH_CHECKING,
      ...(prepare.error ? { detail: { label: "What happened?", text: prepare.error } } : {}),
    };
  }

  const blocker = primaryBlocker(status);

  if (blocker?.id === "ai_not_connected") return aiCard(status, blocker);

  if (blocker?.id === "node_version" && !modelbotNative.isNative) {
    return {
      key: "node_version",
      glyph: "alert",
      heading: blocker.title,
      body:
        `ModelBot needs a newer Node than ${thisMachine()} has (${status.node.version}). Install the ` +
        "current version, then run `modelbot start` again.",
      actions: blocker.action.url
        ? [{ label: "Show me how", kind: "primary", href: blocker.action.url }]
        : [],
      watch: WATCH_CHECKING,
    };
  }

  if (blocker?.id === "docker_missing") {
    return {
      key: "docker_missing",
      glyph: "computer",
      heading: "Your bot needs its own computer",
      body:
        `It works inside a private computer on ${thisMachine()}, so it never touches your files or ` +
        "your logged-in browser. Docker is what builds that computer. It’s free, and we’ll wait " +
        "right here while you install it.",
      actions: [
        { label: "Install OrbStack", kind: "primary", href: blocker.action.url ?? ORBSTACK_URL },
        { label: "Use Docker Desktop", kind: "secondary", href: DOCKER_DESKTOP_URL },
        { label: "Why is this needed?", kind: "ghost", intent: "disclose" },
      ],
      watch: WATCH_CHECKING,
      detail: {
        label: "Why is this needed?",
        text:
          "Your bot clicks around real websites. Giving it a computer of its own means a mistake " +
          "stays in there — it can’t reach your documents, your photos, or the sites you’re already " +
          "signed in to. OrbStack and Docker Desktop both build that computer; OrbStack is smaller " +
          "and faster to install.",
      },
    };
  }

  if (blocker?.id === "docker_not_running") {
    const engine = ENGINE_LABEL[status.docker.engine] ?? "Docker";
    const scheme = ENGINE_SCHEME[status.docker.engine] ?? "";
    return {
      key: "docker_not_running",
      glyph: "computer",
      heading: `${engine} isn’t running yet`,
      body: `Open ${engine}, wait for it to finish starting, and this moves on by itself.`,
      actions: [
        {
          label: `Open ${engine}`,
          kind: "primary",
          ...(scheme ? { href: scheme } : {}),
        },
        { label: "Show me how", kind: "ghost", intent: "disclose" },
      ],
      watch: WATCH_CHECKING,
      detail: {
        label: "Show me how",
        text:
          `${engine} is in your Applications folder. Open it and leave it running — it takes about ` +
          "half a minute to start, and you don’t need to do anything inside it.",
      },
    };
  }

  // A build in flight, or one about to start on its own.
  if (isPreparing(status) || blocker?.action.kind === "prepare_images") {
    const percent =
      typeof prepare.percent === "number" ? Math.max(0, Math.min(100, prepare.percent)) : 0;
    return {
      key: "preparing",
      glyph: "cube",
      heading: "Getting its computer ready",
      body:
        "Building the private computer it works in. This happens once and can take several " +
        "minutes. You can write your task now.",
      actions: [],
      watch: WATCH_CHECKING,
      progress: { percent, step: prepare.step || "Starting the one-time setup" },
    };
  }

  if (blocker) {
    return {
      key: blocker.id,
      glyph: "alert",
      heading: blocker.title,
      body: blocker.detail,
      actions: blocker.action.url
        ? [{ label: "Show me how", kind: "primary", href: blocker.action.url }]
        : [],
      watch: WATCH_CHECKING,
    };
  }

  return null;
}

function aiCard(status: RuntimeStatus, blocker: RuntimeBlocker): BlockerCard {
  // Signed out of a CLI that is already installed is a different, smaller ask
  // than choosing an AI for the first time (ux-spec §2.2, rows 1 and 5).
  if (status.ai.cli_found) {
    const app = status.ai.provider === "codex" ? "Codex" : "Claude Code";
    const other = status.ai.provider === "codex" ? "Claude" : "Codex";
    // Signed in and still blocked means ModelBot has not been pointed at it
    // yet. Asking for a sign-in that already happened reads as a bug.
    if (status.ai.logged_in) {
      return {
        key: "ai_not_connected",
        glyph: "key",
        heading: `Connect ${app}`,
        body:
          `${app} is signed in on ${thisMachine()}, but ModelBot isn’t using it yet. Connect it in ` +
          `Settings and your bot starts thinking with it — your sign-in stays with ${app}.`,
        actions: [
          { label: `Connect ${app}`, kind: "primary", intent: "settings" },
          { label: `Use ${other} instead`, kind: "ghost", intent: "settings" },
        ],
        watch: WATCH_CHECKING,
      };
    }
    return {
      key: "ai_signed_out",
      glyph: "key",
      heading: `${app} needs you to sign in again`,
      body: "One sign-in in your browser and your bot picks up where it left off.",
      actions: [
        { label: "Sign in", kind: "primary", intent: "settings" },
        { label: `Use ${other} instead`, kind: "ghost", intent: "settings" },
      ],
      watch: WATCH_CHECKING,
    };
  }
  return {
    key: "ai_not_connected",
    glyph: "key",
    heading: "Connect your model account",
    body:
      `BotHearth runs on ${thisMachine()} and connects to your installed model CLI. ` +
      "The CLI handles sign-in. Provider eligibility, limits, and charges apply.",
    actions: [
      { label: "Use Claude", kind: "primary", intent: "settings" },
      { label: "Use Codex", kind: "secondary", intent: "settings" },
      { label: "What’s the difference?", kind: "ghost", intent: "settings" },
    ],
    watch: WATCH_TRUST,
    // The daemon’s own line stays reachable rather than being thrown away.
    detail: { label: "What’s the difference?", text: blocker.detail },
  };
}

export interface ComposerState {
  label: string;
  /** aria-disabled, never `opacity` — a disabled control must stay readable. */
  disabled: boolean;
  /**
   * Always true. The start button is the one primary on this screen in every
   * state it can be in, and it never drops to the bordered/grey treatment —
   * that is what made it read as broken. `disabled` alone
   * decides whether it wears the ember or the muted ink fill; base.css §5 owns
   * that pair. Kept as a field so the class name has a single source.
   */
  primary: boolean;
  /** `true` renders the ⌘ ⏎ key caps rather than a sentence. */
  keys: boolean;
  hint: string;
  /** Shown next to the button while a start is queued. */
  cancel: boolean;
}

/**
 * The one-line reason a start is not available, per ux-spec §2.2. A blocked box
 * still accepts text; only the button waits.
 */
export function composerState(input: {
  ready: boolean;
  blockerKey: string | null;
  hasText: boolean;
  armed: boolean;
  submitting: boolean;
}): ComposerState {
  if (input.submitting) {
    return {
      label: "Starting",
      disabled: true,
      primary: true,
      keys: false,
      hint: "Getting its computer ready for this task.",
      cancel: false,
    };
  }
  if (input.armed) {
    return {
      label: "Waiting to start",
      disabled: true,
      primary: true,
      keys: false,
      hint: "Queued — it starts the moment the computer is ready.",
      cancel: true,
    };
  }
  if (!input.ready) {
    const aiBlocked =
      input.blockerKey === "ai_not_connected" || input.blockerKey === "ai_signed_out";
    return aiBlocked
      ? {
          label: "Start task",
          disabled: true,
          primary: true,
          keys: false,
          hint: "Pick an AI above and this is ready to go",
          cancel: false,
        }
      : {
          label: "Start when ready",
          disabled: true,
          primary: true,
          keys: false,
          hint: "Write it now — it starts the moment the computer is ready",
          cancel: false,
        };
  }
  return {
    label: "Start task",
    disabled: !input.hasText,
    primary: true,
    keys: true,
    hint: "to start",
    cancel: false,
  };
}

/** The draft outlives a reload and a trip to Settings (§8). */
function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(value: string): void {
  try {
    if (value) localStorage.setItem(DRAFT_KEY, value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Private mode: the draft still lives in the box for this window.
  }
}

/* -------------------------------------------------------------------------
 * Small DOM helpers. No innerHTML anywhere in this file.
 * ---------------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

const GLYPH_PATHS: Record<BlockerCard["glyph"], Array<[string, string]>> = {
  computer: [
    ["rect", "2.5,4,19,13,2"],
    ["path", "M9 20.5h6M12 17v3.5"],
  ],
  key: [
    ["circle", "8.5,12,3.5"],
    ["path", "M12 12h8.5M18 12v3M15.5 12v2.2"],
  ],
  cube: [
    ["path", "M3.5 8.4 12 4l8.5 4.4v7.2L12 20l-8.5-4.4z"],
    ["path", "M3.5 8.4 12 12.9l8.5-4.5M12 12.9V20"],
  ],
  alert: [
    ["path", "M12 4.2 21 19.4H3z"],
    ["path", "M12 10v4.1M12 16.8v.1"],
  ],
};

function glyph(kind: BlockerCard["glyph"]): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "19");
  svg.setAttribute("height", "19");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, spec] of GLYPH_PATHS[kind]) {
    const shape = document.createElementNS(SVG_NS, tag);
    if (tag === "rect") {
      const [x, y, w, h, r] = spec.split(",");
      shape.setAttribute("x", x!);
      shape.setAttribute("y", y!);
      shape.setAttribute("width", w!);
      shape.setAttribute("height", h!);
      shape.setAttribute("rx", r!);
    } else if (tag === "circle") {
      const [cx, cy, r] = spec.split(",");
      shape.setAttribute("cx", cx!);
      shape.setAttribute("cy", cy!);
      shape.setAttribute("r", r!);
    } else {
      shape.setAttribute("d", spec);
    }
    svg.appendChild(shape);
  }
  return svg;
}

function arrowGlyph(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M4.5 12h14M13 6.5l5.5 5.5L13 17.5");
  svg.appendChild(path);
  return svg;
}

/**
 * `home.css` ships as a render-blocking `<link>` in index.html, next to the
 * other view sheets, so the first paint is already styled and the packaging
 * smoke test can see it (static.ts `uiReferencedAssets`). This is the belt to
 * that braces: a surface that embeds this view without the app shell still gets
 * its sheet, and a second call is a no-op.
 */
function ensureStylesheet(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[href="/home.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/home.css";
  link.dataset.viewSheet = "home";
  document.head.appendChild(link);
}

/* -------------------------------------------------------------------------
 * The view
 * ---------------------------------------------------------------------- */

export interface HomeOptions {
  /** Poll cadence overrides. Production leaves these alone (2s / 30s). */
  activeMs?: number;
  hiddenMs?: number;
}

class HomeView {
  private readonly options: HomeOptions;

  constructor(options: HomeOptions = {}) {
    this.options = options;
  }

  private root: HTMLElement | null = null;
  private box: HTMLTextAreaElement | null = null;
  private startButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private hint: HTMLElement | null = null;
  private message: HTMLElement | null = null;
  private announcer: HTMLElement | null = null;
  private blockerSlot: HTMLElement | null = null;
  private recentSlot: HTMLElement | null = null;

  private watcher: RuntimeWatcher | null = null;
  private status: RuntimeStatus | null = null;
  private session: SessionInfo | null = null;
  private tasks: TaskRow[] | null = null;
  private waitingTick: number | undefined;

  private renderedCardKey: string | null = null;
  private renderedComposer = "";
  private announced = "";
  private armed = false;
  private submitting = false;
  private preparing = false;
  private failures = 0;
  private offline = false;
  private disposers: Array<() => void> = [];

  /* ---------------- lifecycle ---------------- */

  mount(el: HTMLElement): void {
    ensureStylesheet();
    setTitle(null);
    this.root = el;
    this.build(el);
    this.focusBox();

    // A startup link lands on `#/`, so this view — not the legacy shell — is
    // what turns the one-time token into a session before anything is fetched.
    void currentSession()
      .then((session) => {
        if (!this.root) return;
        this.session = session;
        this.publishPill();
        this.startWatching();
        void this.loadRecent();
      })
      .catch(() => {
        if (!this.root) return;
        this.startWatching();
        void this.loadRecent();
      });

    this.on(window, "focus", () => {
      this.focusBox({ onlyIfIdle: true });
      this.watcher?.refresh();
      void this.loadRecent();
    });
    this.on(document, "visibilitychange", () => {
      if (!document.hidden) this.watcher?.refresh();
    });
    this.on(window, "keydown", (event) => this.onGlobalKey(event as KeyboardEvent));

    // A Recent row that is counting down has to actually count. The tick runs
    // only while something is waiting, and stops the moment nothing is.
    this.disposers.push(attention.subscribe(() => this.paintWaiting()));
    this.paintWaiting();
  }

  /** Start or stop the one-second repaint that drives the Recent countdown. */
  private paintWaiting(): void {
    const waiting = waitingByTask(attention.pending()).size > 0;
    if (waiting && this.waitingTick === undefined) {
      this.waitingTick = window.setInterval(() => this.renderRecent(), 1000);
    } else if (!waiting && this.waitingTick !== undefined) {
      window.clearInterval(this.waitingTick);
      this.waitingTick = undefined;
    }
    if (this.tasks) this.renderRecent();
  }

  unmount(): void {
    this.watcher?.stop();
    this.watcher = null;
    if (this.waitingTick !== undefined) window.clearInterval(this.waitingTick);
    this.waitingTick = undefined;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.root = null;
    this.box = null;
  }

  private on(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }

  /* ---------------- frame ---------------- */

  private build(el: HTMLElement): void {
    const page = element("div", "home");

    const main = element("div", "home-main");
    // ux-spec §6 moment 1: one orchestrated entrance, once per install.
    if (this.firstRun()) main.dataset.reveal = "";

    const heading = element("h1", "home-ask");
    HEADING_LINES.forEach((line, index) => {
      if (index > 0) heading.appendChild(document.createElement("br"));
      heading.appendChild(document.createTextNode(line));
    });
    heading.style.setProperty("--i", "0");

    this.blockerSlot = element("div", "home-blocker-slot");
    this.blockerSlot.style.setProperty("--i", "1");

    const box = this.buildTaskBox();
    box.style.setProperty("--i", "2");

    const examples = this.buildExamples();
    examples.style.setProperty("--i", "3");

    main.append(heading, this.blockerSlot, box, examples);

    const side = element("div", "home-side");
    this.recentSlot = element("section", "recent");
    this.recentSlot.setAttribute("aria-label", "Recent tasks");
    side.appendChild(this.recentSlot);
    this.renderRecentSkeleton();

    this.announcer = element("div", "sr-only");
    this.announcer.setAttribute("role", "status");
    this.announcer.setAttribute("aria-live", "polite");

    page.append(main, side, this.announcer);
    el.appendChild(page);
  }

  private buildTaskBox(): HTMLElement {
    const wrap = element("div", "taskbox focus-well");

    const label = element("label", "sr-only", "What should your bot get done?");
    label.setAttribute("for", "home-goal");

    const box = document.createElement("textarea");
    box.id = "home-goal";
    box.rows = 3;
    box.placeholder = PLACEHOLDER;
    box.value = readDraft();
    box.setAttribute("aria-describedby", "home-hint");
    box.addEventListener("input", () => {
      writeDraft(box.value);
      if (this.message) this.message.textContent = "";
      this.paintComposer();
    });
    box.addEventListener("keydown", (event) => {
      // ux-spec §2.1: ⌘⏎ starts. Return on its own is a newline — a task is
      // often more than one sentence, and nothing here should fire by accident.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.start();
      }
    });
    this.box = box;

    const foot = element("div", "taskbox-foot");
    this.hint = element("span", "taskbox-hint");
    this.hint.id = "home-hint";

    const actions = element("span", "taskbox-actions");
    this.cancelButton = element("button", "btn ghost sm", "Cancel");
    this.cancelButton.type = "button";
    this.cancelButton.hidden = true;
    this.cancelButton.addEventListener("click", () => {
      this.armed = false;
      this.announce("Queue cancelled.");
      this.paintComposer();
    });

    this.startButton = element("button", "btn primary", "Start task");
    this.startButton.type = "button";
    this.startButton.addEventListener("click", () => void this.start());

    actions.append(this.cancelButton, this.startButton);
    foot.append(this.hint, actions);

    this.message = element("p", "taskbox-message");
    this.message.setAttribute("role", "status");

    wrap.append(label, box, foot, this.message);
    this.paintComposer();
    return wrap;
  }

  private buildExamples(): HTMLElement {
    const wrap = element("div", "examples");
    wrap.appendChild(element("span", "caps", "Try"));
    for (const text of EXAMPLES) {
      const button = element("button", "example");
      button.type = "button";
      const icon = element("span", "example-arrow");
      icon.appendChild(arrowGlyph());
      button.append(icon, element("span", "example-text", text));
      button.addEventListener("click", () => this.fill(text));
      wrap.appendChild(button);
    }
    return wrap;
  }

  /* ---------------- the box ---------------- */

  private fill(text: string): void {
    if (!this.box) return;
    this.box.value = text;
    writeDraft(text);
    this.focusBox();
    this.paintComposer();
  }

  private focusBox(options: { onlyIfIdle?: boolean } = {}): void {
    const box = this.box;
    if (!box) return;
    if (options.onlyIfIdle) {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
    }
    box.focus();
    const end = box.value.length;
    try {
      box.setSelectionRange(end, end);
    } catch {
      // Some engines refuse a range before layout; the caret still lands.
    }
  }

  private onGlobalKey(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "l") {
      event.preventDefault();
      this.focusBox();
      return;
    }
    if (key === "n") {
      event.preventDefault();
      if (this.box) this.box.value = "";
      writeDraft("");
      this.armed = false;
      if (this.message) this.message.textContent = "";
      this.focusBox();
      this.paintComposer();
    }
  }

  /**
   * A start is only really available when the AI can think AND its computer is
   * up: `task_start_available` speaks for the AI alone, so a missing Docker
   * would otherwise leave the button live and fail at container start.
   */
  private ready(): boolean {
    if (!this.status?.task_start_available) return false;
    return !isSettling(this.status);
  }

  private paintComposer(): void {
    const state = composerState({
      ready: this.ready(),
      blockerKey: this.renderedCardKey,
      hasText: Boolean(this.box?.value.trim()),
      armed: this.armed,
      submitting: this.submitting,
    });
    const signature = JSON.stringify(state);
    if (signature === this.renderedComposer) return;
    this.renderedComposer = signature;

    const button = this.startButton;
    if (button) {
      button.textContent = state.label;
      button.className = state.primary ? "btn primary" : "btn";
      button.setAttribute("aria-disabled", String(state.disabled));
    }
    if (this.cancelButton) this.cancelButton.hidden = !state.cancel;

    const hint = this.hint;
    if (!hint) return;
    hint.replaceChildren();
    if (state.keys) {
      hint.append(
        element("kbd", undefined, "⌘"),
        element("kbd", undefined, "⏎"),
        element("span", undefined, state.hint),
      );
    } else {
      hint.textContent = state.hint;
    }
  }

  /* ---------------- starting ---------------- */

  private async start(): Promise<void> {
    const goal = this.box?.value.trim() ?? "";
    if (!goal) {
      this.focusBox();
      return;
    }
    if (this.submitting) return;

    if (!this.ready()) {
      // ux-spec §1/§2.2: "it starts the moment the computer is ready". Arming is
      // deliberate and reversible — nothing fires that the person did not ask for.
      this.armed = true;
      this.announce("Queued. It starts the moment the computer is ready.");
      this.paintComposer();
      return;
    }

    this.armed = false;
    this.submitting = true;
    if (this.message) this.message.textContent = "";
    this.paintComposer();

    try {
      // The per-task budget the person set in Settings -> Usage. Omitted
      // entirely when nothing has been set, so a default never travels as if it
      // were a choice.
      const budget = readBudgetPreference();
      // `max_steps` is the daemon's to decide (config `agent.max_steps`); a
      // number from here would override whatever the owner set in modelbot.yaml.
      const body = {
        goal,
        capabilities: ["browser"],
        ...(budget === null ? {} : { spend_cap_usd: budget }),
      };
      const response = (await apiPost("/api/v1/tasks", body)) as { task: TaskRow };
      writeDraft("");
      if (this.box) this.box.value = "";
      this.submitting = false;
      this.paintComposer();
      // The one screen change in the app that is a handoff rather than a jump
      // (tokens.css §6, moment 1).
      markTaskStarted(response.task.id);
      navigate(`#/tasks/${response.task.id}`);
    } catch (error) {
      this.submitting = false;
      this.paintComposer();
      this.showStartError(error);
    }
  }

  private showStartError(error: unknown): void {
    const target = this.message;
    if (!target) return;
    target.replaceChildren();

    if (error instanceof ApiError) {
      const body = error.body as { task_id?: unknown } | null;
      // The daemon refuses a budget above its own ceiling by naming a wire
      // field. Its message is replaced with one that says where to change it.
      target.appendChild(document.createTextNode(budgetRejected(error) ?? error.message));
      if (typeof body?.task_id === "string") {
        const link = element("a", "taskbox-message-link", "Open it");
        link.setAttribute("href", `#/tasks/${body.task_id}`);
        target.append(document.createTextNode(" "), link);
      }
      return;
    }
    target.textContent =
      "Your task didn’t start. Check that ModelBot is still running, then try again — your draft is still here.";
  }

  /* ---------------- readiness ---------------- */

  private startWatching(): void {
    this.watcher = createRuntimeWatcher({
      onStatus: (status) => this.onStatus(status),
      onError: (error) => this.onStatusError(error),
      ...(this.options.activeMs === undefined ? {} : { activeMs: this.options.activeMs }),
      ...(this.options.hiddenMs === undefined ? {} : { hiddenMs: this.options.hiddenMs }),
    });
    this.watcher.start();
  }

  private onStatus(status: RuntimeStatus): void {
    this.status = status;
    this.failures = 0;
    if (this.offline) {
      this.offline = false;
      this.clearOffline();
    }
    this.publishPill();
    this.renderBlocker(blockerCard(status));
    this.paintComposer();

    if (shouldAutoPrepare(status) && !this.preparing) {
      this.preparing = true;
      void startPrepare()
        .then(() => this.watcher?.refresh())
        .catch(() => {
          this.preparing = false;
        });
    }
    if (status.images.prepare.state !== "running") this.preparing = false;

    if (this.ready() && this.armed) {
      this.armed = false;
      this.paintComposer();
      void this.start();
    }
  }

  private onStatusError(error: unknown): void {
    this.failures += 1;
    // One blip is not an outage; two in a row is worth telling the person about.
    if (this.failures < 2 || this.offline) return;
    this.offline = true;
    this.renderOffline(error);
  }

  private publishPill(): void {
    publishStatusPill({
      status: this.status,
      model: this.session?.model ?? null,
      executionMode: this.session?.execution_mode ?? null,
    });
  }

  private announce(text: string): void {
    if (!this.announcer || text === this.announced) return;
    this.announced = text;
    this.announcer.textContent = text;
  }

  /* ---------------- the blocker card ---------------- */

  private renderBlocker(card: BlockerCard | null): void {
    const slot = this.blockerSlot;
    if (!slot) return;

    if (!card) {
      if (this.renderedCardKey) {
        this.announce("Everything’s ready. Press Command Return to start.");
        this.dismissCard(slot);
      }
      this.renderedCardKey = null;
      return;
    }

    if (card.key === this.renderedCardKey) {
      this.updateProgress(slot, card);
      return;
    }

    this.renderedCardKey = card.key;
    this.announce(card.heading);
    slot.replaceChildren(this.buildCard(card));
  }

  /** ux-spec §6: the card leaves the way it arrived, reversed and shorter. */
  private dismissCard(slot: HTMLElement): void {
    const card = slot.firstElementChild as HTMLElement | null;
    if (!card) {
      slot.replaceChildren();
      return;
    }
    card.classList.add("is-leaving");
    const remove = () => {
      if (slot.firstElementChild === card) slot.replaceChildren();
    };
    card.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 400);
  }

  private updateProgress(slot: HTMLElement, card: BlockerCard): void {
    if (!card.progress) return;
    const fill = slot.querySelector<HTMLElement>(".meter > i");
    const step = slot.querySelector<HTMLElement>(".blocker-step");
    if (fill) fill.style.transform = `scaleX(${card.progress.percent / 100})`;
    if (step && step.textContent !== card.progress.step) {
      step.textContent = card.progress.step;
    }
  }

  private buildCard(card: BlockerCard): HTMLElement {
    const node = element("section", "blocker");
    node.setAttribute("aria-labelledby", "blocker-heading");

    const icon = element("span", "blocker-glyph");
    icon.appendChild(glyph(card.glyph));

    const body = element("div", "blocker-body");
    const heading = element("h2", undefined, card.heading);
    heading.id = "blocker-heading";
    body.append(heading, element("p", undefined, card.body));

    if (card.progress) {
      const meter = element("div", "meter");
      meter.dataset.motion = "progress";
      meter.setAttribute("role", "progressbar");
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      meter.setAttribute("aria-valuenow", String(Math.round(card.progress.percent)));
      meter.setAttribute("aria-label", "One-time setup");
      const fill = document.createElement("i");
      fill.style.transform = `scaleX(${card.progress.percent / 100})`;
      meter.appendChild(fill);
      body.append(meter, element("p", "blocker-step", card.progress.step));
    }

    let disclosure: HTMLElement | null = null;
    if (card.detail) {
      disclosure = element("p", "blocker-detail", card.detail.text);
      disclosure.hidden = true;
      disclosure.id = "blocker-detail";
    }

    if (card.actions.length) {
      const actions = element("div", "blocker-actions");
      for (const action of card.actions) {
        actions.appendChild(this.buildAction(action, disclosure));
      }
      body.appendChild(actions);
    }
    if (disclosure) body.appendChild(disclosure);

    const watch = element("p", "blocker-watch");
    const dot = element("span", `dot ${card.watch.tone}`);
    watch.append(dot, document.createTextNode(card.watch.text));
    body.appendChild(watch);

    const row = element("div", "blocker-row");
    row.append(icon, body);
    node.appendChild(row);
    return node;
  }

  private buildAction(action: BlockerAction, disclosure: HTMLElement | null): HTMLElement {
    const className = `btn${action.kind === "primary" ? " primary" : action.kind === "ghost" ? " ghost" : ""}`;

    if (action.href) {
      const link = element("a", className, action.label);
      link.setAttribute("href", action.href);
      if (action.href.startsWith("http")) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      }
      return link;
    }

    const button = element("button", className, action.label);
    button.type = "button";
    if (action.intent === "settings") {
      const pick =
        action.label === "Use Codex"
          ? "?pick=codex"
          : action.label === "Use Claude"
            ? "?pick=claude"
            : "";
      button.addEventListener("click", () => navigate(`#/settings/ai${pick}`));
      return button;
    }
    if (action.intent === "prepare") {
      button.addEventListener("click", () => {
        button.setAttribute("aria-disabled", "true");
        this.preparing = true;
        void startPrepare()
          .then(() => this.watcher?.refresh())
          .catch(() => {
            this.preparing = false;
            button.setAttribute("aria-disabled", "false");
          });
      });
      return button;
    }
    if (action.intent === "disclose" && disclosure) {
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "blocker-detail");
      button.addEventListener("click", () => {
        const open = disclosure.hidden;
        disclosure.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
      });
      return button;
    }
    return button;
  }

  /* ---------------- the daemon went away ---------------- */

  private renderOffline(error: unknown): void {
    const slot = this.blockerSlot;
    if (!slot || !this.root) return;
    const expired = error instanceof ApiError && (error.status === 401 || error.status === 403);

    const card = element("section", "blocker blocker-offline");
    const body = element("div", "blocker-body");
    body.append(
      element("h2", undefined, expired ? "ModelBot needs to reconnect." : "ModelBot stopped unexpectedly."),
      element(
        "p",
        undefined,
        expired ? reconnectHelp() : "It restarts by itself. If this keeps happening, send us the log.",
      ),
    );

    const actions = element("div", "blocker-actions");
    const retry = element("button", "btn primary", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => {
      this.failures = 0;
      this.watcher?.refresh();
      void this.loadRecent();
    });
    const copy = element("button", "btn ghost", "Copy diagnostics");
    copy.type = "button";
    copy.addEventListener("click", () => {
      const text = this.diagnostics(error);
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          copy.textContent = "Copied";
          window.setTimeout(() => (copy.textContent = "Copy diagnostics"), 2000);
        })
        .catch(() => {
          copy.textContent = "Copy is blocked in this browser";
        });
    });
    actions.append(retry, copy);
    body.appendChild(actions);

    const icon = element("span", "blocker-glyph");
    icon.appendChild(glyph("alert"));
    const row = element("div", "blocker-row");
    row.append(icon, body);
    card.appendChild(row);

    this.renderedCardKey = "offline";
    slot.replaceChildren(card);
    this.announce("ModelBot stopped unexpectedly. Your draft is still here.");
    this.paintComposer();
  }

  private clearOffline(): void {
    this.renderedCardKey = null;
    this.blockerSlot?.replaceChildren();
  }

  private diagnostics(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof ApiError ? `\nhttp: ${error.status}` : "";
    return [
      "ModelBot diagnostics",
      `when: ${new Date().toISOString()}`,
      `page: ${location.pathname}${location.hash}`,
      `readiness: ${message}${status}`,
      `browser: ${navigator.userAgent}`,
      `last known: ${this.status ? JSON.stringify({ docker: this.status.docker, ai: { provider: this.status.ai.provider, cli_found: this.status.ai.cli_found } }) : "none"}`,
    ].join("\n");
  }

  /* ---------------- Recent ---------------- */

  private async loadRecent(): Promise<void> {
    try {
      const data = (await apiGet("/api/v1/tasks")) as { tasks: TaskRow[] };
      if (!this.root) return;
      this.tasks = [...data.tasks].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      this.renderRecent();
    } catch {
      if (!this.root || this.tasks) return;
      this.renderRecentError();
    }
  }

  /** ux-spec §2.1: never a spinner — three hairline rows while it loads. */
  private renderRecentSkeleton(): void {
    const slot = this.recentSlot;
    if (!slot) return;
    slot.replaceChildren(element("span", "caps", "Recent"));
    const rows = element("div", "recent-skeleton");
    rows.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i += 1) rows.appendChild(element("div", "recent-skeleton-row"));
    slot.appendChild(rows);
  }

  private renderRecent(): void {
    const slot = this.recentSlot;
    const tasks = this.tasks;
    if (!slot || !tasks) return;

    slot.replaceChildren(element("span", "caps", "Recent"));

    if (!tasks.length) {
      slot.appendChild(element("p", "recent-empty", EMPTY_RECENT));
      return;
    }

    const waiting = waitingByTask(attention.pending());
    const list = element("ul", "recent-list");
    for (const task of tasks.slice(0, RECENT_SHOWN)) {
      const deadline = waiting.get(task.id);
      const { word, tone } = deadline === undefined
        ? recentStatus(task.status)
        : { word: "Waiting for you", tone: "warn" as StatusTone };
      // An approval expires in about a minute, and this row is where a person
      // is already looking. The countdown is the difference between "I'll get
      // to it" and "I have 48 seconds".
      const when = deadline === undefined
        ? relativeTime(task.created_at)
        : countdownText(deadline - Date.now());

      const item = document.createElement("li");
      const link = element("a", "recent-row");
      link.setAttribute("href", `#/tasks/${task.id}`);

      const title = element("span", "recent-title", task.goal || "Untitled task");
      const meta = element("span", "recent-meta");
      meta.append(
        element("span", tone === "neutral" ? "dot" : `dot ${tone}`),
        document.createTextNode(when ? `${word} · ${when}` : word),
      );
      link.append(title, meta);
      item.appendChild(link);
      list.appendChild(item);
    }
    slot.appendChild(list);

    const all = element("a", "recent-all");
    all.setAttribute("href", "#/tasks");
    all.append(
      document.createTextNode(`All ${tasks.length} task${tasks.length === 1 ? "" : "s"}`),
      element("span", "recent-all-arrow", "→"),
    );
    slot.appendChild(all);
  }

  private renderRecentError(): void {
    const slot = this.recentSlot;
    if (!slot) return;
    slot.replaceChildren(element("span", "caps", "Recent"));
    slot.appendChild(element("p", "recent-empty", "Your recent tasks couldn’t be loaded just now."));
    const retry = element("button", "btn ghost sm recent-retry", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => {
      this.renderRecentSkeleton();
      void this.loadRecent();
    });
    slot.appendChild(retry);
  }

  private firstRun(): boolean {
    try {
      if (localStorage.getItem(REVEALED_KEY)) return false;
      localStorage.setItem(REVEALED_KEY, "1");
      return true;
    } catch {
      return false;
    }
  }
}

/** Exported so the tests can drive one instance directly. */
export function createHomeView(options: HomeOptions = {}) {
  let view: HomeView | null = null;
  return {
    mount(el: HTMLElement) {
      view = new HomeView(options);
      view.mount(el);
    },
    unmount() {
      view?.unmount();
      view = null;
    },
  };
}

registerView("#/", createHomeView());
