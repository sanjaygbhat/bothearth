import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeComputerClient,
  FakeComputer,
  fakeComputerFor,
} from "../../../src/computer-client/fake.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";
import { createApproval } from "../../../src/policy/approvals.ts";
import { terminalCopy } from "../../../src/ui/task.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { until } from "../../helpers/until.ts";

function taskSummaryJson(store: Store, id: string): string | null {
  const row = store.db.prepare("SELECT summary_json FROM tasks WHERE id = ?").get(id) as { summary_json: string | null } | undefined;
  return row?.summary_json ?? null;
}

// Exercise cancellation during an awaited dispatch step, not merely a stored status.
test("cancelled tasks cannot dispatch queued or subsequent tool calls", async () => {
  const store = new Store();
  const client = createFakeComputerClient("cancel-test");
  store.insertComputer({ id: client.computerId, name: "cancel", capabilities: ["browser"], persistent: false, status: "running" });
  const task = store.insertTask({ computer_id: client.computerId, goal: "cancel", max_steps: 10 });
  let executed = 0;
  const dispatcher = createToolDispatcher({
    store, getClient: () => client,
    emit: async () => { store.cancelTask(task.id); },
    execute: async () => { executed++; return { ok: true, data: {} }; },
  });
  try {
    const context = { taskId: task.id, computerId: client.computerId, origin: "https://example.com", signals: {} };
    assert.equal((await dispatcher.dispatch("done", {}, context)).ok, false);
    assert.equal((await dispatcher.dispatch("done", {}, context)).ok, false);
    assert.equal(executed, 0);
  } finally { await client.close(); store.close(); }
});

for (const action of ["cancel", "shutdown"]) test(`${action} aborts an in-flight provider request`, async () => {
  let closed = false;
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const entered = Promise.withResolvers<AbortSignal>();
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-cancel-")),
    agentLoop: { model: "test", adapter: { kind: "openai_compat", complete: async (req) => {
      assert.ok(req.signal);
      entered.resolve(req.signal);
      return new Promise((_, reject) => req.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } } },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "cancel-provider", name: "cancel", capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ computer_id: "cancel-provider", goal: "wait", driver: "a11y" }) });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    const signal = await entered.promise;
    if (action === "shutdown") {
      await daemon.close();
      closed = true;
    } else {
      const cancel = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/cancel`, { method: "POST", headers });
      assert.equal(cancel.status, 200);
      assert.equal(daemon.store.getTask(task.id)?.status, "cancelled");
    }
    assert.equal(signal.aborted, true);
  } finally {
    if (!closed) await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("routine history waits for real standalone execution and records its cost", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-routine-")),
    agentLoop: { model: "test", adapter: { kind: "openai_compat", complete: async () => {
      entered.resolve();
      await complete.promise;
      return { tool_calls: [{ id: "done", name: "done", arguments: {} }], usage: { tokens_in: 1, tokens_out: 1, usd_est: 0.25 } };
    } } },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "routine-test", name: "routine-test", capabilities: ["browser"], persistent: false, status: "running" });
    const response = await fetch(`${daemon.baseUrl}/api/v1/routines`, { method: "POST", headers, body: JSON.stringify({ name: "test", computer_name: "routine-test", cron: "0 * * * *", task: { goal: "finish" } }) });
    assert.equal(response.status, 201);
    const { routine } = await response.json() as { routine: { id: string } };
    const running = fetch(`${daemon.baseUrl}/api/v1/routines/${routine.id}/run`, { method: "POST", headers });
    await entered.promise;
    const history = await fetch(`${daemon.baseUrl}/api/v1/routines/${routine.id}/history`, { headers }).then((r) => r.json()) as { history: Array<{ status: string }> };
    assert.equal(history.history[0]?.status, "running");
    complete.resolve();
    const result = await (await running).json() as { history: { status: string; cost_usd: number; task_id: string } };
    assert.equal(result.history.status, "done");
    assert.equal(result.history.cost_usd, 0.25);
    assert.equal(daemon.store.getTask(result.history.task_id)?.status, "completed");
  } finally {
    complete.resolve();
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

for (const scenario of ["approve", "cancel", "routine"]) test(`${scenario}: standalone approval wait honors task policy and resumes or cancels`, async () => {
  const cancel = scenario === "cancel";
  let routineRun: Promise<Response> | undefined;
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  let providerCalls = 0;
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-resume-")),
    enabledGates: ["new_domain"],
    agentLoop: { model: "test", mode: "supervised", declaredOrigins: { readable: ["https://example.com"], writable: scenario === "routine" ? ["https://example.com"] : [] },
      adapter: { kind: "openai_compat", complete: async (req) => {
        providerCalls++;
        if (providerCalls === 2) assert.ok(req.messages.some((m) => m.role === "tool" && m.tool_call_id === "submit"));
        return { tool_calls: providerCalls === 1
          ? [{ id: "submit", name: "browser_type", arguments: { snapshot_id: "s", ref: "e1", text: "fixture", submit: true } }]
          : [{ id: "done", name: "done", arguments: {} }], usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 } };
      } },
    },
  });
  const waitUntil = async (fn: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (!fn()) { assert.ok(Date.now() < deadline, "condition timed out"); await new Promise((r) => setTimeout(r, 10)); }
  };
  try {
    const { headers } = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "resume", name: "resume", capabilities: ["browser"], persistent: false, status: "running" });
    let task: { id: string };
    if (scenario === "routine") {
      const response = await fetch(`${daemon.baseUrl}/api/v1/routines`, { method: "POST", headers, body: JSON.stringify({ name: "scope", computer_name: "resume", cron: "0 * * * *", task: { goal: "submit", origins: [] } }) });
      const { routine } = await response.json() as { routine: { id: string } };
      routineRun = fetch(`${daemon.baseUrl}/api/v1/routines/${routine.id}/run`, { method: "POST", headers });
      await waitUntil(() => daemon.store.listTasks().length === 1);
      task = daemon.store.listTasks()[0]!;
    } else {
      const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ computer_id: "resume", goal: "submit", driver: "a11y" }) });
      ({ task } = await created.json() as { task: { id: string } });
    }
    await waitUntil(() => daemon.store.listApprovals("pending").length === 1);
    assert.equal(providerCalls, 1);
    const approval = daemon.store.listApprovals("pending")[0]!;
    if (cancel) {
      await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/cancel`, { method: "POST", headers });
      await waitUntil(() => daemon.store.getTask(task.id)?.status === "cancelled");
      assert.equal(providerCalls, 1);
      assert.equal(daemon.store.getApproval(approval.id)?.status, "pending");
    } else {
      const decision = await fetch(`${daemon.baseUrl}/api/v1/approvals/${approval.id}`, { method: "POST", headers,
        body: JSON.stringify({ decision: "allow_once", bind: JSON.parse(approval.bind_json) }) });
      assert.equal(decision.status, 200);
      await waitUntil(() => daemon.store.getTask(task.id)?.status === "completed");
      assert.equal(daemon.store.getApproval(approval.id)?.status, "consumed");
      assert.equal(providerCalls, 2);
      const calls = daemon.store.db.prepare("SELECT * FROM steps WHERE task_id = ? AND kind = 'tool_result'").all(task.id);
      assert.equal(calls.length, 2);
      if (routineRun) assert.equal((await routineRun).status, 200);
    }
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

for (const status of ["expired", "consumed", "denied", "killed"] as const) test(`repeating an action with ${status} consent preserves approval boundaries`, async () => {
  const store = new Store();
  const computer = createFakeComputerClient("renew-approval");
  store.insertComputer({ id: computer.computerId, name: "renew", capabilities: ["browser", "shell"], persistent: true, status: "running" });
  const task = store.insertTask({ computer_id: computer.computerId, goal: "repeat", max_steps: 5 });
  let executed = 0;
  const dispatcher = createToolDispatcher({ store, getClient: () => computer, emit: async () => {}, execute: async () => { executed++; return { ok: true, data: {} }; } });
  const args = { command: "echo fixture" };
  const context = { taskId: task.id, computerId: computer.computerId, origin: "https://example.com", signals: {} };
  try {
    const first = await dispatcher.dispatch("shell_exec", args, context);
    assert.equal(first.ok, false);
    const approval = store.listApprovals("pending")[0]!;
    assert.ok(approval);
    store.setApprovalStatusIf(approval.id, "pending", status, null);
    const second = await dispatcher.dispatch("shell_exec", args, context);
    assert.equal(second.ok, false);
    assert.equal(executed, 0);
    if (status === "expired" || status === "consumed") {
      assert.equal(!second.ok && second.error.code, "E_POLICY_PENDING");
      const fresh = store.listApprovals("pending")[0]!;
      assert.notEqual(fresh.id, approval.id);
      store.setApprovalStatusIf(fresh.id, "pending", "approved", "allow_once");
      assert.equal((await dispatcher.dispatch("shell_exec", args, context)).ok, true);
      assert.equal(executed, 1);
    } else assert.equal(store.listApprovals().length, 1);
  } finally { await computer.close(); store.close(); }
});

for (const status of ["completed", "failed", "cancelled"]) test(`Store cancellation preserves an already ${status} task`, () => {
  const store = new Store();
  try {
    const task = store.insertTask({ computer_id: "terminal", goal: "saved result", max_steps: 5 });
    store.db.prepare("UPDATE tasks SET status = ?, cancelled_at = ? WHERE id = ?").run(status, status === "cancelled" ? "2026-01-01T00:00:00Z" : null, task.id);
    const before = store.getTask(task.id);
    assert.deepEqual(store.cancelTask(task.id), before);
    assert.deepEqual(store.cancelTask(task.id), before, "repeated cancellation is idempotent");
  } finally { store.close(); }
});

for (const olderStatus of ["completed", "running", "finishes-during-cancel"]) test(`cancelling a ${olderStatus} task preserves another task's shared browser client`, async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  let clientCloses = 0;
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-terminal-cancel-")),
    agentLoop: { model: "test", createDriver: (_, computer) => {
      const close = computer.close.bind(computer);
      computer.close = async () => { clientCloses++; await close(); };
      return createA11yDriver(computer);
    }, adapter: { kind: "openai_compat", complete: async () => {
      entered.resolve(); await complete.promise;
      return { tool_calls: [{ id: "finish", name: "done", arguments: { status: "success", summary: "New task finished" } }], usage: { tokens_in: 0, tokens_out: 0, usd_est: 0 } };
    } } },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "shared-cancel", name: "shared", capabilities: ["browser"], persistent: true, status: "running" });
    const older = daemon.store.insertTask({ computer_id: "shared-cancel", goal: "older", max_steps: 5 });
    daemon.store.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(olderStatus === "completed" ? "completed" : "running", older.id);
    if (olderStatus === "finishes-during-cancel") {
      const cancel = daemon.store.cancelTask.bind(daemon.store);
      daemon.store.cancelTask = (id) => {
        if (id === older.id) daemon.store.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(id);
        return cancel(id);
      };
    }
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ computer_id: "shared-cancel", goal: "new task", driver: "a11y" }) });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    await entered.promise;
    const stopped = await fetch(`${daemon.baseUrl}/api/v1/tasks/${older.id}/cancel`, { method: "POST", headers });
    assert.equal(stopped.status, 200);
    assert.equal(daemon.store.getTask(older.id)?.status, olderStatus === "running" ? "cancelled" : "completed");
    assert.equal(clientCloses, 0, "a different task still owns this browser connection");
    const events = daemon.store.db.prepare("SELECT type FROM audit_refs WHERE task_id = ? AND type = 'task.cancelled'").all(older.id);
    assert.equal(events.length, olderStatus === "running" ? 1 : 0);
    complete.resolve();
    const deadline = Date.now() + 3000;
    while (daemon.store.getTask(task.id)?.status === "running") {
      assert.ok(Date.now() < deadline, "new task did not finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(daemon.store.getTask(task.id)?.status, "completed");
  } finally {
    complete.resolve(); await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("cancel responds immediately when runner teardown never resolves", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const entered = Promise.withResolvers<void>();
  const stuck = Promise.withResolvers<void>();
  let closeSettled = false;
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-cancel-hang-")),
    agentLoop: { model: "test", createDriver: (_, computer) => {
      const close = computer.close.bind(computer);
      computer.close = async () => { await stuck.promise; closeSettled = true; await close(); };
      return createA11yDriver(computer);
    }, adapter: { kind: "openai_compat", complete: async (req) => {
      entered.resolve();
      return new Promise((_, reject) => req.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } } },
  });
  const freeze = daemon.store.freezeTaskSummary.bind(daemon.store);
  daemon.store.freezeTaskSummary = (id) => {
    assert.equal(closeSettled, true, "summary_json must freeze only after teardown settles");
    freeze(id);
  };
  try {
    const { headers } = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "hang-cancel", name: "hang", capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ computer_id: "hang-cancel", goal: "wait", driver: "a11y" }) });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    await entered.promise;
    const started = Date.now();
    const cancel = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/cancel`, { method: "POST", headers });
    const elapsed = Date.now() - started;
    assert.equal(cancel.status, 200);
    assert.ok(elapsed < 1_000, `cancel took ${elapsed}ms; teardown must not block the response`);
    const body = await cancel.json() as { ok: boolean; task: { id: string; status: string } };
    assert.equal(body.ok, true);
    assert.equal(body.task.status, "cancelled");
    assert.equal(daemon.store.getTask(task.id)?.status, "cancelled");
    assert.ok(daemon.store.getTask(task.id)?.summary, "hydrateTask derives summary from the cancelled event before freeze");
    assert.equal(taskSummaryJson(daemon.store, task.id), null, "summary_json stays unset while teardown hangs");
    const againStarted = Date.now();
    const again = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/cancel`, { method: "POST", headers });
    assert.equal(again.status, 200);
    assert.ok(Date.now() - againStarted < 1_000, "a second cancel must stay idempotent while teardown hangs");
    assert.equal(((await again.json()) as { task: { status: string } }).task.status, "cancelled");
    assert.equal(taskSummaryJson(daemon.store, task.id), null, "a second cancel must not freeze while teardown hangs");
    const events = daemon.store.db.prepare("SELECT body_json FROM audit_refs WHERE task_id = ? AND type = 'task.cancelled'").all(task.id) as Array<{ body_json: string }>;
    assert.ok(events.some((row) => JSON.parse(row.body_json).cancelled_by === "ui"));
    stuck.resolve();
    const deadline = Date.now() + 3_000;
    while (taskSummaryJson(daemon.store, task.id) == null) {
      assert.ok(Date.now() < deadline, "summary_json was not frozen after teardown settled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    stuck.resolve();
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("cancel still freezes summary_json when teardown rejects", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const entered = Promise.withResolvers<void>();
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-cancel-throw-")),
    agentLoop: { model: "test", adapter: { kind: "openai_compat", complete: async (req) => {
      entered.resolve();
      return new Promise((_, reject) => req.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } } },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "throw-cancel", name: "throw", capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ computer_id: "throw-cancel", goal: "wait", driver: "a11y" }) });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    await entered.promise;
    let takeoverCalls = 0;
    const takeover = daemon.store.activeTakeoverForComputer.bind(daemon.store);
    daemon.store.activeTakeoverForComputer = (computerId, taskId) => {
      takeoverCalls++;
      if (takeoverCalls > 1) throw new Error("teardown boom");
      return takeover(computerId, taskId);
    };
    const cancel = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/cancel`, { method: "POST", headers });
    assert.equal(cancel.status, 200);
    const deadline = Date.now() + 3_000;
    while (taskSummaryJson(daemon.store, task.id) == null) {
      assert.ok(Date.now() < deadline, "summary_json was not frozen after teardown rejected");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("cookie-session cancel without Origin is api; bearer cancel is not a UI route", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const entered = Promise.withResolvers<void>();
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-cancel-by-")),
    agentLoop: { model: "test", adapter: { kind: "openai_compat", complete: async (req) => {
      entered.resolve();
      return new Promise((_, reject) => req.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } } },
  });
  try {
    const session = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "by-cancel", name: "by", capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers: session.headers, body: JSON.stringify({ computer_id: "by-cancel", goal: "wait", driver: "a11y" }) });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    await entered.promise;
    const bearer = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/cancel`, {
      method: "POST", headers: { authorization: "Bearer test-mcp" },
    });
    assert.equal(bearer.status, 403);
    const cancel = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
    });
    assert.equal(cancel.status, 200);
    const events = daemon.store.db.prepare("SELECT body_json FROM audit_refs WHERE task_id = ? AND type = 'task.cancelled'").all(task.id) as Array<{ body_json: string }>;
    assert.ok(events.some((row) => JSON.parse(row.body_json).cancelled_by === "api"));
    const copy = terminalCopy({ status: "cancelled", reason: "cancelled", budget: null, took: null, cancelledBy: "api" });
    assert.equal(copy.heading, "Stopped through the API");
    assert.doesNotMatch(copy.heading, /You stopped it/);
    assert.doesNotMatch(copy.lede, /You stopped it/);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("approval kill records cancelled_by system", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-cancel-system-")),
  });
  try {
    const session = await bootstrapSession(daemon, "test-boot");
    daemon.store.insertComputer({ id: "sys-cancel", name: "sys", capabilities: ["browser"], persistent: false, status: "running" });
    const task = daemon.store.insertTask({ computer_id: "sys-cancel", goal: "wait", max_steps: 5 });
    const request = createApproval({
      tool: "browser_navigate", args: { url: "https://example.com" }, gate: "new_domain",
      task_id: task.id, control_epoch: 0, origin: "https://example.com",
    });
    daemon.store.insertApproval({
      id: request.approval_id, task_id: task.id, tool: "browser_navigate",
      args: request.args, gate: "new_domain", bind: request.bind as unknown as Record<string, unknown>,
    });
    const kill = await fetch(`${daemon.baseUrl}/api/v1/approvals/${request.approval_id}`, {
      method: "POST", headers: session.headers, body: JSON.stringify({ decision: "kill", bind: request.bind }),
    });
    assert.equal(kill.status, 200);
    assert.equal(daemon.store.getTask(task.id)?.status, "cancelled");
    const events = daemon.store.db.prepare("SELECT body_json FROM audit_refs WHERE task_id = ? AND type = 'task.cancelled'").all(task.id) as Array<{ body_json: string }>;
    assert.ok(events.some((row) => JSON.parse(row.body_json).cancelled_by === "system"));
    const copy = terminalCopy({ status: "cancelled", reason: null, budget: null, took: null, cancelledBy: "system" });
    assert.equal(copy.heading, "BotHearth stopped it");
    assert.doesNotMatch(copy.heading, /You stopped it/);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

const OPEN_HOLD = new Set(["takeover_requested", "human", "resume_validating", "paused"]);

async function cancelHoldFixture(label: string) {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "hold-mcp", bootstrapToken: "hold-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), `mb-cancel-${label}-`)),
  });
  const { headers } = await bootstrapSession(daemon, "hold-boot");
  const computerId = `${label}-hold`;
  daemon.store.insertComputer({ id: computerId, name: label, capabilities: ["browser"], persistent: false, status: "running" });
  const task = daemon.store.insertTask({ computer_id: computerId, goal: "hold", max_steps: 5 });
  const post = (path: string, body: unknown = {}) => fetch(`${daemon.baseUrl}${path}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  return {
    daemon, headers, computerId, task, post, oldFake,
    async close() {
      await daemon.close();
      if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
      else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
    },
    async listOpen() {
      const res = await fetch(`${daemon.baseUrl}/api/v1/takeovers`, { headers });
      const body = await res.json() as { takeovers: Array<{ state: string; task_id: string | null }> };
      return { status: res.status, takeovers: body.takeovers.filter((row) => OPEN_HOLD.has(row.state)) };
    },
  };
}

test("cancel with a paused hold closes it, empties open takeovers, and releases the computer", async () => {
  const f = await cancelHoldFixture("paused");
  try {
    const requested = await f.post("/api/v1/takeover/request", { computer_id: f.computerId, task_id: f.task.id });
    assert.equal(requested.status, 200);
    const id = ((await requested.json()) as { takeover: { takeover_id: string } }).takeover.takeover_id;
    assert.equal((await f.post(`/api/v1/takeover/${id}/acquire`)).status, 200);
    const computer = fakeComputerFor(f.computerId)!;
    assert.equal((await computer.expireTakeover(id)).ok, true);
    f.daemon.store.updateTakeoverState(id, "paused");
    const cancel = await f.post(`/api/v1/tasks/${f.task.id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(f.daemon.store.getTask(f.task.id)?.status, "cancelled");
    assert.equal(OPEN_HOLD.has(f.daemon.store.getTakeover(id)?.state ?? ""), false);
    assert.equal((await f.listOpen()).takeovers.length, 0);
    await until(() => computer.getTakeoverState() === "agent", "computer gate was not released");
    const events = f.daemon.store.listAuditRefs().filter((row) =>
      row.type === "takeover.declined" || row.type === "takeover.released");
    assert.ok(events.some((row) => JSON.parse(row.body_json).reason === "task cancelled"));
  } finally { await f.close(); }
});

test("cancel with a human hold closes it, empties open takeovers, and releases the computer", async () => {
  const f = await cancelHoldFixture("human");
  try {
    const requested = await f.post("/api/v1/takeover/request", { computer_id: f.computerId, task_id: f.task.id });
    assert.equal(requested.status, 200);
    const id = ((await requested.json()) as { takeover: { takeover_id: string } }).takeover.takeover_id;
    assert.equal((await f.post(`/api/v1/takeover/${id}/acquire`)).status, 200);
    assert.equal(f.daemon.store.getTakeover(id)?.state, "human");
    const computer = fakeComputerFor(f.computerId)!;
    const cancel = await f.post(`/api/v1/tasks/${f.task.id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(f.daemon.store.getTask(f.task.id)?.status, "cancelled");
    assert.equal(OPEN_HOLD.has(f.daemon.store.getTakeover(id)?.state ?? ""), false);
    assert.equal((await f.listOpen()).takeovers.length, 0);
    await until(() => computer.getTakeoverState() === "agent", "computer gate was not released");
    const events = f.daemon.store.listAuditRefs().filter((row) =>
      row.type === "takeover.declined" || row.type === "takeover.released");
    assert.ok(events.some((row) => JSON.parse(row.body_json).reason === "task cancelled"));
  } finally { await f.close(); }
});

test("cancel with no hold leaves takeovers empty and the computer on agent", async () => {
  const f = await cancelHoldFixture("none");
  try {
    assert.equal(f.daemon.store.listTakeovers().length, 0);
    const cancel = await f.post(`/api/v1/tasks/${f.task.id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(f.daemon.store.getTask(f.task.id)?.status, "cancelled");
    assert.equal((await f.listOpen()).takeovers.length, 0);
    assert.equal(fakeComputerFor(f.computerId)?.getTakeoverState() ?? "agent", "agent");
  } finally { await f.close(); }
});

async function pausedHoldOn(f: Awaited<ReturnType<typeof cancelHoldFixture>>) {
  const requested = await f.post("/api/v1/takeover/request", { computer_id: f.computerId, task_id: f.task.id });
  assert.equal(requested.status, 200);
  const id = ((await requested.json()) as { takeover: { takeover_id: string } }).takeover.takeover_id;
  assert.equal((await f.post(`/api/v1/takeover/${id}/acquire`)).status, 200);
  const computer = fakeComputerFor(f.computerId)!;
  assert.equal((await computer.expireTakeover(id)).ok, true);
  f.daemon.store.updateTakeoverState(id, "paused");
  return { id, computer };
}

test("cancel still returns the gate when takeover_status fails", async () => {
  let failStatus = false;
  const orig = FakeComputer.prototype.call;
  FakeComputer.prototype.call = async function (this: FakeComputer, method: string, params?: unknown) {
    if (failStatus && method === "takeover_status") {
      return { ok: false as const, error: { code: "E_IO" as const, message: "status failed" } };
    }
    return orig.call(this, method, params);
  };
  const f = await cancelHoldFixture("status-fail");
  try {
    const { computer } = await pausedHoldOn(f);
    failStatus = true;
    const cancel = await f.post(`/api/v1/tasks/${f.task.id}/cancel`);
    assert.equal(cancel.status, 200);
    await until(() => computer.getTakeoverState() === "agent", "failed status skipped decline");
  } finally {
    FakeComputer.prototype.call = orig;
    await f.close();
  }
});

test("cancel HTTP does not wait on a hung takeover_status", async () => {
  const hung = Promise.withResolvers<void>();
  let hangStatus = false;
  const orig = FakeComputer.prototype.call;
  FakeComputer.prototype.call = async function (this: FakeComputer, method: string, params?: unknown) {
    if (hangStatus && method === "takeover_status") await hung.promise;
    return orig.call(this, method, params);
  };
  const f = await cancelHoldFixture("status-hang");
  try {
    const { id } = await pausedHoldOn(f);
    hangStatus = true;
    const started = Date.now();
    const cancel = await f.post(`/api/v1/tasks/${f.task.id}/cancel`);
    const elapsed = Date.now() - started;
    assert.equal(cancel.status, 200);
    assert.ok(elapsed < 4_000, `cancel took ${elapsed}ms; HTTP must not wait past the leftover-decline bound`);
    assert.equal(OPEN_HOLD.has(f.daemon.store.getTakeover(id)?.state ?? ""), false);
  } finally {
    hung.resolve();
    FakeComputer.prototype.call = orig;
    await f.close();
  }
});

for (const end of ["completed", "failed"] as const) test(`${end} with a granted paused hold leaves it for return`, async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const leftComplete = Promise.withResolvers<void>();
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "hold-mcp", bootstrapToken: "hold-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), `mb-end-${end}-`)),
    agentLoop: { model: "test", adapter: { kind: "openai_compat", complete: async () => {
      entered.resolve();
      await proceed.promise;
      leftComplete.resolve();
      throw new Error("runner exploded");
    } } },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "hold-boot");
    const computerId = `${end}-paused-hold`;
    daemon.store.insertComputer({ id: computerId, name: end, capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, {
      method: "POST", headers, body: JSON.stringify({ computer_id: computerId, goal: "hold", driver: "a11y" }),
    });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    await entered.promise;
    const requested = await fetch(`${daemon.baseUrl}/api/v1/takeover/request`, {
      method: "POST", headers, body: JSON.stringify({ computer_id: computerId, task_id: task.id }),
    });
    assert.equal(requested.status, 200);
    const id = ((await requested.json()) as { takeover: { takeover_id: string } }).takeover.takeover_id;
    const acquired = await fetch(`${daemon.baseUrl}/api/v1/takeover/${id}/acquire`, {
      method: "POST", headers, body: JSON.stringify({}),
    });
    assert.equal(acquired.status, 200);
    const computer = fakeComputerFor(computerId)!;
    assert.equal((await computer.expireTakeover(id)).ok, true);
    daemon.store.updateTakeoverState(id, "paused");
    if (end === "completed") daemon.store.finishTask(task.id, "completed");
    proceed.resolve();
    await leftComplete.promise;
    await until(() => daemon.store.getTask(task.id)?.status === end, `task never ${end}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(daemon.store.getTakeover(id)?.state, "paused");
    assert.equal(computer.getTakeoverState(), "paused");
  } finally {
    proceed.resolve();
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

