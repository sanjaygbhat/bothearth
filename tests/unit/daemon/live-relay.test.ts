import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserSession } from "../../../computer-server/src/browser/session.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";
import { CSRF_HEADER, SESSION_COOKIE } from "../../../src/daemon/auth.ts";
import { validateLiveRelayFrame, startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

function fakePage(typed: string[] = []) {
  return {
    id: "p",
    isClosed: () => false,
    on: () => {},
    close: async () => {},
    bringToFront: async () => {},
    keyboard: {
      insertText: async (text: string) => {
        typed.push(text);
      },
    },
  };
}

describe("daemon validates takeover epoch on UI live relay", () => {
  it("UI control frame → validate → dispatch gate: human accepted; agent refused; stale refused", async () => {
    const store = new Store();
    try {
      store.insertTakeover({
        id: "tk_relay",
        computer_id: "comp-a",
        state: "takeover_requested",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        epoch: 7,
      });
      store.grantTakeoverTo("tk_relay", "sess-driving");

      const uiFrame: Record<string, unknown> = {
        v: 1,
        t: "text",
        type: "live.text",
        text: "secret",
        epoch: 7,
      };
      const stamped = validateLiveRelayFrame(store, "comp-a", uiFrame, "sess-driving");
      assert.ok(stamped);
      assert.equal(stamped.epoch, 7);
      for (const epoch of [undefined, 0, 6, 8, "7"]) {
        assert.equal(validateLiveRelayFrame(store, "comp-a", { ...uiFrame, epoch }, "sess-driving"), null);
      }
      assert.equal(uiFrame.epoch, 7);

      const typed: string[] = [];
      const page = fakePage(typed);
      const session = new BrowserSession();
      session.page = page as never;
      session.livePage = page as never;
      session.relayPage = page as never;
      session.liveMode = "human";

      const human = createState("browser");
      human.browser = session;
      human.takeover.state = "human";
      human.takeover.epoch = 7;
      const accepted = await dispatch(human, {
        jsonrpc: "2.0",
        id: 1,
        method: "live.text",
        params: stamped,
      });
      assert.equal(accepted.ok, true);
      assert.deepEqual(typed, ["secret"]);

      const agent = createState("browser");
      agent.takeover.state = "agent";
      agent.takeover.epoch = 7;
      const inAgent = await dispatch(agent, {
        jsonrpc: "2.0",
        id: 2,
        method: "live.text",
        params: stamped,
      });
      assert.equal(inAgent.ok, false);
      if (!inAgent.ok) assert.equal(inAgent.error.code, "E_TAKEOVER_BUSY");

      const stale = createState("browser");
      stale.takeover.state = "human";
      stale.takeover.epoch = 7;
      const staleFrame = { ...stamped, epoch: 6 };
      const refused = await dispatch(stale, {
        jsonrpc: "2.0",
        id: 3,
        method: "live.key",
        params: staleFrame,
      });
      assert.equal(refused.ok, false);
      if (!refused.ok) assert.equal(refused.error.code, "E_TAKEOVER_BUSY");

      store.updateTakeoverState("tk_relay", "agent");
      assert.equal(validateLiveRelayFrame(store, "comp-a", uiFrame, "sess-driving"), null);
    } finally {
      store.close();
    }
  });

  it("relays only while the computer's persisted takeover row is HUMAN", () => {
    const store = new Store();
    try {
      store.insertTakeover({
        id: "tk_a",
        computer_id: "computer-a",
        state: "takeover_requested",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        epoch: 3,
      });
      const frame = { v: 1, t: "text", type: "live.text", text: "secret", epoch: 3 };
      assert.equal(validateLiveRelayFrame(store, "computer-a", frame, "sess-a"), null);
      store.grantTakeoverTo("tk_a", "sess-a");
      assert.ok(validateLiveRelayFrame(store, "computer-a", frame, "sess-a"));
      // A second paired device is authenticated and can open the same live
      // socket; it may watch, but it may not type into a computer someone else
      // took control of.
      assert.equal(validateLiveRelayFrame(store, "computer-a", frame, "sess-b"), null);
      assert.equal(validateLiveRelayFrame(store, "computer-b", frame, "sess-a"), null);
      store.updateTakeoverState("tk_a", "agent");
      assert.equal(validateLiveRelayFrame(store, "computer-a", frame, "sess-a"), null);
    } finally {
      store.close();
    }
  });

  it("grant persists CS epoch; matching control frame is accepted", async () => {
    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: "test-mcp-token-relay-aaaaaaaa",
      bootstrapToken: "test-boot-token-relay-bbbbbbbb",
    });
    const origin = `http://127.0.0.1:${daemon.port}`;
    try {
      const boot = await fetch(`${daemon.baseUrl}/api/v1/session/bootstrap`, {
        method: "POST",
        headers: { Origin: origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "test-boot-token-relay-bbbbbbbb" }),
      });
      assert.equal(boot.status, 200);
      const bootJson = (await boot.json()) as { csrf: string };
      const cookie = (boot.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(";")[0]!)
        .join("; ");
      const headers = {
        Origin: origin,
        Host: `127.0.0.1:${daemon.port}`,
        cookie,
        [CSRF_HEADER]: bootJson.csrf,
        "content-type": "application/json",
      };
      const created = await fetch(`${daemon.baseUrl}/api/v1/computers`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "relay", capabilities: ["browser"] }),
      });
      assert.equal(created.status, 201);
      const computerId = ((await created.json()) as { computer: { id: string } }).computer.id;

      const requested = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
        method: "POST",
        headers,
        body: JSON.stringify({ computer_id: computerId, reason: "login" }),
      });
      assert.equal(requested.status, 200);
      const reqJson = (await requested.json()) as {
        takeover: { takeover_id: string; epoch: number };
      };
      assert.ok(reqJson.takeover.epoch > 0);
      const tk = reqJson.takeover.takeover_id;

      const granted = await fetch(`${daemon.baseUrl}/api/v1/takeover/${tk}/acquire`, {
        method: "POST",
        headers,
      });
      assert.equal(granted.status, 200);
      const row = daemon.store.getTakeover(tk);
      assert.equal(row?.state, "human");
      assert.equal(row?.epoch, reqJson.takeover.epoch);

      // The acquiring device is the driver, and the row is where that is written.
      assert.ok(row?.granted_to, "the grant did not record the device that took it");
      const uiFrame = { v: 1, t: "text" as const, text: "secret", epoch: row!.epoch };
      assert.equal(validateLiveRelayFrame(daemon.store, computerId, uiFrame, "another-device"), null);
      const stamped = validateLiveRelayFrame(daemon.store, computerId, uiFrame, row!.granted_to!);
      assert.ok(stamped);

      // The page is told who holds it, and never a session id.
      const listed = await fetch(`${daemon.baseUrl}/api/v1/takeovers`, { headers });
      const rows = (await listed.json() as { takeovers: Array<Record<string, unknown>> }).takeovers;
      const mine = rows.find((entry) => entry.id === tk)!;
      assert.equal(mine.holder, row!.granted_to);
      assert.equal("granted_to" in mine, false, "a session id reached the browser");
      assert.equal(stamped.epoch, row!.epoch);
      assert.equal(uiFrame.epoch, row!.epoch);
      assert.match(cookie, new RegExp(SESSION_COOKIE));
    } finally {
      await daemon.close();
    }
  });
});
