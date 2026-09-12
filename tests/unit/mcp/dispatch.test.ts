import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { raceHarnessMcpToolCall } from "../../../src/daemon/server.ts";
import { createComputerMcpBackend } from "../../../src/mcp/computer-backend.ts";
import { dispatchToolCall } from "../../../src/mcp/dispatch.ts";
import type { McpToolBackend } from "../../../src/mcp/types.ts";
import { toolError } from "../../../src/protocol/errors.ts";
import type { ToolName, ToolResult } from "../../../src/types/contracts.ts";

function parsePayload(result: CallToolResult): {
  ok: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  isError: boolean;
} {
  const text = result.content.find((c) => c.type === "text");
  assert.ok(text && text.type === "text", "tool result missing text content");
  const body = JSON.parse(text.text) as {
    ok: boolean;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
  return { ...body, isError: result.isError === true };
}

function hangBackend(): McpToolBackend {
  return {
    uiBaseUrl: "http://127.0.0.1",
    callTool: () => new Promise<ToolResult>(() => {}),
  };
}

describe("MCP dispatch timeout", () => {
  it("never-resolving backend times out with mcp_tool_timeout", async () => {
    const mcp = await dispatchToolCall(
      hangBackend(),
      "browser_snapshot",
      {},
      { toolTimeoutMs: 50 },
    );
    const parsed = parsePayload(mcp);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.isError, true);
    assert.equal(parsed.error?.code, "E_TIMEOUT");
    assert.equal(parsed.error?.details?.cause, "mcp_tool_timeout");
    assert.equal(parsed.error?.details?.timeout_ms, 50);
  });

  it("MCP timer aborts the backend signal with mcp_tool_timeout and timeout_ms", async () => {
    let reason: unknown;
    const backend: McpToolBackend = {
      uiBaseUrl: "http://127.0.0.1",
      async callTool(_name: ToolName, _args, signal) {
        return new Promise<ToolResult>(() => {
          signal.addEventListener(
            "abort",
            () => {
              reason = signal.reason;
            },
            { once: true },
          );
        });
      },
    };
    await dispatchToolCall(backend, "browser_snapshot", {}, { toolTimeoutMs: 50 });
    assert.equal((reason as { cause?: unknown }).cause, "mcp_tool_timeout");
    assert.equal((reason as { timeout_ms?: unknown }).timeout_ms, 50);
  });

  it("abort mid-call returns E_TIMEOUT with cause abort", async () => {
    const computer = createFakeComputerClient("c_abort");
    computer.call = () => new Promise(() => {});
    const backend = createComputerMcpBackend({
      client: computer,
      uiBaseUrl: "http://127.0.0.1",
    });
    const ac = new AbortController();
    const pending = dispatchToolCall(
      backend,
      "browser_snapshot",
      {},
      { toolTimeoutMs: 5_000, signal: ac.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    ac.abort();
    try {
      const parsed = parsePayload(await pending);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.isError, true);
      assert.equal(parsed.error?.code, "E_TIMEOUT");
      assert.equal(parsed.error?.details?.cause, "abort");
    } finally {
      await computer.close().catch(() => undefined);
    }
  });

  it("already-aborted parent signal returns abort without waiting for the timer", async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const parsed = parsePayload(
      await dispatchToolCall(
        hangBackend(),
        "browser_snapshot",
        {},
        {
          toolTimeoutMs: 2_000,
          signal: ac.signal,
        },
      ),
    );
    assert.equal(parsed.error?.code, "E_TIMEOUT");
    assert.equal(parsed.error?.details?.cause, "abort");
    assert.ok(Date.now() - started < 500);
  });

  it("parent abort while backend ignores abort does not hang", { timeout: 2_000 }, async () => {
    const ac = new AbortController();
    const pending = dispatchToolCall(
      hangBackend(),
      "browser_snapshot",
      {},
      {
        toolTimeoutMs: 5_000,
        signal: ac.signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    ac.abort();
    const parsed = parsePayload(await pending);
    assert.equal(parsed.error?.code, "E_TIMEOUT");
    assert.equal(parsed.error?.details?.cause, "abort");
  });
});

describe("harness MCP callTool abort", () => {
  it("emits one tool.error with mcp_tool_timeout when the MCP timer aborts", async () => {
    const events: Array<{ type: string; body: Record<string, unknown> }> = [];
    let released = false;
    const backend: McpToolBackend = {
      uiBaseUrl: "http://127.0.0.1",
      callTool: (name, _args, signal) =>
        raceHarnessMcpToolCall({
          dispatch: new Promise<ToolResult>(() => {}),
          signal,
          emitError: (result) => {
            events.push({ type: "tool.error", body: { name, result } });
          },
          onDispatchSettled: () => {
            released = true;
          },
        }),
    };
    const parsed = parsePayload(
      await dispatchToolCall(backend, "browser_snapshot", {}, { toolTimeoutMs: 50 }),
    );
    assert.equal(parsed.error?.details?.cause, "mcp_tool_timeout");
    assert.equal(parsed.error?.details?.timeout_ms, 50);
    const errors = events.filter((event) => event.type === "tool.error");
    assert.equal(errors.length, 1);
    const emitted = errors[0]!.body.result as {
      ok: false;
      error: { code: string; details?: { cause?: string; timeout_ms?: number } };
    };
    assert.equal(emitted.ok, false);
    assert.equal(emitted.error.code, "E_TIMEOUT");
    assert.equal(emitted.error.details?.cause, "mcp_tool_timeout");
    assert.equal(emitted.error.details?.timeout_ms, 50);
    assert.equal(released, false);
  });

  it("keeps occupancy until dispatch settles and ignores late success", async () => {
    let resolveDispatch!: (value: ToolResult) => void;
    let released = false;
    const events: ToolResult[] = [];
    const ac = new AbortController();
    const pending = raceHarnessMcpToolCall({
      dispatch: new Promise<ToolResult>((resolve) => {
        resolveDispatch = resolve;
      }),
      signal: ac.signal,
      emitError: (result) => {
        events.push(result);
      },
      onDispatchSettled: () => {
        released = true;
      },
    });
    ac.abort({ cause: "mcp_tool_timeout", timeout_ms: 40 });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.details?.cause, "mcp_tool_timeout");
    assert.equal(result.error.details?.timeout_ms, 40);
    assert.equal(events.length, 1);
    assert.equal(released, false);
    resolveDispatch({ ok: true, data: { late: true } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(released, true);
    assert.equal(result.ok, false);
    assert.equal(events.length, 1);
  });

  it("does not prefer dispatch success after abort has already won", async () => {
    const events: ToolResult[] = [];
    const ac = new AbortController();
    ac.abort({ cause: "mcp_tool_timeout", timeout_ms: 40 });
    const result = await raceHarnessMcpToolCall({
      dispatch: Promise.resolve({ ok: true, data: { late: true } }),
      signal: ac.signal,
      emitError: (value) => {
        events.push(value);
      },
      onDispatchSettled: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.details?.cause, "mcp_tool_timeout");
    assert.equal(result.error.details?.timeout_ms, 40);
    assert.equal(events.length, 1);
  });

  it("does not emit a second tool.error when the dispatcher already returned E_TIMEOUT", async () => {
    const events: ToolResult[] = [];
    const result = await raceHarnessMcpToolCall({
      dispatch: Promise.resolve(toolError("E_TIMEOUT", "observe timed out", { cause: "observe" })),
      signal: new AbortController().signal,
      emitError: (value) => {
        events.push(value);
      },
      onDispatchSettled: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "E_TIMEOUT");
    assert.equal(result.error.details?.cause, "observe");
    assert.equal(events.length, 0);
  });
});
