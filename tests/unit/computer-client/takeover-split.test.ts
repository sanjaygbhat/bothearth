import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";
import { ExecComputerClient } from "../../../src/computer-client/exec-client.ts";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { CSRF_HEADER, SESSION_COOKIE } from "../../../src/daemon/auth.ts";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { toolError } from "../../../src/protocol/errors.ts";
import type { JsonRpcClient } from "../../../src/sandbox/client.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";

class DispatchRpc implements JsonRpcClient {
  readonly child = null;
  readonly methods: string[] = [];
  readonly state: ReturnType<typeof createState>;
  constructor(state: ReturnType<typeof createState>) {
    this.state = state;
  }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.methods.push(method);
    return dispatch(this.state, {
      jsonrpc: "2.0",
      id: this.methods.length,
      method,
      params,
    });
  }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

class SplitExec extends ExecComputerClient {
  private readonly browserRpc: DispatchRpc;
  private readonly shellRpc: DispatchRpc;
  constructor(
    computerId: string,
    browserRpc: DispatchRpc,
    shellRpc: DispatchRpc,
  ) {
    super(computerId);
    this.browserRpc = browserRpc;
    this.shellRpc = shellRpc;
  }
  protected override async rpc(role: "browser" | "shell"): Promise<JsonRpcClient> {
    return role === "browser" ? this.browserRpc : this.shellRpc;
  }
}

function trackingBrowser() {
  const calls = { abort: 0, stop: 0, start: 0, reset: 0, modes: [] as string[] };
  return {
    calls,
    liveMode: "agent",
    abortActs() {
      calls.abort += 1;
      return Promise.resolve();
    },
    async resetLiveKeys() {
      calls.reset += 1;
    },
    async stopScreencast() {
      calls.stop += 1;
    },
    async startScreencast() {
      calls.start += 1;
    },
    async maskSecrets() {
      return [];
    },
    setLiveMode(mode: string) {
      calls.modes.push(mode);
      this.liveMode = mode;
    },
  };
}

function rpc(state: ReturnType<typeof createState>, method: string, params: unknown = {}) {
  return dispatch(state, { jsonrpc: "2.0", id: 1, method, params });
}

describe("decline on real split browser/shell (no MODELBOT_TEST_FAKE_COMPUTER)", () => {
  const prevFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  before(() => {
    delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
  });
  after(() => {
    if (prevFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = prevFake;
  });

  it("request hits browser only; decline leaves browser, shell, store all agent", async () => {
    assert.notEqual(process.env.MODELBOT_TEST_FAKE_COMPUTER, "1");
    const browserRpc = new DispatchRpc(createState("browser"));
    const shellRpc = new DispatchRpc(createState("shell"));
    const client = new SplitExec("c_r72", browserRpc, shellRpc);
    const store = new Store();
    try {
      const asked = await client.call("request_takeover", { reason: "password" });
      assert.equal(asked.ok, true);
      const tk = String((asked as { data: { takeover_id: string } }).data.takeover_id);
      const expires = String((asked as { data: { expires_at: string } }).data.expires_at);
      assert.equal(browserRpc.state.takeover.state, "takeover_requested");
      assert.equal(shellRpc.state.takeover.state, "agent");
      assert.ok(!shellRpc.methods.includes("request_takeover"));
      store.insertTakeover({
        id: tk,
        computer_id: client.computerId,
        state: "takeover_requested",
        expires_at: expires,
      });

      const declined = await client.declineTakeover(tk);
      assert.equal(declined.ok, true);
      // Daemon only commits the store after a successful computer decline.
      if (declined.ok) store.updateTakeoverState(tk, "agent");

      assert.equal(browserRpc.state.takeover.state, "agent");
      assert.equal(shellRpc.state.takeover.state, "agent");
      assert.equal(store.getTakeover(tk)?.state, "agent");
      assert.equal(browserRpc.state.takeover.takeoverId, null);
      assert.equal(shellRpc.state.takeover.takeoverId, null);
      assert.ok(!shellRpc.methods.includes("takeover.sync"));
    } finally {
      store.close();
      await client.close();
    }
  });
});

describe("takeover_id bind + grant side effects after validate", () => {
  it("stale id A cannot grant or release active session B", async () => {
    const state = createState("browser");
    const asked = await rpc(state, "request_takeover", { reason: "password" });
    assert.equal(asked.ok, true);
    const b = String((asked as { data: { takeover_id: string } }).data.takeover_id);
    assert.notEqual(b, "tk_stale_A");

    const grantA = await rpc(state, "takeover.grant", { takeover_id: "tk_stale_A" });
    assert.equal(grantA.ok, false);
    if (!grantA.ok) assert.equal(grantA.error.code, "E_POLICY");
    assert.equal(state.takeover.state, "takeover_requested");
    assert.equal(state.takeover.takeoverId, b);

    const releaseA = await rpc(state, "takeover.release", { takeover_id: "tk_stale_A" });
    assert.equal(releaseA.ok, false);
    if (!releaseA.ok) assert.equal(releaseA.error.code, "E_POLICY");
    assert.equal(state.takeover.state, "takeover_requested");
    assert.equal(state.takeover.takeoverId, b);
  });

  it("rejected grant performs no capture/mode side effect", async () => {
    const state = createState("browser");
    const stub = trackingBrowser();
    state.browser = stub as never;
    const sub = await rpc(state, "screencast.subscribe");
    assert.equal(sub.ok, true);
    assert.equal(state.screencastSubscribed, true);
    assert.equal(stub.calls.start, 1);

    const asked = await rpc(state, "request_takeover", { reason: "password" });
    assert.equal(asked.ok, true);
    const tk = String((asked as { data: { takeover_id: string } }).data.takeover_id);
    const declined = await rpc(state, "takeover.decline", { takeover_id: tk });
    assert.equal(declined.ok, true);
    assert.equal(state.takeover.state, "agent");
    const modesAfterDecline = stub.calls.modes.slice();
    const stopAfterDecline = stub.calls.stop;
    const abortAfterDecline = stub.calls.abort;

    const late = await rpc(state, "takeover.grant", { takeover_id: tk });
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.error.code, "E_POLICY");
    assert.equal(state.takeover.state, "agent");
    assert.equal(state.screencastSubscribed, true);
    assert.equal(stub.calls.stop, stopAfterDecline);
    assert.equal(stub.calls.abort, abortAfterDecline);
    assert.deepEqual(stub.calls.modes, modesAfterDecline);
    assert.equal(stub.liveMode, "agent");
    assert.ok(!stub.calls.modes.includes("human"));
  });

  it("takeover.sync restores human on browser and shell at the recorded epoch", async () => {
    const browserRpc = new DispatchRpc(createState("browser"));
    const shellRpc = new DispatchRpc(createState("shell"));
    const client = new SplitExec("c_restore", browserRpc, shellRpc);
    const expires = new Date(Date.now() + 60_000).toISOString();
    try {
      const synced = await client.call("takeover.sync", {
        takeover_id: "tk_hold", expires_at: expires, state: "human", epoch: 7,
      });
      assert.equal(synced.ok, true);
      assert.equal(browserRpc.state.takeover.state, "human");
      assert.equal(shellRpc.state.takeover.state, "human");
      assert.equal(browserRpc.state.takeover.takeoverId, "tk_hold");
      assert.equal(shellRpc.state.takeover.takeoverId, "tk_hold");
      assert.equal(browserRpc.state.takeover.epoch, 7);
      assert.equal(shellRpc.state.takeover.epoch, 7);
      assert.ok(shellRpc.methods.includes("takeover.sync"));
    } finally {
      await client.close();
    }
  });

  it("exec-client stale grant does not takeover.sync the shell", async () => {
    const browserRpc = new DispatchRpc(createState("browser"));
    const shellRpc = new DispatchRpc(createState("shell"));
    const client = new SplitExec("c_r73", browserRpc, shellRpc);
    const asked = await client.call("request_takeover", { reason: "password" });
    assert.equal(asked.ok, true);
    const granted = await client.grantTakeover("tk_stale_A");
    assert.equal(granted.ok, false);
    if (!granted.ok) assert.equal(granted.error.code, "E_POLICY");
    assert.equal(browserRpc.state.takeover.state, "takeover_requested");
    assert.equal(shellRpc.state.takeover.state, "agent");
    assert.ok(!shellRpc.methods.includes("takeover.sync"));
    await client.close();
  });
});

describe("refused relay surfaces error on live UI socket", () => {
  let daemon: DaemonHandle;
  let workspaceRoot: string;
  let origRelay: typeof FakeComputer.prototype.relayInput;

  before(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "modelbot-relay-fixture-"));
    process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
    origRelay = FakeComputer.prototype.relayInput;
    FakeComputer.prototype.relayInput = async () =>
      toolError("E_TAKEOVER_BUSY", "input relay only during HUMAN");
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: "test-mcp-token-aaaaaaaaaaaa",
      bootstrapToken: "test-boot-token-bbbbbbbbbbbb",
      workspaceRoot,
    });
  });

  after(async () => {
    FakeComputer.prototype.relayInput = origRelay;
    try { await daemon?.close(); } finally { rmSync(workspaceRoot, { recursive: true, force: true }); }
  });

  it("HUMAN epoch key whose relay returns E_TAKEOVER_BUSY is sent as t=error", async () => {
    const origin = `http://127.0.0.1:${daemon.port}`;
    const boot = await fetch(`${daemon.baseUrl}/api/v1/session/bootstrap`, {
      method: "POST",
      headers: { Origin: origin, "content-type": "application/json" },
      body: JSON.stringify({ token: "test-boot-token-bbbbbbbbbbbb" }),
    });
    assert.equal(boot.status, 200);
    const csrf = ((await boot.json()) as { csrf: string }).csrf;
    const cookie = (boot.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const headers = {
      Origin: origin,
      Host: `127.0.0.1:${daemon.port}`,
      cookie,
      [CSRF_HEADER]: csrf,
      "content-type": "application/json",
    };
    const created = await fetch(`${daemon.baseUrl}/api/v1/computers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "split", capabilities: ["browser"] }),
    });
    assert.equal(created.status, 201);
    const computerId = ((await created.json()) as { computer: { id: string } }).computer.id;
    const requested = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST",
      headers,
      body: JSON.stringify({ computer_id: computerId, reason: "password" }),
    });
    assert.equal(requested.status, 200);
    const tk = ((await requested.json()) as { takeover: { takeover_id: string } })
      .takeover.takeover_id;
    const granted = await fetch(`${daemon.baseUrl}/api/v1/takeover/${tk}/grant`, {
      method: "POST",
      headers,
    });
    assert.equal(granted.status, 200);

    const liveUrl = `${daemon.baseUrl.replace("http", "ws")}/api/v1/live/${computerId}`;
    const ws = new WebSocket(liveUrl, {
      headers: { Origin: origin, Cookie: cookie },
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 2000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      });
    });
    ws.send(JSON.stringify({ v: 1, t: "key", key: "a", epoch: daemon.store.getTakeover(tk)!.epoch }));
    const err = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("relay error timeout")), 2000);
      ws.addEventListener("message", (ev) => {
        const raw = ev.data;
        if (typeof raw !== "string") return;
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (msg.t === "error") {
          clearTimeout(t);
          resolve(msg);
        }
      });
    });
    ws.close();
    assert.equal(err.t, "error");
    assert.equal(err.code, "E_TAKEOVER_BUSY");
    assert.match(cookie, new RegExp(SESSION_COOKIE));
  });
});

it("browser-only takeover grant, release, decline and expiry never open a shell", async () => {
  const browserRpc = new DispatchRpc(createState("browser"));
  browserRpc.state.browser = trackingBrowser() as any;
  browserRpc.state.screencastSubscribed = true;
  // The real dispatch validates IDs and the FSM; opening a missing shell fails this check.
  class BrowserOnly extends ExecComputerClient {
    protected override async rpc(role: "browser" | "shell"): Promise<JsonRpcClient> {
      assert.equal(role, "browser");
      return browserRpc;
    }
  }
  const client = new BrowserOnly("browser_only", { capabilities: ["browser"] });
  const request = async () => {
    const result = await client.call("request_takeover", { reason: "login" });
    assert.equal(result.ok, true);
    return String((result as { data: { takeover_id: string } }).data.takeover_id);
  };
  try {
    let id = await request();
    assert.equal((await client.grantTakeover(`${id}-stale`)).ok, false);
    assert.equal((await client.grantTakeover(id)).ok, true);
    assert.equal(browserRpc.state.screencastSubscribed, true, "operator view survives grant");
    assert.equal(browserRpc.state.browser.liveMode, "human");
    for (const method of ["browser_snapshot", "browser_screenshot"]) {
      const result = await client.call(method, {});
      assert.equal(result.ok, false, `${method} must stay model-blind`);
      if (!result.ok) assert.equal(result.error.code, "E_TAKEOVER_BUSY");
    }
    assert.equal((await client.releaseTakeover(id)).ok, true);
    assert.equal(browserRpc.state.takeover.state, "agent");
    id = await request();
    assert.equal((await client.declineTakeover(id)).ok, true);
    assert.equal(browserRpc.state.takeover.state, "agent");
    id = await request();
    assert.equal((await client.expireTakeover(id)).ok, true);
    assert.equal(browserRpc.state.takeover.state, "paused");
    assert.equal((browserRpc.state.browser as any).calls.reset, 2, "release and expiry both clear held keys");
  } finally {
    await client.close();
  }
});

class StubRpc implements JsonRpcClient {
  readonly child = null;
  requested: Array<{ method: string; params: unknown }> = [];
  fail: Error | undefined;
  constructor(fail?: Error) {
    this.fail = fail;
  }
  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.fail) throw this.fail;
    this.requested.push({ method, params });
    return { ok: true, data: { typed: 1 } };
  }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

class StubExec extends ExecComputerClient {
  stub: JsonRpcClient;
  constructor(stub: JsonRpcClient) {
    super("c_relay");
    this.stub = stub;
  }
  protected override async rpc(): Promise<JsonRpcClient> {
    return this.stub;
  }
}

describe("relayInput notify result", () => {
  it("notify rejects → caller sees non-ok result", async () => {
    const client = new StubExec(new StubRpc(new Error("pipe closed")));
    const result = await client.relayInput({ t: "key", key: "a" });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected error");
    assert.equal(result.error.code, "E_IO");
    assert.match(result.error.message, /pipe closed/);
  });

  it("notify resolves → CS ToolResult after request", async () => {
    const stub = new StubRpc();
    const client = new StubExec(stub);
    const msg = { t: "text", text: "hi" };
    const result = await client.relayInput(msg);
    assert.deepEqual(result, { ok: true, data: { typed: 1 } });
    assert.equal(stub.requested.length, 1);
    assert.equal(stub.requested[0]?.method, "live.text");
    assert.equal(stub.requested[0]?.params, msg);
  });
});
