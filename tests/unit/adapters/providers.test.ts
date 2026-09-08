import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createOpenAICompatibleAdapter } from "../../../src/adapters/openai-compatible.ts";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic.ts";
import { TOOL_CATALOGUE } from "../../../src/tools/catalog.ts";
import { startMockOpenAI } from "../../fixtures/mock-openai.ts";
import {
  startMockAnthropic,
  type MockAnthropicHandle,
} from "../../fixtures/mock-anthropic.ts";

const handles: Array<{ close(): Promise<void> }> = [];

type TestEndpoint = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  close(): Promise<void>;
};

async function openAIEndpoint(): Promise<TestEndpoint> {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED !== "1") {
    return startMockOpenAI();
  }
  return {
    baseUrl: "http://mock-openai.local",
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_nav",
                    function: {
                      name: "browser_navigate",
                      arguments: JSON.stringify({
                        url: "https://fixture.local/",
                        wait_until: null,
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      ),
    async close() {},
  };
}

async function anthropicEndpoint(): Promise<MockAnthropicHandle & { fetch?: typeof globalThis.fetch }> {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED !== "1") {
    return startMockAnthropic();
  }
    const requests: Array<Record<string, unknown>> = [];
    return {
      server: null as unknown as MockAnthropicHandle["server"],
      baseUrl: "http://mock-anthropic.local",
      requests,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "using the browser" },
              {
                type: "tool_use",
                id: "toolu_fixture",
                name: "browser_snapshot",
                input: { scope: null, interactive_only: true, depth: null, max_chars: null },
              },
            ],
            usage: { input_tokens: 20, output_tokens: 7 },
          }),
          { status: 200 },
        );
      },
      async close() {},
    };
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("provider adapters", () => {
  it("translates OpenAI-compatible tools, calls, usage, and configured price", async () => {
    const mock: TestEndpoint = await openAIEndpoint();
    handles.push(mock);
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: "fake-key",
      pricePerMtokIn: 4,
      pricePerMtokOut: 20,
      fetch: mock.fetch,
    });
    const response = await adapter.complete({
      system: "safe system",
      messages: [{ role: "user", content: "open fixture" }],
      tools: TOOL_CATALOGUE,
      model: "fixture-model",
    });
    assert.equal(response.tool_calls[0]?.name, "browser_navigate");
    assert.deepEqual(response.tool_calls[0]?.arguments, {
      url: "https://fixture.local/",
      wait_until: null,
    });
    assert.deepEqual(response.usage, {
      tokens_in: 10,
      tokens_out: 5,
      usd_est: 0.00014,
    });
  });

  it("translates Anthropic tool schemas, tool_use, and usage", async () => {
    const mock = await anthropicEndpoint();
    handles.push(mock);
    const response = await createAnthropicAdapter({
      baseUrl: mock.baseUrl,
      apiKey: "fake-key",
      pricePerMtokIn: 2,
      pricePerMtokOut: 10,
      fetch: mock.fetch,
    }).complete({
      system: "safe system",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "look" }],
        },
      ],
      tools: TOOL_CATALOGUE,
      model: "fixture-claude",
    });
    assert.equal(response.tool_calls[0]?.name, "browser_snapshot");
    assert.equal(response.content, "using the browser");
    assert.equal(response.usage.usd_est, 0.00011);
    const request = mock.requests[0]!;
    assert.equal(request.system, "safe system");
    const tools = request.tools as Array<Record<string, unknown>>;
    assert.ok(tools[0]?.input_schema);
    const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]?.content, [{ type: "text", text: "look" }]);
  });
});
