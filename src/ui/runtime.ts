/**
 * Readiness client — `GET /api/v1/runtime` and `POST /api/v1/runtime/prepare`.
 *
 * The daemon owns the ladder (reports/wp-d1.md); this module owns three things
 * the UI needs on top of it:
 *
 *   1. Types for the payload, so a view never reads an untyped bag.
 *   2. `primaryBlocker` — ux-spec §2.2 shows ONE card at a time and orders it
 *      "Model connection -> container runtime", which is not the order the daemon
 *      emits (it leads with the longest download). The precedence lives here so
 *      home and any later surface agree on which card is showing.
 *   3. `createRuntimeWatcher` — a poller that only runs when something is
 *      actually moving: every 2s while a blocker exists or a build is running,
 *      not at all once the machine is ready, and slowly while the window is
 *      hidden. Home never has to think about timers.
 *
 * Nothing here touches the DOM, so all of it is unit-testable in node.
 */

import { apiGet, apiPost, ApiError } from "./api.ts";
import type { ConnectionStatus } from "./connection.ts";
import type { LicenceInfo } from "./session.ts";

export type ImageName = "computer" | "shell" | "proxy";
export type PrepareStateName = "idle" | "running" | "done" | "failed";
export type DockerEngine = "docker-desktop" | "orbstack" | "colima" | "unknown";
export type BlockerActionKind =
  | "open_url"
  | "open_settings"
  | "prepare_images"
  | "retry";

export interface PrepareState {
  state: PrepareStateName;
  step: string;
  percent: number | null;
  log_tail: string[];
  error: string | null;
}

export interface ImageStatus {
  present: boolean;
  created_at: string | null;
  stale: boolean;
}

export interface RuntimeBlocker {
  id: string;
  title: string;
  detail: string;
  action: { kind: BlockerActionKind; url?: string };
}

/**
 * The daemon's `ProviderLimit` (src/daemon/provider-limit.ts) as it reaches the
 * browser: a CLI that is signed in and still refusing. `logged_in` stays true —
 * the sign-in is fine, the plan is not — so this is the only field that says so.
 */
export interface ProviderLimit {
  reason: "quota_exhausted" | "rate_limited";
  /** ISO, or null when the provider named no reset. */
  resets_at: string | null;
}

/** `Sep 11, 5:21 PM`, matching the daemon's own blocker copy. */
export function limitTime(resetsAt: string | null | undefined): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface RuntimeStatus {
  node: { ok: boolean; version: string };
  docker: {
    installed: boolean;
    running: boolean;
    engine: DockerEngine;
    version: string;
  };
  images: Record<ImageName, ImageStatus> & { prepare: PrepareState };
  ai: {
    provider: "claude" | "codex" | null;
    cli_found: boolean;
    cli_path_kind: "path" | "well-known" | null;
    logged_in: boolean | null;
    detail: string;
    limit?: ProviderLimit | null;
  };
  task_start_available: boolean;
  blockers: RuntimeBlocker[];
  licence?: LicenceInfo;
}

/* -------------------------------------------------------------------------
 * Which card is on screen
 * ---------------------------------------------------------------------- */

/**
 * ux-spec §2.2: "One card, at most one at a time. Precedence: Model connection ->
 * container runtime -> nothing." An unusable Node runtime comes first because
 * nothing else can be fixed until it is, and it is the one blocker whose fix
 * lives outside the app entirely. Ids the daemon may add later fall to the end
 * in the order it sent them, so a new blocker still shows rather than vanishing.
 */
const BLOCKER_PRECEDENCE: readonly string[] = [
  "node_version",
  "licence_required",
  "ai_not_connected",
  "docker_missing",
  "docker_not_running",
  "images_missing",
];

export function primaryBlocker(status: RuntimeStatus | null): RuntimeBlocker | null {
  if (!status?.blockers?.length) return null;
  const rank = (blocker: RuntimeBlocker) => {
    const index = BLOCKER_PRECEDENCE.indexOf(blocker.id);
    return index === -1 ? BLOCKER_PRECEDENCE.length : index;
  };
  return [...status.blockers].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** A build in flight is a state, not a blocker — the daemon suppresses the id. */
export function isPreparing(status: RuntimeStatus | null): boolean {
  return status?.images?.prepare?.state === "running";
}

/** True while anything is still moving, i.e. while it is worth polling. */
export function isSettling(status: RuntimeStatus | null): boolean {
  if (!status) return true;
  return status.blockers.length > 0 || isPreparing(status);
}

/**
 * Images are missing and nothing is asking the person for anything, so the
 * download can start on its own (ux-spec §1 step 3: "images prepared if
 * absent"). A failed run is NOT restarted automatically — that would loop.
 */
export function shouldAutoPrepare(status: RuntimeStatus | null): boolean {
  if (!status) return false;
  if (status.images.prepare.state !== "idle") return false;
  return status.blockers.some((blocker) => blocker.action.kind === "prepare_images");
}

/* -------------------------------------------------------------------------
 * Naming the AI, without hard-coding a model
 * ---------------------------------------------------------------------- */

function providerName(provider: string | null | undefined): string | null {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return null;
}

/** Longest model name the titlebar pill can carry before it crowds the frame. */
const MODEL_NAME_MAX = 24;

/**
 * Turn whatever model id the API reports into something a person reads, without
 * knowing any model in advance: drop the vendor prefix and the build date, fold
 * a run of version numbers into one dotted number, and title-case the rest.
 * `claude-opus-4-5-20250929` -> `Opus 4.5`; `gpt-5.6-sol` -> `GPT-5.6 Sol`.
 * Returns null when there is nothing honest to show, and the caller falls back
 * to the provider on its own.
 */
export function formatModelName(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const tokens = trimmed
    .replace(/[-_](\d{8})$/, "") // trailing build date
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (!tokens.length) return null;

  const vendors = new Set(["claude", "anthropic", "openai", "models", "model"]);
  while (tokens.length > 1 && vendors.has(tokens[0]!.toLowerCase())) tokens.shift();

  const words: string[] = [];
  for (const token of tokens) {
    const numeric = /^\d+(\.\d+)*$/.test(token);
    if (numeric && words.length) {
      const previous = words[words.length - 1]!;
      if (/^\d+(\.\d+)*$/.test(previous)) {
        // A second bare number continues the version: 4 then 5 -> 4.5.
        words[words.length - 1] = `${previous}.${token}`;
        continue;
      }
      words.push(token);
      continue;
    }
    // An abbreviation (no vowels, short) reads better shouted: gpt -> GPT.
    words.push(
      token.length <= 4 && !/[aeiouy]/i.test(token)
        ? token.toUpperCase()
        : token.charAt(0).toUpperCase() + token.slice(1),
    );
  }

  // Re-attach each version to the word before it, hyphenated after an
  // abbreviation ("GPT-5.6") and spaced after a name ("Opus 4.5").
  const parts: string[] = [];
  for (const word of words) {
    const previous = parts[parts.length - 1];
    if (previous && /^\d+(\.\d+)*$/.test(word) && !/^\d/.test(previous)) {
      parts[parts.length - 1] = /^[A-Z0-9.]+$/.test(previous)
        ? `${previous}-${word}`
        : `${previous} ${word}`;
      continue;
    }
    parts.push(word);
  }

  const name = parts.join(" ");
  return name.length > MODEL_NAME_MAX ? null : name;
}

export interface AiIdentity {
  /** Titlebar text, e.g. `Claude · Opus 4.5`. */
  text: string;
  /** Muted tail. Omitted when we cannot honestly claim a subscription. */
  sub?: string;
  tone: "ok" | "warn";
  /** Full accessible name — the sub is hidden below 620px. */
  label: string;
}

/**
 * ux-spec §2.1: the chip answers "which model is this, and what will it cost
 * me" on screen one. Provider comes from the readiness probe, the model from
 * the session; when either is missing we say less rather than guess.
 */
export interface AiReadiness {
  task_start_available: boolean;
  ai: { provider: "claude" | "codex" | null; limit?: ProviderLimit | null };
}

export function aiIdentity(input: {
  /** The readiness probe when there is one; the session alone is enough. */
  status: AiReadiness | null;
  model?: string | null;
  executionMode?: "standalone" | "codex" | "claude" | null;
  connectionStatus?: ConnectionStatus;
}): AiIdentity {
  const ready = input.status?.task_start_available ?? false;
  if (!ready && !input.model?.trim()) {
    return {
      text: "No model connected",
      tone: "warn",
      label: "No model connected. Open the Model connection settings.",
    };
  }

  // `executionMode` is the same field Settings publishes the instant a
  // connection changes (connection.ts `publishConnection`); the readiness
  // probe's own `status.ai.provider` is a separate, polled detection that can
  // still name the AI just switched away from until its next tick catches up.
  // The fresher of the two wins, and the probe is only the fallback for a
  // caller (a page just loading) that has not read the session yet.
  const provider =
    providerName(input.executionMode) ?? providerName(input.status?.ai.provider);
  const model = formatModelName(input.model);
  const onPlan = provider !== null; // A signed-in CLI runs on the person’s own plan.

  const text = provider
    ? model
      ? `${provider} · ${model}`
      : provider
    : (model ?? "Your own model");

  // Signed in and refusing. The chip is the one thing on every screen, so it
  // says so rather than reading "on your plan" while every task dies in six
  // seconds.
  const limit = input.status?.ai.limit ?? null;
  if (limit) {
    const until = limitTime(limit.resets_at);
    const said =
      limit.reason === "quota_exhausted"
        ? `plan limit reached${until ? ` until ${until}` : ""}`
        : `turning tasks down${until ? ` until ${until}` : ""}`;
    return {
      text,
      sub: `· ${said}`,
      tone: "warn",
      label: `Model connection: ${text} — ${said}. Open the Model connection settings.`,
    };
  }

  if (!ready) {
    const state = input.connectionStatus === "signed_out" ? "sign-in required"
      : input.connectionStatus === "signing_in" ? "finish sign-in"
      : input.connectionStatus === "missing" ? "setup needed"
      : input.connectionStatus === "error" ? "connection check failed"
      : input.status ? "check connection" : "checking connection";
    return {
      text, sub: `· ${state}`, tone: "warn",
      label: `Selected model: ${input.model!.trim()}${provider ? ` (${provider})` : ""}. ${state}. Open the Model connection settings.`,
    };
  }

  const sub = onPlan ? "· on your plan" : undefined;

  // The label keeps the detail the pill had to drop.
  const full = [provider, formatModelName(input.model) ?? input.model?.trim()]
    .filter(Boolean)
    .join(" · ");
  return {
    text,
    ...(sub ? { sub } : {}),
    tone: "ok",
    label: `Model connection: ${full || text}${onPlan ? ", billed on your own plan" : ""}`,
  };
}

/* -------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------- */

async function fetchRuntime(): Promise<RuntimeStatus> {
  return (await apiGet("/api/v1/runtime")) as RuntimeStatus;
}

/** 409 means a build is already running, which is a success for the caller. */
export async function startPrepare(): Promise<PrepareState | null> {
  try {
    const body = (await apiPost("/api/v1/runtime/prepare")) as { prepare: PrepareState };
    return body.prepare ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return null;
    throw error;
  }
}

/* -------------------------------------------------------------------------
 * Watcher
 * ---------------------------------------------------------------------- */

const POLL_ACTIVE_MS = 2000;
const POLL_HIDDEN_MS = 30_000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;

export interface RuntimeWatcher {
  /** Fetch once, then keep polling for as long as anything is settling. */
  start(): void;
  /** Fetch now, whatever the schedule says. Safe to call at any time. */
  refresh(): void;
  stop(): void;
  snapshot(): RuntimeStatus | null;
}

export interface RuntimeWatcherOptions {
  onStatus(status: RuntimeStatus): void;
  onError?(error: unknown): void;
  /** Injected in tests; defaults to the real endpoint. */
  load?: () => Promise<RuntimeStatus>;
  /** Injected in tests; defaults to `document.hidden`. */
  hidden?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  activeMs?: number;
  hiddenMs?: number;
}

export function createRuntimeWatcher(options: RuntimeWatcherOptions): RuntimeWatcher {
  const load = options.load ?? fetchRuntime;
  const hidden = options.hidden ?? (() => Boolean(globalThis.document?.hidden));
  const setTimer =
    options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle));
  const activeMs = options.activeMs ?? POLL_ACTIVE_MS;
  const hiddenMs = options.hiddenMs ?? POLL_HIDDEN_MS;

  let timer: number | undefined;
  let running = false;
  let inFlight = false;
  let generation = 0;
  let last: RuntimeStatus | null = null;
  // A dead endpoint is retried no faster than the normal cadence, then slower.
  let backoff = Math.max(activeMs, 0) || RETRY_MIN_MS;

  function cancelTimer(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  function schedule(ms: number): void {
    cancelTimer();
    if (!running) return;
    timer = setTimer(() => {
      timer = undefined;
      void poll();
    }, ms);
  }

  async function poll(): Promise<void> {
    if (!running || inFlight) return;
    inFlight = true;
    const attempt = ++generation;
    try {
      const status = await load();
      if (!running || attempt !== generation) return;
      last = status;
      backoff = Math.max(activeMs, 0) || RETRY_MIN_MS;
      options.onStatus(status);
      // Ready and still: stop entirely, so `start()` works again. Home
      // re-checks on focus. Cancelling the timer while leaving `running` true
      // would leave nothing but `refresh()` able to wake the watcher.
      if (isSettling(status)) schedule(hidden() ? hiddenMs : activeMs);
      else {
        cancelTimer();
        running = false;
      }
    } catch (error) {
      if (!running || attempt !== generation) return;
      options.onError?.(error);
      schedule(hidden() ? hiddenMs : backoff);
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    } finally {
      if (attempt === generation) inFlight = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      void poll();
    },
    refresh() {
      if (!running) return;
      cancelTimer();
      void poll();
    },
    stop() {
      running = false;
      generation += 1;
      inFlight = false;
      cancelTimer();
    },
    snapshot: () => last,
  };
}
