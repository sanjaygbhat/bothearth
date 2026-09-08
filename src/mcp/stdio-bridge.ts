/**
 * Stdio MCP bridge: speak MCP on stdio, forward to loopback Streamable HTTP `/mcp`.
 * Endpoint + token from env / data dir only — never from model-visible config URL.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../index.ts";

interface StdioBridgeOptions {
  /** Full MCP HTTP URL, e.g. http://127.0.0.1:7777/mcp */
  endpoint: string;
  mcpToken: string;
}

function assertLoopbackEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`invalid MCP endpoint: ${endpoint}`);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `stdio bridge refuses non-loopback MCP endpoint host: ${host}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`stdio bridge requires http(s) endpoint`);
  }
  return url;
}

/**
 * Resolve bridge endpoint + token from env (MODELBOT_ENDPOINT / MODELBOT_TOKEN).
 * Defaults endpoint to http://127.0.0.1:7777/mcp.
 */
export function resolveStdioBridgeConfig(env: NodeJS.ProcessEnv = process.env): StdioBridgeOptions {
  const token = env.MODELBOT_TOKEN?.trim() ?? "";
  if (!token) {
    throw new Error("MODELBOT_TOKEN required for mcp-stdio bridge");
  }
  const raw =
    env.MODELBOT_ENDPOINT?.trim() ||
    env.MODELBOT_MCP_URL?.trim() ||
    "http://127.0.0.1:7777/mcp";
  const url = assertLoopbackEndpoint(raw);
  // Accept base URL without /mcp
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/mcp";
  }
  return { endpoint: url.toString(), mcpToken: token };
}

/** Run stdio ↔ HTTP MCP proxy until stdin closes. */
export async function runMcpStdioBridge(
  opts?: Partial<StdioBridgeOptions>,
): Promise<void> {
  const resolved = {
    ...resolveStdioBridgeConfig(),
    ...opts,
  };
  const url = assertLoopbackEndpoint(resolved.endpoint);

  const remote = new Client(
    { name: "modelbot-mcp-stdio-bridge", version: VERSION },
    { capabilities: {} },
  );
  const httpTransport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${resolved.mcpToken}`,
      },
    },
  });
  await remote.connect(httpTransport);

  const local = new Server(
    { name: "modelbot-mcp-stdio", version: VERSION },
    { capabilities: { tools: {} } },
  );

  local.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await remote.listTools();
    return { tools: listed.tools };
  });

  local.setRequestHandler(CallToolRequestSchema, async (req) => {
    return remote.callTool({
      name: req.params.name,
      arguments: req.params.arguments,
    });
  });

  const stdio = new StdioServerTransport();
  await local.connect(stdio);
}
