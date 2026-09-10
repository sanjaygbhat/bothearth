import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpStandalone } from "../../../src/mcp/server.ts";
import { runMcpStdioBridge } from "../../../src/mcp/stdio-bridge.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";

test("guest Unix MCP pipe keeps simultaneous native clients and their replies separate", { timeout: 15_000 }, async () => {
  // Exercise the actual socket/stdio branch on macOS too. This is a protocol
  // test; UID/process isolation is separately tested by the Docker fixture.
  const entry = new URL("../../../computer-server/src/native-process.ts", import.meta.url).href;
  const fixture = fakeCli("guest-mcp-pipe", () => `Object.defineProperty(process,'platform',{value:'linux'});process.getuid=()=>1002;await import(${JSON.stringify(entry)});`);
  const id = randomUUID();
  const relay = spawn(fixture.binary, ["mcp-listen", id], { stdio: ["pipe", "pipe", "pipe"] });
  const token = "synthetic-host-only-token";
  const requests: unknown[] = [];
  const server = await mcpStandalone({ port: 0, mcpToken: token, backend: { uiBaseUrl: "http://127.0.0.1",
    async callTool(name, args) { requests.push({ name, args }); return { ok: true, data: { name, path: args.path, content: args.content } }; },
    async releaseTakeover() { return { ok: true, data: {} }; }, async grantTakeover() { return { ok: true, data: {} }; }, async declineTakeover() { return { ok: true, data: {} }; },
  } });
  let bridge: Awaited<ReturnType<typeof runMcpStdioBridge>> | undefined;
  const clients: Client[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.once("exit", () => reject(new Error("MCP pipe exited before ready")));
      let text = "";
      relay.stderr.on("data", chunk => { text += chunk; if (text.includes("BOTHEARTH_MCP_READY")) resolve(); });
    });
    bridge = await runMcpStdioBridge({ endpoint: server.url, mcpToken: token, input: relay.stdout, output: relay.stdin });
    const connect = async (name: string) => {
      const client = new Client({ name, version: "1" });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: fixture.binary, args: ["mcp-connect", id], stderr: "ignore" }));
      return client;
    };
    const [leader, executor] = await Promise.all([connect("codex-leader"), connect("claude-executor")]);
    assert.ok((await leader!.listTools()).tools.some(tool => tool.name === "write_file"));
    const answers = await Promise.all([leader!, executor!].map((client, i) => client.callTool({ name: "write_file", arguments: { path: `out/client-${i}.txt`, content: `client-${i}` } })));
    for (let i = 0; i < answers.length; i++) {
      assert.notEqual(answers[i]!.isError, true);
      assert.match(JSON.stringify(answers[i]), new RegExp(`client-${i}`));
      assert.doesNotMatch(JSON.stringify(answers[i]), new RegExp(`client-${1-i}`));
    }
    assert.equal(requests.length, 2);
    await executor!.close();
    assert.ok((await leader!.listTools()).tools.length > 0);
    const next = await connect("next-executor");
    assert.ok((await next.listTools()).tools.length > 0, "another native executor can initialize after the first closes");
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await bridge?.close();
    const exit = relay.exitCode === null ? once(relay, "close") : undefined;
    relay.stdin.end();
    await exit;
    await server.close();
  }
});
