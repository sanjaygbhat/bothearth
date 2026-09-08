import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { decodeLiveFrame } from "../../../src/protocol/live.ts";
import { until } from "../../helpers/until.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

for (const overlap of [false, true]) test(`static operator frames refresh after durable grant (overlapping subscriber: ${overlap})`, async () => {
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const start = FakeComputer.prototype.startLive;
  const grant = FakeComputer.prototype.grantTakeover;
  type StaticComputer = { state: string; emitFrame(mode: "human" | "agent"): void };
  FakeComputer.prototype.startLive = function () {
    const computer = this as unknown as StaticComputer;
    computer.emitFrame(computer.state === "human" ? "human" : "agent");
  };
  FakeComputer.prototype.grantTakeover = async function (id) {
    const result = await grant.call(this, id);
    // A real static screencast can arrive before the grant RPC returns to the daemon.
    if (result.ok) (this as unknown as StaticComputer).emitFrame("human");
    return result;
  };
  const daemon = await startDaemon({ host: "127.0.0.1", port: 0,
    mcpToken: "first-frame-mcp-private", bootstrapToken: "first-frame-bootstrap-private" });
  const sockets: WebSocket[] = [];
  try {
    const { cookie, headers } = await bootstrapSession(daemon, "first-frame-bootstrap-private");
    const post = async (path: string, body = {}) => {
      const response = await fetch(daemon.baseUrl + path, { method: "POST", headers,
        body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text());
      return await response.json() as Record<string, any>;
    };
    const created = await post("/api/v1/computers", { name: "static-first-frame", capabilities: ["browser"] });
    const id = created.computer.id;
    const connect = () => {
      const messages: string[] = [];
      const ws = new WebSocket(`${daemon.baseUrl.replace("http", "ws")}/api/v1/live/${id}`, {
        headers: { Origin: daemon.baseUrl, Cookie: cookie },
      });
      sockets.push(ws);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const message = JSON.parse(event.data);
          if (message.t === "mode") messages.push(`mode:${message.mode}`);
        } else messages.push(`frame:${decodeLiveFrame(new Uint8Array(event.data as ArrayBuffer)).header.mode}`);
      });
      return messages;
    };
    const first = connect();
    await until(() => first.includes("frame:agent"), "static frame missing");
    // Keep the old socket open to reproduce overlapping subscriptions during reload.
    const replacement = overlap ? connect() : first;
    await until(() => replacement.includes("frame:agent"), "static frame missing");
    const requested = await post("/api/v1/takeover/request", { computer_id: id });
    await post(`/api/v1/takeover/${requested.takeover.takeover_id}/grant`);
    await until(() => replacement.includes("frame:human"), "static frame missing");
    assert.ok(replacement.indexOf("mode:human") < replacement.indexOf("frame:human"));
  } finally {
    for (const socket of sockets) socket.close();
    await daemon.close();
    FakeComputer.prototype.startLive = start;
    FakeComputer.prototype.grantTakeover = grant;
  }
});
