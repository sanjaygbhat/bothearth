import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { CSRF_HEADER, SESSION_COOKIE, deviceId } from "../../../src/daemon/auth.ts";
import { until } from "../../helpers/until.ts";

async function fixture() {
  const prior = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const workspaceRoot = await mkdtemp(join(tmpdir(), "modelbot-live-authority-"));
  const daemon = await startDaemon({ host: "127.0.0.1", port: 0, workspaceRoot,
    mcpToken: "synthetic-live-authority-mcp", bootstrapToken: "synthetic-live-authority-bootstrap" });
  daemon.store.insertComputer({ id: "authority-browser", name: "Authority fixture", capabilities: ["browser"], status: "running" });
  daemon.store.insertTakeover({ id: "authority-lease", computer_id: "authority-browser",
    state: "takeover_requested", epoch: 7, expires_at: new Date(Date.now() + 60000).toISOString() });
  const session = daemon.store.createSession();
  // Control belongs to the device that took it, and relay is checked against
  // that device, so the fixture has to grant it to this session.
  daemon.store.grantTakeoverTo("authority-lease", deviceId(session.id));
  const sockets: WebSocket[] = [];
  const connect = async (path: string, sid = session.id) => {
    const messages: unknown[] = [];
    const ws = new WebSocket(daemon.baseUrl.replace("http", "ws") + path, {
      headers: { Origin: daemon.baseUrl, Cookie: `${SESSION_COOKIE}=${sid}` },
    });
    sockets.push(ws);
    ws.addEventListener("message", (event) => messages.push(event.data));
    await until(() => ws.readyState === WebSocket.OPEN);
    return { ws, messages };
  };
  return { daemon, session, connect, async close() {
    for (const ws of sockets) ws.close();
    await daemon.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    if (prior === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = prior;
  } };
}

for (const change of ["epoch", "revoke"] as const) test(`queued operator input is not authorized after ${change} changes`, async () => {
  const original = FakeComputer.prototype.relayInput;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const received: unknown[] = [];
  FakeComputer.prototype.relayInput = async (msg) => {
    received.push(msg);
    if (received.length === 1) await blocked;
    return { ok: true, data: {} };
  };
  const f = await fixture();
  try {
    const { ws } = await f.connect("/api/v1/live/authority-browser");
    ws.send(JSON.stringify({ v: 1, t: "text", text: "first", epoch: 7 }));
    await until(() => received.length === 1);
    ws.send(JSON.stringify({ v: 1, t: "text", text: "queued", epoch: 7 }));
    await sleep(50);
    if (change === "epoch") f.daemon.store.db.prepare("UPDATE takeovers SET epoch = 8 WHERE id = ?").run("authority-lease");
    else f.daemon.store.deleteSession(f.session.id);
    release();
    await sleep(100);
    assert.equal(received.length, 1, "an already-entered action may finish; queued input must not run");
    assert.equal(f.daemon.store.getTakeover("authority-lease")?.state, "human", "session closure must not release the privacy gate");
    if (change === "epoch") {
      for (const epoch of [undefined, 0, 7, 9]) ws.send(JSON.stringify({ v: 1, t: "text", text: "stale", epoch }));
      ws.send(JSON.stringify({ v: 1, t: "text", text: "current", epoch: 8 }));
      await until(() => received.length === 2);
      assert.equal((received[1] as { text: string }).text, "current");
    } else await until(() => ws.readyState === WebSocket.CLOSED);
  } finally {
    release();
    await f.close();
    FakeComputer.prototype.relayInput = original;
  }
});

test("expired sessions lose live frames and events; fresh login preserves HUMAN and logout revokes both sockets", async () => {
  const start = FakeComputer.prototype.startLive;
  let computer!: FakeComputer;
  FakeComputer.prototype.startLive = function () { computer = this; };
  const f = await fixture();
  try {
    const live = await f.connect("/api/v1/live/authority-browser");
    const events = await f.connect("/api/v1/events");
    await until(() => Boolean(computer));
    const frame = () => computer.emit("frame", { header: { v: 1, t: "frame", mode: "human", epoch: 7,
      width: 1, height: 1, codec: "jpeg", seq: 1, ts: Date.now() }, payload: new Uint8Array([255, 216, 255, 217]) });
    frame();
    await until(() => live.messages.length >= 2);
    const count = live.messages.length;
    f.daemon.store.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), f.session.id);
    frame();
    await until(() => live.ws.readyState === WebSocket.CLOSED && events.ws.readyState === WebSocket.CLOSED);
    assert.equal(live.messages.length, count, "no frame is sent after session expiry");
    const fresh = f.daemon.store.createSession();
    const next = await f.connect("/api/v1/live/authority-browser", fresh.id);
    const nextEvents = await f.connect("/api/v1/events", fresh.id);
    frame();
    await until(() => next.messages.length >= 2);
    const result = await fetch(f.daemon.baseUrl + "/api/v1/session/logout", { method: "POST",
      headers: { Origin: f.daemon.baseUrl, Cookie: `${SESSION_COOKIE}=${fresh.id}`, [CSRF_HEADER]: fresh.csrf } });
    assert.equal(result.status, 200);
    await until(() => next.ws.readyState === WebSocket.CLOSED && nextEvents.ws.readyState === WebSocket.CLOSED);
    assert.equal(f.daemon.store.getTakeover("authority-lease")?.state, "human");
  } finally {
    await f.close();
    FakeComputer.prototype.startLive = start;
  }
});
