import type { AdapterMessage, AdapterToolCall } from "../types/contracts.ts";

/** ARCH §3 / schema defaults. */
export const DEFAULT_CONTEXT_TOKENS_MAX = 120_000;
export const DEFAULT_COMPACT_AT = 0.6;
/** Last 3 tool observations are kept verbatim. */
const DEFAULT_KEEP_TOOL_OBS = 3;

export function compactTokenThreshold(contextTokensMax: number, compactAt: number): number {
  if (!(compactAt > 0) || !(contextTokensMax > 0)) return Number.POSITIVE_INFINITY;
  return Math.floor(contextTokensMax * compactAt);
}

export function inputTokensExceedCompactAt(
  tokensIn: number,
  contextTokensMax: number,
  compactAt: number,
): boolean {
  return tokensIn > compactTokenThreshold(contextTokensMax, compactAt);
}

interface CompactResult {
  compacted: boolean;
  removed: number;
}

/**
 * Deterministic truncation (no LLM): keep last N `role:tool` messages
 * verbatim, replace older turns with one assistant note. System prompt
 * stays outside `messages` (passed as `complete({ system })`).
 */
export function compactTranscript(
  messages: AdapterMessage[],
  keepToolObs = DEFAULT_KEEP_TOOL_OBS,
): CompactResult {
  const keep = Math.max(1, keepToolObs);
  const toolAt: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role === "tool") toolAt.push(i);
  }
  let keepFrom: number;
  if (toolAt.length > 0) {
    keepFrom = toolAt[Math.max(0, toolAt.length - keep)]!;
    const toolCallId = messages[keepFrom]!.tool_call_id;
    for (let i = keepFrom - 1; i >= 0; i -= 1) {
      const message = messages[i]! as AdapterMessage & { tool_calls?: AdapterToolCall[] };
      if (
        message.role === "assistant" &&
        message.tool_calls?.some((call) => call.id === toolCallId)
      ) {
        keepFrom = i;
        break;
      }
    }
  } else if (messages.length > keep) {
    keepFrom = messages.length - keep;
  } else {
    return { compacted: false, removed: 0 };
  }
  if (keepFrom <= 0) return { compacted: false, removed: 0 };
  const removed = messages.splice(0, keepFrom);
  messages.unshift({
    role: "assistant",
    content:
      `[compacted] ${removed.length} earlier messages replaced by deterministic truncation. ` +
      `Original goal stands. Last ${keep} tool observations kept verbatim.`,
  });
  return { compacted: true, removed: removed.length };
}
