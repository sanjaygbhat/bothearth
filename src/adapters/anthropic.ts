import type {
  AdapterCompleteRequest,
  AdapterCompleteResponse,
  AdapterEndpointConfig,
  AdapterMessage,
  AdapterToolCall,
  ProviderAdapter,
} from "../types/contracts.ts";
import {
  adapterFetchTimeoutMs,
  DEFAULT_ADAPTER_FETCH_TIMEOUT_MS,
  estimateUsd,
  finiteNumber,
  textOnly,
  trimEndSlash,
} from "./openai-compatible.ts";

export interface AnthropicAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  pricePerMtokIn?: number;
  pricePerMtokOut?: number;
  extra?: Record<string, unknown>;
  fetch?: typeof globalThis.fetch;
  /** Per-fetch abort timeout. Default agent.stall_sec (120 s), floor 10 s. */
  timeoutMs?: number;
}

interface AnthropicResponse {
  content?: Array<{
    type?: unknown;
    text?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
  }>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = "anthropic" as const;
  private readonly opts: AnthropicAdapterOptions;

  constructor(opts: AnthropicAdapterOptions = {}) {
    const extra = opts.extra ? { ...opts.extra } : undefined;
    if (extra) {
      delete extra.timeout_ms;
      delete extra.stall_sec;
    }
    this.opts = {
      ...opts,
      extra,
      timeoutMs: adapterFetchTimeoutMs(opts),
    };
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    const messages: Record<string, unknown>[] = [];
    for (const message of req.messages) {
      if (message.role === "system") continue;
      messages.push(this.toProviderMessage(message));
    }
    const body: Record<string, unknown> = {
      model: req.model,
      system: req.system,
      max_tokens: 4096,
      messages,
      tools: req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      ...this.opts.extra,
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.opts.apiKey) headers["x-api-key"] = this.opts.apiKey;
    const fetcher = this.opts.fetch ?? globalThis.fetch;
    const base = trimEndSlash(this.opts.baseUrl ?? "https://api.anthropic.com");
    const response = await fetcher(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_ADAPTER_FETCH_TIMEOUT_MS), ...(req.signal ? [req.signal] : [])]),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic request failed (${response.status}): ${raw.slice(0, 512)}`);
    }
    let payload: AnthropicResponse;
    try {
      payload = JSON.parse(raw) as AnthropicResponse;
    } catch {
      throw new Error("Anthropic endpoint returned invalid JSON");
    }
    const text = (payload.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    const toolCalls = (payload.content ?? [])
      .filter((part) => part.type === "tool_use")
      .map((part, index) => {
        if (typeof part.name !== "string" || part.name.length === 0) {
          throw new Error("Anthropic tool_use is missing a name");
        }
        return {
          id: typeof part.id === "string" ? part.id : `toolu_${index}`,
          name: part.name,
          arguments:
            part.input && typeof part.input === "object" && !Array.isArray(part.input)
              ? (part.input as Record<string, unknown>)
              : {},
        };
      });
    const tokensIn = finiteNumber(payload.usage?.input_tokens);
    const tokensOut = finiteNumber(payload.usage?.output_tokens);
    const usd = estimateUsd(
      tokensIn,
      tokensOut,
      this.opts.pricePerMtokIn,
      this.opts.pricePerMtokOut,
    );
    return {
      ...(text ? { content: text } : {}),
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
      const content =
        typeof message.content === "string" ? message.content : textOnly(message.content);
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "unknown",
            content,
          },
        ],
      };
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const internalCalls = (message as AdapterMessage & {
      tool_calls?: AdapterToolCall[];
    }).tool_calls;
    if (role === "assistant" && internalCalls?.length) {
      const content: Record<string, unknown>[] = [];
      const text =
        typeof message.content === "string" ? message.content : textOnly(message.content);
      if (text) content.push({ type: "text", text });
      content.push(
        ...internalCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        })),
      );
      return { role, content };
    }
    if (typeof message.content === "string") return { role, content: message.content };
    return {
      role,
      content: message.content
        .filter((part) => part.type === "text")
        .map((part) => ({ type: "text", text: part.text })),
    };
  }
}

export function createAnthropicAdapter(
  opts: AnthropicAdapterOptions = {},
): AnthropicAdapter {
  return new AnthropicAdapter(opts);
}

export function anthropicOptionsFromConfig(
  config: AdapterEndpointConfig,
  apiKey?: string,
): AnthropicAdapterOptions {
  return {
    baseUrl: config.base_url,
    apiKey,
    pricePerMtokIn: config.price_per_mtok_in,
    pricePerMtokOut: config.price_per_mtok_out,
    extra: config.extra,
    timeoutMs: adapterFetchTimeoutMs({ extra: config.extra }),
  };
}
