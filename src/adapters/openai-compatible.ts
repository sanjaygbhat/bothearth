import type {
  AdapterCompleteRequest,
  AdapterCompleteResponse,
  AdapterContentPart,
  AdapterEndpointConfig,
  AdapterMessage,
  AdapterToolCall,
  ProviderAdapter,
} from "../types/contracts.ts";

export interface OpenAICompatibleAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  pricePerMtokIn?: number;
  pricePerMtokOut?: number;
  extra?: Record<string, unknown>;
  fetch?: typeof globalThis.fetch;
  /** Configured model; refused at construction for gpt-5.6+ on Completions. */
  model?: string;
  /** Per-fetch abort timeout. Default agent.stall_sec (120 s), floor 10 s. */
  timeoutMs?: number;
}

interface OpenAIToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

/** gpt-5.6+ refuses function tools on `/chat/completions`. Major.minor after optional vendor prefix. */
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?/i;

function chatCompletionsRefusedModel(model: string): boolean {
  const leaf = model.trim().split("/").pop() ?? model;
  const m = GPT_VERSION.exec(leaf);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major > 5 || (major === 5 && minor >= 6);
}

/** Matches docs/ARCHITECTURE.md agent.stall_sec default. */
export const DEFAULT_ADAPTER_FETCH_TIMEOUT_MS = 120_000;
export const MIN_ADAPTER_FETCH_TIMEOUT_MS = 10_000;

function positiveMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Timeout for adapter `fetch`. Sized from stall_sec / timeout_ms, never below 10 s. */
export function adapterFetchTimeoutMs(opts: {
  timeoutMs?: number;
  extra?: Record<string, unknown>;
}): number {
  const extra = opts.extra ?? {};
  const stallSec = positiveMs(extra.stall_sec);
  const resolved =
    positiveMs(opts.timeoutMs) ??
    positiveMs(extra.timeout_ms) ??
    (stallSec !== undefined ? stallSec * 1000 : undefined) ??
    DEFAULT_ADAPTER_FETCH_TIMEOUT_MS;
  return Math.max(MIN_ADAPTER_FETCH_TIMEOUT_MS, resolved);
}

/** OpenAI reasoning_effort values. Ported from OpenBot `agent-langgraph/src/model-options.ts`. */
const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function assertChatCompletionsModel(model: string): void {
  if (!chatCompletionsRefusedModel(model)) return;
  throw new Error(
    `${model} cannot be used on the Chat Completions path. ` +
      "That endpoint refuses function tools for gpt-5.6+ models, so every tool-using step would fail with no reply. " +
      "Use a Completions-compatible model (for example gpt-5.5). " +
      "gpt-5.6-sol requires the Responses adapter (not yet shipped).",
  );
}

function mappedExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return extra;
  const {
    effort,
    reasoning_effort: existingEffort,
    timeout_ms: _timeoutMs,
    stall_sec: _stallSec,
    ...rest
  } = extra;
  const raw = effort ?? existingEffort;
  if (raw === undefined) return rest;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(
      `extra.effort=${String(raw)} is not an effort this API has. Use one of: ${REASONING_EFFORTS.join(", ")}.`,
    );
  }
  return { ...rest, reasoning_effort: value };
}

export function trimEndSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function estimateUsd(
  tokensIn: number,
  tokensOut: number,
  priceIn: number | undefined,
  priceOut: number | undefined,
): number | undefined {
  if (priceIn === undefined && priceOut === undefined) return undefined;
  return (tokensIn * (priceIn ?? 0) + tokensOut * (priceOut ?? 0)) / 1_000_000;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error("provider returned invalid tool arguments JSON");
  }
}

export function textOnly(parts: AdapterContentPart[]): string {
  return parts
    .filter((part): part is Extract<AdapterContentPart, { type: "text" }> =>
      part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind = "openai_compat" as const;
  private readonly opts: OpenAICompatibleAdapterOptions;

    constructor(opts: OpenAICompatibleAdapterOptions = {}) {
    if (opts.model !== undefined) assertChatCompletionsModel(opts.model);
    this.opts = {
      ...opts,
      extra: mappedExtra(opts.extra),
      timeoutMs: adapterFetchTimeoutMs(opts),
    };
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    assertChatCompletionsModel(req.model);
    const messages: Record<string, unknown>[] = [
      { role: "system", content: req.system },
    ];
    for (const message of req.messages) {
      if (message.role === "system") continue;
      messages.push(this.toProviderMessage(message));
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: false,
      ...this.opts.extra,
      tools: req.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: "auto",
    };

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const fetcher = this.opts.fetch ?? globalThis.fetch;
    const base = trimEndSlash(this.opts.baseUrl ?? "https://api.openai.com/v1");
    const response = await fetcher(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_ADAPTER_FETCH_TIMEOUT_MS), ...(req.signal ? [req.signal] : [])]),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI-compatible request failed (${response.status}): ${raw.slice(0, 512)}`);
    }
    let payload: OpenAIResponse;
    try {
      payload = JSON.parse(raw) as OpenAIResponse;
    } catch {
      throw new Error("OpenAI-compatible endpoint returned invalid JSON");
    }
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI-compatible response has no message");
    const content = typeof message.content === "string" ? message.content : undefined;
    const toolCalls = (message.tool_calls ?? []).map((call, index) => {
      const name = call.function?.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("provider tool call is missing a name");
      }
      return {
        id: typeof call.id === "string" ? call.id : `call_${index}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      };
    });
    const tokensIn = finiteNumber(payload.usage?.prompt_tokens);
    const tokensOut = finiteNumber(payload.usage?.completion_tokens);
    const usd = estimateUsd(
      tokensIn,
      tokensOut,
      this.opts.pricePerMtokIn,
      this.opts.pricePerMtokOut,
    );
    return {
      ...(content ? { content } : {}),
      tool_calls: toolCalls,
      usage: {
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        ...(usd !== undefined ? { usd_est: usd } : {}),
      },
    };
  }

  private toProviderMessage(message: AdapterMessage): Record<string, unknown> {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id ?? "unknown",
        content:
          typeof message.content === "string" ? message.content : textOnly(message.content),
      };
    }
    const internalCalls = (message as AdapterMessage & {
      tool_calls?: AdapterToolCall[];
    }).tool_calls;
    if (message.role === "assistant" && internalCalls?.length) {
      return {
        role: "assistant",
        content: typeof message.content === "string" ? message.content || null : textOnly(message.content),
        tool_calls: internalCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: message.content
        .filter((part) => part.type === "text")
        .map((part) => ({ type: "text", text: part.text })),
    };
  }
}

export function createOpenAICompatibleAdapter(
  opts: OpenAICompatibleAdapterOptions = {},
): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter(opts);
}

export function openAICompatibleOptionsFromConfig(
  config: AdapterEndpointConfig,
  apiKey?: string,
): OpenAICompatibleAdapterOptions {
  return {
    baseUrl: config.base_url,
    apiKey,
    pricePerMtokIn: config.price_per_mtok_in,
    pricePerMtokOut: config.price_per_mtok_out,
    extra: config.extra,
    model: config.model,
    timeoutMs: adapterFetchTimeoutMs({ extra: config.extra }),
  };
}
