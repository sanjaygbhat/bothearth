/**
 * A model provider can be signed in and unusable at the same time: `codex
 * login status` still exits 0 while the plan's quota is spent, so the sign-in
 * probe reports "connected" and the owner burns one six-second task after
 * another. The only witness is the text the CLI printed when the task died.
 *
 * This classifies that text — the provider's own wording, never an exit code
 * on its own and never a guess — and holds the refusal until the provider's
 * own reset time passes or a later call goes through.
 */

export type ProviderLimitReason = "quota_exhausted" | "rate_limited";

export interface ProviderLimit {
  reason: ProviderLimitReason;
  /** The reset the provider named, ISO. Null when it named none. */
  resets_at: string | null;
}

/** Plan/quota exhaustion: waiting is the only fix. Checked before the rate limits. */
const QUOTA = [
  /you'?ve hit your usage limit/i,
  /usage limit reached/i,
  /exceeded your current quota/i,
  /insufficient_quota/i,
  /credit balance is too low/i,
  /plan limit/i,
];

/** Throttling: the same call usually works again shortly. */
const RATE = [/rate[ _-]?limit/i, /too many requests/i, /\b429\b/];

/** Codex CLI: "…or try again at Sep 11th, 2026 5:21 PM." */
const CODEX_RESET = /try again at ([A-Za-z]{3,9} \d{1,2})(?:st|nd|rd|th)?(, \d{4} \d{1,2}:\d{2} ?[AP]M)/i;

/** Claude Code: "Claude AI usage limit reached|1757251260" (unix seconds). */
const CLAUDE_RESET = /usage limit reached\|(\d{10})\b/;

function parseReset(text: string): string | null {
  const codex = CODEX_RESET.exec(text);
  if (codex) {
    const at = Date.parse(`${codex[1]}${codex[2]}`);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  const claude = CLAUDE_RESET.exec(text);
  return claude ? new Date(Number(claude[1]) * 1000).toISOString() : null;
}

/** Null when the failure was not the provider refusing for quota or rate. */
export function classifyProviderLimit(text: string): ProviderLimit | null {
  if (!text) return null;
  const reason: ProviderLimitReason | null = QUOTA.some((re) => re.test(text))
    ? "quota_exhausted"
    : RATE.some((re) => re.test(text))
      ? "rate_limited"
      : null;
  return reason ? { reason, resets_at: parseReset(text) } : null;
}

/**
 * How long a refusal that named no reset is believed. Long enough that the
 * owner is not invited to burn another task straight away, short enough that
 * ModelBot recovers by itself from a provider hiccup.
 */
const UNDATED_TTL_MS = 60_000;

export interface ProviderLimits {
  record(provider: "codex" | "claude", limit: ProviderLimit): void;
  /** The provider answered: forget the refusal. */
  clear(provider: "codex" | "claude"): void;
  /** The live refusal, or null once its reset time has passed. */
  get(provider: "codex" | "claude"): ProviderLimit | null;
}

export function createProviderLimits(now: () => number = Date.now): ProviderLimits {
  const held = new Map<string, { limit: ProviderLimit; until: number }>();
  return {
    record(provider, limit) {
      const reset = limit.resets_at ? Date.parse(limit.resets_at) : Number.NaN;
      held.set(provider, {
        limit,
        until: Number.isFinite(reset) ? reset : now() + UNDATED_TTL_MS,
      });
    },
    clear(provider) {
      held.delete(provider);
    },
    get(provider) {
      const entry = held.get(provider);
      if (!entry) return null;
      if (now() >= entry.until) {
        held.delete(provider);
        return null;
      }
      return entry.limit;
    },
  };
}

/** Additive `task.failed` / pause fields, so the UI can say why instead of guessing. */
export function providerLimitFields(limit: ProviderLimit | null): Record<string, string> {
  if (!limit) return {};
  return {
    provider_limit_reason: limit.reason,
    ...(limit.resets_at ? { provider_limit_resets_at: limit.resets_at } : {}),
  };
}

/** Pause copy for a native task the provider refused for quota or rate. */
export function providerLimitPauseDetail(
  provider: "codex" | "claude",
  limit: ProviderLimit,
): string {
  const plan = provider === "codex" ? "Codex" : "Claude";
  const reset = limit.resets_at ? `; resets at ${limit.resets_at}` : "";
  if (limit.reason === "rate_limited") {
    return `Your ${plan} plan is rate-limited${reset}.`;
  }
  return `Your ${plan} plan’s usage limit is reached${reset}.`;
}

/**
 * Buckets a stopped task's `reason` into something the UI can switch on
 * instead of matching strings itself. A timeout waiting for a person, an
 * approval that lapsed, and a provider refusal are not this machine's fault;
 * "model_error" is the model's own `done(status:"fail")` verdict, not an
 * exception here — only a caller that saw that verdict may pass it in.
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

const REASON_KIND: Record<string, FailureKind> = {
  spend_cap: "spend_cap",
  max_steps: "max_steps",
  max_runtime: "max_runtime",
  stall: "stalled",
  loop_detected: "loop",
  takeover: "waiting_for_you",
  approval: "waiting_for_you",
};

export function classifyFailureKind(
  reason: string,
  limit: ProviderLimit | null,
  override?: FailureKind,
): FailureKind {
  if (override) return override;
  if (limit) return "provider_limit";
  return REASON_KIND[reason] ?? "machine";
}
