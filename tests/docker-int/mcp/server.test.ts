/**
 * Docker-int MCP smoke: takes the docker lock; runs against the in-process fake
 * (the real image path is the mcp-smoke e2e). Proves lock integration for this suite.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { createComputerMcpBackend } from "../../../src/mcp/computer-backend.ts";
import { mcpStandalone } from "../../../src/mcp/server.ts";
import { TOOL_NAMES } from "../../../src/types/contracts.ts";
import { withDockerLock } from "../lock.ts";

const TOKEN = "docker-int-mcp-token";

describe("MCP docker-int", () => {
  it("holds docker lock and lists catalogue tools", async () => {
    await withDockerLock(async () => {
      const computer = createFakeComputerClient("c_docker");
      const backend = createComputerMcpBackend({
        client: computer,
        uiBaseUrl: "http://127.0.0.1:7777",
      });
      const handle = await mcpStandalone({
        mcpToken: TOKEN,
        port: 0,
        backend,
      });
      const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      const client = new Client({ name: "mcp-docker-int", version: "0.0.1" });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        assert.deepEqual(
          listed.tools.map((t) => t.name),
          [...TOOL_NAMES],
        );
      } finally {
        await client.close().catch(() => undefined);
        await handle.close().catch(() => undefined);
        await computer.close().catch(() => undefined);
      }
    });
  });
});
