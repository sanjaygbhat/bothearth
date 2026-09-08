import type {
  TakeoverEvent,
  TakeoverState,
  TakeoverTransition,
  TakeoverWireState,
  ToolName,
} from "../types/contracts.ts";

/**
 * Takeover FSM (ARCH §1 + §4 + DECISIONS R2 TTL→PAUSED).
 *
 * Wire names (takeover_status): requested|human|validating|agent|paused|expired|terminated.
 * Durable `paused` after TTL; wire may say `expired` as synonym (not a separate durable state).
 *
 * Enforcement (both sides fail-closed — DECISIONS R2):
 * - Daemon: before dispatching any non-exempt tool, if isTakeoverBusy → E_TAKEOVER_BUSY.
 * - Computer-server: while busy/human, refuse non-relay cmds → E_TAKEOVER_BUSY.
 * - Capture barrier: computer-server stops model-bound frames/inputs BEFORE UI grant ack.
 * - Lease TTL timer: daemon is source of truth; fires `ttl` → paused on both sides.
 * - Resume: UI release → resume_validating; requires re-snapshot + re-mask before agent.
 */
export const TAKEOVER_TRANSITIONS: readonly TakeoverTransition[] = [
  { from: "agent", event: "request", to: "takeover_requested" },
  { from: "takeover_requested", event: "grant", to: "human" },
  { from: "takeover_requested", event: "decline", to: "agent" },
  { from: "paused", event: "decline", to: "agent" },
  { from: "human", event: "release", to: "resume_validating" },
  { from: "resume_validating", event: "validated", to: "agent" },
  { from: "resume_validating", event: "still_sensitive", to: "human" },
  { from: "takeover_requested", event: "ttl", to: "paused" },
  { from: "human", event: "ttl", to: "paused" },
  { from: "resume_validating", event: "ttl", to: "paused" },
  { from: "paused", event: "request", to: "takeover_requested" },
  { from: "agent", event: "stop", to: "terminated" },
  { from: "takeover_requested", event: "stop", to: "terminated" },
  { from: "human", event: "stop", to: "terminated" },
  { from: "resume_validating", event: "stop", to: "terminated" },
  { from: "paused", event: "stop", to: "terminated" },
] as const;

/** States where non-exempt tools must return E_TAKEOVER_BUSY. */
export const TAKEOVER_BUSY_STATES: readonly TakeoverState[] = [
  "takeover_requested",
  "human",
  "resume_validating",
  "paused",
] as const;

/**
 * Tools allowed while busy (ARCH §4).
 * takeover_status + done only (checklist Must #7 — no files_list exemption).
 */
export const TAKEOVER_EXEMPT_TOOLS: readonly ToolName[] = [
  "takeover_status",
  "done",
] as const;

export function toWireState(state: TakeoverState): TakeoverWireState {
  switch (state) {
    case "takeover_requested":
      return "requested";
    case "resume_validating":
      return "validating";
    case "agent":
      return "agent";
    case "human":
      return "human";
    case "paused":
      return "paused";
    case "terminated":
      return "terminated";
    default: {
      const _x: never = state;
      return _x;
    }
  }
}

/** Map wire → durable. `expired` collapses to `paused`. */
export function fromWireState(wire: TakeoverWireState): TakeoverState {
  switch (wire) {
    case "requested":
      return "takeover_requested";
    case "validating":
      return "resume_validating";
    case "agent":
      return "agent";
    case "human":
      return "human";
    case "paused":
    case "expired":
      return "paused";
    case "terminated":
      return "terminated";
    default: {
      const _x: never = wire;
      return _x;
    }
  }
}

export function applyTakeoverTransition(
  state: TakeoverState,
  event: TakeoverEvent,
): TakeoverState | null {
  const hit = TAKEOVER_TRANSITIONS.find((t) => t.from === state && t.event === event);
  return hit ? hit.to : null;
}

export function isTakeoverBusy(state: TakeoverState): boolean {
  return (TAKEOVER_BUSY_STATES as readonly TakeoverState[]).includes(state);
}

export function isTakeoverExemptTool(name: ToolName): boolean {
  return (TAKEOVER_EXEMPT_TOOLS as readonly ToolName[]).includes(name);
}

/** Persist CS post-validate state after HTTP /release. still_sensitive stays human. */
export function durableStateAfterRelease(data: unknown): TakeoverState {
  if (!data || typeof data !== "object") return "agent";
  const state = (data as { state?: unknown }).state;
  if (state === "human") return "human";
  if (state === "validating" || state === "resume_validating") return "resume_validating";
  return "agent";
}
