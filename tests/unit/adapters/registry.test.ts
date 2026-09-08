/** The provider seam: a contributor adds one file plus one register call. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAdapter,
  registerAdapter,
  registeredAdapterNames,
} from "../../../src/adapters/index.ts";
import type { AdapterEndpointConfig } from "../../../src/types/contracts.ts";

const endpoint: AdapterEndpointConfig = { model: "test-model" };

describe("adapter registry", () => {
  it("ships the two built-in providers", () => {
    assert.deepEqual(registeredAdapterNames(), ["openai_compat", "anthropic"]);
  });

  it("builds a built-in adapter whose kind is its registered name", () => {
    const adapter = createAdapter({
      name: "openai_compat",
      endpoint: { model: "gpt-5.6-sol", base_url: "https://example.invalid/v1" },
      apiKey: "k",
    });
    assert.equal(adapter.kind, "openai_compat");
    assert.equal(typeof adapter.complete, "function");
  });

  it("names the registered adapters when the config picks an unknown one", () => {
    assert.throws(
      () => createAdapter({ name: "nope", endpoint }),
      /unknown adapter "nope".*openai_compat/s,
    );
  });

  it("registers a third-party provider and hands it the resolved key", () => {
    let seen: string | undefined = "unset";
    registerAdapter("stub_provider", (ctx) => {
      seen = ctx.apiKey;
      return {
        kind: ctx.name,
        async complete() {
          return { tool_calls: [], usage: { tokens_in: 0, tokens_out: 0 } };
        },
      };
    });
    const adapter = createAdapter({ name: "stub_provider", endpoint, apiKey: "secret" });
    assert.equal(adapter.kind, "stub_provider");
    assert.equal(seen, "secret");
    assert.ok(registeredAdapterNames().includes("stub_provider"));
  });

  it("refuses to register the same name twice", () => {
    assert.throws(
      () => registerAdapter("openai_compat", () => {
        throw new Error("unreachable");
      }),
      /already registered/,
    );
  });
});
