import { randomBytes } from "node:crypto";
import type {
  TakeoverEvent,
  TakeoverState,
  TakeoverWireState,
  ToolName,
  ToolResult,
} from "../../src/types/contracts.ts";
import {
  applyTakeoverTransition,
  isTakeoverBusy,
  isTakeoverExemptTool,
  toWireState,
} from "../../src/protocol/takeover.ts";
import { toolError } from "../../src/protocol/errors.ts";
import type { SensitiveField } from "./redact.ts";

export interface TakeoverSession {
  state: TakeoverState;
  takeoverId: string | null;
  expiresAt: string | null;
  epoch: number;
  reason: string | null;
  /** The credential field on screen when control was asked for, if any. */
  field: SensitiveField | null;
}

export function createTakeoverSession(): TakeoverSession {
  return {
    state: "agent",
    takeoverId: null,
    expiresAt: null,
    epoch: 1,
    reason: null,
    field: null,
  };
}

function busyResult(session: TakeoverSession): ToolResult {
  return toolError("E_TAKEOVER_BUSY", undefined, {
    takeover_id: session.takeoverId ?? "tk_unknown",
    state: toWireState(session.state),
    expires_at: session.expiresAt,
  });
}

const RELAY = new Set([
  "live.pointer",
  "live.key",
  "live.text",
  "takeover.grant",
  "takeover.request",
  "takeover.release",
  "takeover.decline",
  "takeover.validate",
  "takeover.ttl",
  "takeover.sync",
  "takeover.masked-observation",
  "screencast.subscribe",
  "screencast.unsubscribe",
  "quarantine.list",
  "quarantine.promote",
  "takeover_status",
  // Read-only introspection: the daemon asking what this computer can run is
  // never an action on the page, so it must not be refused mid-takeover.
  "methods",
]);

const LIVE_RELAY = new Set(["live.pointer", "live.key", "live.text"]);

const TTL_MS = 600_000;

/** The human's clock: it starts at grant, and their own input pushes it out. */
function renew(session: TakeoverSession): void {
  session.expiresAt = new Date(Date.now() + TTL_MS).toISOString();
}

function isRelayOrControl(method: string): boolean {
  return RELAY.has(method);
}

export function gateMethod(
  session: TakeoverSession,
  method: string,
  relayEpoch: number | null = null,
): ToolResult | null {
  if (LIVE_RELAY.has(method)) {
    if (session.state !== "human" || relayEpoch !== session.epoch) {
      return busyResult(session);
    }
    renew(session);
    return null;
  }
  if (!isTakeoverBusy(session.state)) return null;
  if (isRelayOrControl(method)) return null;
  if (isTakeoverExemptTool(method as ToolName)) return null;
  return busyResult(session);
}

export function transition(
  session: TakeoverSession,
  event: TakeoverEvent,
): TakeoverState | null {
  const next = applyTakeoverTransition(session.state, event);
  if (!next) return null;
  session.state = next;
  if (event === "request") {
    session.takeoverId = `tk_${randomBytes(6).toString("hex")}`;
    session.epoch += 1;
  }
  if (next === "human") {
    renew(session);
  }
  if (event === "decline") {
    session.epoch += 1;
  }
  if (next === "agent") {
    session.takeoverId = null;
    session.expiresAt = null;
    session.reason = null;
    session.field = null;
  }
  return next;
}

export function statusPayload(session: TakeoverSession): {
  state: TakeoverWireState;
  /** Null until the grant: an unanswered question has no deadline of its own. */
  expires_at: string | null;
  takeover_id: string;
  epoch: number;
  /** Why a person was asked, and for which field — null once control is back. */
  reason: string | null;
  field: SensitiveField | null;
} {
  return {
    state: toWireState(session.state),
    expires_at: session.expiresAt,
    takeover_id: session.takeoverId ?? "",
    epoch: session.epoch,
    reason: session.reason,
    field: session.field,
  };
}
