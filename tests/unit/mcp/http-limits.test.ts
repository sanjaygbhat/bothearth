import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { test } from "node:test";

test("standalone MCP survives malformed requests and bounds fixed/chunked bodies", { timeout: 15000 }, async () => {
  const module = new URL("../../../src/mcp/server.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { mcpStandalone } from ${JSON.stringify(module)};
    const server = await mcpStandalone({ port: 0, mcpToken: "test-only-token",
      backend: { uiBaseUrl: "http://127.0.0.1", callTool: async () => ({ ok: true, data: {} }) } });
    console.log(server.url);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  const exit = once(child, "exit");
  try {
    const [url] = await Promise.race([once(lines, "line"), exit.then(() => { throw Error(stderr); })]);
    const send = (headers: Record<string, string> = {}, body = "{}", chunked = false) => new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: {
        authorization: "Bearer test-only-token", "content-type": "application/json",
        ...(chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(Buffer.byteLength(body)) }), ...headers,
      } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      if (chunked) { req.write(body.slice(0, 600000)); req.end(body.slice(600000)); }
      else req.end(body);
    });
    assert.equal(await send({ host: "[" }), 400, "malformed Host must not crash the listener");
    const oversized = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
    assert.equal(await send({}, oversized), 413, "Content-Length request is bounded");
    assert.equal(await send({}, oversized, true), 413, "chunked request is bounded");
    assert.equal(await send({ authorization: "Bearer invalid" }), 401);
    assert.equal(await send(), 400, "listener still serves ordinary requests");
    assert.equal(child.exitCode, null, stderr);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    await exit;
  }
});
