import { createServer, type Server } from "node:http";

export interface MockAnthropicHandle {
  server: Server;
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startMockAnthropic(): Promise<MockAnthropicHandle> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const body = JSON.stringify({
        id: "msg_fixture",
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
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock has no address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
