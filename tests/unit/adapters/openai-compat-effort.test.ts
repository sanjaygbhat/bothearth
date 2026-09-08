import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfigDoc, withDefaults } from "../../../src/config/load.ts";
import type { ModelbotConfig } from "../../../src/types/contracts.ts";
import {
  createOpenAICompatibleAdapter,
  openAICompatibleOptionsFromConfig,
} from "../../../src/adapters/openai-compatible.ts";

const EXAMPLE_PATH = fileURLToPath(new URL("../../../src/config/example.yaml", import.meta.url));

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok", tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200 },
  );
}

function documentedOpenAiDefault(): { model: string; extra: Record<string, unknown> } {
  const config = loadConfigDoc(EXAMPLE_PATH) as unknown as ModelbotConfig;
  const defaults = withDefaults({}) as ModelbotConfig;
  assert.equal(config.adapters.openai_compat.model, defaults.adapters.openai_compat.model);
  return { model: config.adapters.openai_compat.model, extra: config.adapters.openai_compat.extra ?? {} };
}

describe("Chat Completions gpt-5.6 refuse + effort mapping", () => {
  it("refuses gpt-5.10, gpt-6, and vendor-prefixed gpt-5.6-sol", () => {
    const fetch: typeof globalThis.fetch = async () => okResponse();
    for (const model of ["gpt-5.10", "gpt-6", "openai/gpt-5.6-sol"]) {
      assert.throws(
        () => createOpenAICompatibleAdapter({ model, fetch }),
        /cannot be used on the Chat Completions path/,
        model,
      );
    }
    assert.doesNotThrow(() =>
      createOpenAICompatibleAdapter({ model: "gpt-5.5", fetch }),
    );
  });

  it("refuses gpt-5.6-sol at construction before fetch", () => {
    let called = 0;
    const fetch: typeof globalThis.fetch = async () => {
      called += 1;
      return okResponse();
    };
    assert.throws(
      () => createOpenAICompatibleAdapter({ model: "gpt-5.6-sol", fetch }),
      /Responses adapter \(not yet shipped\)/,
    );
    assert.equal(called, 0);
  });

  it("refuses gpt-5.6-family complete() before fetch", async () => {
    let called = 0;
    const fetch: typeof globalThis.fetch = async () => {
      called += 1;
      return okResponse();
    };
    const adapter = createOpenAICompatibleAdapter({ fetch });
    await assert.rejects(
      () =>
        adapter.complete({
          system: "s",
          messages: [],
          tools: [],
          model: "gpt-5.6-terra",
        }),
      /Chat Completions path/,
    );
    assert.equal(called, 0);
  });

  it("config gpt-5.6-sol throws at adapter construction (start path)", () => {
    assert.throws(
      () =>
        createOpenAICompatibleAdapter(
          openAICompatibleOptionsFromConfig({ model: "gpt-5.6-sol", extra: { effort: "high" } }),
        ),
      /cannot be used on the Chat Completions path/,
    );
  });

  it("maps extra.effort high to reasoning_effort and omits effort", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return okResponse();
    };
    const adapter = createOpenAICompatibleAdapter({
      model: "gpt-5.5",
      extra: { effort: "high" },
      fetch,
    });
    await adapter.complete({
      system: "s",
      messages: [],
      tools: [],
      model: "gpt-5.5",
    });
    assert.equal(body?.reasoning_effort, "high");
    assert.equal("effort" in (body ?? {}), false);
  });

  it("throws at construction on an out-of-enum effort", () => {
    assert.throws(
      () => createOpenAICompatibleAdapter({ extra: { effort: "turbo" } }),
      /extra\.effort=turbo is not an effort this API has/,
    );
  });

  it("public configuration default completes without refusal", async () => {
    const documented = documentedOpenAiDefault();
    assert.equal(documented.model, "gpt-5.5");
    assert.doesNotMatch(documented.model, /^gpt-5\.[6-9]/);
    let called = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      called += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, documented.model);
      if (documented.extra.effort === "high") assert.equal(body.reasoning_effort, "high");
      return okResponse();
    };
    const adapter = createOpenAICompatibleAdapter({
      model: documented.model,
      extra: documented.extra,
      fetch,
    });
    const response = await adapter.complete({
      system: "s",
      messages: [],
      tools: [],
      model: documented.model,
    });
    assert.equal(response.content, "ok");
    assert.equal(called, 1);
  });
});
