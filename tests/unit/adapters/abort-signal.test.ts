import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic.ts";
import {
  adapterFetchTimeoutMs,
  createOpenAICompatibleAdapter,
  MIN_ADAPTER_FETCH_TIMEOUT_MS,
} from "../../../src/adapters/openai-compatible.ts";

function openaiOk(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok", tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );
}

function anthropicOk(): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200 },
  );
}

describe("adapter fetch AbortSignal", () => {
  it("OpenAI fetch spy receives a signal", async () => {
    let signal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      signal = init?.signal ?? undefined;
      return openaiOk();
    };
    await createOpenAICompatibleAdapter({ fetch }).complete({
      system: "s",
      messages: [],
      tools: [],
      model: "fixture",
    });
    assert.ok(signal instanceof AbortSignal);
  });

  it("Anthropic fetch spy receives a signal", async () => {
    let signal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      signal = init?.signal ?? undefined;
      return anthropicOk();
    };
    await createAnthropicAdapter({ fetch }).complete({
      system: "s",
      messages: [],
      tools: [],
      model: "fixture-claude",
    });
    assert.ok(signal instanceof AbortSignal);
  });

  it("timeout floors at 10s and follows stall_sec", () => {
    assert.equal(adapterFetchTimeoutMs({ extra: { stall_sec: 5 } }), MIN_ADAPTER_FETCH_TIMEOUT_MS);
    assert.equal(adapterFetchTimeoutMs({ extra: { stall_sec: 120 } }), 120_000);
    assert.equal(adapterFetchTimeoutMs({ timeoutMs: 15_000 }), 15_000);
  });
});
