/**
 * Task view — `#/tasks/:id` (ux-spec §2.3–2.6, §3, §6, §7).
 *
 * One screen, five states, no modal: Working, Waiting for you, You’re driving,
 * Done, Stopped.
 *
 * Two sources feed one model. `GET /api/v1/tasks/:id` gives the durable
 * activity a reload must not lose; `WS /api/v1/events` gives what is happening
 * right now, including the tool arguments the durable projection deliberately
 * drops. Both go through `feedLine()`, so a step reads identically whether it
 * arrived live or was replayed.
 *
 * Nothing internal is ever rendered: no tool ids, no gate names, no control
 * epoch, no container id, no raw JSON outside the approval’s explicit
 * "show me" disclosure. Every string that comes from a tool, a website or the
 * model is written with `textContent` — this module never touches `innerHTML`.
 */

import { apiFetch, ApiError, apiGet, apiPost, humanApiError } from "./api.ts";
import { appendTextChild } from "./safe.ts";
import { currentDeviceId, currentSession, type SessionInfo } from "./session.ts";
import { navigate, registerView, setTitle, toast, type Tone } from "./shell.ts";
import { bindCommand } from "./palette.ts";
import { limitTime } from "./runtime.ts";
import { formatUsd, readBudgetPreference } from "./usage.ts";
import {
  decideApproval,
  renderApproval,
  type ApprovalSurface,
  type PendingApproval,
} from "./approval.ts";
import {
  acquiredControl,
  CONTROL_TAKEN,
  declineControl,
  isActiveTakeover,
  isDriver,
  releaseControl,
  rememberAcquired,
  renderDriving,
  renderNeedsYou,
  renderObserving,
  requestControl,
  STILL_SENSITIVE,
  TAKE_FAILED,
  takeoverReason,
  type TakeoverRow,
} from "./takeover.ts";
import { LivePanel, shortUrl } from "./live/panel.ts";
import { modelbotNative } from "./native.ts";
import { checkMark, icon } from "./live/icons.ts";
import type { UiEvent } from "../types/contracts.ts";

export type TaskRecord = {
  id: string;
  computer_id: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at?: string;
  max_steps?: number;
  /** Which AI ran it. Only newer records carry it. */
  adapter?: string | null;
  /* The daemon has grown these over time and not every record carries every
     one. `taskSpan` reads whichever exist and never trusts a single field. */
  started_at?: string | null;
  finished_at?: string | null;
  completed_at?: string | null;
  ended_at?: string | null;
  /** Decided once by the store; the UI must not recompute it. */
  duration_ms?: number | null;
  /**
   * What this run has spent and what it is allowed to spend. `spend_usd` is a
   * live estimate on a running task and the total on a finished one; both are
   * absent on older daemons, and the view falls back to what it counted itself.
   */
  spend_usd?: number | null;
  spend_cap_usd?: number | null;
  /** Tool calls made and allowed, when the budget is counted in calls. */
  calls?: number | null;
  calls_cap?: number | null;
  /** The daemon's verdict on why it stopped, when the record carries one. */
  failure_kind?: string | null;
  /** The receipt, frozen at the first terminal read. Null while running. */
  summary?: TaskReceipt | null;
  /**
   * Where this run's output landed on THIS Mac, when the daemon knows. Present
   * only on newer records. The Mac shell reveals a saved file in Finder when it
   * is set, and downloads the file through the app's own session when it is not
   * — either way the app is never navigated to the file.
   */
  results_dir?: string | null;
};

/**
 * The daemon's frozen receipt (`GET /api/v1/tasks/:id`.task.summary). It is
 * computed once from the whole audit log and checked against the disk, so it
 * does not shrink on a refetch the way a count derived from a truncated feed
 * does — which is why it outranks anything this file can count for itself.
 */
export type TaskReceipt = {
  steps: number;
  sites: string[];
  asks: number;
  files_saved: string[];
  cost_usd: number | null;
};

export type DurableStep = {
  kind: string;
  body: Record<string, unknown>;
  created_at: string;
  result_id?: number;
};

export type TaskDetail = {
  task: TaskRecord;
  steps: DurableStep[];
  truncated?: boolean;
  history_truncated?: boolean;
};

export type StatusView = { word: string; tone: Tone };

/**
 * The five status words a person ever sees (§2.1). Never a raw status, never
 * "pending_approval", never a word the product does not otherwise use.
 */
export function statusWord(
  status: string,
  flags: { needsYou?: boolean; driving?: boolean; observing?: boolean } = {},
): StatusView {
  if (flags.driving) return { word: "You’re driving", tone: "run" };
  if (status === "completed") return { word: "Done", tone: "ok" };
  if (status === "failed") return { word: "Couldn’t finish", tone: "danger" };
  if (status === "cancelled") return { word: "Stopped", tone: "neutral" };
  // A question this window can answer outranks who is holding the keyboard.
  if (flags.needsYou) return { word: "Waiting for you", tone: "warn" };
  if (flags.observing) return { word: "Someone else has control", tone: "warn" };
  if (status === "paused") return { word: "Waiting for you", tone: "warn" };
  return { word: "Working", tone: "run" };
}

export function isFinished(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // "3:32 PM", not "03:32 PM": a leading zero on a 12-hour clock is noise.
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export type Spend = {
  /** Dollars this run is known to have spent. */
  usd: number;
  capUsd: number | null;
  /** Tool calls it has made, and how many it is allowed. */
  calls: number;
  callsCap: number | null;
};

/**
 * What the budget meter says, and what its bar is a fraction of.
 *
 * Dollars while the run is priced; tool calls while it is not. A proxy-metered
 * run reports no dollar figure at all, and "$0.00 of $2.00" beside a task that
 * is spending its way to a hard stop is the lie that hid a whole failure — so
 * the moment there is a call to count, the count is what is shown.
 */
export function budgetMeter(spend: Spend): {
  /** The compact figure, for the status bar and the running facts. */
  used: string;
  /** The same figure written out, for the receipt. */
  long: string;
  /** What the bar is a fraction of, for its label. */
  of: string;
  ratio: number | null;
} {
  const cap = spend.capUsd !== null && Number.isFinite(spend.capUsd) ? spend.capUsd : null;
  if (spend.usd > 0 || spend.calls === 0) {
    const amount = formatUsd(spend.usd);
    if (cap === null) return { used: amount, long: amount, of: "", ratio: null };
    return {
      used: `${amount} of ${formatUsd(cap)}`,
      long: `${amount} of your ${formatUsd(cap)} budget`,
      of: `your ${formatUsd(cap)} budget`,
      ratio: cap > 0 ? Math.min(1, spend.usd / cap) : null,
    };
  }
  const callsCap =
    spend.callsCap !== null && Number.isFinite(spend.callsCap) ? spend.callsCap : null;
  const calls = `${spend.calls} tool call${spend.calls === 1 ? "" : "s"}`;
  if (callsCap === null) return { used: calls, long: calls, of: "", ratio: null };
  return {
    used: `${spend.calls} of ${callsCap} tool calls`,
    long: `${spend.calls} of the ${callsCap} tool calls it was allowed`,
    of: `its ${callsCap} tool calls`,
    ratio: callsCap > 0 ? Math.min(1, spend.calls / callsCap) : null,
  };
}

export function elapsedText(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function elapsedPrecise(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * How long the task actually ran. `updated_at` alone is not enough: it is not
 * always written when a task ends, and it defaults to `created_at`. The span is
 * taken from the record AND its own events, and the events win when they
 * disagree — a step recorded at 1:01 is proof the task had not finished at
 * 12:58. Nothing here reads the clock, so every render gives the same answer.
 */

export type TaskSpan = { from: string; to: string; ms: number };

function parse(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function taskSpan(
  task: TaskRecord,
  steps: DurableStep[] = [],
  stoppedAt: string | null = null,
): TaskSpan | null {
  // A run that stopped at a known moment ends there. A paused run carries no
  // finish time on its record, so without this its clock runs on to whatever
  // happens to be stamped last — the reload, which is how a run that worked
  // 34 seconds and then waited nine minutes reported nine minutes.
  const stop = parse(stoppedAt);
  // The store decides the duration once (`finished − started`). Reconstructing
  // it here from `created_at` would make the screen and the database disagree
  // by the seconds between "created" and "actually started", so a stamped
  // duration wins outright; the reconstruction below is for older rows.
  const stamped = task.duration_ms;
  const stampedFrom = parse(task.started_at) ?? parse(task.created_at);
  const stampedTo = parse(task.finished_at);
  if (stop === null && typeof stamped === "number" && Number.isFinite(stamped) && stamped >= 0
      && stampedFrom !== null && stampedTo !== null) {
    return {
      from: new Date(stampedFrom).toISOString(),
      to: new Date(stampedTo).toISOString(),
      ms: stamped,
    };
  }

  const stepTimes = steps.map((s) => parse(s.created_at)).filter((v): v is number => v !== null);

  const startCandidates = [parse(task.started_at), parse(task.created_at)].filter(
    (v): v is number => v !== null,
  );
  if (stepTimes.length) startCandidates.push(Math.min(...stepTimes));
  if (!startCandidates.length) return null;
  const from = Math.min(...startCandidates);

  if (stop !== null) {
    return stop < from
      ? null
      : { from: new Date(from).toISOString(), to: new Date(stop).toISOString(), ms: stop - from };
  }

  const endCandidates = [
    parse(task.finished_at),
    parse(task.completed_at),
    parse(task.ended_at),
    parse(task.updated_at),
  ].filter((v): v is number => v !== null);
  if (stepTimes.length) endCandidates.push(Math.max(...stepTimes));
  if (!endCandidates.length) return null;
  const to = Math.max(...endCandidates);

  if (to < from) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), ms: to - from };
}

/**
 * The heading's phrase, or null when the record cannot support one.
 *
 * A task that recorded events cannot have taken no time, so a sub-second span
 * there means the timestamps are missing, not that the work was instant — and
 * "Done in 0 seconds" is a worse answer than saying nothing. With no events at
 * all, "less than a second" is the honest reading.
 */
export function spanDurationText(span: TaskSpan | null, eventCount: number): string | null {
  if (!span) return null;
  if (span.ms < 1000) return eventCount > 0 ? null : "less than a second";
  return elapsedText(span.from, span.to) || null;
}

/** The receipt's exact figure, or null on the same reasoning. */
export function spanPreciseText(span: TaskSpan | null, eventCount: number): string | null {
  if (!span) return null;
  if (span.ms < 1000) return eventCount > 0 ? null : "Less than a second";
  return elapsedPrecise(span.from, span.to) || null;
}

/**
 * Terminal outcomes. Done, Stopped and Couldn't-finish each have their own
 * heading, lede, bar label and actions: one shared receipt would put "Finished
 * 15:36" over a run that did not finish.
 */

const SHOW_GOAL = "Show full task";

/** Longest goal heading the column carries before it starts eating the view. */
export const GOAL_HEAD_MAX = 120;

/**
 * A goal is whatever a person typed — one line or three thousand characters.
 * The heading gets the first line, capped, and the rest waits behind
 * "Show full task": an unclamped `h1` at 25px pushed the approval card and the
 * Take-control button out of the column entirely.
 */
export function goalHead(goal: string): { head: string; rest: string } {
  const full = goal.trim();
  const line = full.split("\n", 1)[0]!.trim();
  const head =
    line.length > GOAL_HEAD_MAX
      ? line.slice(0, GOAL_HEAD_MAX).replace(/\s+\S*$/, "")
      : line;
  return head.length === full.length ? { head, rest: "" } : { head: `${head}…`, rest: full };
}

export type TerminalKind = "done" | "stopped" | "failed" | "paused";

export function terminalKind(status: string): TerminalKind {
  if (status === "completed") return "done";
  if (status === "cancelled") return "stopped";
  if (status === "paused") return "paused";
  return "failed";
}

/**
 * Why it ended, in the words a person would use. Keyed by the daemon's own
 * `reason` (agent-loop.ts `AgentStopReason`) plus the two `server.ts` writes.
 *
 * Never a CLI command, never an error code, never "Something went wrong" on its
 * own — `clarify` bans all three, and this screen is where a $100/mo subscriber
 * is most exposed. A budget stop is not in here: it names real figures, so
 * `spendCapLede` builds it.
 */
const STOP_REASON: Record<string, string> = {
  max_steps:
    "It used every step this task was given and stopped rather than keep going on its own.",
  loop_detected:
    "It kept arriving back at the same step, so it stopped rather than go round again.",
  stall: "The page it was working on stopped responding, so it stopped rather than guess.",
  model_response:
    "The AI answered in a way it could not act on, so it stopped rather than guess.",
  runner_error: "Something on this Mac got in its way, so it stopped rather than guess.",
  cancelled: "You stopped it, and it stopped where it was.",
  max_runtime: "It reached the time limit set for it, and stopped where it was.",
  takeover: "It needed you to take over and nobody did, so it stopped and waited.",
  approval: "It asked you a question and the question timed out, so it stopped and waited.",
};

/** The plain-English cause, or null when the record does not name one. */
export function stopReasonText(reason: string | null): string | null {
  return (reason && STOP_REASON[reason]) ?? null;
}

/**
 * The daemon's machine-readable verdict on why a task stopped
 * (`src/daemon/task-outcome.ts` `failure_kind`), when the record carries one.
 * Older records do not, and `terminalCopy` falls back to `reason` for those.
 */
export type FailureKind =
  | "machine"
  | "provider_limit"
  | "waiting_for_you"
  | "spend_cap"
  | "max_steps"
  | "stalled"
  | "loop"
  | "max_runtime"
  | "model_error";

const FAILURE_KINDS = new Set<string>([
  "machine", "provider_limit", "waiting_for_you", "spend_cap",
  "max_steps", "stalled", "loop", "max_runtime", "model_error",
]);

function failureKind(terminal: Record<string, unknown> | null | undefined): FailureKind | null {
  const value = terminal?.failure_kind;
  return typeof value === "string" && FAILURE_KINDS.has(value) ? (value as FailureKind) : null;
}

/**
 * The cap that stopped this run and that a resume can be raised past. A budget
 * or a step limit is not a dead end, and the daemon ends such a run `paused` as
 * readily as `failed` — so both branches read it here rather than each guessing.
 * Records written before `failure_kind` existed say the same thing in `reason`.
 */
function limitReached(
  fk: FailureKind | null,
  reason: string | null,
): "spend_cap" | "max_steps" | null {
  if (fk === "spend_cap" || fk === "max_steps") return fk;
  return reason === "spend_cap" || reason === "max_steps" ? reason : null;
}

/**
 * `failure_kind` copy that replaces the guess `runner_error` used to make for
 * everything unrecognized. `provider_limit` and `waiting_for_you` get their own
 * sentence built with real figures (the plan's reset time, how long it waited)
 * so they are handled where that context is at hand, not here; `model_error`
 * is deliberately absent — its lede is the generic fallback, and the model's
 * own message goes in the details row instead (see `terminalError`).
 */
const FAILURE_KIND_WHY: Partial<Record<FailureKind, string>> = {
  machine: "Something on this machine got in its way, so it stopped rather than guess.",
  stalled: "The page it was working on stopped responding, so it stopped rather than guess.",
  loop: "It kept arriving back at the same step, so it stopped rather than go round again.",
  max_steps: "It reached its step limit.",
  // A clock the owner set is not this machine getting in the way: nothing here
  // went wrong, and Resume carries the run on.
  max_runtime: "It reached the time limit set for it, and stopped where it was.",
};

/**
 * "It reached its $2.00 budget after 200 tool calls." — with the figures, which
 * is the whole answer to "why did it stop?"; without them only when the record
 * carries neither.
 */
export function spendCapLede(budget: string | null, calls: number | null): string {
  const after = calls !== null && calls > 0
    ? ` after ${calls} tool call${calls === 1 ? "" : "s"}`
    : "";
  return `It reached ${budget === null ? "the budget set for this task" : `its ${budget}`}${after}.`;
}

/**
 * The budget "Resume with a higher budget" asks for: the figure set in
 * Settings when that is more than this task had, otherwise twice what it had —
 * never above the most the daemon will accept. Null when it cannot go higher,
 * which is a thing to say rather than a request to send.
 */
export function raisedCap(
  cap: number | null,
  preferred: number | null,
  max: number | null,
): number | null {
  const from = cap !== null && Number.isFinite(cap) && cap > 0 ? cap : null;
  const want = Math.max(preferred ?? 0, from === null ? 0 : from * 2);
  if (want <= 0) return null;
  const limited = max !== null && Number.isFinite(max) ? Math.min(want, max) : want;
  const rounded = Math.round(limited * 100) / 100;
  return from !== null && rounded <= from ? null : rounded;
}

export type PlanLimit = {
  reason: "quota_exhausted" | "rate_limited";
  /** The CLI whose plan ran out, or null when a direct-API run hit the wall. */
  provider: "Claude" | "Codex" | null;
  /** Already formatted for a person, or null when the provider named no reset. */
  resetAt: string | null;
};

/**
 * The daemon classified this failure as the provider refusing (see
 * src/daemon/provider-limit.ts) and put its verdict on the terminal event.
 * Nothing on this Mac caused it and nothing on this Mac fixes it, so
 * `runner_error`'s "something on this Mac got in its way" is the wrong sentence
 * and sends the person to the wrong place.
 */
export function planLimit(
  body: Record<string, unknown> | null | undefined,
  adapter?: string | null,
): PlanLimit | null {
  const provider = adapter === "codex" ? "Codex" : adapter === "claude" ? "Claude" : null;
  const reason = body?.provider_limit_reason;
  if (reason === "quota_exhausted" || reason === "rate_limited") {
    const resets = body?.provider_limit_resets_at;
    return { reason, provider, resetAt: limitTime(typeof resets === "string" ? resets : null) };
  }
  // The newer `failure_kind` contract can carry the same verdict on its own,
  // with neither of the two richer fields above. Which of the two reasons it
  // was is lost without them, and "the plan ran out" is the far more common
  // one — a wrong guess here is still less wrong than blaming this machine.
  if (body?.failure_kind === "provider_limit") {
    return { reason: "quota_exhausted", provider, resetAt: null };
  }
  return null;
}

function limitLede(limit: PlanLimit): string {
  const plan = `Your ${limit.provider ?? "AI"} plan`;
  const back = limit.resetAt ? ` It comes back at ${limit.resetAt}.` : "";
  return limit.reason === "quota_exhausted"
    ? `${plan} hit its limit, so it stopped.${back} Switch to your other AI connection, or wait it out.`
    : `${plan} turned this task down for too many requests, so it stopped.${back} Switch to your other AI connection, or start it again in a minute.`;
}

export interface TerminalCopy {
  kind: TerminalKind;
  heading: string;
  lede: string;
  /** The titlebar figure. Only a run that finished may say "Finished". */
  barVerb: string;
  againLabel: string;
  /** Stopped and Failed offer the diagnostics; Done has nothing to diagnose. */
  diagnostics: boolean;
  /** The plan ran out, so the offer is a different AI, not another attempt. */
  planLimit: PlanLimit | null;
  /** A higher cap would let it go on, so the offer is that, not another attempt. */
  limitReached: "spend_cap" | "max_steps" | null;
}

export function terminalCopy(input: {
  status: string;
  reason: string | null;
  budget: string | null;
  took: string | null;
  /** The terminal event's body, which carries the daemon's limit verdict. */
  terminal?: Record<string, unknown> | null;
  adapter?: string | null;
  /** Tool calls the run made, so a budget stop can say what it bought. */
  calls?: number | null;
}): TerminalCopy {
  const kind = terminalKind(input.status);
  const fk = failureKind(input.terminal);
  // `failure_kind` outranks the raw `reason`: it is the daemon's own
  // classification, and it exists precisely to replace the guesswork below.
  const why =
    fk === "spend_cap" || (!fk && input.reason === "spend_cap")
      ? spendCapLede(input.budget, input.calls ?? null)
      : (fk && FAILURE_KIND_WHY[fk]) ?? stopReasonText(input.reason);
  const limit = planLimit(input.terminal, input.adapter ?? null);
  if (kind === "done") {
    return {
      kind,
      heading: input.took ? `Done in ${input.took}` : "Done",
      lede: "Give it a look before you act on it.",
      barVerb: "Finished",
      againLabel: "Run again",
      diagnostics: false,
      planLimit: null,
      limitReached: null,
    };
  }
  if (kind === "paused") {
    // `waiting_for_you` names how long it waited, so the sentence uses the
    // real figure rather than the generic "part-way" line.
    const waited =
      fk === "waiting_for_you" && input.took
        ? `It waited ${input.took} for you and stopped. Resume to pick up where it left off.`
        : null;
    return {
      kind,
      heading: "It’s waiting for you",
      lede:
        waited ??
        why ??
        "It stopped part-way and is waiting for you before it goes on. Nothing it had already done is lost.",
      barVerb: "Paused",
      againLabel: "Run again",
      diagnostics: true,
      planLimit: null,
      // A budget or step cap now stops a run `paused`, not `failed`. Offering a
      // plain Resume there asks the daemon for something it refuses (409
      // E_SPEND_CAP / E_LIMIT); the offer has to carry the raise.
      limitReached: limitReached(fk, input.reason),
    };
  }
  if (kind === "stopped") {
    return {
      kind,
      heading: "You stopped it",
      lede:
        why ??
        "It stopped where it was. Anything it had already done stays done.",
      // It did not finish, so it may not say it finished.
      barVerb: "Stopped",
      againLabel: "Run again",
      diagnostics: true,
      planLimit: null,
      limitReached: null,
    };
  }
  return {
    kind,
    heading: "It couldn’t finish",
    // A plan limit outranks the daemon’s own reason: `runner_error` blames this
    // machine, and the AI subscription running out is not this machine's fault.
    lede: limit ? limitLede(limit) : (why ??
      "It ran into something it could not get past and stopped rather than guess. Nothing is half-saved on this machine."),
    barVerb: "Stopped",
    againLabel: "Run again",
    diagnostics: true,
    planLimit: limit,
    // A budget or step cap is not a dead end — raising it and resuming is the
    // honest offer, not "run the whole thing again".
    limitReached: limitReached(fk, input.reason),
  };
}

/** The last few things it actually DID, for "check what it did before you start again". */
export function lastActions(rows: FeedRow[], limit = 4): FeedRow[] {
  return rows.filter((row) => row.voice === "do").slice(-limit);
}

/** A finite number, or null — the wire is full of nulls and strings. */
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function readString(body: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function args(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.arguments;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isSaveTool(name: string): boolean {
  return name === "files_write" || name === "write_file";
}

/**
 * A `tool.result` the daemon emitted for an outcome that actually succeeded.
 * The daemon sends failures as `tool.error`, but the receipt and the feed may
 * only describe what happened, so the flag is read rather than assumed.
 */
function resultOk(body: Record<string, unknown>): boolean {
  const result = body.result;
  if (!result || typeof result !== "object") return true;
  return (result as { ok?: unknown }).ok !== false;
}

export type FeedVoice = "say" | "do" | "stumble";

export interface FeedLine {
  text: string;
  voice: FeedVoice;
  /** The model’s own prose is markdown; everything else is one plain sentence. */
  rich?: boolean;
  /**
   * Set on every line that announces a saved file: the file’s name, or `""`
   * when the event did not carry one. One save reaches this feed up to three
   * times — the result, its durable replay with the arguments stripped, and the
   * promotion — and a person who saved one file should read one line.
   * `collapseFeed` folds them together on this key.
   */
  artifact?: string;
}

/**
 * What the feed knows beyond the one event being rendered.
 *
 * `browser_snapshot` returns an aria snapshot in which every ref carries its
 * role and its accessible name, and the click and type calls that follow
 * address those refs — so indexing one gives the other its words. The yaml is
 * sanitized server-side (`redactSnapshotYaml`, secret fields masked to `***`),
 * so nothing here reaches past what the daemon already allowed. The durable
 * projection strips tool arguments, so on a reload the labels are simply absent
 * and every line falls back to its generic verb — never to a wrong one.
 */
export interface FeedContext {
  /** ref (`e12`) -> what a person would call that control (`Search flights`). */
  labels?: Map<string, string>;
  /** The page the bot was on when this event happened, if it is known. */
  currentUrl?: string | null;
}

/** Parse `- button "Search flights" [ref=e12]` lines out of an aria snapshot. */
export function indexSnapshotLabels(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof yaml !== "string") return out;
  for (const line of yaml.split("\n")) {
    const match = /^\s*-\s*([a-z]+)(?:\s+"([^"]*)")?[^\[]*\[ref=(e\d+)\]/.exec(line);
    if (!match) continue;
    const role = match[1] ?? "";
    const name = (match[2] ?? "").trim();
    const ref = match[3];
    if (!ref) continue;
    // A control with no accessible name gets its role, which is still more than
    // "something on the page"; an empty one is dropped rather than guessed at.
    const label = name || (role === "button" || role === "link" ? "" : role);
    if (label) out.set(ref, label);
  }
  return out;
}

/** Anything whose own label says it holds a credential is never echoed back. */
const SECRET_LABEL = /pass|passcode|pin\b|secret|card|cvv|cvc|security code|otp|one[- ]time/i;

/** `"Search flights"` — quoted, trimmed, and never long enough to wrap a line. */
function quoted(value: string, max = 42): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return `\u201c${cut}\u201d`;
}

/** `12 KB` — the size of a thing it saved, so the row says what landed. */
export function byteSize(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Tool name -> what a person would say happened. Names are user-facing:
 * "Opened google.com/flights", never `browser_navigate` (§2.3), and
 * every line carries its own content when the arguments hold any: what was
 * clicked, what was typed, which page was read, what was saved and how big.
 * The generic verb is the fallback, not the default.
 */
export function toolLine(
  name: string,
  callArgs: Record<string, unknown>,
  ctx: FeedContext = {},
): string | null {
  const url = typeof callArgs.url === "string" ? shortUrl(callArgs.url) ?? callArgs.url : null;
  const path = typeof callArgs.path === "string" ? baseName(callArgs.path) : null;
  const ref = typeof callArgs.ref === "string" ? callArgs.ref : null;
  const label = ref ? (ctx.labels?.get(ref) ?? null) : null;
  switch (name) {
    case "browser_navigate":
      return url ? `Opened ${url}` : "Opened a site";
    case "browser_tabs":
      return url ? `Opened ${url} in another tab` : "Moved between tabs";
    case "browser_snapshot":
      // The page's own title lives on the RESULT, not the call, and the durable
      // projection keeps neither — so this stays the one deliberately generic
      // verb. `collapseFeed` turns a run of them into "Read the page ×4", which
      // is the count the reader actually wanted.
      return "Read the page";
    case "browser_screenshot": {
      const at = url ?? ctx.currentUrl ?? null;
      return at ? `Looked at ${at}` : "Looked at the screen";
    }
    case "browser_click":
      return label ? `Clicked ${quoted(label)}` : "Clicked something on the page";
    case "browser_type": {
      const text = typeof callArgs.text === "string" ? callArgs.text.trim() : "";
      const secret = !text || (label ? SECRET_LABEL.test(label) : false);
      if (secret) return label ? `Filled in ${quoted(label)}` : "Typed on the page";
      return label ? `Typed ${quoted(text)} into ${quoted(label)}` : `Typed ${quoted(text)}`;
    }
    case "browser_press": {
      const key = typeof callArgs.key === "string" ? callArgs.key.trim() : "";
      return key ? `Pressed ${quoted(key, 12)}` : "Pressed a key";
    }
    case "browser_select":
      return label ? `Chose an option in ${quoted(label)}` : "Chose an option on the page";
    case "browser_scroll":
      return "Scrolled the page";
    case "browser_wait":
      return "Waited for the page to settle";
    case "files_write":
    case "write_file":
      return path ? `Saved ${path}` : "Saved a file";
    case "files_read":
      return path ? `Read ${path}` : "Read one of its files";
    case "files_list":
      return "Looked through its files";
    case "shell_exec":
      // Deliberately contentless: a command line is the one argument that is
      // both jargon and a disclosure risk, so it stays out of the feed.
      return "Ran a command on its computer";
    case "request_takeover":
      return "Asked for your help";
    case "done":
      return "Wrapped up";
    // Internal bookkeeping a person has no use for.
    case "takeover_status":
      return null;
    default: {
      const plain = name.replace(/^(browser|computer|files|shell)_/, "").replaceAll("_", " ");
      return plain ? `${plain.charAt(0).toUpperCase()}${plain.slice(1)}` : null;
    }
  }
}

/** One durable step or one live event -> one feed line, or nothing. */
export function feedLine(
  kind: string,
  body: Record<string, unknown>,
  ctx: FeedContext = {},
): FeedLine | null {
  switch (kind) {
    case "assistant": {
      const content = readString(body, "content", "text", "summary");
      return content ? { text: content, voice: "say", rich: true } : null;
    }
    case "task.started":
      return { text: "Opened its computer", voice: "do" };
    case "task.step":
      return null;
    case "task.completed":
    case "task.failed":
    case "task.cancelled": {
      const summary = readString(body, "summary");
      if (summary) return { text: summary, voice: "say", rich: true };
      if (kind === "task.cancelled") return { text: "You stopped the task", voice: "do" };
      if (kind === "task.failed") return { text: "It couldn’t finish", voice: "stumble" };
      return { text: "Finished", voice: "do" };
    }
    case "tool.call": {
      const name = readString(body, "name", "tool");
      // A save is announced by its result, and an ask for the keyboard is
      // announced by `takeover.requested`, which names the actual reason —
      // so the call itself stays silent rather than printing a second, vaguer
      // line for the same ask.
      if (!name || isSaveTool(name) || name === "request_takeover") return null;
      const text = toolLine(name, args(body), ctx);
      return text ? { text, voice: "do" } : null;
    }
    case "tool.result": {
      const name = readString(body, "name", "tool");
      if (!name || !isSaveTool(name) || !resultOk(body)) return null;
      const path = typeof args(body).path === "string" ? (args(body).path as string) : null;
      return {
        text: path ? `Saved ${baseName(path)}` : "Saved a file",
        voice: "do",
        artifact: path ? baseName(path) : "",
      };
    }
    case "tool.error":
      return { text: "That step didn’t work, so it tried another way", voice: "stumble" };
    case "policy.denied": {
      const url = readString(body, "url");
      const host = url ? shortUrl(url) : null;
      return {
        text: host ? `Held back from opening ${host}` : "Held back from a step it wasn’t allowed to take",
        voice: "stumble",
      };
    }
    case "approval.requested": {
      const name = readString(body, "tool", "name");
      const gate = readString(body, "gate");
      if (gate === "new_domain") return { text: "Asked you about opening a new site", voice: "do" };
      if (name === "files_write") return { text: "Asked you about saving a file", voice: "do" };
      return { text: "Asked you a question", voice: "do" };
    }
    case "approval.decided": {
      const decision = readString(body, "decision");
      if (decision === "deny") return { text: "You said no, so it stopped there", voice: "do" };
      if (decision === "kill") return { text: "You stopped the task", voice: "do" };
      return { text: "You said yes, and it carried on", voice: "do" };
    }
    case "approval.expired":
      return { text: "The question timed out, so it stopped and waited for you", voice: "stumble" };
    case "takeover.requested":
      return { text: takeoverReason(readString(body, "reason")), voice: "do" };
    case "takeover.started":
      return { text: "Handed you the keyboard and the mouse", voice: "do" };
    case "takeover.released":
      return { text: "You handed control back", voice: "do" };
    case "takeover.declined":
      return { text: "You let it carry on by itself", voice: "do" };
    case "takeover.expired":
      return { text: "Control timed out, so it paused and waited for you", voice: "stumble" };
    case "download.promoted": {
      // Same two shapes as `noteFacts` below; see the note there.
      const name = readString(body, "name", "item_name", "path", "workspace_path", "filename");
      const size = typeof body.bytes === "number" ? byteSize(body.bytes) : null;
      const what = name ? `Saved ${baseName(name)}` : "Saved a file";
      return {
        text: size ? `${what} (${size})` : what,
        voice: "do",
        artifact: name ? baseName(name) : "",
      };
    }
    case "sandbox.oom":
    case "sandbox.error":
      return { text: "Its computer ran into trouble", voice: "stumble" };
    default:
      return null;
  }
}

export interface FeedRow extends FeedLine {
  at: string;
  repeat: number;
}

/**
 * How long after a save line another line about the same file is taken to be
 * the same save rather than a second one. The call, its durable replay and the
 * promotion land within a second of each other; a model that rewrites the same
 * file a minute later has genuinely saved it twice and gets two lines.
 */
const SAME_SAVE_MS = 30_000;

/**
 * Consecutive identical lines collapse to one row with a ×n badge, and the
 * several lines one save produces collapse to the single best one: writing
 * `today.md` yields `Saved a file` from the durable replay, `Saved today.md`
 * from the result and `Saved today.md (227 bytes)` from the promotion. The most
 * informative line wins. The audit log is untouched; this is only what a person
 * reads.
 */
export function collapseFeed(items: Array<FeedLine & { at: string }>): FeedRow[] {
  const rows: FeedRow[] = [];
  let lastSave: FeedRow | undefined;
  for (const item of items) {
    // Save lines are folded by file first: two identical ones are one save
    // reported twice, never a "×2" the reader would have to discount.
    if (item.artifact !== undefined) {
      // `""` is a save whose event kept no filename, so it folds into whichever
      // save it arrived beside; a named file only ever folds into its own.
      const sameFile =
        lastSave !== undefined &&
        (item.artifact === "" || lastSave.artifact === "" || lastSave.artifact === item.artifact) &&
        Date.parse(item.at) - Date.parse(lastSave.at) <= SAME_SAVE_MS;
      if (sameFile && lastSave) {
        if (item.text.length > lastSave.text.length) lastSave.text = item.text;
        if (item.artifact) lastSave.artifact = item.artifact;
        lastSave.at = item.at;
        continue;
      }
      const row: FeedRow = { ...item, repeat: 1 };
      rows.push(row);
      lastSave = row;
      continue;
    }
    const last = rows[rows.length - 1];
    if (last && last.text === item.text && last.voice === item.voice && !item.rich) {
      last.repeat += 1;
      last.at = item.at;
      continue;
    }
    rows.push({ ...item, repeat: 1 });
  }
  return rows;
}

/* -------------------------------------------------------------------------
 * Markdown. Bold, italic, inline code, links and lists — the subset the model
 * actually emits. Built node by node, so a `<script>` in a tool result is a
 * string of eleven characters and nothing else.
 * ---------------------------------------------------------------------- */

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw, location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

export function renderInline(host: ParentNode, text: string): void {
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      appendTextChild(host, "strong", part.slice(2, -2));
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      appendTextChild(host, "code", part.slice(1, -1));
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]!);
      if (href) {
        const anchor = appendTextChild(host, "a", link[1]!) as HTMLAnchorElement;
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else {
        host.appendChild(document.createTextNode(link[1]!));
      }
      continue;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      appendTextChild(host, "em", part.slice(1, -1));
      continue;
    }
    host.appendChild(document.createTextNode(part));
  }
}

/** Block-level markdown: headings, paragraphs, bullet and numbered lists, fences. */
export function renderRich(host: HTMLElement, text: string): void {
  host.classList.add("rich");
  let list: HTMLElement | null = null;
  let fence: HTMLElement | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      if (fence) fence = null;
      else fence = appendTextChild(host, "pre", "");
      list = null;
      continue;
    }
    if (fence) {
      fence.textContent = `${fence.textContent ?? ""}${line}\n`;
      continue;
    }
    if (!line.trim()) {
      list = null;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      list = null;
      renderInline(appendTextChild(host, "h3", ""), heading[2]!);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const want = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== want) list = appendTextChild(host, want, "");
      renderInline(appendTextChild(list, "li", ""), (bullet ?? numbered)![1]!);
      continue;
    }
    list = null;
    renderInline(appendTextChild(host, "p", ""), line);
  }
}

type Facts = {
  /** The durable record was truncated, so every count below is a floor. */
  partial: boolean;
  usedUsd: number;
  capUsd: number | null;
  /** The most one task may be given, when the daemon says. */
  maxUsd: number | null;
  /** Tool calls the daemon has counted, and the cap it counts them against. */
  calls: number | null;
  callsCap: number | null;
  usageSteps: number;
  asks: number;
  files: Map<string, string>;
  sites: Set<string>;
  budgetKind: string | null;
  provider: string;
};

function emptyFacts(): Facts {
  return {
    partial: false,
    usedUsd: 0,
    capUsd: null,
    maxUsd: null,
    calls: null,
    callsCap: null,
    usageSteps: 0,
    asks: 0,
    files: new Map(),
    sites: new Set(),
    budgetKind: null,
    provider: "Claude",
  };
}

type Item = FeedLine & { at: string; kind: string };

type SurfaceKind = "none" | "approval" | "driving" | "observing" | "needs-you";

/**
 * Home sets this immediately before it navigates to a task it just created, and
 * the task view consumes it exactly once. It is the whole mechanism behind the
 * task-start transition: no shared state survives the first read, so a reload,
 * a back navigation or a pasted link never animates.
 */
let startedTaskId: string | null = null;

export function markTaskStarted(taskId: string): void {
  startedTaskId = taskId;
}

function takeStartedTask(): string | null {
  const id = startedTaskId;
  startedTaskId = null;
  return id;
}

function session(): Promise<SessionInfo | null> {
  // A deep link to a task may be the first page this tab ever renders, so the
  // session handshake cannot be assumed to have already happened on home. It is
  // shared: whoever asks first starts it, everyone else waits on the same one.
  return currentSession().catch(() => null);
}

class TaskView {
  private host: HTMLElement | null = null;
  private root!: HTMLElement;
  private taskId = "";
  private detail: TaskDetail | null = null;
  private readonly items = new Map<string, Item>();
  private readonly takeoverReasons = new Map<string, string>();
  /** takeover id -> the device the daemon granted it to (`takeover.started`). */
  private readonly takeoverActors = new Map<string, string>();
  /**
   * ref -> control label, rebuilt from every `browser_snapshot` result so the
   * click and type lines that follow can say WHAT was clicked and typed.
   * Live only: the durable projection drops tool
   * arguments and results, so a replayed feed falls back to its generic verbs
   * rather than to a stale label.
   */
  private readonly refLabels = new Map<string, string>();
  private currentUrl: string | null = null;
  private renderedRows: string[] = [];
  private feed!: HTMLElement;
  private announce!: HTMLElement;
  private surface!: HTMLElement;
  private grid!: HTMLElement;
  private left!: HTMLElement;
  private goalEl!: HTMLElement;
  private goalMore!: HTMLButtonElement;
  private goalFull!: HTMLElement;
  private spend!: HTMLElement;
  /** The receipt’s cost value, refreshed with the bar so the two agree. */
  private receiptCost: HTMLElement | null = null;
  private stopBtn!: HTMLButtonElement;
  private tabs!: HTMLElement;
  private panel: LivePanel | null = null;
  private factsEl: HTMLElement | null = null;
  private approval: ApprovalSurface | null = null;
  private approvalReq: PendingApproval | null = null;
  private takeover: TakeoverRow | null = null;
  /** This browser, as a takeover names its holder. Null until the daemon says. */
  private deviceId: string | null = null;
  /** The grant this page acquired itself — proof of control without the daemon. */
  private acquired: string | null = acquiredControl();
  private leaseTick = 0;
  /** When the lease deadline was last re-read, so typing cannot spam the daemon. */
  private leaseRead = 0;
  private surfaceKind: SurfaceKind = "none";
  private lastWord = "";
  private driving: ReturnType<typeof renderDriving> | null = null;
  private needsYou: ReturnType<typeof renderNeedsYou> | null = null;
  private events: WebSocket | null = null;
  /**
   * The pause the daemon has just announced. `emit` broadcasts before it
   * appends, so the refetch this triggers can beat the durable `task.step` into
   * the log; the receipt reads the moment and the reason from here until it
   * does.
   */
  private pausedStep: { at: string; body: Record<string, unknown> } | null = null;
  private reconnectTimer = 0;
  private alive = false;
  private controlBusy = false;
  private facts: Facts = emptyFacts();
  private commands: Array<() => void> = [];
  private readonly onKey = (event: KeyboardEvent) => this.handleKey(event);

  private running(): boolean {
    return Boolean(this.detail) && !isFinished(this.detail!.task.status);
  }

  /** Whoever the daemon says holds the active grant, on the row or the event. */
  private holder(): string | null {
    const row = this.takeover;
    if (!row) return null;
    return row.holder ?? this.takeoverActors.get(row.id) ?? null;
  }

  /** The keyboard is handed to one client, not to every window watching. */
  private drivingNow(): boolean {
    return isDriver(this.takeover, this.holder(), {
      device: this.deviceId,
      acquired: this.acquired,
    });
  }

  /** Someone else is driving: this window watches and offers nothing to press. */
  private observingNow(): boolean {
    return this.takeover?.state === "human" && !this.drivingNow();
  }

  async mount(el: HTMLElement, id: string): Promise<void> {
    this.alive = true;
    this.host = el;
    this.taskId = id;
    this.buildFrame(el);
    document.addEventListener("keydown", this.onKey);
    this.commands = [
      bindCommand("stop-task", { available: () => this.running(), run: () => void this.stop() }),
      bindCommand("take-control", {
        available: () => this.running() && this.takeover?.state !== "human",
        run: () => void this.takeControl(),
      }),
      bindCommand("give-control-back", {
        available: () => this.drivingNow(),
        run: () => void this.returnControl(),
      }),
    ];
    // Which client this is. It decides whether a granted takeover is yours to
    // drive, so the view redraws when the answer arrives.
    void currentDeviceId().then((id) => {
      if (!this.alive || id === null) return;
      this.deviceId = id;
      this.render();
    });
    const info = await session();
    if (!this.alive) return;
    this.facts.capUsd = info?.spend_cap_usd ?? null;
    this.facts.maxUsd = info?.budget?.max_usd ?? null;
    this.facts.budgetKind = info?.budget_kind ?? null;
    this.facts.provider = info?.execution_mode === "codex" ? "Codex" : "Claude";
    await this.load();
    if (!this.alive) return;
    this.connectEvents();
  }

  /** `#/tasks/a -> #/tasks/b` keeps the events socket, drops everything else. */
  update(id: string): void {
    if (id === this.taskId || !this.host) return;
    this.taskId = id;
    this.reset();
  }

  /** Rebuild the whole screen for `this.taskId` from the record on the daemon. */
  private reset(): void {
    if (!this.host) return;
    this.items.clear();
    this.takeoverReasons.clear();
    this.takeoverActors.clear();
    this.acquired = acquiredControl();
    this.stopLeaseTick();
    this.renderedRows = [];
    this.approval?.destroy();
    this.approval = null;
    this.approvalReq = null;
    this.takeover = null;
    this.pausedStep = null;
    this.surfaceKind = "none";
    this.lastWord = "";
    this.panel?.close();
    this.panel = null;
    this.factsEl = null;
    const capUsd = this.facts.capUsd;
    const maxUsd = this.facts.maxUsd;
    const budgetKind = this.facts.budgetKind;
    const provider = this.facts.provider;
    this.facts = { ...emptyFacts(), capUsd, maxUsd, budgetKind, provider };
    this.host.replaceChildren();
    this.buildFrame(this.host);
    void this.load();
  }

  unmount(): void {
    this.alive = false;
    for (const release of this.commands) release();
    this.commands = [];
    document.removeEventListener("keydown", this.onKey);
    window.clearTimeout(this.reconnectTimer);
    this.stopLeaseTick();
    this.approval?.destroy();
    this.approval = null;
    this.panel?.close();
    this.panel = null;
    const ws = this.events;
    this.events = null;
    ws?.close();
    setTitle(null);
  }

  private buildFrame(el: HTMLElement): void {
    this.root = appendTextChild(el, "div", "", "task-view");
    // The screen rises in, but only for the task you just started. Coming back
    // to one, or opening a link to one, is navigation and gets no animation.
    if (takeStartedTask() === this.taskId) this.root.classList.add("starting");

    const bar = appendTextChild(this.root, "div", "", "task-bar");
    this.spend = appendTextChild(bar, "span", "", "spend");
    this.stopBtn = document.createElement("button");
    this.stopBtn.type = "button";
    this.stopBtn.className = "btn sm";
    this.stopBtn.textContent = "Stop";
    this.stopBtn.addEventListener("click", () => void this.stop());
    bar.append(this.stopBtn);

    this.tabs = appendTextChild(this.root, "div", "", "task-tabs");
    this.tabs.setAttribute("role", "tablist");
    this.tabs.setAttribute("aria-label", "Task or its computer");

    this.grid = appendTextChild(this.root, "div", "", "task-grid");
    this.left = appendTextChild(this.grid, "div", "", "task-left");
    this.goalEl = appendTextChild(this.left, "h1", "", "t-title task-goal");
    this.goalMore = document.createElement("button");
    this.goalMore.type = "button";
    this.goalMore.className = "btn sm ghost goal-more";
    this.goalMore.textContent = SHOW_GOAL;
    this.goalMore.hidden = true;
    this.goalMore.setAttribute("aria-expanded", "false");
    this.left.append(this.goalMore);
    this.goalFull = appendTextChild(this.left, "div", "", "goal-full");
    this.goalFull.hidden = true;
    this.goalFull.tabIndex = 0;
    this.goalMore.addEventListener("click", () => {
      const open = this.goalFull.hidden;
      this.goalFull.hidden = !open;
      this.goalMore.textContent = open ? "Hide full task" : SHOW_GOAL;
      this.goalMore.setAttribute("aria-expanded", String(open));
    });
    this.surface = appendTextChild(this.left, "div", "", "task-surface");
    this.surface.hidden = true;
    this.feed = appendTextChild(this.left, "div", "", "feed");
    this.feed.setAttribute("role", "log");
    this.feed.setAttribute("aria-live", "polite");
    this.feed.setAttribute("aria-label", "What your bot is doing");
    this.feed.tabIndex = 0;

    // The status word lives in the titlebar, which a view may not write into
    // as a live region — so the change is announced once from here (§7).
    this.announce = appendTextChild(this.root, "p", "", "sr-only");
    this.announce.setAttribute("role", "status");

    for (const [key, label] of [["task", "Task"], ["computer", "Computer"]] as const) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.dataset.tab = key;
      tab.textContent = label;
      tab.addEventListener("click", () => this.setTab(key));
      this.tabs.append(tab);
    }
    this.setTab("task");
  }

  private setTab(which: "task" | "computer"): void {
    this.grid.setAttribute("data-tab", which);
    for (const node of this.tabs.querySelectorAll<HTMLElement>("[data-tab]")) {
      node.setAttribute("aria-selected", node.dataset.tab === which ? "true" : "false");
    }
  }

  private async load(): Promise<void> {
    try {
      const detail = (await apiGet(
        `/api/v1/tasks/${encodeURIComponent(this.taskId)}`,
      )) as TaskDetail;
      if (!this.alive) return;
      this.detail = detail;
      if (detail.task.status !== "paused") this.pausedStep = null;
      // The receipt is a pure function of THIS record. When the daemon
      // truncated the history the counts below are floors, not totals, and the
      // receipt has to say so rather than print a smaller number on a second
      // visit than it printed on the first.
      this.facts.partial = detail.truncated === true || detail.history_truncated === true;
      this.noteRecordSpend(detail.task);
      this.seed(detail.steps ?? []);
      this.ensurePanel();
      await this.refreshAlerts();
      if (!this.alive) return;
      this.render();
    } catch {
      if (!this.alive) return;
      this.renderUnreachable();
    }
  }

  /**
   * Durable replay. Keys are stable, so replaying is idempotent; a live line
   * that already knows more (a URL, a filename) survives, because the durable
   * projection drops tool arguments on purpose.
   */
  private seed(steps: DurableStep[]): void {
    for (const step of steps) {
      const body = (step.body ?? {}) as Record<string, unknown>;
      this.noteFacts(step.kind, body);
      const line = feedLine(step.kind, body, this.feedContext());
      if (!line) continue;
      const key = `${step.kind}|${step.created_at}`;
      const existing = this.items.get(key);
      if (existing && existing.text.length >= line.text.length) continue;
      this.items.set(key, { ...line, at: step.created_at, kind: step.kind });
    }
  }

  /**
   * Facts are derived, never accumulated, so a reload or a refetch cannot
   * double-count.
   *
   * Sites and files come from `tool.result` and `download.promoted` — never
   * from `tool.call`. A navigation that was blocked and a write the computer
   * rejected are requests, not outcomes, and the receipt may only describe what
   * happened (`src/daemon/agent-loop.ts` states the same rule for the daemon's
   * own copy of it).
   */
  private noteFacts(kind: string, body: Record<string, unknown>): void {
    if (kind === "usage") {
      const usd = number(body.usd_est) ?? number(body.spend_usd);
      const steps = number(body.steps);
      if (usd !== null) this.facts.usedUsd = usd;
      if (steps !== null) this.facts.usageSteps = Math.max(this.facts.usageSteps, steps);
      const calls = number(body.calls);
      if (calls !== null) this.facts.calls = Math.max(this.facts.calls ?? 0, calls);
      this.facts.callsCap = number(body.calls_cap) ?? this.facts.callsCap;
      return;
    }
    // A refusal names what the run had actually spent when it was refused. It
    // is the only place the proxy's own figure reaches this screen while
    // `usage` still reports nothing, and it is what the receipt must total.
    if (kind === "policy.denied") {
      const spent = number(body.proxy_estimate_usd) ?? number(body.spend_usd);
      if (spent !== null) this.facts.usedUsd = Math.max(this.facts.usedUsd, spent);
      this.facts.capUsd = number(body.cap_usd) ?? this.facts.capUsd;
      return;
    }
    if (kind === "tool.result") {
      const name = readString(body, "name", "tool");
      const callArgs = args(body);
      const ok = resultOk(body);
      if (ok && (name === "browser_navigate" || name === "browser_tabs")) {
        const url = typeof callArgs.url === "string" ? shortUrl(callArgs.url) : null;
        if (url) {
          this.facts.sites.add(url.split("/")[0]!);
          this.setCurrentUrl(url);
        }
      }
      if (ok && name === "files_write") {
        const path = typeof callArgs.path === "string" ? callArgs.path : null;
        if (path) this.facts.files.set(path, baseName(path));
      }
      // The aria snapshot is the only place the page's own words for its
      // controls appear. It is sanitized before it leaves the container
      // (`redactSnapshotYaml`, secret fields masked to `***`), so indexing it
      // adds no disclosure the daemon had not already allowed.
      const result = body.result;
      const data =
        result && typeof result === "object"
          ? ((result as Record<string, unknown>).data as Record<string, unknown> | undefined)
          : undefined;
      const yaml = data && typeof data.yaml === "string" ? data.yaml : null;
      if (yaml) {
        for (const [ref, label] of indexSnapshotLabels(yaml)) this.refLabels.set(ref, label);
      }
      const url = data && typeof data.url === "string" ? shortUrl(data.url) : null;
      if (url) this.setCurrentUrl(url);
    }
    if (kind === "download.promoted") {
      // Two producers, two shapes. The daemon's browser-download promote route
      // emits `workspace_path` + `item_name`; the `write_file` tool emits a
      // workspace-relative `path`. Both are accepted.
      const path = readString(body, "path", "workspace_path", "filename");
      const name = readString(body, "name", "item_name");
      // `write_file` sets `item_name` to the whole workspace path, so the
      // display name is always reduced to the basename: one file, one name, on
      // every visit to this screen.
      if (path) this.facts.files.set(path, baseName(name ?? path));
      else if (name) this.facts.files.set(name, baseName(name));
    }
    if (kind === "takeover.requested") {
      const id = readString(body, "takeover_id");
      const reason = readString(body, "reason");
      if (id && reason) this.takeoverReasons.set(id, reason);
    }
    if (kind === "takeover.started") {
      const id = readString(body, "takeover_id");
      const actor = readString(body, "actor");
      if (id && actor) this.takeoverActors.set(id, actor);
    }
  }

  private setCurrentUrl(url: string): void {
    this.currentUrl = url;
    this.panel?.setUrl(url);
  }

  /** What every `feedLine` call on this view gets to work with. */
  private feedContext(): FeedContext {
    return { labels: this.refLabels, currentUrl: this.currentUrl };
  }

  /**
   * What the daemon says this run has spent. The record is the only source that
   * survives a reload — the live figures ride on events this page may not have
   * seen — so it seeds the meter and is never allowed to lower it.
   */
  private noteRecordSpend(task: TaskRecord): void {
    const spent = number(task.spend_usd) ?? number(task.summary?.cost_usd);
    if (spent !== null) this.facts.usedUsd = Math.max(this.facts.usedUsd, spent);
    this.facts.capUsd = number(task.spend_cap_usd) ?? this.facts.capUsd;
    const calls = number(task.calls);
    if (calls !== null) this.facts.calls = Math.max(this.facts.calls ?? 0, calls);
    this.facts.callsCap = number(task.calls_cap) ?? this.facts.callsCap;
  }

  /** Tool calls made: the daemon's count when it keeps one, else this page's. */
  private callCount(): number {
    return Math.max(this.facts.calls ?? 0, this.countKind("tool.call"));
  }

  /** The one place the budget figures are assembled, so nothing can disagree. */
  private currentSpend(): Spend {
    return {
      usd: this.facts.usedUsd,
      capUsd: this.facts.capUsd,
      calls: this.callCount(),
      callsCap: this.facts.callsCap,
    };
  }

  private countKind(kind: string): number {
    let total = 0;
    for (const item of this.items.values()) if (item.kind === kind) total += 1;
    return total;
  }

  private stepCount(): number {
    const frozen = this.receipt();
    if (frozen && Number.isFinite(frozen.steps)) return frozen.steps;
    return Math.max(this.facts.usageSteps, this.callCount());
  }

  private ensurePanel(): void {
    if (this.panel || !this.detail) return;
    const computerId = this.detail.task.computer_id;
    this.panel = new LivePanel({
      computerId,
      onTakeControl: () => void this.takeControl(),
      onReturnControl: () => void this.returnControl(),
      onFullScreen: (full) => this.grid.setAttribute("data-full", String(full)),
      onInput: () => this.onLiveInput(),
    });
    this.grid.append(this.panel.root);
    this.factsEl = appendTextChild(this.panel.root, "div", "", "facts");
    if (!isFinished(this.detail.task.status)) this.panel.connect();
  }

  private connectEvents(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/v1/events`);
    this.events = ws;
    ws.addEventListener("message", (event) => {
      if (this.events !== ws || typeof event.data !== "string") return;
      let parsed: UiEvent;
      try {
        parsed = JSON.parse(event.data) as UiEvent;
      } catch {
        return;
      }
      this.onEvent(parsed);
    });
    ws.addEventListener("close", () => {
      if (this.events !== ws || !this.alive) return;
      this.reconnectTimer = window.setTimeout(() => {
        if (this.alive && this.events === ws) this.connectEvents();
      }, 1000);
    });
  }

  /** One synthetic event in, one rendered feed out. The unit tests use this. */
  onEvent(event: UiEvent): void {
    const body = (event.body ?? {}) as Record<string, unknown>;
    const mine = !event.task_id || event.task_id === this.taskId;
    const forMyComputer =
      !event.computer_id || event.computer_id === this.detail?.task.computer_id;

    if (event.type === "usage") {
      if (!mine) return;
      this.noteFacts("usage", body);
      this.renderFacts();
      this.renderBar();
      return;
    }

    if (event.type.startsWith("approval.") || event.type.startsWith("takeover.")) {
      if (mine || forMyComputer) {
        this.noteFacts(event.type, body);
        void this.refreshAlerts().then(() => {
          if (this.alive) this.render();
        });
      }
    }

    if (!mine) return;

    // `task.step` is the running heartbeat and does not refetch — except when
    // it carries the pause. A budget, step or runtime stop changes the task's
    // state exactly as a terminal event does, and a page that treated it as a
    // heartbeat sat on "Working" with a frozen meter for nine minutes until
    // someone reloaded it.
    const paused = event.type === "task.step" && body.status === "paused";
    if (paused) this.pausedStep = { at: event.ts, body };
    if (event.type.startsWith("task.") && (paused || event.type !== "task.step")) {
      void this.load();
    }

    this.noteFacts(event.type, body);
    const line = feedLine(event.type, body, this.feedContext());
    if (!line) return;
    this.items.set(`${event.type}|${event.ts}|live`, {
      ...line,
      at: event.ts,
      kind: event.type,
    });
    this.renderFeed();
    this.renderFacts();
  }

  private async refreshAlerts(): Promise<void> {
    const computerId = this.detail?.task.computer_id;
    try {
      const [approvals, takeovers] = (await Promise.all([
        apiGet("/api/v1/approvals"),
        apiGet("/api/v1/takeovers"),
      ])) as [
        {
          approvals: Array<{
            id: string;
            task_id: string;
            status: string;
            tool: string;
            gate: string;
            args_json: string;
            bind_json: string;
            created_at: string;
          }>;
        },
        { takeovers: TakeoverRow[] },
      ];
      if (!this.alive) return;
      // The daemon's own `status` is the authority on whether an ask is
      // pending: dropping one whose `expires` had passed by the BROWSER's clock
      // would let a skewed clock hide a live ask entirely. The card reads the
      // daemon's clock instead (`approvalDeadline`).
      const pending = approvals.approvals.find(
        (a) => a.task_id === this.taskId && a.status === "pending",
      );
      this.approvalReq = pending
        ? {
            approval_id: pending.id,
            tool: pending.tool,
            gate: pending.gate,
            args: JSON.parse(pending.args_json) as Record<string, unknown>,
            bind: JSON.parse(pending.bind_json),
            created_at: pending.created_at,
            // `GET /api/v1/approvals` returns the stored rows, which do not
            // carry `can_remember` — only the `approval.requested` event does.
            // The rule is the daemon's own (dispatcher.ts offers a remembered
            // grant on `new_domain` and nowhere else), so it is applied here
            // rather than guessed at. The route re-checks the gate before it
            // writes a grant, so an over-offer degrades to a plain allow_once.
            can_remember: pending.gate === "new_domain",
          }
        : null;
      this.takeover =
        takeovers.takeovers.find(
          (t) => t.computer_id === computerId && isActiveTakeover(t.state),
        ) ?? null;
    } catch {
      /* The view already reports connection trouble; alerts retry on the next event. */
    }
  }

  private async stop(): Promise<void> {
    this.stopBtn.disabled = true;
    try {
      await apiPost(`/api/v1/tasks/${encodeURIComponent(this.taskId)}/cancel`);
      await this.load();
    } catch {
      this.stopBtn.disabled = false;
      toast("error", "Couldn’t stop the task. Check your connection and try again.");
    }
  }

  private async decide(decision: "allow_once" | "allow_task" | "deny"): Promise<void> {
    const req = this.approvalReq;
    if (!req || !this.approval) return;
    this.approval.setBusy(true);
    try {
      await decideApproval(req.approval_id, decision, req.bind);
      this.approvalReq = null;
      this.approval.destroy();
      this.approval = null;
      this.surfaceKind = "none";
      await this.refreshAlerts();
      this.render();
    } catch {
      this.approval?.setBusy(false);
      toast("error", "That answer didn’t go through. The question is still open — try again.");
    }
  }

  private async takeControl(): Promise<void> {
    const computerId = this.detail?.task.computer_id;
    if (!computerId || this.controlBusy) return;
    this.controlBusy = true;
    this.panel?.setTakeBusy(true);
    // Optimistic: the frame goes ember now, and the server’s own mode message
    // either confirms it or rolls it back (§3.2 step 4).
    this.panel?.setPhase("driving");
    try {
      const granted = await requestControl(computerId, this.taskId);
      // Proof this window is the one driving, before the daemon is asked again:
      // the server's mode message can land before the next render otherwise,
      // and this window would call its own handover someone else's.
      if (granted) {
        rememberAcquired((this.acquired = granted.takeover_id));
        this.panel?.setDriver(true);
        // Straight to full screen: the click that got here is the user gesture
        // the Fullscreen API wants, and it is still spendable this tick.
        await this.panel?.setFullScreen(true);
        this.panel?.setNotice(CONTROL_TAKEN);
      }
      this.leaseRead = Date.now();
      await this.refreshAlerts();
      this.render();
    } catch (error) {
      this.panel?.setPhase("live");
      // Said over the picture the person was looking at, not only in a toast
      // at the edge of a screen they have just left for full screen.
      const why = humanApiError(error, TAKE_FAILED);
      this.panel?.setNotice(why, "warn");
      toast("warn", why);
    } finally {
      this.controlBusy = false;
      this.panel?.setTakeBusy(false);
    }
  }

  private async returnControl(): Promise<void> {
    const lease = this.takeover;
    if (!lease || this.controlBusy) return;
    this.controlBusy = true;
    this.driving?.setBusy(true);
    try {
      const released = await releaseControl(lease.id);
      if (released) {
        rememberAcquired((this.acquired = null));
        this.driving?.setHold(null);
        await this.panel?.setFullScreen(false);
        this.panel?.setPhase("live");
      } else {
        this.driving?.setHold(STILL_SENSITIVE);
        // The driving card is off screen while full screen, so the reason has
        // to be where the person is looking.
        if (this.panel?.isFullScreen()) this.panel.setNotice(STILL_SENSITIVE, "warn");
      }
      await this.refreshAlerts();
      this.render();
    } catch {
      toast("warn", "Control didn’t go back yet. Try again in a moment.");
    } finally {
      this.controlBusy = false;
      this.driving?.setBusy(false);
    }
  }

  /**
   * "Not needed, continue": the sensitive-field detectors guess, and a wrong
   * guess costs minutes of a person's attention. Declining hands the step back
   * to the bot rather than leaving the ask on screen until it times out.
   */
  private async decline(takeoverId: string): Promise<void> {
    if (this.controlBusy) return;
    this.controlBusy = true;
    this.needsYou?.setBusy(true);
    try {
      await declineControl(takeoverId);
      await this.refreshAlerts();
      this.render();
    } catch (error) {
      toast("warn", humanApiError(error, "It didn’t carry on. Try again in a moment."));
    } finally {
      this.controlBusy = false;
      this.needsYou?.setBusy(false);
    }
  }

  /** Carry on where it paused: the same task, the same computer, the same transcript. */
  private async resume(raise?: number, steps?: number): Promise<void> {
    const body: { spend_cap_usd?: number; max_steps?: number } = {};
    if (raise !== undefined) body.spend_cap_usd = raise;
    if (steps !== undefined) body.max_steps = steps;
    try {
      await apiPost(
        `/api/v1/tasks/${encodeURIComponent(this.taskId)}/resume`,
        Object.keys(body).length > 0 ? body : undefined,
      );
    } catch (error) {
      toast("error", humanApiError(error, "Couldn’t pick it up again. Run it again instead."));
      return;
    }
    this.reset();
  }

  /**
   * Resume past the budget it stopped on. The daemon refuses a resume that has
   * nothing left to spend, so a bigger figure has to travel with it (W3).
   */
  private async resumeWithMore(): Promise<void> {
    const raise = raisedCap(this.facts.capUsd, readBudgetPreference(), this.facts.maxUsd);
    if (raise === null) {
      toast(
        "warn",
        `${formatUsd(this.facts.capUsd ?? 0)} is the most one task can have on this Mac.`,
      );
      return;
    }
    await this.resume(raise);
  }

  /**
   * Resume past the step limit it stopped on. The daemon refuses a resume with
   * no steps left the same way it refuses one with nothing left to spend
   * (`409 E_LIMIT`), so a bigger count has to travel with it — twice what this
   * task had, or twice the calls it made when the record names no limit.
   */
  private async resumeWithMoreSteps(): Promise<void> {
    const had = number(this.detail?.task.max_steps) ?? 0;
    const raised = Math.max(Math.round(had * 2), this.callCount() * 2, 1);
    await this.resume(undefined, raised);
  }

  private async runAgain(): Promise<void> {
    const task = this.detail?.task;
    if (!task) return;
    try {
      const created = (await apiPost("/api/v1/tasks", {
        goal: task.goal,
        computer_id: task.computer_id,
      })) as { task: { id: string } };
      navigate(`#/tasks/${created.task.id}`);
    } catch {
      toast("error", "Couldn’t start it again. Check the AI connection in Settings.");
    }
  }

  /** ux-spec §2.7. Esc, Enter, ⌘↩, ⌘. and ⌘⇧T all land here. */
  handleKey(event: KeyboardEvent): void {
    if (this.approval?.handleKey(event)) return;
    // Full screen first: Esc leaves it and leaves control exactly where it is.
    if (event.key === "Escape" && this.panel?.isFullScreen()) {
      event.preventDefault();
      void this.panel.setFullScreen(false);
      return;
    }
    // The live surface takes the keyboard while you drive, so the way out has
    // to be a key it deliberately does not forward. Esc is it, and the hint
    // under the frame says so in as many words.
    if (event.key === "Escape" && this.drivingNow()) {
      event.preventDefault();
      void this.returnControl();
      return;
    }
    const command = event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && command && this.drivingNow()) {
      event.preventDefault();
      void this.returnControl();
      return;
    }
    if (event.key === "." && command) {
      if (this.detail && !isFinished(this.detail.task.status)) {
        event.preventDefault();
        void this.stop();
      }
      return;
    }
    if (command && event.shiftKey && (event.key === "T" || event.key === "t")) {
      event.preventDefault();
      if (this.drivingNow()) void this.returnControl();
      else if (!this.observingNow()) void this.takeControl();
    }
  }

  private render(): void {
    const task = this.detail?.task;
    if (!task) return;
    const driving = this.drivingNow();
    const observing = this.observingNow();
    const needsYou =
      Boolean(this.approvalReq) || Boolean(this.takeover && !driving && !observing);
    const status = statusWord(task.status, { needsYou, driving, observing });

    const goal = goalHead(task.goal || "Untitled task");
    setTitle(status.word, { dot: status.tone, back: "#/", backLabel: "All tasks" });
    if (status.word !== this.lastWord) {
      this.lastWord = status.word;
      // The heading, not the whole prompt: a screen reader re-reads this region
      // on every state change.
      this.announce.textContent = `${status.word}. ${goal.head}`;
    }
    this.goalEl.textContent = goal.head;
    this.goalMore.hidden = !goal.rest;
    this.goalFull.textContent = goal.rest;
    if (!goal.rest) this.goalFull.hidden = true;
    this.renderBar();

    if (isFinished(task.status) || (task.status === "paused" && !this.pausedForTakeover())) {
      this.renderOutcome(task);
      return;
    }

    // The panel goes first: it owns the phase, and the driving surface below
    // asks it for the keyboard once it is in the driving phase.
    this.renderPanelState(driving, needsYou, observing);
    this.renderSurface(driving, observing);
    this.renderFeed();
    this.renderFacts();
  }

  /**
   * Paused with the keyboard already asked for or handed over. Resume cannot
   * fix that — only a person taking control can — so this pause keeps the live
   * surface and the Take-control button instead of the receipt.
   */
  private pausedForTakeover(): boolean {
    return this.takeover?.state === "takeover_requested" || this.takeover?.state === "human";
  }

  private renderBar(): void {
    const task = this.detail?.task;
    const finished = task ? isFinished(task.status) : false;
    // A paused task has a receipt on screen too, and can still be stopped.
    const settled = finished || (task?.status === "paused" && !this.pausedForTakeover());
    const spend = `${budgetMeter(this.currentSpend()).used} used`;
    // The span never ends before the last thing that happened.
    const at = task ? this.span(task)?.to : undefined;
    // The verb comes from the outcome, so a run that did not finish may not
    // read "Finished 15:36".
    const verb = task && settled ? this.outcome(task).barVerb : null;
    // While a task runs the receipt panel states the cost with its cap and its
    // meter — the fuller answer — so the bar speaks only once that panel is
    // gone, which is when the run ends.
    this.spend.textContent =
      settled && at && verb ? `${verb} ${clockTime(at)} · ${spend}` : "";
    this.stopBtn.hidden = finished;
    // The receipt is built once, but a usage event can still land after it.
    // Two different totals for the same task on one screen is a trust bug.
    if (this.receiptCost) this.receiptCost.textContent = this.receiptCostText();
  }

  /**
   * A count that shrinks is worse than no count, so a partial record says it is
   * partial rather than report a smaller number on a second visit. The frozen
   * receipt is computed from the whole audit log and cannot shrink, so when it
   * exists it is the answer and the derived count is the fallback.
   */
  private receiptSitesText(): string {
    const frozen = this.receipt();
    if (frozen) return frozen.sites.length ? frozen.sites.join(", ") : "None";
    const sites = [...this.facts.sites];
    if (sites.length) return this.facts.partial ? `${sites.join(", ")}, and possibly more` : sites.join(", ");
    return this.facts.partial ? "Not all of this run was kept" : "None";
  }

  private receiptFilesText(): string {
    const files = [...this.savedFiles().values()];
    if (files.length) return files.join(", ");
    return this.facts.partial && !this.receipt() ? "Not all of this run was kept" : "None";
  }

  private receiptAsksText(): string {
    const frozen = this.receipt();
    if (frozen) return frozen.asks === 0 ? "Nothing — it did it all itself" : String(frozen.asks);
    const asks = this.countKind("approval.requested");
    if (asks === 0) {
      return this.facts.partial ? "Not all of this run was kept" : "Nothing — it did it all itself";
    }
    return this.facts.partial ? `At least ${asks}` : String(asks);
  }

  /**
   * What it cost, on the receipt. The frozen `cost_usd` is the daemon's own
   * total and outranks anything counted here; when the run was never priced the
   * figure is the tool calls it made, because "$0.00" on a receipt for a task
   * that stopped ON its budget is the one number that must never appear.
   */
  private receiptCostText(): string {
    return budgetMeter(this.currentSpend()).long;
  }

  /**
   * The approval and the takeover are rebuilt only when the state they show
   * actually changes — a card that reappears on every event would steal focus
   * from the person reading it.
   */
  private renderSurface(driving: boolean, observing: boolean): void {
    const want: SurfaceKind = driving
      ? "driving"
      : this.approvalReq
        ? "approval"
        : observing
          ? "observing"
          : this.takeover
            ? "needs-you"
            : "none";
    const sameApproval =
      want === "approval" &&
      this.approval?.root.dataset.approvalId === this.approvalReq?.approval_id;
    if (want === this.surfaceKind && (want !== "approval" || sameApproval)) return;

    this.surfaceKind = want;
    if (want !== "approval") {
      this.approval?.destroy();
      this.approval = null;
    }
    this.driving = null;
    this.needsYou = null;
    this.stopLeaseTick();
    this.surface.replaceChildren();

    if (want === "none") {
      this.surface.hidden = true;
      return;
    }
    this.surface.hidden = false;

    if (want === "observing") {
      this.surface.append(renderObserving().root);
      return;
    }

    if (want === "driving") {
      this.driving = renderDriving({
        onReturn: () => void this.returnControl(),
        onStop: () => void this.stop(),
      });
      this.surface.append(this.driving.root);
      this.renderLease();
      this.leaseTick = window.setInterval(() => this.renderLease(), 1000);
      // "Give control back" is the one place the keyboard must NOT be when a
      // person has just been handed it. The card announces itself
      // (role="alert") without holding focus; the screen gets it instead.
      if (this.panel) this.panel.focusScreen();
      else this.driving.focus();
      return;
    }

    if (want === "approval" && this.approvalReq) {
      if (!sameApproval) {
        this.approval?.destroy();
        this.approval = renderApproval(this.approvalReq, {
          onDecide: (decision) => {
            void this.decide(
              decision === "deny"
                ? "deny"
                : decision === "allow_task"
                  ? "allow_task"
                  : "allow_once",
            );
          },
          onExpire: () =>
            toast("warn", "That question timed out. Your bot stopped and is waiting for you."),
        });
      }
      const surface = this.approval;
      if (surface) {
        this.surface.append(surface.root);
        surface.focus();
      }
      return;
    }

    // Declining is only an answer while it is still asking: once the keyboard
    // has been handed over there is nothing left to decline.
    const asking = this.takeover?.state === "takeover_requested" ? this.takeover.id : null;
    this.needsYou = renderNeedsYou({
      reason: this.takeover ? (this.takeoverReasons.get(this.takeover.id) ?? null) : null,
      onTake: () => void this.takeControl(),
      ...(asking ? { onDecline: () => void this.decline(asking) } : {}),
    });
    this.surface.append(this.needsYou.root);
    this.needsYou.focus();
  }

  private sortedItems(): Item[] {
    return [...this.items.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  private renderFeed(): void {
    const rows = collapseFeed(this.sortedItems());
    if (!rows.length) {
      this.feed.replaceChildren();
      this.renderedRows = [];
      const finished = this.detail ? isFinished(this.detail.task.status) : false;
      appendTextChild(
        this.feed,
        "p",
        finished ? "Nothing was saved about this run." : "Getting its computer ready",
        "feed-empty",
      );
      return;
    }

    const stamps = rows.map((r) => clockTime(r.at));
    const shown = stamps.map((stamp, index) => (index === 0 || stamp !== stamps[index - 1] ? stamp : null));
    // The stamp is part of the signature: two runs that differ only in which
    // rows print a clock must still rewrite the tail.
    const signature = rows.map((r, index) => `${r.voice}|${r.repeat}|${shown[index] ?? ""}|${r.text}`);
    let shared = 0;
    while (
      shared < signature.length &&
      shared < this.renderedRows.length &&
      signature[shared] === this.renderedRows[shared]
    ) {
      shared += 1;
    }
    // Only the tail is rewritten, so the polite log announces what is new
    // rather than the whole history over again (§7).
    if (shared === 0) this.feed.replaceChildren();
    while (this.feed.childElementCount > shared) this.feed.lastElementChild?.remove();
    for (let index = shared; index < rows.length; index += 1) {
      this.feed.append(this.stepNode(rows[index]!, shown[index] ?? null));
    }
    for (const node of this.feed.querySelectorAll<HTMLElement>(".step.now")) {
      node.classList.remove("now");
    }
    if (this.detail && !isFinished(this.detail.task.status)) {
      this.feed.lastElementChild?.classList.add("now");
    }
    this.renderedRows = signature;

    const nearBottom =
      this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 120;
    if (nearBottom) this.feed.scrollTop = this.feed.scrollHeight;
  }

  private stepNode(row: FeedRow, stamp: string | null): HTMLElement {
    const step = document.createElement("div");
    step.className = `step ${row.voice}`;
    // `15:32` three times running is not three facts. The clock is printed when
    // it CHANGES; the rows under it belong to that minute.
    const when = appendTextChild(step, "div", stamp ?? "", "when");
    if (!stamp) when.setAttribute("aria-hidden", "true");
    const what = appendTextChild(step, "div", "", "what");
    if (row.rich) renderRich(what, row.text);
    else what.textContent = row.text;
    if (row.repeat > 1) appendTextChild(what, "span", `×${row.repeat}`, "rep");
    return step;
  }

  private renderFacts(): void {
    if (!this.factsEl) return;
    this.factsEl.replaceChildren();

    const spend = budgetMeter(this.currentSpend());
    const budget = appendTextChild(this.factsEl, "div", "", "r");
    appendTextChild(
      budget,
      "span",
      this.facts.budgetKind === "tool_proxy" ? "Tool budget used" : "Budget used",
    );
    appendTextChild(budget, "b", spend.used);

    if (spend.ratio !== null) {
      const meter = appendTextChild(this.factsEl, "div", "", "meter");
      if (spend.ratio >= 0.8) meter.classList.add("warn");
      meter.setAttribute("role", "img");
      meter.setAttribute(
        "aria-label",
        `${Math.round(spend.ratio * 100)} percent of ${spend.of} used`,
      );
      appendTextChild(meter, "i", "").style.transform = `scaleX(${spend.ratio.toFixed(3)})`;
    }

    const steps = appendTextChild(this.factsEl, "div", "", "r");
    appendTextChild(steps, "span", "Steps so far");
    appendTextChild(steps, "b", String(this.stepCount()));

    const files = appendTextChild(this.factsEl, "div", "", "r");
    appendTextChild(files, "span", "Files it has saved");
    appendTextChild(
      files,
      "b",
      this.facts.files.size ? [...this.facts.files.values()].join(", ") : "None yet",
    );
  }

  private renderPanelState(driving: boolean, needsYou: boolean, observing: boolean): void {
    const panel = this.panel;
    if (!panel) return;
    panel.setDriver(driving);
    const phase = panel.getPhase();
    if (driving) panel.setPhase("driving");
    else if (observing) panel.setPhase("observing");
    else if (needsYou) panel.setPhase("paused");
    else if (phase === "paused" || phase === "driving" || phase === "observing") {
      panel.setPhase("live");
    }

    // Nothing to press in either case: the keyboard is already granted, and a
    // second client asking for it would only be refused.
    if (driving || observing) {
      panel.setActionsVisible(false, true);
      return;
    }
    panel.setTakeLabel(needsYou ? "Take control instead" : "Take control", false);
    panel.setActionsVisible(true, true);
  }

  /** The lease line under "You’re driving", ticking once a second. */
  private renderLease(): void {
    const at = this.takeover?.expires_at
      ? Date.parse(this.takeover.expires_at)
      : Number.NaN;
    const left = Number.isFinite(at) ? at - Date.now() : null;
    this.driving?.setLease(left);
    this.panel?.setLease(left);
  }

  private stopLeaseTick(): void {
    window.clearInterval(this.leaseTick);
    this.leaseTick = 0;
  }

  /**
   * Every relayed input restarts the daemon's lease, so the deadline on screen
   * is stale the moment a person types. Re-read it rather than guess — at most
   * once every fifteen seconds, so a burst of typing costs one request.
   */
  private onLiveInput(): void {
    const now = Date.now();
    if (!this.drivingNow() || now - this.leaseRead < 15_000) return;
    this.leaseRead = now;
    void this.refreshAlerts().then(() => {
      if (this.alive) this.render();
    });
  }

  /**
   * The body of the event that ended this run. It carries the daemon's own
   * `reason` and, when the provider refused, its limit verdict — and unlike
   * `terminalStep()` it does not require a written summary.
   */
  private terminalBody(): Record<string, unknown> | null {
    const steps = this.detail?.steps ?? [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      if (step.kind.startsWith("task.") && step.body?.reason) return step.body;
    }
    return this.pausedStep?.body ?? null;
  }

  /**
   * When this run paused, or null if it did not. The live event knows before
   * the durable log does; after a reload the log is the only one that knows.
   */
  private pausedAt(): string | null {
    if (this.pausedStep) return this.pausedStep.at;
    const steps = this.detail?.steps ?? [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      if (step.kind === "task.step" && step.body?.status === "paused") return step.created_at;
    }
    return null;
  }

  /** This run's span, stopped at the pause while it is paused. */
  private span(task: TaskRecord): TaskSpan | null {
    return taskSpan(
      task,
      this.detail?.steps ?? [],
      task.status === "paused" ? this.pausedAt() : null,
    );
  }

  /** The daemon's own word for why this run ended, or null. */
  private stopReason(): string | null {
    const reason = this.terminalBody()?.reason;
    return typeof reason === "string" && reason ? reason : null;
  }

  /** One outcome object, so the bar, the heading and the actions cannot drift. */
  private outcome(task: TaskRecord): TerminalCopy {
    // The verdict rides on the terminal event, and on newer daemons on the
    // record as well. Either one is enough to stop this screen blaming the Mac
    // for a budget the daemon itself enforced.
    const terminal = this.terminalBody();
    return terminalCopy({
      status: task.status,
      reason: this.stopReason(),
      budget: this.facts.capUsd === null ? null : `${formatUsd(this.facts.capUsd)} budget`,
      took: spanDurationText(this.span(task), this.items.size),
      terminal: terminal?.failure_kind ? terminal : { ...terminal, failure_kind: task.failure_kind },
      adapter: task.adapter ?? null,
      calls: this.callCount(),
    });
  }

  /**
   * What the runner threw, when the terminal event carries a stringified error
   * rather than a summary written for a person. It names the cause, so it
   * decides the copy — but it is never the headline.
   */
  private terminalError(): string | null {
    const body = this.terminalStep()?.body;
    const summary = typeof body?.summary === "string" ? body.summary : null;
    return summary && /^\s*\w*Error\b/.test(summary) ? summary : null;
  }

  /** The frozen receipt when the daemon has one, else what this view counted. */
  private receipt(): TaskReceipt | null {
    const summary = this.detail?.task.summary;
    return summary && typeof summary === "object" ? summary : null;
  }

  private terminalStep(): DurableStep | null {
    const steps = this.detail?.steps ?? [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      if (step.kind.startsWith("task.") && typeof step.body?.summary === "string") return step;
    }
    return null;
  }

  /** The receipt: what a run that has stopped — for good or for now — did. */
  private renderOutcome(task: TaskRecord): void {
    this.approval?.destroy();
    this.approval = null;
    this.surfaceKind = "none";
    this.surface.hidden = true;
    this.surface.replaceChildren();
    this.left.replaceChildren();
    this.feed.remove();
    this.factsEl?.remove();
    this.factsEl = null;

    const terminal = this.terminalStep();
    const summary = typeof terminal?.body.summary === "string" ? terminal.body.summary : null;
    const copy = this.outcome(task);
    const scroll = appendTextChild(this.left, "div", "", "done-scroll");
    scroll.dataset.outcome = copy.kind;

    const head = appendTextChild(scroll, "div", "", "done-h");
    if (copy.kind === "done") head.append(checkMark());
    appendTextChild(head, "h1", copy.heading, "t-title");

    // The lede is the REASON, not a shrug. On Done it is only drawn when the
    // model wrote no summary of its own; on the two that did not finish it is
    // the whole point of the screen and is always drawn.
    if (copy.kind !== "done" || !summary) {
      appendTextChild(scroll, "p", copy.lede, "done-lede");
    }

    // A stringified runner error is not a result: it goes behind a details row
    // so the screen leads with what happened, not with the exception text.
    if (summary && summary === this.terminalError()) {
      const detail = appendTextChild(scroll, "details", "", "done-detail");
      appendTextChild(detail, "summary", "What the AI reported");
      appendTextChild(detail, "p", summary);
    } else if (summary) {
      renderRich(appendTextChild(scroll, "div", "", "result"), summary);
    }

    this.renderArtifacts(task, scroll);

    if (copy.kind !== "done") this.renderProgressSoFar(scroll);

    const acts = appendTextChild(scroll, "div", "", "done-acts");
    // A paused task can be carried on, so continuing is the offer and starting
    // over is not.
    const paused = copy.kind === "paused";
    const another = document.createElement("button");
    another.type = "button";
    another.className = paused ? "btn" : "btn primary";
    another.textContent = "Start another task";
    another.addEventListener("click", () => navigate("#/"));

    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn";
    again.textContent = copy.againLabel;
    again.addEventListener("click", () => void this.runAgain());

    let resume: HTMLButtonElement | null = null;
    let switchAi: HTMLButtonElement | null = null;
    let resumeLimit: HTMLButtonElement | null = null;
    if (copy.planLimit) {
      // Running it again on the same dry plan just burns another six seconds.
      another.className = "btn";
      switchAi = document.createElement("button");
      switchAi.type = "button";
      switchAi.className = "btn primary";
      switchAi.textContent = "Switch AI connection";
      switchAi.addEventListener("click", () => navigate("#/settings/ai"));
      acts.append(switchAi, again, another);
    } else if (copy.limitReached) {
      // A cap it can be resumed past is not a dead end, so raising it leads
      // and "Run again" — which throws the cap away and starts over — is
      // secondary, same as on a paused task. This outranks the plain Resume
      // below: a task the daemon paused on its budget or its step limit is
      // refused a resume that carries no raise.
      another.className = "btn";
      resumeLimit = document.createElement("button");
      resumeLimit.type = "button";
      resumeLimit.className = "btn primary";
      const spendCap = copy.limitReached === "spend_cap";
      resumeLimit.textContent = spendCap ? "Resume with a higher budget" : "Resume with more steps";
      resumeLimit.addEventListener("click", () =>
        void (spendCap ? this.resumeWithMore() : this.resumeWithMoreSteps()),
      );
      acts.append(resumeLimit, again, another);
    } else if (paused) {
      // Resume is the offer that actually applies here, so it leads and
      // "Run again" — which starts over from nothing — stays secondary.
      resume = document.createElement("button");
      resume.type = "button";
      resume.className = "btn primary";
      resume.textContent = "Resume";
      resume.addEventListener("click", () => void this.resume());
      acts.append(resume, again, another);
    } else {
      acts.append(another, again);
    }

    // "Open result" opens the RESULT: the file the task saved, revealed in
    // Finder by the shell and downloaded by a browser. It used to open the
    // terminal event at the API — a page of raw JSON, over the whole app in the
    // Mac shell — for every task, including ones that saved nothing. A task
    // with no file has no result to open, so there is no button.
    const deliverable = [...this.savedFiles().keys()].pop();
    if (deliverable !== undefined) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn";
      open.textContent = "Open result";
      open.addEventListener("click", () => {
        const shown = modelbotNative.revealFile({
          url: this.fileUrl(task, deliverable),
          path: deliverable,
          resultsDir: task.results_dir ?? null,
        });
        if (!shown) toast("warn", "Couldn’t open that result.");
      });
      acts.append(open);
    }

    if (copy.diagnostics) {
      const diag = document.createElement("button");
      diag.type = "button";
      diag.className = "btn";
      diag.textContent = "Copy diagnostics";
      diag.addEventListener("click", () => void this.copyDiagnostics(task, copy, diag));
      acts.append(diag);
    }

    this.renderReceipt(task);
    (resume ?? switchAi ?? resumeLimit ?? another).focus({ preventScroll: true });
  }

  /**
   * "Files it saved" — the row the product's whole promise rests on.
   *
   * The daemon's frozen receipt is built from the whole audit log and checked
   * against the disk, so when there is one it is the whole list: adding back
   * what this view happened to see would put a file the daemon has just
   * verified is gone straight back on the screen, with a live Open button.
   * Without a receipt, what landed while this view was watching is all there is.
   */
  private savedFiles(): Map<string, string> {
    const receipt = this.receipt();
    const files = new Map<string, string>();
    for (const path of receipt?.files_saved ?? []) {
      if (typeof path === "string" && path) files.set(path, baseName(path));
    }
    if (!receipt) for (const [path, name] of this.facts.files) files.set(path, name);
    return files;
  }

  /** Where the daemon serves one of this task's files. Never navigated to. */
  private fileUrl(task: TaskRecord, path: string): string {
    return `/api/v1/computers/${encodeURIComponent(task.computer_id)}/files?path=${encodeURIComponent(path)}`;
  }

  private renderArtifacts(task: TaskRecord, scroll: HTMLElement): void {
    const files = this.savedFiles();
    if (files.size === 0) return;

    const block = appendTextChild(scroll, "section", "", "artifacts");
    appendTextChild(block, "span", "Files it saved", "caps");
    for (const [path, name] of files) {
      const row = appendTextChild(block, "div", "", "file");
      appendTextChild(row, "span", "", "g").append(icon("file"));
      const who = appendTextChild(row, "span", "", "who");
      appendTextChild(who, "span", name, "n");
      appendTextChild(who, "span", "On its computer, ready to open", "w");

      const href = this.fileUrl(task, path);
      const acts = appendTextChild(row, "span", "", "file-acts");
      // The shell reveals the file in Finder, or downloads it; the browser
      // opens a tab. Nothing here ever navigates the app to an API URL.
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn sm";
      open.textContent = "Open";
      open.addEventListener("click", () => {
        const shown = modelbotNative.revealFile({
          url: href,
          path,
          resultsDir: task.results_dir ?? null,
        });
        if (!shown) toast("warn", "Couldn’t open that file. Copy link still works.");
        // In the Mac shell a file that is gone reveals nothing, downloads
        // nothing and says nothing. Ask the daemon whether it is still there
        // (a HEAD, so no bytes move); if it is not, say so and stop offering it.
        void this.confirmArtifact(href, open, who);
      });
      acts.append(open);

      // Reveal-in-Finder would be a lie: the file is inside its computer, not
      // on the Mac's own disk. A link you can paste anywhere is the honest
      // second action, and it is the one thing this surface can truthfully do.
      const copyLink = document.createElement("button");
      copyLink.type = "button";
      copyLink.className = "btn sm";
      copyLink.textContent = "Copy link";
      copyLink.addEventListener("click", () => {
        void this.toClipboard(new URL(href, location.href).href, copyLink, "Copy link");
      });
      acts.append(copyLink);
    }
  }

  /**
   * Ask the daemon whether a file the receipt offers is still on its computer,
   * and say so on the screen when it is not.
   *
   * `HEAD` so nothing is transferred to answer a yes/no question. Only a real
   * 404 changes anything: a daemon that has just restarted, or a browser with
   * no network, is not evidence that a file is gone, and a wrong "it's gone"
   * on this screen would be the same lie in the other direction.
   */
  private async confirmArtifact(
    href: string,
    open: HTMLButtonElement,
    caption: HTMLElement,
  ): Promise<void> {
    try {
      await apiFetch(href, { method: "HEAD" });
    } catch (error) {
      if (!this.alive || !(error instanceof ApiError) || error.status !== 404) return;
      toast("warn", "This file isn’t here any more.");
      open.disabled = true;
      open.title = "This file isn’t on its computer any more.";
      const where = caption.querySelector<HTMLElement>(".w");
      if (where) where.textContent = "Not on its computer any more";
    }
  }

  /** The last few things it did — the "check what it did" the copy promises. */
  private renderProgressSoFar(scroll: HTMLElement): void {
    const rows = lastActions(collapseFeed(this.sortedItems()));
    if (!rows.length) return;
    const block = appendTextChild(scroll, "section", "", "sofar");
    appendTextChild(block, "span", "What it got done first", "caps");
    const list = appendTextChild(block, "ul", "", "sofar-list");
    for (const row of rows) {
      appendTextChild(list, "li", row.repeat > 1 ? `${row.text} ×${row.repeat}` : row.text);
    }
  }

  /** Everything a support conversation needs, and nothing a screen should show. */
  private async copyDiagnostics(
    task: TaskRecord,
    copy: TerminalCopy,
    button: HTMLButtonElement,
  ): Promise<void> {
    const span = this.span(task);
    const receipt = this.receipt();
    const lines = [
      `ModelBot task ${task.id}`,
      `outcome: ${copy.kind}`,
      `reason: ${this.stopReason() ?? "not recorded"}`,
      `status: ${task.status}`,
      `started: ${task.started_at ?? task.created_at}`,
      `finished: ${task.finished_at ?? span?.to ?? "not recorded"}`,
      `duration_ms: ${task.duration_ms ?? span?.ms ?? "not recorded"}`,
      `steps: ${receipt?.steps ?? this.stepCount()}`,
      `cost_usd: ${receipt?.cost_usd ?? this.facts.usedUsd}`,
      `sites: ${(receipt?.sites ?? [...this.facts.sites]).join(", ") || "none"}`,
      `asks: ${receipt?.asks ?? this.countKind("approval.requested")}`,
    ];
    await this.toClipboard(lines.join("\n"), button, "Copy diagnostics");
  }

  private async toClipboard(text: string, button: HTMLButtonElement | HTMLElement, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Couldn’t copy";
    }
    window.setTimeout(() => {
      button.textContent = label;
    }, 2000);
  }

  /** The right column becomes the receipt — the honest answer to "what did
   *  this cost me" — and the live view becomes the last screen it saw. */
  private renderReceipt(task: TaskRecord): void {
    const panel = this.panel;
    if (!panel) return;
    // Keep the last frame this page received: it is the only copy — the daemon
    // stores no picture, so a later visit gets the empty state instead.
    panel.close(true);
    panel.setPhase("ended");
    panel.setActionsVisible(false, false);

    const head = panel.root.querySelector<HTMLElement>(".side-head");
    const caps = head?.querySelector<HTMLElement>(".caps");
    if (caps) caps.textContent = "What it did";
    // The live label belongs to a live view. This one is a receipt.
    const state = head?.querySelector<HTMLElement>(".state");
    if (state) state.hidden = true;

    const frozen = this.receipt();
    const total = frozen?.steps ?? collapseFeed(this.sortedItems()).length;
    const stepsBtn = document.createElement("button");
    stepsBtn.type = "button";
    stepsBtn.className = "btn sm ghost";
    const stepsLabel = this.facts.partial
      ? `${total} step${total === 1 ? "" : "s"} kept`
      : `All ${total} step${total === 1 ? "" : "s"}`;
    stepsBtn.textContent = stepsLabel;
    let showing = false;
    stepsBtn.addEventListener("click", () => {
      showing = !showing;
      stepsBtn.textContent = showing ? "Back to the result" : stepsLabel;
      const scroll = this.left.querySelector<HTMLElement>(".done-scroll");
      if (showing) {
        this.left.append(this.feed);
        if (scroll) scroll.hidden = true;
        this.renderedRows = [];
        this.renderFeed();
      } else {
        this.feed.remove();
        if (scroll) scroll.hidden = false;
      }
    });
    head?.append(stepsBtn);

    const list = document.createElement("dl");
    list.className = "receipt";
    // A run that did not finish did not spend the time a finished one did, so
    // the word says which of the two this is.
    const kind = terminalKind(task.status);
    const rows: Array<[string, string]> = [
      [
        kind === "done" ? "Time" : "Time before it stopped",
        spanPreciseText(this.span(task), this.items.size)
          ?? "Not recorded for this task",
      ],
      [
        this.facts.budgetKind === "tool_proxy"
          ? "Tool cost"
          : `Cost, on your ${this.facts.provider} plan`,
        this.receiptCostText(),
      ],
      ["Sites it visited", this.receiptSitesText()],
      ["Things it asked you", this.receiptAsksText()],
      // The row the product's promise rests on, and the one a failed run used
      // to drop entirely — leaving no answer at all to "did it save anything?".
      ["Files it saved", this.receiptFilesText()],
      // Whether the profile was actually wiped is checked by the daemon
      // executor, not this screen, so this states only what is true either
      // way rather than a guarantee this view cannot itself verify.
      // Follow-up: once the daemon reports a real wipe result on the record,
      // read that field here instead of this fixed line.
      [
        "Browser profile",
        "The agent uses a separate browser profile for this computer.",
      ],
    ];
    this.receiptCost = null;
    for (const [term, value] of rows) {
      const row = appendTextChild(list, "div", "");
      appendTextChild(row, "dt", term);
      const dd = appendTextChild(row, "dd", value);
      if (term.startsWith("Cost") || term === "Tool cost") this.receiptCost = dd;
    }

    const view = panel.root.querySelector<HTMLElement>(".view");
    panel.root.insertBefore(list, view);

    // "Last screen" always renders: with the frame when there is one, and
    // otherwise with the last page it was on and a calm line saying no picture
    // was kept. Dropping the block entirely leaves the column half empty.
    const lastScreen = document.createElement("div");
    lastScreen.className = "side-head";
    lastScreen.style.marginTop = "var(--space-md)";
    appendTextChild(lastScreen, "span", "Last screen", "caps");
    panel.root.insertBefore(lastScreen, view);

    panel.root.querySelector<HTMLElement>(".view-acts")?.remove();
    if (!panel.hasPainted() && view) {
      view.classList.add("kept-none");
      view.querySelector<HTMLElement>(".screen")?.replaceChildren();
      const site =
        this.receipt()?.sites?.[this.receipt()!.sites.length - 1] ??
        [...this.facts.sites].pop() ??
        null;
      const empty = appendTextChild(view, "div", "", "view-empty");
      appendTextChild(
        empty,
        "p",
        site
          ? `No picture of the last screen was kept. The last page it was on was ${site}.`
          : "No picture of the last screen was kept for this run.",
      );
      const note = panel.root.querySelector<HTMLElement>(".view-note");
      if (note) note.textContent = "Its computer is off until the next task.";
    }
  }

  private renderUnreachable(): void {
    setTitle("Task", { dot: "danger", back: "#/", backLabel: "All tasks" });
    this.left.replaceChildren();
    appendTextChild(this.left, "h1", "We couldn’t open this task", "t-title");
    appendTextChild(
      this.left,
      "p",
      "ModelBot may have restarted. It comes back by itself — try again in a moment.",
      "done-lede",
    );
    const acts = appendTextChild(this.left, "div", "", "done-acts");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn primary";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void this.load());
    const home = document.createElement("button");
    home.type = "button";
    home.className = "btn ghost";
    home.textContent = "All tasks";
    home.addEventListener("click", () => navigate("#/"));
    acts.append(retry, home);
  }
}

let current: TaskView | null = null;

registerView("#/tasks/:id", {
  mount(el, params) {
    current = new TaskView();
    return current.mount(el, params.id ?? "");
  },
  update(params) {
    current?.update(params.id ?? "");
  },
  unmount() {
    current?.unmount();
    current = null;
  },
});

export { TaskView };
