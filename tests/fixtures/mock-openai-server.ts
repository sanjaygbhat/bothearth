/**
 * Mock OpenAI-compatible chat completions for adapter tests.
 * Fake keys only — never real credentials.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export interface MockOpenAIOptions {
  host?: string;
  port?: number;
  /** Deterministic tool-call plan (one round). */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  content?: string;
}

export interface MockOpenAIHandle {
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockOpenAI(opts: MockOpenAIOptions = {}): Promise<MockOpenAIHandle> {
  const toolCalls = opts.toolCalls ?? [
    {
      id: "call_nav",
      name: "browser_navigate",
      arguments: { url: "https://fixture.local/", wait_until: null },
    },
  ];
  const content = opts.content ?? null;

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await readBody(req);
      const message: Record<string, unknown> = {
        role: "assistant",
        content,
      };
      if (toolCalls.length) {
        message.tool_calls = toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: {
            name: t.name,
            arguments: JSON.stringify(t.arguments),
          },
        }));
      }
      json(res, 200, {
        id: "chatcmpl_fixture",
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      return;
    }
    json(res, 404, { error: { message: "not found" } });
  });

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  await new Promise<void>((r) => server.listen(port, host, r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const baseUrl = `http://${host}:${addr.port}`;

  return {
    server,
    baseUrl,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("mock-openai-server.ts") ||
    process.argv[1].endsWith("mock-openai-server.js"));

if (isMain) {
  const h = await startMockOpenAI({ port: Number(process.env.PORT ?? 0) || 0 });
  process.stdout.write(`${h.baseUrl}\n`);
  const stop = () => {
    void h.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
