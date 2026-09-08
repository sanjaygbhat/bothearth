import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../../src/daemon/server.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

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
