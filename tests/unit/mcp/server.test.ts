import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { createComputerMcpBackend } from "../../../src/mcp/computer-backend.ts";
import { mcpStandalone } from "../../../src/mcp/server.ts";
import { resolveStdioBridgeConfig } from "../../../src/mcp/stdio-bridge.ts";
import { TOOL_CATALOGUE } from "../../../src/tools/catalog.ts";
import { TOOL_NAMES } from "../../../src/types/contracts.ts";
import type { McpToolBackend } from "../../../src/mcp/types.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const TOKEN = "test-mcp-token-aaaaaaaa";

function parseToolPayload(result: CallToolResult): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  isError: boolean;
  hasImage: boolean;
} {
  const text = result.content.find((c) => c.type === "text");
  assert.ok(text && text.type === "text", "tool result missing text content");
  const body = JSON.parse(text.text) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };
  return {
    ...body,
    isError: result.isError === true,
    hasImage: result.content.some((c) => c.type === "image"),
  };
}

async function withServer(
  fn: (ctx: {
    handle: Awaited<ReturnType<typeof mcpStandalone>>;
    client: Client;
    computer: ReturnType<typeof createFakeComputerClient>;
  }) => Promise<void>,
  opts?: {
    checkApproval?: McpToolBackend["checkApproval"];
  },
): Promise<void> {
  const computer = createFakeComputerClient(
    `c_${Math.random().toString(16).slice(2, 8)}`,
  );
  const backend = createComputerMcpBackend({
    client: computer,
    uiBaseUrl: "http://127.0.0.1:7777",
    checkApproval: opts?.checkApproval,
  });
  const handle = await mcpStandalone({
    mcpToken: TOKEN,
    port: 0,
    backend,
  });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "mcp-test", version: "0.0.1" });
  await client.connect(transport);
  try {
    await fn({ handle, client, computer });
  } finally {
    await client.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await computer.close().catch(() => undefined);
  }
}

describe("MCP server", () => {
  it("does not expose the trusted navigation policy envelope as an MCP tool", async () => {
    await withServer(async ({ client, computer }) => {
      let executed = 0;
      computer.call = async () => { executed++; return { ok: true, data: {} }; };
      for (const name of ["policy.call", "takeover.request"]) {
        const result = await client.callTool({ name, arguments: {
          method: "browser_navigate", params: { url: "https://destination.example" },
          navigation_origins: ["destination.example"],
        } }).catch((error: unknown) => error);
        assert.ok(result instanceof Error || (result as CallToolResult).isError);
      }
      assert.equal(executed, 0);
    });
  });
  it("initialize + tools/list matches catalogue", async () => {
    await withServer(async ({ client }) => {
      const listed = await client.listTools();
      const listedNames = listed.tools.map((t) => t.name);
      // The catalogue (TOOL_NAMES / TOOL_CATALOGUE) is the source of truth for
      // both the set and the order of exposed tools; never hard-code a count.
      assert.deepEqual(listedNames, [...TOOL_NAMES]);
      assert.equal(listed.tools.length, TOOL_NAMES.length);
      assert.equal(listed.tools.length, TOOL_CATALOGUE.length);
      // No extras, no omissions, independent of ordering.
      assert.deepEqual(
        [...listedNames].sort(),
        [...TOOL_NAMES].sort(),
        "MCP tools/list must expose exactly the catalogue tools",
      );
      // Every exposed tool carries the catalogue's schema and description.
      for (const entry of TOOL_CATALOGUE) {
        const tool = listed.tools.find((t) => t.name === entry.name);
        assert.ok(tool, `catalogue tool not exposed over MCP: ${entry.name}`);
        assert.equal(tool.description, entry.description);
        assert.equal(typeof tool.inputSchema, "object");
        assert.equal(tool.inputSchema.type, "object");
        assert.deepEqual(tool.inputSchema, entry.inputSchema);
      }
      // The browser-role file writer must stay exposed.
      assert.ok(listedNames.includes("write_file"));
    });
  });

  it("browser_navigate / snapshot / click round-trip", async () => {
    await withServer(async ({ client }) => {
      const nav = parseToolPayload(
        (await client.callTool({
          name: "browser_navigate",
          arguments: { url: "https://example.com/", wait_until: null },
        })) as CallToolResult,
      );
      assert.equal(nav.ok, true);

      const snap = parseToolPayload(
        (await client.callTool({
          name: "browser_snapshot",
          arguments: {
            scope: null,
            interactive_only: true,
            depth: null,
            max_chars: null,
          },
        })) as CallToolResult,
      );
      assert.equal(snap.ok, true);
      const snapshotId = String(snap.data?.snapshot_id ?? "snap_x");

      const click = parseToolPayload(
        (await client.callTool({
          name: "browser_click",
          arguments: {
            snapshot_id: snapshotId,
            ref: "e1",
            button: "left",
            double_click: false,
          },
        })) as CallToolResult,
      );
      assert.equal(click.ok, true);
    });
  });

  it("request_takeover → E_TAKEOVER_BUSY; release resumes", async () => {
    await withServer(async ({ client, computer }) => {
      const tk = parseToolPayload(
        (await client.callTool({
          name: "request_takeover",
          arguments: { reason: "need human", category: "captcha" },
        })) as CallToolResult,
      );
      assert.equal(tk.ok, true);
      assert.ok(tk.data?.takeover_id);
      assert.ok(typeof tk.data?.url === "string");
      assert.match(String(tk.data?.url), /^http:\/\/127\.0\.0\.1/);
      assert.doesNotMatch(
        JSON.stringify(tk.data),
        /secret|capability|bootstrap/i,
      );

      const busy = parseToolPayload(
        (await client.callTool({
          name: "browser_click",
          arguments: {
            snapshot_id: "snap_x",
            ref: "e1",
            button: "left",
            double_click: false,
          },
        })) as CallToolResult,
      );
      assert.equal(busy.ok, false);
      assert.equal(busy.isError, true);
      assert.equal(busy.error?.code, "E_TAKEOVER_BUSY");

      const status = parseToolPayload(
        (await client.callTool({
          name: "takeover_status",
          arguments: { takeover_id: String(tk.data!.takeover_id) },
        })) as CallToolResult,
      );
      assert.equal(status.ok, true);

      // FSM: requested → grant(human) → release(validating→agent).
      const takeoverId = String(tk.data!.takeover_id);
      const granted = await computer.grantTakeover(takeoverId);
      assert.equal(granted.ok, true);
      const released = await computer.releaseTakeover(takeoverId);
      assert.equal(released.ok, true);

      const after = parseToolPayload(
        (await client.callTool({
          name: "browser_click",
          arguments: {
            snapshot_id: "snap_x",
            ref: "e1",
            button: "left",
            double_click: false,
          },
        })) as CallToolResult,
      );
      assert.equal(after.ok, true);
    });
  });

  it("screenshot returns MCP image block; no raw b64 in JSON text", async () => {
    await withServer(async ({ client }) => {
      const shot = (await client.callTool({
        name: "browser_screenshot",
        arguments: {
          full_page: false,
          max_width: null,
          max_height: null,
          snapshot_id: null,
          ref: null,
        },
      })) as CallToolResult;
      const parsed = parseToolPayload(shot);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.hasImage, true);
      assert.equal(parsed.data?.jpeg_base64, undefined);
      assert.doesNotMatch(JSON.stringify(parsed.data), /\/9j\//);
    });
  });

  it("gated tool surfaces E_POLICY_PENDING with approval_id", async () => {
    // Production path: shared tool dispatcher (not an injectable checkApproval hook).
    const store = new Store(":memory:");
    store.insertComputer({
      id: "c_gate",
      name: "c_gate",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });
    const computer = createFakeComputerClient("c_gate");
    const dispatcher = createToolDispatcher({
      store,
      getClient: (_id: string) => computer,
      emit: () => undefined,
    });
    const res = await dispatcher.dispatch(
      "browser_upload",
      {
        snapshot_id: "snap_1",
        ref: "e1",
        paths: ["/workspace/a.txt"],
      },
      {
        taskId: "t_mcp_gate",
        computerId: "c_gate",
        origin: "https://example.com",
        mode: "supervised",
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, "E_POLICY_PENDING");
    assert.equal(typeof res.error?.details?.approval_id, "string");
    await computer.close().catch(() => undefined);
  });

  it("auth negatives: missing bearer and browser Origin", async () => {
    await withServer(async ({ handle }) => {
      const noAuth = await fetch(handle.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "x", version: "0" },
          },
        }),
      });
      assert.equal(noAuth.status, 401);

      const withOrigin = await fetch(handle.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          origin: "https://evil.example",
        },
        body: "{}",
      });
      assert.equal(withOrigin.status, 403);
    });
  });

  it("resolveStdioBridgeConfig refuses non-loopback", () => {
    assert.throws(
      () =>
        resolveStdioBridgeConfig({
          MODELBOT_TOKEN: "t",
          MODELBOT_ENDPOINT: "http://example.com/mcp",
        }),
      /loopback|refuse|non-loopback|invalid/i,
    );
    const ok = resolveStdioBridgeConfig({
      MODELBOT_TOKEN: "t",
      MODELBOT_ENDPOINT: "http://127.0.0.1:7777/mcp",
    });
    assert.equal(ok.mcpToken, "t");
    assert.match(ok.endpoint, /127\.0\.0\.1:7777\/mcp/);
  });

  it("stdio bridge round-trip lists tools", async () => {
    await withServer(async ({ handle }) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--experimental-strip-types",
          join(ROOT, "src/cli/index.ts"),
          "mcp-stdio",
        ],
        env: {
          ...process.env,
          MODELBOT_TOKEN: TOKEN,
          MODELBOT_ENDPOINT: handle.url,
        },
        stderr: "pipe",
      });
      const client = new Client({ name: "mcp-stdio", version: "0.0.1" });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        assert.deepEqual(
          listed.tools.map((t) => t.name),
          [...TOOL_NAMES],
        );
        assert.equal(listed.tools.length, TOOL_NAMES.length);
        const nav = parseToolPayload(
          (await client.callTool({
            name: "browser_navigate",
            arguments: { url: "https://example.com/", wait_until: null },
          })) as CallToolResult,
        );
        assert.equal(nav.ok, true);
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  });
});
