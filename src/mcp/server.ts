import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../index.ts";
import { authorizeMcpRequest } from "./auth.ts";
import { catalogueAsMcpTools, dispatchToolCall } from "./dispatch.ts";
import type { McpServerOptions, McpStandaloneHandle } from "./types.ts";

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpSdkServer;
};

export const MAX_MCP_REQUEST_BODY_BYTES = 1024 * 1024;

function buildSdkServer(
  options: McpServerOptions,
): McpSdkServer {
  const toolTimeoutMs = options.toolTimeoutMs ?? 300_000;
  const server = new McpSdkServer(
    {
      name: options.serverName ?? "modelbot",
      version: options.serverVersion ?? VERSION,
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.backend.listTools?.() ?? catalogueAsMcpTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    dispatchToolCall(
      options.backend,
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
      { toolTimeoutMs },
    ),
  );

  return server;
}

/** HTTP handler for `/mcp` (Streamable HTTP). */
export function createMcpHttpHandler(options: McpServerOptions): {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  closeAll: () => Promise<void>;
} {
  const sessions = new Map<string, Session>();

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid request URL or Host" }));
      return true;
    }
    if (url.pathname !== (options.path ?? "/mcp")) return false;

    const denied = authorizeMcpRequest(req, {
      mcpToken: options.mcpToken,
      port: options.port,
      allowedHosts: options.allowedHosts,
    });
    if (denied) {
      res.writeHead(denied.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: denied.error }));
      return true;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed / unknown session",
            },
            id: null,
          }),
        );
        return true;
      }
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return true;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "GET, POST, DELETE" });
      res.end();
      return true;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_MCP_REQUEST_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        return true;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    let body: unknown;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }),
        );
        return true;
      }
    }

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
      return true;
    }

    if (!sessionId && body && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });
      const server = buildSdkServer(options);
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return true;
    }

    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: no valid session or initialize",
        },
        id: null,
      }),
    );
    return true;
  }

  async function closeAll(): Promise<void> {
    for (const s of sessions.values()) {
      await s.transport.close().catch(() => undefined);
      await s.server.close().catch(() => undefined);
    }
    sessions.clear();
  }

  return { handle, closeAll };
}

/** Standalone MCP HTTP listener on 127.0.0.1; the daemon mounts the handler itself. */
export async function mcpStandalone(
  options: McpServerOptions,
): Promise<McpStandaloneHandle> {
  // Mutable opts so ephemeral port (0) updates Host checks after bind.
  const opts: McpServerOptions = { ...options };
  const { handle, closeAll } = createMcpHttpHandler(opts);
  const server: Server = createServer((req, res) => {
    void handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("not found");
      }
    }).catch(() => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal request error" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : options.port;
  opts.port = port;

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      await closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
