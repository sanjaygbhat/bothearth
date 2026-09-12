import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import {
  restoreTakeoverExpiries,
  startDaemon,
  type DaemonHandle,
} from "../../../src/daemon/server.ts";
import { CSRF_HEADER, SESSION_COOKIE } from "../../../src/daemon/auth.ts";
import { Store } from "../../../src/daemon/store.ts";
import {
  applyTakeoverTransition,
} from "../../../src/protocol/takeover.ts";
import type { TakeoverState } from "../../../src/types/contracts.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const MCP = "test-mcp-token-aaaaaaaa";
const BOOT = "test-boot-token-bbbbbbbb";

describe("takeover decline", () => {
  it("operator can renew paused takeover without an agent capture interval", async () => {
    const state = createState("shell");
    const call = (method: string, params = {}) => dispatch(state, { jsonrpc: "2.0", id: 1, method, params });
    assert.equal((await call("request_takeover")).ok, true);
    const oldId = state.takeover.takeoverId;
    assert.equal((await call("takeover.ttl", { takeover_id: oldId })).ok, true);
    assert.equal(state.takeover.state, "paused");
    assert.equal((await call("request_takeover")).ok, false, "model cannot renew its own busy lease");
    assert.equal((await call("takeover.request")).ok, true, "operator control path renews directly from paused");
    assert.equal(state.takeover.state, "takeover_requested");
    assert.notEqual(state.takeover.takeoverId, oldId);
    const hidden = await call("browser_snapshot");
    assert.equal(hidden.ok, false);
    if (!hidden.ok) assert.equal(hidden.error.code, "E_TAKEOVER_BUSY");
  });
  it("FSM: takeover_requested → decline → agent; paused → decline → agent", () => {
    assert.equal(
      applyTakeoverTransition("takeover_requested", "decline"),
      "agent",
    );
    assert.equal(applyTakeoverTransition("paused", "decline"), "agent");
  });

  it("FSM: release still has no transition from takeover_requested or paused", () => {
    assert.equal(applyTakeoverTransition("takeover_requested", "release"), null);
    assert.equal(applyTakeoverTransition("paused", "release"), null);
  });

  it("FakeComputer: paused → releaseTakeover returns E_POLICY; decline returns agent", async () => {
    const fake = createFakeComputerClient("c_fake");
    const req = await fake.call("request_takeover", { reason: "password" });
    assert.equal(req.ok, true);
    const tk = (req as { data: { takeover_id: string } }).data.takeover_id;
    const expired = await fake.expireTakeover(tk);
    assert.equal(expired.ok, true);
    assert.equal(fake.getTakeoverState(), "paused");
    const release = await fake.releaseTakeover(tk);
    assert.equal(release.ok, false);
    if (!release.ok) assert.equal(release.error.code, "E_POLICY");
    const declined = await fake.declineTakeover(tk);
    assert.equal(declined.ok, true);
    assert.equal(fake.getTakeoverState(), "agent");
    const lateGrant = await fake.grantTakeover(tk);
    assert.equal(lateGrant.ok, false);
    await fake.close();
  });

  it("computer-server takeover.release returns E_POLICY from takeover_requested and paused", async () => {
    const requested = createState("shell");
    const asked = await dispatch(requested, {
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "password" },
    });
    assert.equal(asked.ok, true);
    const relReq = await dispatch(requested, {
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.release",
      params: {},
    });
    assert.equal(relReq.ok, false);
    if (!relReq.ok) assert.equal(relReq.error.code, "E_POLICY");

    const paused = createState("shell");
    const asked2 = await dispatch(paused, {
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "password" },
    });
    assert.equal(asked2.ok, true);
    const ttl = await dispatch(paused, {
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.ttl",
      params: {},
    });
    assert.equal(ttl.ok, true);
    assert.equal(paused.takeover.state, "paused");
    const relPaused = await dispatch(paused, {
      jsonrpc: "2.0",
      id: 3,
      method: "takeover.release",
      params: {},
    });
    assert.equal(relPaused.ok, false);
    if (!relPaused.ok) assert.equal(relPaused.error.code, "E_POLICY");
  });

  it("takeover.ttl rejects a stale id and accepts the active id", async () => {
    const state = createState("shell");
    const asked = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "captcha" },
    });
    assert.equal(asked.ok, true);
    const activeId = state.takeover.takeoverId!;

    const stale = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.ttl",
      params: { takeover_id: "tk_stale" },
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "E_POLICY");
    assert.equal(state.takeover.state, "takeover_requested");

    const current = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "takeover.ttl",
      params: { takeover_id: activeId },
    });
    assert.equal(current.ok, true);
    assert.equal(state.takeover.state, "paused");
  });

  it("decline bumps epoch and live relay still requires HUMAN+epoch", async () => {
    const state = createState("browser");
    await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "password" },
    });
    const epochBefore = state.takeover.epoch;
    const declined = await dispatch(state, {
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.decline",
      params: { takeover_id: state.takeover.takeoverId },
    });
    assert.equal(declined.ok, true);
    assert.equal(state.takeover.state, "agent");
    assert.ok(state.takeover.epoch > epochBefore);
    const relay = await dispatch(state, {
      jsonrpc: "2.0",
      id: 3,
      method: "live.text",
      params: { text: "x", epoch: epochBefore },
    });
    assert.equal(relay.ok, false);
    if (!relay.ok) assert.equal(relay.error.code, "E_TAKEOVER_BUSY");
    const grant = await dispatch(state, {
      jsonrpc: "2.0",
      id: 4,
      method: "takeover.grant",
      params: {},
    });
    assert.equal(grant.ok, false);
    if (!grant.ok) assert.equal(grant.error.code, "E_POLICY");
  });
});

function persistedTakeover(id: string, expiresAt: string): Store {
  const store = new Store(":memory:");
  store.insertComputer({
    id: "c_r8_restart",
    name: "r8 restart",
    capabilities: ["browser"],
    persistent: true,
    status: "running",
  });
  store.insertTakeover({
    id,
    computer_id: "c_r8_restart",
    state: "takeover_requested",
    expires_at: expiresAt,
    epoch: 2,
  });
  return store;
}

describe("takeover expiry restoration", () => {
  it("terminates deleted-computer takeovers and repairs older orphan rows without opening a client", async () => {
    const store = persistedTakeover("tk_orphan", new Date(500).toISOString());
    try {
      store.deleteComputer("c_r8_restart");
      assert.equal(store.getTakeover("tk_orphan")?.state, "terminated");
      store.updateTakeoverState("tk_orphan", "human"); // Pre-fix database state.
      await restoreTakeoverExpiries(store,
        () => assert.fail("orphan scheduled"),
        async () => assert.fail("orphan opened a missing computer"), 1_000);
      assert.equal(store.getTakeover("tk_orphan")?.state, "terminated");
      assert.equal(store.listTakeovers().length, 1); // Preserve history.
    } finally { store.close(); }
  });
  it("reschedules a persisted future deadline on restart", async () => {
    const store = persistedTakeover("tk_future", new Date(2_000).toISOString());
    const scheduled: string[] = [];
    try {
      await restoreTakeoverExpiries(
        store,
        (id) => scheduled.push(id),
        async () => assert.fail("future takeover expired immediately"),
        1_000,
      );
      assert.deepEqual(scheduled, ["tk_future"]);
    } finally {
      store.close();
    }
  });

  it("resolves a persisted past deadline before startup returns", async () => {
    const store = persistedTakeover("tk_past", new Date(500).toISOString());
    try {
      await restoreTakeoverExpiries(
        store,
        () => assert.fail("past takeover was scheduled"),
        async (id) => store.updateTakeoverState(id, "paused"),
        1_000,
      );
      assert.equal(store.getTakeover("tk_past")?.state, "paused");
    } finally {
      store.close();
    }
  });
});

describe("/api/v1/takeover decline + /release E_POLICY", () => {
  let daemon: DaemonHandle;
  let base: string;
  let origin: string;
  let cookie = "";
  let csrf = "";

  before(async () => {
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: BOOT,
    });
    base = daemon.baseUrl;
    origin = `http://127.0.0.1:${daemon.port}`;
    const boot = await fetch(`${base}/api/v1/session/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "content-type": "application/json" },
      body: JSON.stringify({ token: BOOT }),
    });
    assert.equal(boot.status, 200);
    const body = (await boot.json()) as { csrf: string };
    csrf = body.csrf;
    cookie = (boot.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0]!)
      .join("; ");
    assert.match(cookie, new RegExp(SESSION_COOKIE));
  });

  after(async () => {
    await daemon.close();
  });

  async function api(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {
      Origin: origin,
      Host: `127.0.0.1:${daemon.port}`,
      cookie,
      [CSRF_HEADER]: csrf,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep */
    }
    return { status: res.status, json };
  }

  it("/release returns E_POLICY from takeover_requested; decline → agent; late grant fails", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "fixture", capabilities: ["browser"] },
    });
    assert.equal(created.status, 201);
    const computerId = created.json.computer.id as string;
    const req = await api("/api/v1/takeover/request", {
      method: "POST",
      body: { computer_id: computerId, reason: "password" },
    });
    assert.equal(req.status, 200);
    const tk = req.json.takeover.takeover_id as string;

    const release = await api(`/api/v1/takeover/${tk}/release`, {
      method: "POST",
    });
    assert.equal(release.status, 409);
    assert.equal(release.json.error, "E_POLICY");
    assert.match(String(release.json.message), /not been taken yet/i);

    const declined = await api(`/api/v1/takeover/${tk}/decline`, {
      method: "POST",
    });
    assert.equal(declined.status, 200);
    assert.equal(declined.json.takeover.state, "agent");

    const late = await api(`/api/v1/takeover/${tk}/grant`, { method: "POST" });
    assert.equal(late.status, 409);

    const audit = await api("/api/v1/audit");
    assert.equal(audit.status, 200);
    const types = (audit.json.records as Array<{ type: string }>).map(
      (r) => r.type,
    );
    assert.ok(types.includes("takeover.declined"));
  });

  it("operator request reuses active control and renews an expired lease without an agent gap", async () => {
    const created = await api("/api/v1/computers", { method: "POST", body: { name: "self-control", capabilities: ["browser"] } });
    const computerId = created.json.computer.id as string;
    const request = () => api("/api/v1/takeover/request", { method: "POST", body: { computer_id: computerId } });
    const task = daemon.store.insertTask({ computer_id: computerId, goal: "login", max_steps: 3 });
    const invalid = await api("/api/v1/takeover/request", { method: "POST", body: { computer_id: computerId, task_id: "missing" } });
    assert.equal(invalid.status, 400);
    const first = await api("/api/v1/takeover/request", { method: "POST", body: { computer_id: computerId, task_id: task.id } });
    assert.equal(first.status, 200);
    const id = first.json.takeover.takeover_id;
    assert.equal((await request()).json.takeover.takeover_id, id);
    assert.equal((await api(`/api/v1/takeover/${id}/acquire`, { method: "POST" })).status, 200);
    const active = await request();
    assert.equal(active.json.takeover.takeover_id, id);
    assert.equal(active.json.takeover.state, "human");
    daemon.store.db.prepare("UPDATE takeovers SET expires_at = ? WHERE id = ?").run(new Date(0).toISOString(), id);
    const renewed = await request();
    assert.equal(renewed.status, 200);
    assert.notEqual(renewed.json.takeover.takeover_id, id);
    assert.equal(renewed.json.takeover.state, "requested");
    assert.equal(daemon.store.getTakeover(id)?.state, "terminated");
    assert.equal(daemon.store.getTakeover(renewed.json.takeover.takeover_id)?.task_id, task.id);
    const status = await api(`/api/v1/takeover/${renewed.json.takeover.takeover_id}/status`);
    assert.equal(status.json.takeover.state, "requested");
  });

  it("/release returns E_POLICY from paused (client path the route uses)", async () => {
    const fake = createFakeComputerClient("c_paused_http");
    const req = await fake.call("request_takeover", { reason: "ttl" });
    assert.equal(req.ok, true);
    const tk = (req as { data: { takeover_id: string } }).data.takeover_id;
    await fake.expireTakeover(tk);
    assert.equal(fake.getTakeoverState(), "paused" satisfies TakeoverState);
    const release = await fake.releaseTakeover(tk);
    assert.equal(release.ok, false);
    if (!release.ok) assert.equal(release.error.code, "E_POLICY");
    await fake.close();
  });
});
