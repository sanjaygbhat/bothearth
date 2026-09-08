import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { ConnectorMcpClient } from "../../../src/mcp/client.ts";
import { destroyComputer, inspectComputerContainer, pauseComputer, unpauseComputer } from "../../../src/sandbox/lifecycle.ts";
import { decodeLiveFrame } from "../../../src/protocol/live.ts";
import { withDockerLock } from "../lock.ts";

test("inherited Docker pause survives daemon restart and wakes for tools or live view", { timeout: 90_000 }, async () => {
  await withDockerLock(async () => {
    const root = await mkdtemp(join(tmpdir(), "modelbot-paused-restart-"));
    const name = `pause-${randomUUID().slice(0, 8)}`, token = randomUUID();
    const options = { port: 0, mcpToken: token, bootstrapToken: token,
      sqlitePath: join(root, "state.sqlite"), workspaceRoot: join(root, "computers"), idlePauseMin: 0 };
    const start = () => { options.bootstrapToken = randomUUID(); return startDaemon(options); };
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let mcp: ConnectorMcpClient | undefined;
    let ws: WebSocket | undefined;
    const login = async () => {
      const response = await fetch(`${daemon!.baseUrl}/api/v1/session/bootstrap`, { method: "POST",
        headers: { Origin: daemon!.baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ token: options.bootstrapToken }) });
      assert.equal(response.status, 200);
      const { csrf } = await response.json() as { csrf: string };
      return { Origin: daemon!.baseUrl, "Content-Type": "application/json", "X-CSRF-Token": csrf,
        Cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    try {
      daemon = await start();
      const created = await fetch(`${daemon.baseUrl}/api/v1/computers`, { method: "POST", headers: await login(),
        body: JSON.stringify({ name, capabilities: ["browser"], persistent: true }) });
      assert.equal(created.status, 201);
      const original = await inspectComputerContainer(name, "browser");
      await daemon.close(); daemon = undefined;
      await pauseComputer(name);
      daemon = await start();
      mcp = await ConnectorMcpClient.connectHttp({ url: `${daemon.baseUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } });
      const call = async (tool: string, args = {}) => {
        const result = await mcp!.callTool(tool, args);
        return JSON.parse(String(result.content[0]!.text));
      };
      // Operator metadata polling must not wake an idle computer.
      assert.equal((await fetch(`${daemon.baseUrl}/api/v1/computers`, { headers: await login() })).status, 200);
      assert.equal(((await inspectComputerContainer(name, "browser"))!.State as { Paused: boolean }).Paused, true);
      const snapshot = await call("browser_snapshot", { depth: null, interactive_only: false, max_chars: 1000, scope: null });
      assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
      assert.equal((await call("browser_tabs", { action: "list" })).ok, true);
      assert.equal((await inspectComputerContainer(name, "browser"))!.Id, original!.Id, "same persistent container was resumed");
      await mcp.close(); mcp = undefined;
      await daemon.close(); daemon = undefined;
      await pauseComputer(name);
      daemon = await start();
      const headers = await login();
      ws = new WebSocket(`${daemon.baseUrl.replace("http", "ws")}/api/v1/live/${name}`, { headers: { Origin: daemon.baseUrl, Cookie: headers.Cookie } });
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("paused browser did not produce live pixels")), 15_000);
        ws!.addEventListener("message", (event) => {
          if (typeof event.data === "string") return;
          const frame = decodeLiveFrame(new Uint8Array(event.data));
          if (frame.payload.length > 100 && frame.payload[0] === 0xff) { clearTimeout(timer); resolve(); }
        });
      });
      assert.equal((await inspectComputerContainer(name, "browser"))!.Id, original!.Id);
    } finally {
      ws?.close();
      await mcp?.close().catch(() => undefined);
      await unpauseComputer(name).catch(() => undefined);
      await daemon?.close();
      await destroyComputer(name, { keepProfile: false });
      await rm(root, { recursive: true, force: true });
    }
  });
});
