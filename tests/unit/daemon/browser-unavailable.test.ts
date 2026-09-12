/**
 * The computer can be running while the browser inside it will not start
 * (computer-server `dispatch.ts`). The model cannot fix that and must not be
 * left to improvise around it: the task stops with the cause, and the daemon
 * stops offering to start new ones until a browser comes back.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import {
  BROWSER_RELAUNCH_ACTIVITY,
  BROWSER_TIMEOUT_RELAUNCH_AFTER,
  runAgentLoop,
  type AgentLoopEvent,
} from "../../../src/daemon/agent-loop.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";
import {
  buildRuntimeStatus,
  createRuntimeProbe,
  type ImageStatus,
  type PrepareState,
  type RuntimeStatus,
} from "../../../src/daemon/runtime.ts";
import { Store } from "../../../src/daemon/store.ts";
import type { AdapterCompleteResponse, ProviderAdapter, ToolResult } from "../../../src/types/contracts.ts";

const BROWSER_DOWN =
  "The browser cannot start, so no page can be loaded, shown or driven. Taking control would show " +
  "an empty screen; report the failure instead. quarantine mount missing";

class BrowserDeadComputer extends FakeComputer {
  override async call(method: string, params?: unknown): Promise<ToolResult> {
    return method === "browser_click"
      ? { ok: false, error: { code: "E_SANDBOX_DEAD", message: BROWSER_DOWN } }
      : super.call(method, params);
  }
}

describe("a browser that will not start", { concurrency: false }, () => {
  it("pauses the task with the cause instead of leaving the model to improvise", async () => {
    const computer = new BrowserDeadComputer("browser-dead");
    let calls = 0;
    const adapter: ProviderAdapter = {
      kind: "openai_compat",
      async complete(): Promise<AdapterCompleteResponse> {
        calls += 1;
        return {
          tool_calls: [{ id: "c1", name: "browser_click",
            arguments: { snapshot_id: "snap", ref: "e1", button: null, double_click: null } }],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
        };
      },
    };
    const events: AgentLoopEvent[] = [];
    const store = new Store();
    try {
      const result = await runAgentLoop({
        taskId: "task_browser_dead",
        computerId: computer.computerId,
        goal: "sign in",
        model: "mock-model",
        adapter,
        computer,
        driver: createA11yDriver(computer),
        declaredOrigins: { readable: ["https://fixture.local"], writable: ["https://fixture.local"] },
        policyGate: () => ({ decision: "allow" }),
        store,
        emit: (event) => { events.push(event); },
      });
      assert.equal(result.status, "paused");
      assert.equal(result.reason, "browser_unavailable");
      assert.equal(calls, 1, "the model was asked for another move on a browser that cannot start");

      const stop = events.findLast((event) => event.type === "task.step" && event.body.status === "paused");
      assert.ok(stop, "no paused task.step was emitted");
      assert.equal(stop.body.failure_kind, "machine");
      assert.equal(stop.body.detail, BROWSER_DOWN, "the stop did not name the cause");
      assert.equal(store.getTask("task_browser_dead")?.status ?? "paused", "paused");
    } finally {
      store.close();
    }
  });

  it("stops offering to start a task, and offers again once a browser is back", async () => {
    const images: Record<"computer" | "shell" | "proxy", ImageStatus> = {
      computer: { present: true, created_at: "2026-01-01T00:00:00Z", stale: false, stamp: "s" },
      shell: { present: true, created_at: "2026-01-01T00:00:00Z", stale: false, stamp: "s" },
      proxy: { present: true, created_at: "2026-01-01T00:00:00Z", stale: false, stamp: "s" },
    };
    const prepare: PrepareState = { state: "idle", step: "", percent: null, log_tail: [], error: null };
    const ai: RuntimeStatus["ai"] = { provider: "claude", cli_found: true, cli_path_kind: "well-known",
      logged_in: true, detail: "Claude Code is signed in and ready." };
    const build = (browserUnavailable: string | null) => buildRuntimeStatus({
      nodeVersion: "22.18.0",
      docker: { installed: true, running: true, engine: "orbstack", version: "27.1.1" },
      images, prepare, ai, taskStartAvailable: true, browserUnavailable,
    });

    const down = build(BROWSER_DOWN);
    assert.equal(down.task_start_available, false, "a task was offered with no browser to run it in");
    const blocker = down.blockers.find((entry) => entry.id === "browser_unavailable");
    assert.ok(blocker, "no blocker explained why the task could not start");
    assert.equal(blocker.action.kind, "retry");
    assert.ok(blocker.detail.includes(BROWSER_DOWN), "the blocker did not carry the computer's own words");
    assert.equal(build(null).task_start_available, true);
    assert.equal(build(null).blockers.length, 0);
  });

  it("raises the blocker from a harness tool call, the mode that ships", async () => {
    // The harness (Codex/Claude Code over MCP) is the shipping execution mode.
    // Its tool calls used to bypass the health check entirely: every call
    // answered "the browser cannot start" and the runtime still said ready.
    const original = FakeComputer.prototype.call;
    FakeComputer.prototype.call = async function (method: string, params?: unknown) {
      return method.startsWith("browser_")
        ? { ok: false as const, error: { code: "E_SANDBOX_DEAD", message: BROWSER_DOWN } }
        : original.call(this, method, params);
    };
    process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
    const daemon = await startDaemon({
      host: "127.0.0.1", port: 0, mcpToken: "browser-down-mcp", bootstrapToken: "browser-down-boot",
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-browser-down-")),
    });
    const transport = new StreamableHTTPClientTransport(new URL(`${daemon.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer browser-down-mcp",
        Host: `127.0.0.1:${daemon.port}` } },
    });
    const client = new Client({ name: "browser-down-client", version: "0.0.1" });
    try {
      const { headers } = await bootstrapSession(daemon, "browser-down-boot");
      const created = await fetch(`${daemon.baseUrl}/api/v1/computers`, { method: "POST", headers,
        body: JSON.stringify({ name: "down", capabilities: ["browser"] }) });
      assert.equal(created.status, 201);

      await client.connect(transport);
      const result = await client.callTool({ name: "browser_snapshot",
        arguments: { scope: null, interactive_only: false, depth: null, max_chars: 4000 } });
      const text = (result.content as Array<{ type: string; text: string }>).find((c) => c.type === "text");
      assert.ok(text, "the MCP call returned no tool result");
      assert.equal((JSON.parse(text.text) as { ok: boolean }).ok, false);

      const runtime = await fetch(`${daemon.baseUrl}/api/v1/runtime`, { headers });
      assert.equal(runtime.status, 200);
      const body = await runtime.json() as { task_start_available: boolean;
        blockers: Array<{ id: string; detail: string }> };
      const blocker = body.blockers.find((entry) => entry.id === "browser_unavailable");
      assert.ok(blocker, "a dead browser was invisible to the runtime after a harness call");
      assert.ok(blocker.detail.includes(BROWSER_DOWN));
      assert.equal(body.task_start_available, false);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      FakeComputer.prototype.call = original;
    }
  });

  it("clears the blocker as soon as the computer reports a browser again", async () => {
    let down: string | null = BROWSER_DOWN;
    const probe = createRuntimeProbe({
      preparer: { snapshot: () => ({ state: "idle", step: "", percent: null, log_tail: [], error: null }),
        start: () => ({ started: true, state: { state: "idle", step: "", percent: null, log_tail: [], error: null } }),
        settled: () => undefined },
      configuredProvider: () => "claude",
      providerStatus: async () => "connected",
      standaloneReady: () => true,
      taskStartAvailable: () => true,
      browserUnavailable: () => down,
      nodeVersion: "22.18.0",
      stampFor: () => "stamp0",
      resolve: (name: string) =>
        name === "docker" ? { name, path: "/usr/local/bin/docker", source: "path" as const }
          : name === "claude" ? { name, path: "/opt/homebrew/bin/claude", source: "well-known" as const }
            : null,
      run: async (_bin: string, args: string[]) => {
        if (args[0] === "version") return { stdout: "27.1.1|OrbStack\n", stderr: "", code: 0 };
        if (args[0] === "context") return { stdout: "orbstack\n", stderr: "", code: 0 };
        return { stdout: "modelbot/computer:dev|2026-01-01T00:00:00Z|stamp0\n" +
          "modelbot/shell:dev|2026-01-01T00:00:00Z|stamp0\nmodelbot/proxy:dev|2026-01-01T00:00:00Z|stamp0\n",
          stderr: "", code: 0 };
      },
    });
    const blocked = await probe.snapshot();
    assert.equal(blocked.task_start_available, false);
    assert.equal(blocked.blockers[0]?.id, "browser_unavailable");
    down = null;
    // Same cache entry, fresh verdict: the owner does not wait out a TTL to
    // start a task once the browser is back, and a cached poll invents no
    // blocker of its own.
    const back = await probe.snapshot();
    assert.equal(back.task_start_available, true);
    assert.deepEqual(back.blockers, []);
  });

  assert.equal(BROWSER_TIMEOUT_RELAUNCH_AFTER, 2);

  const SNAPSHOT_ARGS = {
    scope: null, interactive_only: false, depth: null, max_chars: 4000,
  };

  async function until(label: string, check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(label);
  }

  async function startHarness() {
    process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
    const token = `browser-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const daemon = await startDaemon({
      host: "127.0.0.1", port: 0, mcpToken: `${token}-mcp`, bootstrapToken: `${token}-boot`,
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-browser-timeout-")),
    });
    const transport = new StreamableHTTPClientTransport(new URL(`${daemon.baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}-mcp`,
        Host: `127.0.0.1:${daemon.port}` } },
    });
    const client = new Client({ name: "browser-timeout-client", version: "0.0.1" });
    const { headers } = await bootstrapSession(daemon, `${token}-boot`);
    const created = await fetch(`${daemon.baseUrl}/api/v1/computers`, { method: "POST", headers,
      body: JSON.stringify({ name: "timeout", capabilities: ["browser"] }) });
    assert.equal(created.status, 201);
    const computerId = ((await created.json()) as { computer: { id: string } }).computer.id;
    const taskId = `task_timeout_${computerId}`;
    daemon.store.insertHarnessTaskBinding({
      task_id: taskId, computer_id: computerId, spend_cap_usd: 1, max_steps: 20,
      proxy_usd_per_tool_call: 0.01,
    });
    await client.connect(transport);
    return { daemon, headers, computerId, taskId, client, transport };
  }

  async function snapshot(client: Client) {
    return client.callTool({ name: "browser_snapshot", arguments: SNAPSHOT_ARGS });
  }

  async function activityHasRelaunch(daemon: Awaited<ReturnType<typeof startDaemon>>, taskId: string, headers: Record<string, string>) {
    const detail = await fetch(`${daemon.baseUrl}/api/v1/tasks/${taskId}`, { headers });
    assert.equal(detail.status, 200);
    const view = await detail.json() as { steps: Array<{ kind: string; body: { content?: string } }> };
    return view.steps.some((step) => step.body.content === BROWSER_RELAUNCH_ACTIVITY);
  }

  function installTimeoutFake(control: { timeout: boolean; closes: number; dead?: boolean; crash?: boolean }) {
    const originalCall = FakeComputer.prototype.call;
    const originalClose = FakeComputer.prototype.close;
    FakeComputer.prototype.call = async function (method: string, params?: unknown) {
      if (method.startsWith("browser_") && control.dead) {
        return { ok: false as const, error: { code: "E_SANDBOX_DEAD", message: BROWSER_DOWN } };
      }
      if (method.startsWith("browser_") && control.crash) {
        return { ok: false as const, error: { code: "E_IO", message: "Target crashed" } };
      }
      if (method.startsWith("browser_") && control.timeout) {
        return { ok: false as const, error: { code: "E_TIMEOUT", message: "tool exceeded 60000ms" } };
      }
      return originalCall.call(this, method, params);
    };
    FakeComputer.prototype.close = async function () {
      control.closes += 1;
      return originalClose.call(this);
    };
    return () => {
      FakeComputer.prototype.call = originalCall;
      FakeComputer.prototype.close = originalClose;
    };
  }

  it("relaunches once after two consecutive browser tool timeouts", async () => {
    const control = { timeout: true, closes: 0 };
    const restore = installTimeoutFake(control);
    const harness = await startHarness();
    try {
      await snapshot(harness.client);
      await snapshot(harness.client);
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await until("browser was not relaunched after two timeouts", () => control.closes === 1);
      await until("activity missing relaunch line", () => activityHasRelaunch(harness.daemon, harness.taskId, harness.headers));
      const runtime = await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      assert.equal(runtime.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(control.closes, 1, "two timeouts relaunched more than once");
    } finally {
      await harness.client.close().catch(() => undefined);
      await harness.daemon.close();
      restore();
    }
  });

  it("resets the timeout count when a browser tool succeeds in between", async () => {
    const control = { timeout: true, closes: 0 };
    const restore = installTimeoutFake(control);
    const harness = await startHarness();
    try {
      await snapshot(harness.client);
      control.timeout = false;
      await snapshot(harness.client);
      control.timeout = true;
      await snapshot(harness.client);
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(control.closes, 0, "a success between timeouts still relaunched");
      assert.equal(await activityHasRelaunch(harness.daemon, harness.taskId, harness.headers), false);
    } finally {
      await harness.client.close().catch(() => undefined);
      await harness.daemon.close();
      restore();
    }
  });

  it("does not relaunch while a human hold or takeover request is open", async () => {
    const control = { timeout: true, closes: 0 };
    const restore = installTimeoutFake(control);
    const harness = await startHarness();
    try {
      await snapshot(harness.client);
      await snapshot(harness.client);
      harness.daemon.store.insertTakeover({
        id: "tk_hold_timeout", computer_id: harness.computerId, task_id: harness.taskId,
        state: "takeover_requested", expires_at: null,
      });
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(control.closes, 0, "relaunched while a takeover request was open");
      assert.equal(await activityHasRelaunch(harness.daemon, harness.taskId, harness.headers), false);
      harness.daemon.store.updateTakeoverState("tk_hold_timeout", "terminated");
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await until("deferred relaunch after hold did not run", () => control.closes === 1);
      await until("activity missing relaunch line after hold", () =>
        activityHasRelaunch(harness.daemon, harness.taskId, harness.headers));
    } finally {
      await harness.client.close().catch(() => undefined);
      await harness.daemon.close();
      restore();
    }
  });

  it("drops a pending relaunch when a browser tool succeeds before the probe", async () => {
    const control = { timeout: true, closes: 0, dead: false };
    const restore = installTimeoutFake(control);
    let harness: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
      harness = await startHarness();
      await snapshot(harness.client);
      await snapshot(harness.client);
      control.timeout = false;
      await snapshot(harness.client);
      control.dead = true;
      await snapshot(harness.client);
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(control.closes, 0, "a recovered browser was still closed after a later sandbox-dead");
      assert.equal(await activityHasRelaunch(harness.daemon, harness.taskId, harness.headers), false);
    } finally {
      await harness?.client.close().catch(() => undefined);
      await harness?.daemon.close();
      restore();
    }
  });

  it("relaunches once after one crash and one timeout", async () => {
    const control = { timeout: false, crash: true, closes: 0 };
    const restore = installTimeoutFake(control);
    const harness = await startHarness();
    try {
      await snapshot(harness.client);
      control.crash = false;
      control.timeout = true;
      await snapshot(harness.client);
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await until("browser was not relaunched after one crash and one timeout", () => control.closes === 1);
      await until("activity missing relaunch line", () => activityHasRelaunch(harness.daemon, harness.taskId, harness.headers));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(control.closes, 1, "crash plus timeout relaunched more than once");
    } finally {
      await harness.client.close().catch(() => undefined);
      await harness.daemon.close();
      restore();
    }
  });

  it("defers a crash relaunch while a human hold is open", async () => {
    const control = { timeout: false, crash: true, closes: 0 };
    const restore = installTimeoutFake(control);
    const harness = await startHarness();
    try {
      await snapshot(harness.client);
      control.crash = false;
      control.timeout = true;
      await snapshot(harness.client);
      harness.daemon.store.insertTakeover({
        id: "tk_hold_crash", computer_id: harness.computerId, task_id: harness.taskId,
        state: "takeover_requested", expires_at: null,
      });
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(control.closes, 0, "relaunched while a takeover request was open");
      assert.equal(await activityHasRelaunch(harness.daemon, harness.taskId, harness.headers), false);
      harness.daemon.store.updateTakeoverState("tk_hold_crash", "terminated");
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await until("deferred crash relaunch after hold did not run", () => control.closes === 1);
      await until("activity missing relaunch line after hold", () =>
        activityHasRelaunch(harness.daemon, harness.taskId, harness.headers));
    } finally {
      await harness.client.close().catch(() => undefined);
      await harness.daemon.close();
      restore();
    }
  });

  it("resets the crash count when a browser tool succeeds in between", async () => {
    const control = { timeout: false, crash: true, closes: 0 };
    const restore = installTimeoutFake(control);
    const harness = await startHarness();
    try {
      await snapshot(harness.client);
      control.crash = false;
      await snapshot(harness.client);
      control.crash = true;
      await snapshot(harness.client);
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(control.closes, 0, "a success between crashes still relaunched");
      assert.equal(await activityHasRelaunch(harness.daemon, harness.taskId, harness.headers), false);
    } finally {
      await harness.client.close().catch(() => undefined);
      await harness.daemon.close();
      restore();
    }
  });

  it("does not relaunch if a hold appears before the close", async () => {
    const control = { timeout: true, closes: 0 };
    const restore = installTimeoutFake(control);
    let harness: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
      harness = await startHarness();
      const { computerId, taskId } = harness;
      const store = harness.daemon.store;
      const getComputer = store.getComputer.bind(store);
      const takeover = store.activeTakeoverForComputer.bind(store);
      let armed = false;
      let outerCheck = true;
      let inserted = false;
      store.getComputer = (id) => {
        const row = getComputer(id);
        if (id === computerId) armed = true;
        return row;
      };
      store.activeTakeoverForComputer = (id, boundTaskId) => {
        if (!armed || id !== computerId) return takeover(id, boundTaskId);
        if (outerCheck) {
          outerCheck = false;
          return undefined;
        }
        if (!inserted) {
          inserted = true;
          store.insertTakeover({
            id: "tk_hold_toctou", computer_id: computerId, task_id: taskId,
            state: "takeover_requested", expires_at: null,
          });
        }
        return takeover(id, boundTaskId);
      };
      await snapshot(harness.client);
      await snapshot(harness.client);
      await fetch(`${harness.daemon.baseUrl}/api/v1/runtime`, { headers: harness.headers });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(control.closes, 0, "closed Chromium after a hold appeared before close");
      assert.equal(await activityHasRelaunch(harness.daemon, harness.taskId, harness.headers), false);
    } finally {
      await harness?.client.close().catch(() => undefined);
      await harness?.daemon.close();
      restore();
    }
  });
});
