import type { ErrorCode } from "../types/contracts.ts";

/** ARCH §4 common error table. */
export const ERROR_CODES = [
  "E_AUTH",
  "E_CAPABILITY",
  "E_SPEND_CAP",
  "E_POLICY",
  "E_POLICY_PENDING",
  "E_STALE_REF",
  "E_TIMEOUT",
  "E_TAKEOVER_BUSY",
  "E_TAKEOVER_EXPIRED",
  "E_SANDBOX_DEAD",
  "E_IO",
  "E_LIMIT",
] as const satisfies readonly ErrorCode[];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  E_AUTH: "Authentication failed or missing credential.",
  E_CAPABILITY: "Computer or task lacks required capability.",
  E_SPEND_CAP: "Harness MCP tool-call proxy reached the task spend cap.",
  E_POLICY: "Policy denied the action.",
  E_POLICY_PENDING: "Action gated; poll approval status.",
  E_STALE_REF: "Snapshot ref is stale; re-snapshot and retry.",
  E_TIMEOUT: "Operation timed out.",
  E_TAKEOVER_BUSY:
    "Human has control. Poll takeover_status until state=\"agent\", then re-snapshot.",
  E_TAKEOVER_EXPIRED: "Takeover lease expired (paused).",
  E_SANDBOX_DEAD: "Sandbox computer is not running.",
  E_IO: "I/O error.",
  E_LIMIT: "Result or resource limit exceeded.",
};

export function toolError(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
  return {
    ok: false,
    error: {
      code,
      message: message ?? ERROR_MESSAGES[code],
      ...(details ? { details } : {}),
    },
  };
}

const TARGET_CRASHED = /target crashed/i;

/** Model-facing copy when Playwright reports `Target crashed`. No takeover ask. */
export const TAB_CRASH_MESSAGE = "The tab crashed. Call browser_navigate to reload it.";

export function browserIoError(err: unknown): {
  ok: false;
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
} {
  const text = err instanceof Error ? err.message : String(err);
  return toolError("E_IO", TARGET_CRASHED.test(text) ? TAB_CRASH_MESSAGE : text);
}

export function isTargetCrashed(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return TARGET_CRASHED.test(text);
}
