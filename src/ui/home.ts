/**
 * Home — `#/`. The task box IS the page (ux-spec §2.1, owner ruling).
 *
 * Everything on this screen exists to get one sentence typed and started:
 * the display heading, the box (focused on arrival), a current/last-task card
 * under the box, three examples that fill it, the Recent column, and — only
 * when something is genuinely in the way — one calm blocker card above the
 * box. The box never stops accepting text, and nothing here is ever a modal.
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
import { publishLicenceBadge } from "./licence.ts";
import { refreshSession, PAIR_AGAIN, type SessionInfo } from "./session.ts";
import { attention, modelbotNative, type AttentionItem } from "./native.ts";
import { attentionBanner, countdownText } from "./needs-you.ts";
import { IS_APPLE } from "./palette.ts";
import { navigate, registerView, setAttention, setStatusPill, setTitle } from "./shell.ts";
import { markTaskStarted } from "./task.ts";
import { stepText, type TaskRow, type TaskStep } from "./task-view.ts";
import { isActiveTakeover, type TakeoverRow } from "./takeover.ts";
import type { Connection, Provider } from "./connection.ts";

/* -------------------------------------------------------------------------
 * Copy and constants — ux-spec §2.1 / §2.2, design-brief §5.
 * ---------------------------------------------------------------------- */

const HEADING_LINES = ["What should your bot", "get done?"] as const;

export const EXAMPLES = [
  "Organise an authorised inbox. Propose labels and filters first; wait for my approval before changing mail.",
  "Collect invoices from approved billing portals. Save a ledger and wait for me to sign in.",
  "Review staging logs for a recent failure. Record the error and matching log lines; change nothing.",
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
    ? "Open BotHearth from your Applications folder again. Your draft is saved."
    : `${PAIR_AGAIN} Your draft is still here.`;
}

export const EMPTY_RECENT =
  "No tasks yet. Try a public page you can check yourself.";

const PLACEHOLDER = "Describe it the way you’d say it to a person";
const RUNTIME_STARTING_COPY = "BotHearth is still starting its runtime. Trying again…";
const START_PROBE_WAIT_MS = 15_000;

function runtimeStartingError(error: unknown): { retryAfterMs: number } | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { error?: unknown; status?: unknown; retry_after_ms?: unknown } | null;
  if (!body || (body.status !== "starting" && body.error !== "E_RUNTIME_STARTING")) return null;
  const wait = typeof body.retry_after_ms === "number" && Number.isFinite(body.retry_after_ms)
    ? Math.max(0, Math.min(START_PROBE_WAIT_MS, body.retry_after_ms))
    : START_PROBE_WAIT_MS;
  return { retryAfterMs: wait };
}

const DRAFT_KEY = "modelbot.draft";
const REVEALED_KEY = "modelbot.revealed";
const RECENT_SHOWN = 4;
const NEW_COMPUTER = "__new__";
const COMPUTER_STATE_WORD: Record<string, string> = {
  idle: "Ready",
  running: "Working",
  paused: "Paused",
  "human-hold": "Waiting for you",
  stopped: "Off",
};

type ComputerChoice = {
  id: string;
  name: string;
  state: string;
};

function computerOccupied(state: string): boolean {
  return state === "running" || state === "paused" || state === "human-hold";
}

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

const TERMINAL_STATUS = new Set(["completed", "cancelled", "failed"]);

/** First line of the prompt, the same title the task screen uses. */
export function taskTitle(goal: string): string {
  const line = goal.trim().split("\n", 1)[0]!.trim();
  return line || "Untitled task";
}

/** Newest-first list → the live task if any, else the most recent one. */
export function featuredTask(
  tasks: TaskRow[],
): { task: TaskRow; label: "Current task" | "Last task" } | null {
  if (!tasks.length) return null;
  const current = tasks.find((task) => !TERMINAL_STATUS.has(task.status));
  return current
    ? { task: current, label: "Current task" }
    : { task: tasks[0]!, label: "Last task" };
}

/** Running/paused and waiting on a person — awaiting a message or a hold. */
export function taskNeedsYou(
  task: Pick<TaskRow, "status" | "awaiting_message">,
  controlState?: string,
): boolean {
  if (task.status !== "running" && task.status !== "paused") return false;
  return task.awaiting_message === true
    || controlState === "takeover_requested"
    || controlState === "human"
    || controlState === "paused";
}

/** First ~80 characters of the goal, the banner title. */
export function needsYouTitle(goal: string): string {
  const line = taskTitle(goal);
  if (line.length <= 80) return line;
  const clipped = line.slice(0, 80).replace(/\s+\S*$/, "");
  return `${clipped || line.slice(0, 80)}…`;
}

/** Wall-clock wait, always "waiting for N min". */
export function waitingForLabel(since: string, now: number = Date.now()): string {
  const then = new Date(since).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(1, Math.round((now - then) / 60_000));
  return `waiting for ${minutes} min`;
}

function clipExcerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 180) return trimmed;
  return `${trimmed.slice(0, 180).trimEnd()}…`;
}

function lastAssistant(steps: TaskStep[]): { text: string; at: string } | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.kind !== "assistant") continue;
    const text = stepText(step);
    if (!text) continue;
    return { text: clipExcerpt(text), at: step.created_at };
  }
  return null;
}

export function recentStatus(
  status: string,
  controlState?: string,
  awaitingMessage = false,
): { word: string; tone: StatusTone } {
  if (!["completed", "cancelled", "failed"].includes(status)) {
    if (awaitingMessage) return { word: "Waiting for you", tone: "warn" };
    if (controlState === "human") return { word: "Human control", tone: "warn" };
    if (controlState === "paused") return { word: "Control paused", tone: "warn" };
    if (controlState === "resume_validating") return { word: "Returning control", tone: "run" };
    if (controlState === "takeover_requested") return { word: "Waiting for you", tone: "warn" };
  }
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
  intent?: "settings" | "licence" | "prepare" | "disclose";
  provider?: Provider;
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
  text: "Checking automatically…",
  tone: "run" as StatusTone,
};
const WATCH_TRUST = {
  text: "Sign in through your model provider.",
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
      body: "Setup stopped partway. Try again to continue.",
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

  if (blocker?.id === "licence_required") return {
    key: blocker.id, glyph: "alert", heading: blocker.title, body: blocker.detail,
    actions: [{ label: "Add licence key", kind: "primary", intent: "licence" }], watch: WATCH_CHECKING,
  };

  if (blocker?.id === "ai_not_connected") return aiCard(status, blocker);

  if (blocker?.id.startsWith("selected_provider_")) return {
    key: `${blocker.id}:${status.ai.provider}`, glyph: "key", heading: blocker.title, body: blocker.detail,
    actions: [{ label: blocker.id === "selected_provider_signed_out" ? "Sign in"
      : blocker.id === "selected_provider_signing_in" ? "Finish sign-in" : "Model connection",
      kind: "primary", intent: "settings", ...(status.ai.provider ? { provider: status.ai.provider } : {}) }],
    watch: WATCH_CHECKING,
  };

  if (blocker?.id === "node_version" && !modelbotNative.isNative) {
    return {
      key: "node_version",
      glyph: "alert",
      heading: blocker.title,
      body:
        `BotHearth needs a newer Node than ${thisMachine()} has (${status.node.version}). Install the ` +
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
      heading: "Install Docker to continue",
      body: `Docker runs the bot’s separate browser on ${thisMachine()}.`,
      actions: [
        { label: "Install OrbStack", kind: "primary", href: blocker.action.url ?? ORBSTACK_URL },
        { label: "Use Docker Desktop", kind: "secondary", href: DOCKER_DESKTOP_URL },
        { label: "Why is this needed?", kind: "ghost", intent: "disclose" },
      ],
      watch: WATCH_CHECKING,
      detail: {
        label: "Why is this needed?",
        text: "Docker runs the bot’s browser separately from your everyday browser. Files and accounts you give the bot remain available to it.",
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
      body: `Open ${engine} and leave it running.`,
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
        text: `Open ${engine} from your Applications folder.`,
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
      body: "Setup can take several minutes. You can write your task now.",
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
        : blocker.action.kind === "open_settings" ? [{ label: "Open Settings", kind: "primary", intent: "settings" }] : [],
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
    // Signed in and still blocked means BotHearth has not been pointed at it
    // yet. Asking for a sign-in that already happened reads as a bug.
    if (status.ai.logged_in) {
      return {
        key: "ai_not_connected",
        glyph: "key",
        heading: `Connect ${app}`,
        body:
          `${app} is signed in. Connect it in Settings to start.`,
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
      body: "Sign in through your browser to reconnect.",
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
    body: "Connect Codex or Claude Code. Your provider’s eligibility, limits and charges apply.",
    actions: [
      { label: "Use Codex", kind: "primary", intent: "settings" },
      { label: "Use Claude", kind: "secondary", intent: "settings" },
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
  /** `true` renders the ⌘/Ctrl ⏎ key caps rather than a sentence. */
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
    if (input.blockerKey === "licence_required") return {
      label: "Start task", disabled: true, primary: true, keys: false,
      hint: "Add your licence key to start", cancel: false,
    };
    if (input.blockerKey?.startsWith("selected_provider_")) return {
      label: "Start task", disabled: true, primary: true, keys: false,
      hint: input.blockerKey.startsWith("selected_provider_signed_out") ? "Sign in above to start"
        : input.blockerKey.startsWith("selected_provider_signing_in") ? "Finish signing in to start"
        : input.blockerKey.startsWith("selected_provider_held") ? "Can’t check while you have control"
        : "Check Model connection to start", cancel: false,
    };
    const aiBlocked =
      input.blockerKey === "ai_not_connected" || input.blockerKey === "ai_signed_out";
    return aiBlocked
      ? {
          label: "Start task",
          disabled: true,
          primary: true,
          keys: false,
          hint: "Connect a model above to start",
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

type ModelSelection = { adapter: Provider | "standalone"; model: string };
// Matches the native task API, including provider-qualified IDs.
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+\[\]-]{0,511}$/;
type ModelCatalog = { providers: Array<{
  id: Provider; label: string; default_model: string;
  connected?: boolean; start_available?: boolean;
  connection_status?: Connection["status"]; limit?: Connection["limit"];
  models: Array<{ id: string; label: string }>;
}> };

/** Native selects cover the usual choice; a custom ID needs one deliberate selection. */
function modelFields(id: string, onChange: () => void) {
  const root = element("fieldset", "home-model-fields");
  root.disabled = true;
  root.append(element("legend", "sr-only", id === "home" ? "Task model" : "Subagent model"));
  const providerLabel = element("label", "home-model-field", "Provider");
  const provider = document.createElement("select");
  provider.id = `${id}-provider`;
  for (const [value, name] of [["codex", "Codex"], ["claude", "Claude"]]) {
    const option = element("option", undefined, name);
    option.value = value!;
    provider.append(option);
  }
  provider.value = "codex";
  providerLabel.append(provider);
  const modelLabel = element("label", "home-model-field", "Model");
  const model = document.createElement("select");
  model.id = `${id}-model`;
  modelLabel.append(model);
  const customLabel = element("label", "home-model-field home-model-custom", "Custom model ID");
  const custom = document.createElement("input");
  custom.id = `${id}-custom-model`;
  custom.type = "text";
  custom.maxLength = 512;
  custom.autocomplete = "off";
  custom.spellcheck = false;
  custom.placeholder = "Exact model ID";
  customLabel.append(custom);
  root.append(providerLabel, modelLabel, customLabel);
  let catalog: ModelCatalog | null = null;
  let configuredModel = "";
  let configuredOption: HTMLOptionElement | null = null;
  const value = (): ModelSelection => ({ adapter: provider.value as ModelSelection["adapter"],
    model: model.value === "__custom__" ? custom.value.trim() : model.value });
  const fill = (selected: string, keepCustom = false) => {
    const configured = provider.value === "standalone";
    model.disabled = configured;
    const entry = catalog?.providers.find((p) => p.id === provider.value);
    const choices = new Map((entry?.models ?? []).map((m) => [m.id, m.label]));
    if (selected && !choices.has(selected)) choices.set(selected, selected);
    model.replaceChildren();
    for (const key of choices.keys()) {
      const option = element("option", undefined, key);
      option.value = key;
      model.append(option);
    }
    const other = element("option", undefined, "Custom model…");
    other.value = "__custom__";
    if (!configured) model.append(other);
    if (configured && !selected) {
      const unknown = element("option", undefined, "Model not reported");
      unknown.value = "";
      model.append(unknown);
    }
    model.value = configured ? selected : keepCustom || !selected ? "__custom__" : selected;
    custom.value = selected;
    customLabel.hidden = configured || (!catalog && !selected) || model.value !== "__custom__";
  };
  provider.addEventListener("change", () => {
    fill(provider.value === "standalone" ? configuredModel : catalog?.providers.find((p) => p.id === provider.value)?.default_model ?? "");
    onChange();
  });
  model.addEventListener("change", () => {
    customLabel.hidden = model.value !== "__custom__";
    if (!customLabel.hidden) custom.focus();
    onChange();
  });
  custom.addEventListener("input", onChange);
  fill("");
  return { root, value,
    set(selection: ModelSelection) { provider.value = selection.adapter; fill(selection.model); },
    setConfigured(modelId: string | null) {
      if (modelId === null) {
        configuredOption?.remove();
        configuredOption = null;
        return;
      }
      configuredModel = modelId;
      if (!configuredOption) {
        configuredOption = element("option", undefined, "Configured model");
        configuredOption.value = "standalone";
        provider.append(configuredOption);
      }
      provider.value = "standalone";
      fill(modelId);
    },
    setCatalog(next: ModelCatalog) {
      const previous = value();
      const keepCustom = model.value === "__custom__" && Boolean(previous.model);
      catalog = next;
      fill(previous.model || next.providers.find((p) => p.id === previous.adapter)?.default_model || "", keepCustom);
      root.disabled = false;
    },
  };
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
  private killSlot: HTMLElement | null = null;
  private needsSlot: HTMLElement | null = null;
  private nowSlot: HTMLElement | null = null;
  private recentSlot: HTMLElement | null = null;
  private leadModel: ReturnType<typeof modelFields> | null = null;
  private executorModel: ReturnType<typeof modelFields> | null = null;
  private orchestrator: HTMLInputElement | null = null;
  private executorOptions: HTMLDetailsElement | null = null;
  private executorSummary: HTMLElement | null = null;
  private modelHint: HTMLElement | null = null;
  private modelRetry: HTMLButtonElement | null = null;
  private modelCatalog: ModelCatalog | null = null;
  private modelsBlocked = true;
  private configuredCurrent = false;
  private leadEdited = false;
  private executorEdited = false;
  private reasoning: HTMLSelectElement | null = null;
  private reasoningLabel: HTMLLabelElement | null = null;
  private computerPicker: HTMLLabelElement | null = null;
  private computerSelect: HTMLSelectElement | null = null;
  private computerNote: HTMLElement | null = null;
  private computers: ComputerChoice[] | null = null;
  private defaultComputerId: string | null = null;
  private maxComputers = 2;
  private selectedComputerId = "";
  private createdComputerId = "";
  private creatingComputer: Promise<string> | null = null;
  private modelsRevision = 0;

  private watcher: RuntimeWatcher | null = null;
  private status: RuntimeStatus | null = null;
  private session: SessionInfo | null = null;
  private tasks: TaskRow[] | null = null;
  private takeovers: TakeoverRow[] | null = null;
  private holdBanner = false;
  private recentRevision = 0;
  private waitingTick: number | undefined;
  private needsExcerpt: string | undefined;
  private needsSince: string | undefined;
  private ownedNeedsYouAttention = false;

  private renderedCardKey: string | null = null;
  private renderedComposer = "";
  private announced = "";
  private armed = false;
  private submitting = false;
  private startRetryTimer: number | undefined;
  private startRetryWait: (() => void) | undefined;
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
    // Remounts (task → Home) must not keep the page-load `kill_switch`.
    void refreshSession()
      .then((session) => {
        if (!this.root) return;
        this.session = session;
        this.renderKillSwitch();
        if (!this.leadEdited && (session?.execution_mode === "codex" || session?.execution_mode === "claude")) {
          const selection = { adapter: session.execution_mode, model: session.model ?? "" };
          this.leadModel?.set(selection);
          this.executorModel?.set(selection);
        } else if (!this.leadEdited && session?.execution_mode === "standalone") {
          this.leadModel?.setConfigured(session.model ?? "");
        }
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
      this.refreshReadiness();
      void this.loadRecent();
    });
    this.on(document, "visibilitychange", () => {
      if (!document.hidden) this.refreshReadiness();
    });
    this.on(window, "bothearth:licence-changed", () => this.refreshReadiness());
    this.on(window, "hashchange", () => {
      if (location.hash === "#/" || location.hash === "") {
        this.refreshReadiness();
        void refreshSession().then((session) => {
          if (!this.root) return;
          this.session = session;
          this.renderKillSwitch();
        });
      }
    });
    this.on(window, "keydown", (event) => this.onGlobalKey(event as KeyboardEvent));

    // A Recent row that is counting down has to actually count. The tick runs
    // only while something is waiting, and stops the moment nothing is.
    this.disposers.push(attention.subscribe(() => {
      this.paintWaiting();
      void this.loadRecent();
    }));
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
    this.recentRevision += 1;
    this.modelsRevision += 1;
    this.watcher?.stop();
    this.watcher = null;
    if (this.waitingTick !== undefined) window.clearInterval(this.waitingTick);
    this.waitingTick = undefined;
    if (this.startRetryTimer !== undefined) window.clearTimeout(this.startRetryTimer);
    this.startRetryTimer = undefined;
    const resume = this.startRetryWait;
    this.startRetryWait = undefined;
    resume?.();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.releaseNeedsYouAttention();
    this.root = null;
    this.box = null;
    this.killSlot = null;
    this.needsSlot = null;
    this.nowSlot = null;
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

    this.killSlot = element("div", "home-kill-slot");
    this.killSlot.style.setProperty("--i", "1");

    this.needsSlot = element("div", "home-needs-slot");
    this.needsSlot.style.setProperty("--i", "2");

    this.blockerSlot = element("div", "home-blocker-slot");
    this.blockerSlot.style.setProperty("--i", "3");

    const box = this.buildTaskBox();
    box.style.setProperty("--i", "4");

    this.nowSlot = element("div", "home-now-slot");
    this.nowSlot.style.setProperty("--i", "5");

    const examples = this.buildExamples();
    examples.style.setProperty("--i", "6");

    main.append(heading, this.killSlot, this.needsSlot, this.blockerSlot, box, this.nowSlot, examples);

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
      // ux-spec §2.1: ⌘⏎ (Ctrl⏎ off Apple) starts. Return on its own is a
      // newline — a task is often more than one sentence, and nothing here
      // should fire by accident.
      if (event.key === "Enter" && (event.metaKey || (!IS_APPLE() && event.ctrlKey))) {
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

    wrap.append(label, box, this.buildRunOptions(), foot, this.message);
    this.paintComposer();
    return wrap;
  }

  private buildRunOptions(): HTMLElement {
    const wrap = element("div", "task-run-options");
    this.leadModel = modelFields("home", () => {
      this.leadEdited = true;
      const selection = this.leadModel!.value();
      if (selection.adapter === "standalone") {
        if (this.orchestrator) this.orchestrator.checked = false;
        this.configuredCurrent = false;
        void this.loadModels();
      }
      if (!this.executorEdited && selection.adapter !== "standalone") this.executorModel?.set(selection);
      this.paintRunOptions();
    });
    const label = element("label", "home-orchestrator");
    this.orchestrator = document.createElement("input");
    this.orchestrator.type = "checkbox";
    this.orchestrator.id = "home-orchestrator";
    this.orchestrator.checked = false;
    this.orchestrator.disabled = true;
    this.orchestrator.setAttribute("aria-controls", "home-executor-options");
    label.append(this.orchestrator, element("span", undefined, "Use subagents"));
    this.executorOptions = document.createElement("details");
    this.executorOptions.id = "home-executor-options";
    this.executorOptions.className = "home-executor-options";
    this.executorOptions.hidden = true;
    this.executorSummary = element("summary", undefined, "Subagent model");
    this.executorModel = modelFields("executor", () => { this.executorEdited = true; this.paintRunOptions(); });
    this.executorOptions.append(this.executorSummary, this.executorModel.root);
    this.orchestrator.addEventListener("change", () => this.paintRunOptions());
    this.modelHint = element("p", "home-model-hint", "Loading model choices…");
    this.modelHint.setAttribute("role", "status");
    this.modelRetry = element("button", "btn ghost sm home-model-retry", "Retry model choices");
    this.modelRetry.type = "button";
    this.modelRetry.hidden = true;
    this.modelRetry.addEventListener("click", () => void this.loadModels());
    this.reasoningLabel = document.createElement("label");
    this.reasoningLabel.textContent = "Reasoning ";
    this.reasoning = document.createElement("select");
    this.reasoning.id = "home-reasoning";
    this.reasoning.setAttribute("aria-label", "Reasoning effort");
    for (const value of ["low", "medium", "high"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value[0]!.toUpperCase() + value.slice(1);
      this.reasoning.append(option);
    }
    this.reasoning.value = "medium";
    this.reasoningLabel.append(this.reasoning);
    this.computerPicker = element("label", "home-model-field home-computer-picker");
    this.computerPicker.textContent = "Computer";
    this.computerPicker.hidden = true;
    this.computerSelect = document.createElement("select");
    this.computerSelect.id = "home-computer";
    this.computerSelect.setAttribute("aria-label", "Computer");
    this.computerSelect.addEventListener("change", () => void this.onComputerPicked());
    this.computerPicker.append(this.computerSelect);
    this.computerNote = element("p", "home-model-hint home-computer-note");
    this.computerNote.hidden = true;
    wrap.append(this.leadModel.root, this.reasoningLabel, label, this.executorOptions, this.modelHint, this.modelRetry, this.computerPicker, this.computerNote);
    return wrap;
  }

  private paintRunOptions(): void {
    const enabled = Boolean(this.modelCatalog);
    const configured = this.leadModel?.value().adapter === "standalone";
    const on = enabled && !configured && this.orchestrator?.checked === true;
    if (this.orchestrator) {
      this.orchestrator.disabled = configured || !enabled || this.modelsBlocked || this.submitting;
    }
    if (this.leadModel) this.leadModel.root.disabled = !enabled || this.modelsBlocked || this.submitting;
    if (this.reasoningLabel) this.reasoningLabel.hidden = this.leadModel?.value().adapter !== "codex";
    if (this.reasoning) this.reasoning.disabled = !enabled || this.modelsBlocked || this.submitting;
    if (this.computerSelect) this.computerSelect.disabled = this.submitting;
    if (this.executorModel) this.executorModel.root.disabled = !enabled || this.modelsBlocked || this.submitting;
    if (this.executorOptions) this.executorOptions.hidden = !on;
    const executor = this.executorModel?.value();
    if (executor && this.executorSummary) {
      this.executorSummary.textContent = `Subagent model · ${executor.adapter === "codex" ? "Codex" : "Claude"} · ${executor.model || "Choose a model"}`;
    }
    if (this.status) this.renderBlocker(blockerCard(this.effectiveStatus()));
    this.publishPill();
    this.paintComposer();
    if (this.modelCatalog && !this.modelsBlocked && isSettling(this.effectiveStatus())) this.watcher?.start();
    if (this.armed && !this.modelsBlocked && !this.submitting) {
      this.armed = false;
      void this.start();
    }
  }

  private pickerNeeded(): boolean {
    return (this.computers ?? []).length >= 1;
  }

  private paintComputerPicker(): void {
    const picker = this.computerPicker;
    const select = this.computerSelect;
    const note = this.computerNote;
    if (!picker || !select || !note) return;
    const computers = this.computers ?? [];
    const needed = this.pickerNeeded();
    picker.hidden = !needed;
    if (!needed) {
      this.selectedComputerId = "";
      this.paintComputerNote();
      return;
    }
    const atCap = computers.length >= this.maxComputers;
    const previous = this.selectedComputerId;
    const allowed = new Set<string>();
    select.replaceChildren();
    for (const computer of computers) {
      const option = document.createElement("option");
      option.value = computer.id;
      option.textContent = `${computer.name} · ${COMPUTER_STATE_WORD[computer.state] ?? computer.state}`;
      option.disabled = computerOccupied(computer.state);
      if (!option.disabled) allowed.add(computer.id);
      select.append(option);
    }
    if (!atCap) {
      const fresh = document.createElement("option");
      fresh.value = NEW_COMPUTER;
      fresh.textContent = "New computer";
      select.append(fresh);
      allowed.add(NEW_COMPUTER);
    }
    const free = computers.find((computer) => !computerOccupied(computer.state));
    if (previous && allowed.has(previous)) select.value = previous;
    else if (free) select.value = free.id;
    else if (this.defaultComputerId) select.value = this.defaultComputerId;
    else if (computers[0]) select.value = computers[0].id;
    this.selectedComputerId = select.value;
    this.paintComputerNote();
  }

  private paintComputerNote(): void {
    const note = this.computerNote;
    if (!note) return;
    if (this.computers === null) {
      note.hidden = true;
      note.replaceChildren();
      return;
    }
    const atCap = this.computers.length >= this.maxComputers;
    const choseNew = this.selectedComputerId === NEW_COMPUTER || this.selectedComputerId === this.createdComputerId;
    note.replaceChildren();
    if (this.pickerNeeded() && choseNew) {
      note.append(
        document.createTextNode("A new computer must sign in to the model provider first ("),
      );
      const link = element("a", "taskbox-message-link", "Settings → Model connection");
      link.setAttribute("href", "#/settings/ai");
      note.append(link, document.createTextNode(")."));
      note.hidden = false;
      return;
    }
    if (this.pickerNeeded() && atCap && !this.computers.some((computer) => !computerOccupied(computer.state))) {
      note.textContent = `You already have ${this.maxComputers} computers, the maximum.`;
      note.hidden = false;
      return;
    }
    note.textContent = "This computer keeps its logins.";
    note.hidden = false;
  }

  private applyComputerInventory(body: {
    computers?: ComputerChoice[];
    default_computer_id?: string | null;
    max_computers?: number;
  }): void {
    this.computers = Array.isArray(body.computers) ? body.computers : [];
    this.defaultComputerId = typeof body.default_computer_id === "string" ? body.default_computer_id : null;
    if (typeof body.max_computers === "number" && Number.isFinite(body.max_computers) && body.max_computers >= 1) {
      this.maxComputers = body.max_computers;
    }
    this.paintComputerPicker();
  }

  private async onComputerPicked(): Promise<void> {
    const value = this.computerSelect?.value ?? "";
    this.selectedComputerId = value;
    this.paintComputerNote();
    if (value !== NEW_COMPUTER) return;
    try { await this.createComputer(); }
    catch (error) { this.showStartError(error); }
  }

  private createComputer(): Promise<string> {
    if (this.selectedComputerId && this.selectedComputerId !== NEW_COMPUTER) {
      return Promise.resolve(this.selectedComputerId);
    }
    this.creatingComputer ??= this.provisionComputer().finally(() => { this.creatingComputer = null; });
    return this.creatingComputer;
  }

  private async provisionComputer(): Promise<string> {
    const suffix = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12)
      ?? Math.random().toString(16).slice(2, 10);
    const created = await apiPost("/api/v1/computers", {
      name: `browser-${suffix}`,
      capabilities: ["browser"],
      persistent: true,
    }) as { computer: { id: string; name: string } };
    const id = created.computer.id;
    this.createdComputerId = id;
    this.selectedComputerId = id;
    try { await apiPost(`/api/v1/computers/${encodeURIComponent(id)}/default`); }
    catch { /* Selection still stands; Model connection uses the default when it can. */ }
    this.defaultComputerId = id;
    if (!this.computers?.some((computer) => computer.id === id)) {
      this.computers = [...this.computers ?? [], { id, name: created.computer.name, state: "idle" }];
    }
    this.paintComputerPicker();
    return id;
  }

  private async loadModels(): Promise<void> {
    const revision = ++this.modelsRevision;
    const configured = this.leadModel?.value().adapter === "standalone";
    if (configured) this.configuredCurrent = false;
    this.modelsBlocked = true;
    if (this.modelRetry) this.modelRetry.disabled = true;
    this.paintComposer();
    try {
      const [models, session] = await Promise.allSettled([
        apiGet("/api/v1/models"), configured ? apiGet("/api/v1/session") : Promise.resolve(null),
      ]);
      if (!this.root || revision !== this.modelsRevision) return;
      if (configured && this.leadModel?.value().adapter === "standalone") {
        if (session.status === "rejected") throw session.reason;
        const current = session.value as SessionInfo;
        this.session = current;
        this.renderKillSwitch();
        if (current.execution_mode === "codex" || current.execution_mode === "claude") {
          this.leadModel.setConfigured(null);
          const selection = { adapter: current.execution_mode, model: current.model ?? "" };
          this.leadModel.set(selection);
          if (!this.executorEdited) this.executorModel?.set(selection);
        } else if (current.execution_mode === "standalone") {
          this.leadModel.setConfigured(current.model ?? "");
          this.configuredCurrent = true;
        } else throw new Error("configured model not reported");
      }
      if (models.status === "rejected") throw models.reason;
      const catalog = models.value as ModelCatalog;
      if (!Array.isArray(catalog.providers)) throw new Error("missing model catalog");
      const providers = catalog.providers.filter((p) => p && ["codex", "claude"].includes(p.id) && Array.isArray(p.models));
      if (!providers.length) throw new Error("missing model providers");
      await Promise.allSettled(providers.map(async (provider) => {
        if (typeof provider.start_available === "boolean" && (provider.start_available || provider.connection_status)) return;
        const state = await apiGet(`/api/v1/connection?provider=${provider.id}`) as Connection;
        provider.connection_status = state.status;
        provider.limit = state.limit ?? null;
        provider.connected = ["connected", "signed_in"].includes(state.status);
        provider.start_available = provider.connected && !state.limit;
      }));
      if (!this.root || revision !== this.modelsRevision) return;
      this.modelCatalog = { providers };
      this.modelsBlocked = false;
      this.leadModel?.setCatalog(this.modelCatalog);
      this.executorModel?.setCatalog(this.modelCatalog);
      if (this.modelHint) this.modelHint.textContent = "Your provider checks model access when the task starts.";
      if (this.modelRetry) this.modelRetry.hidden = true;
      this.paintRunOptions();
    } catch (error) {
      if (!this.root || revision !== this.modelsRevision) return;
      const legacy = error instanceof ApiError && error.status === 404 && !this.modelCatalog;
      this.modelsBlocked = false;
      if (this.modelHint) this.modelHint.textContent = legacy
        ? `This app instance uses the connected model${this.session?.model ? ` (${this.session.model})` : ""}. Per-task model choices need an app update.`
        : this.leadModel?.value().adapter === "standalone" && !this.configuredCurrent
        ? "Couldn’t check the configured model. You can still start with the last known model."
        : this.leadModel?.value().adapter === "standalone"
        ? "Couldn’t check other models. The configured model is still selected."
        : this.modelCatalog
        ? "Couldn’t load model choices. You can still start with the last known model."
        : "Couldn’t load model choices. You can still start with the default model.";
      if (this.modelRetry) this.modelRetry.hidden = false;
      this.paintRunOptions();
    } finally {
      if (this.root && revision === this.modelsRevision && this.modelRetry) this.modelRetry.disabled = false;
    }
  }

  private effectiveStatus(): RuntimeStatus | null {
    const status = this.status;
    const selected = this.leadModel?.value();
    if (!status || !this.modelCatalog || selected?.adapter === "standalone") return status;
    const provider = this.modelCatalog.providers.find((p) => p.id === selected?.adapter);
    const executor = this.orchestrator?.checked
      ? this.modelCatalog.providers.find((p) => p.id === this.executorModel?.value().adapter) : null;
    const available = provider?.start_available === true && (!this.orchestrator?.checked || executor?.start_available === true);
    const blockers = status.blockers.filter((b) => !["ai_not_connected", "ai_limit_reached"].includes(b.id));
    const blocked = provider?.start_available ? executor : provider;
    if (!available) {
      const name = blocked?.label ?? "the selected provider";
      const state = blocked?.connection_status;
      blockers.push({ id: state === "signed_out" ? "selected_provider_signed_out"
        : state === "signing_in" ? "selected_provider_signing_in"
        : state === "unknown" ? "selected_provider_held" : "selected_provider_unavailable",
        title: state === "signed_out" ? `Sign in to ${name}`
          : state === "signing_in" ? `Finish signing in to ${name}`
          : state === "unknown" ? "Can’t check while you have control"
          : blocked?.limit ? `${name} limit reached` : `Check the ${name} connection`,
        detail: state === "signed_out" || state === "signing_in"
          ? `Your ${blocked === executor ? "executor " : ""}model is selected. Complete ${name} sign-in in Model connection to start.`
          : state === "unknown" ? "Waiting for you to return control. The connection is checked again when you do."
          : blocked?.limit ? `${name} is signed in but has reached a provider limit. Check Model connection for details.`
          : "Your model selection is kept. Open Model connection to check setup, sign-in and provider access.",
        action: { kind: "open_settings" } });
    }
    const connection = available ? provider : blocked;
    return { ...status, task_start_available: available, blockers,
      ai: { ...status.ai, provider: connection?.id ?? null,
        cli_found: connection?.connected === true || ["signed_out", "signing_in", "unknown"].includes(connection?.connection_status ?? ""),
        logged_in: connection?.connected ?? null, limit: connection?.limit ?? null } };
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
    let draft = this.box.value.trim();
    const prior = EXAMPLES.find(example => draft.endsWith(example));
    if (prior) draft = draft.slice(0, -prior.length).trimEnd();
    this.box.value = draft ? `${draft}\n\n${text}` : text;
    writeDraft(this.box.value);
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
    if (this.modelChoicesBlocked()) return false;
    const status = this.effectiveStatus();
    if (!status?.task_start_available) return false;
    return !isSettling(status);
  }

  private modelChoicesBlocked(): boolean {
    return this.modelsBlocked;
  }

  private paintComposer(): void {
    const state = composerState({
      ready: this.ready(),
      blockerKey: this.renderedCardKey,
      hasText: Boolean(this.box?.value.trim()),
      armed: this.armed,
      submitting: this.submitting,
    });
    if (this.modelChoicesBlocked() && !this.submitting) {
      if (this.armed) {
        state.hint = "Queued — it starts the moment model choices are ready.";
      } else {
        state.label = "Start task";
        state.hint = "Loading model choices…";
        state.disabled = true;
        state.keys = false;
        state.primary = false;
      }
    }
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
        element("kbd", undefined, IS_APPLE() ? "⌘" : "Ctrl"),
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
    if (this.modelChoicesBlocked()) {
      this.armed = true;
      this.announce("Queued. It starts the moment model choices are ready.");
      this.paintComposer();
      return;
    }
    const selected = this.modelCatalog ? this.leadModel?.value() : null;
    const selection = selected?.adapter === "standalone" ? null : selected;
    const orchestrator = this.orchestrator?.checked === true && Boolean(selection);
    const executor = orchestrator ? this.executorModel?.value() : null;
    if (selection && (!MODEL_ID.test(selection.model) || (executor && !MODEL_ID.test(executor.model)))) {
      if (this.message) this.message.textContent = "Enter an exact model ID for each selected provider.";
      return;
    }
    if (!this.ready()) {
      if (this.effectiveStatus()?.blockers.some((blocker) => blocker.id === "licence_required")) {
        this.armed = false;
        navigate("#/settings/licence");
        this.paintComposer();
        return;
      }
      const status = this.effectiveStatus();
      if (status?.blockers.some((blocker) => blocker.id.startsWith("selected_provider_"))) {
        this.armed = false;
        navigate(`#/settings/ai${status.ai.provider ? `?pick=${status.ai.provider}` : ""}`);
        this.paintComposer();
        return;
      }
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
    this.paintRunOptions();

    try {
      let computerId = this.computerPicker?.hidden ? "" : this.computerSelect?.value ?? "";
      if (computerId === NEW_COMPUTER) computerId = await this.createComputer();
      const body = { goal, capabilities: ["browser"], ...(computerId ? { computer_id: computerId } : {}), ...(selection ? {
        ...selection, execution_mode: orchestrator ? "orchestrator" : "executor", ...(executor ? { executor } : {}),
        ...(selection.adapter === "codex" && this.reasoning?.value !== "medium" ? { reasoning_effort: this.reasoning?.value } : {}),
      } : {}) };
      let retried = false;
      for (;;) {
        try {
          const response = (await apiPost("/api/v1/tasks", body)) as { task: TaskRow };
          writeDraft("");
          if (this.box) this.box.value = "";
          this.submitting = false;
          this.paintRunOptions();
          // The one screen change in the app that is a handoff rather than a jump
          // (tokens.css §6, moment 1).
          markTaskStarted(response.task.id);
          navigate(`#/tasks/${response.task.id}`);
          return;
        } catch (error) {
          const starting = !retried ? runtimeStartingError(error) : null;
          if (!starting) throw error;
          retried = true;
          if (this.message) this.message.textContent = RUNTIME_STARTING_COPY;
          await new Promise<void>((resolve) => {
            this.startRetryWait = resolve;
            this.startRetryTimer = window.setTimeout(() => {
              this.startRetryTimer = undefined;
              this.startRetryWait = undefined;
              resolve();
            }, starting.retryAfterMs);
          });
          if (!this.root) {
            this.submitting = false;
            return;
          }
        }
      }
    } catch (error) {
      this.submitting = false;
      this.paintRunOptions();
      this.showStartError(error);
    }
  }

  private showStartError(error: unknown): void {
    const target = this.message;
    if (!target) return;
    target.replaceChildren();

    if (error instanceof ApiError) {
      const body = error.body as {
        task_id?: unknown; takeover_id?: unknown; task_status?: unknown; computers?: unknown; max_computers?: unknown;
      } | null;
      if (Array.isArray(body?.computers)) {
        this.applyComputerInventory({
          computers: body.computers.filter((row): row is ComputerChoice =>
            Boolean(row) && typeof row === "object" && typeof (row as ComputerChoice).id === "string"
              && typeof (row as ComputerChoice).name === "string" && typeof (row as ComputerChoice).state === "string"),
          default_computer_id: this.defaultComputerId,
          max_computers: typeof body.max_computers === "number" ? body.max_computers : this.maxComputers,
        });
      }
      const taskId = typeof body?.task_id === "string" ? body.task_id : "";
      const takeoverId = typeof body?.takeover_id === "string" ? body.takeover_id : "";
      const taskStatus = typeof body?.task_status === "string" ? body.task_status : "";
      this.paintHoldMessage(error.message, taskId, takeoverId, taskStatus);
      return;
    }
    target.textContent =
      "Your task didn’t start. Check that BotHearth is running, then try again. Your draft is saved.";
  }

  private paintHoldMessage(message: string, taskId: string, takeoverId: string, taskStatus: string): void {
    const target = this.message;
    if (!target) return;
    target.replaceChildren();
    target.appendChild(document.createTextNode(message));
    if (!taskId && !takeoverId) return;
    const actions = element("span", "taskbox-message-actions");
    if (taskId) {
      const link = element("a", "taskbox-message-link", "Open it");
      link.setAttribute("href", `#/tasks/${taskId}`);
      actions.append(link);
    }
    const live = !taskStatus || taskStatus === "paused" || taskStatus === "running";
    if (taskId && takeoverId && live) {
      const resume = element("button", "btn ghost sm", "Resume it");
      resume.type = "button";
      resume.addEventListener("click", () => void this.recoverHeldTask(taskId, "resume"));
      const stop = element("button", "btn ghost sm", "Stop it");
      stop.type = "button";
      stop.addEventListener("click", () => void this.recoverHeldTask(taskId, "stop"));
      actions.append(resume, stop);
    }
    if (takeoverId) {
      const give = element("button", "btn ghost sm", "Return control");
      give.type = "button";
      give.addEventListener("click", () => void this.recoverHeldTask(taskId, "return", takeoverId));
      actions.append(give);
    }
    target.append(document.createTextNode(" "), actions);
    this.holdBanner = true;
  }

  private paintHoldBanner(): void {
    if (this.submitting) return;
    const defaultId = this.defaultComputerId;
    const hold = this.takeovers?.find((row) =>
      (row.state === "human" || row.state === "paused") &&
      (!defaultId || row.computer_id === defaultId),
    );
    if (!hold) {
      if (this.holdBanner && this.message) this.message.textContent = "";
      this.holdBanner = false;
      return;
    }
    const task = hold.task_id ? this.tasks?.find((row) => row.id === hold.task_id) : undefined;
    const goal = task?.goal?.trim();
    const named = goal ? `“${goal.length > 120 ? `${goal.slice(0, 117)}…` : goal}”` : "A task";
    this.paintHoldMessage(
      `${named} still holds this computer.`,
      hold.task_id ?? task?.id ?? "",
      hold.id,
      task?.status ?? "",
    );
  }

  private async recoverHeldTask(taskId: string, action: "resume" | "stop" | "return", takeoverId?: string): Promise<void> {
    try {
      if (action === "resume") await apiPost(`/api/v1/tasks/${encodeURIComponent(taskId)}/resume`);
      else if (action === "stop") await apiPost(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`);
      else if (takeoverId) await apiPost(`/api/v1/takeover/${encodeURIComponent(takeoverId)}/release`);
      if (this.message) this.message.textContent = "";
      if (taskId) navigate(`#/tasks/${taskId}`);
    } catch (error) {
      this.showStartError(error);
    }
  }

  /* ---------------- readiness ---------------- */

  private startWatching(): void {
    this.watcher = createRuntimeWatcher({
      load: async () => {
        const [status] = await Promise.all([
          apiGet("/api/v1/runtime") as Promise<RuntimeStatus>, this.loadModels(),
        ]);
        if (!this.root) return status;
        this.status = status;
        // Keep checking a selected provider even when the global default is ready.
        return this.effectiveStatus() ?? status;
      },
      onStatus: (status) => this.onStatus(status),
      onError: (error) => this.onStatusError(error),
      ...(this.options.activeMs === undefined ? {} : { activeMs: this.options.activeMs }),
      ...(this.options.hiddenMs === undefined ? {} : { hiddenMs: this.options.hiddenMs }),
    });
    this.watcher.start();
  }

  private refreshReadiness(): void {
    this.watcher?.start();
    this.watcher?.refresh();
  }

  private onStatus(status: RuntimeStatus): void {
    if (status.licence) publishLicenceBadge(status.licence);
    this.failures = 0;
    if (this.offline) {
      this.offline = false;
      this.clearOffline();
    }
    this.publishPill();
    this.renderBlocker(blockerCard(this.effectiveStatus()));
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

    if (this.armed && !this.modelsBlocked && !this.submitting) {
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
    const selected = this.modelCatalog ? this.leadModel?.value() : null;
    const provider = this.modelCatalog?.providers.find((p) => p.id === selected?.adapter);
    publishStatusPill({
      status: provider ? { task_start_available: provider.start_available === true,
        ai: { provider: provider.id, limit: provider.limit ?? null } } : this.status,
      model: selected?.model ?? this.session?.model ?? null,
      executionMode: selected?.adapter ?? this.session?.execution_mode ?? null,
      connectionStatus: provider?.connection_status,
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
    if (action.intent === "licence") {
      button.addEventListener("click", () => navigate("#/settings/licence"));
      return button;
    }
    if (action.intent === "settings") {
      const pick =
        action.provider ? `?pick=${action.provider}` : action.label === "Use Codex"
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
      element("h2", undefined, expired ? "BotHearth needs to reconnect." : "BotHearth stopped unexpectedly."),
      element(
        "p",
        undefined,
        expired ? reconnectHelp() : "Try again. Your draft is saved.",
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
    this.announce("BotHearth stopped unexpectedly. Your draft is saved.");
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
      "BotHearth diagnostics",
      `when: ${new Date().toISOString()}`,
      `page: ${location.pathname}${location.hash}`,
      `readiness: ${message}${status}`,
      `browser: ${navigator.userAgent}`,
      `last known: ${this.status ? JSON.stringify({ docker: this.status.docker, ai: { provider: this.status.ai.provider, cli_found: this.status.ai.cli_found } }) : "none"}`,
    ].join("\n");
  }

  /* ---------------- Recent ---------------- */

  private async loadRecent(): Promise<void> {
    const revision = ++this.recentRevision;
    try {
      const [tasks, takeovers, inventory] = await Promise.allSettled([
        apiGet("/api/v1/tasks") as Promise<{ tasks: TaskRow[] }>,
        apiGet("/api/v1/takeovers") as Promise<{ takeovers: TakeoverRow[] }>,
        apiGet("/api/v1/computers") as Promise<{
          computers?: ComputerChoice[]; default_computer_id?: string | null; max_computers?: number;
        }>,
      ]);
      if (!this.root || revision !== this.recentRevision) return;
      if (tasks.status === "rejected") throw tasks.reason;
      this.takeovers = takeovers.status === "fulfilled" ? takeovers.value.takeovers ?? [] : null;
      this.defaultComputerId = inventory.status === "fulfilled"
        && typeof inventory.value.default_computer_id === "string"
        ? inventory.value.default_computer_id
        : null;
      this.tasks = [...tasks.value.tasks].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      if (inventory.status === "fulfilled") this.applyComputerInventory(inventory.value);
      await this.refreshNeedsYouExcerpt(revision);
      if (!this.root || revision !== this.recentRevision) return;
      this.renderRecent();
      this.paintHoldBanner();
    } catch {
      if (!this.root || revision !== this.recentRevision || this.tasks) return;
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
      this.renderFeatured();
      return;
    }

    const list = element("ul", "recent-list");
    for (const task of tasks.slice(0, RECENT_SHOWN)) {
      const item = document.createElement("li");
      item.appendChild(this.taskLink(task, "recent-row"));
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
    this.renderFeatured();
  }

  private controlState(task: TaskRow): string | undefined {
    if (TERMINAL_STATUS.has(task.status)) return undefined;
    return this.takeovers?.find((row) =>
      row.computer_id === task.computer_id &&
      (!row.task_id || row.task_id === task.id) && isActiveTakeover(row.state),
    )?.state;
  }

  private currentNeedsYou(): TaskRow | null {
    if (!this.tasks) return null;
    const featured = featuredTask(this.tasks);
    if (featured?.label === "Current task" && taskNeedsYou(featured.task, this.controlState(featured.task))) {
      return featured.task;
    }
    return this.tasks.find((task) => taskNeedsYou(task, this.controlState(task))) ?? null;
  }

  private async refreshNeedsYouExcerpt(revision: number): Promise<void> {
    const task = this.currentNeedsYou();
    this.needsExcerpt = typeof task?.last_assistant === "string" && task.last_assistant.trim()
      ? clipExcerpt(task.last_assistant)
      : undefined;
    this.needsSince = undefined;
    if (!task?.awaiting_message || this.needsExcerpt) return;
    try {
      const detail = await apiGet(`/api/v1/tasks/${encodeURIComponent(task.id)}`) as {
        steps?: TaskStep[];
      };
      if (!this.root || revision !== this.recentRevision) return;
      const found = lastAssistant(detail.steps ?? []);
      if (found) {
        this.needsExcerpt = found.text;
        this.needsSince = found.at;
      }
    } catch {
      // Banner still renders from the list; excerpt is optional.
    }
  }

  private renderKillSwitch(): void {
    const slot = this.killSlot;
    if (!slot) return;
    if ((this.session as { kill_switch?: unknown } | null)?.kill_switch !== true) {
      slot.replaceChildren();
      return;
    }
    const banner = element("section", "blocker home-kill-switch");
    banner.setAttribute("role", "alert");
    banner.style.background = "var(--color-danger-wash)";
    banner.style.borderColor = "var(--color-danger)";
    const line = element("p");
    line.append("The kill switch is on, so the bot will refuse every action. Turn it off in ");
    const link = element("a");
    link.setAttribute("href", "#/settings/sensitive");
    link.textContent = "Settings → Sensitive actions";
    line.append(link, ".");
    banner.append(line);
    slot.replaceChildren(banner);
  }

  private renderNeedsYou(): void {
    const slot = this.needsSlot;
    if (!slot) return;
    const task = this.currentNeedsYou();
    if (!task) {
      slot.replaceChildren();
      this.releaseNeedsYouAttention();
      return;
    }
    const banner = element("section", "blocker blocker-offline home-needs-you");
    banner.setAttribute("role", "status");
    banner.append(element("h2", undefined, "Needs you"));
    banner.append(element("p", undefined, needsYouTitle(task.goal)));
    if (this.needsExcerpt) banner.append(element("p", undefined, this.needsExcerpt));
    const wait = waitingForLabel(this.needsSince ?? task.started_at ?? task.created_at);
    if (wait) banner.append(element("p", undefined, wait));
    const actions = element("div", "blocker-actions");
    const open = element("a", "btn primary", "Open the task");
    open.setAttribute("href", `#/tasks/${task.id}`);
    actions.append(open);
    banner.append(actions);
    slot.replaceChildren(banner);
    this.claimNeedsYouAttention(task);
  }

  private claimNeedsYouAttention(task: TaskRow): void {
    if (attention.pending().length > 0) return;
    const wait = waitingForLabel(this.needsSince ?? task.started_at ?? task.created_at);
    setAttention({
      count: 1,
      text: "Needs you",
      route: `#/tasks/${task.id}`,
      ...(wait ? { sub: wait } : {}),
    });
    this.ownedNeedsYouAttention = true;
  }

  private releaseNeedsYouAttention(): void {
    if (!this.ownedNeedsYouAttention) return;
    this.ownedNeedsYouAttention = false;
    const pending = attention.pending();
    setAttention(pending.length ? attentionBanner(pending) : null);
  }

  private renderFeatured(): void {
    const slot = this.nowSlot;
    if (!slot) return;
    this.renderNeedsYou();
    const featured = this.tasks ? featuredTask(this.tasks) : null;
    if (!featured) {
      slot.replaceChildren();
      return;
    }
    const waiting = featured.label === "Current task"
      && taskNeedsYou(featured.task, this.controlState(featured.task));
    const link = this.taskLink(featured.task, "home-now", waiting);
    link.prepend(element("span", "caps", featured.label));
    slot.replaceChildren(link);
  }

  private taskLink(task: TaskRow, className: string, forceWaiting = false): HTMLAnchorElement {
    const terminal = TERMINAL_STATUS.has(task.status);
    const control = terminal ? undefined : this.takeovers?.find((row) =>
      row.computer_id === task.computer_id &&
      (!row.task_id || row.task_id === task.id) && isActiveTakeover(row.state),
    );
    const deadline = terminal || (control && control.state !== "takeover_requested")
      ? undefined : waitingByTask(attention.pending()).get(task.id);
    let { word, tone } = recentStatus(task.status, control?.state, task.awaiting_message === true);
    if (forceWaiting || deadline !== undefined) {
      word = "Waiting for you";
      tone = "warn";
    } else if (this.takeovers === null && task.status === "running") {
      word = "Active";
    }
    const when = deadline === undefined
      ? relativeTime(task.created_at)
      : countdownText(deadline - Date.now());

    const link = element("a", className);
    link.setAttribute("href", `#/tasks/${task.id}`);
    const title = element("span", "recent-title", taskTitle(task.goal));
    const meta = element("span", "recent-meta");
    meta.append(
      element("span", tone === "neutral" ? "dot" : `dot ${tone}`),
      document.createTextNode(when ? `${word} · ${when}` : word),
    );
    link.append(title, meta);
    return link;
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
