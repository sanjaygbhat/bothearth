import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgentLoop } from "../../../src/daemon/agent-loop.ts";
import { Store } from "../../../src/daemon/store.ts";
import { taskActivity } from "../../../src/daemon/task-view.ts";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";
import { stepText, taskStatus } from "../../../src/ui/task-view.ts";

// Scripted adapter + existing fake computer, real runner/SQLite/UI projection.
// This is not an LLM, HTTP, image, or container acceptance test.
for (const [status, expected] of [
  ["success", "completed"], ["fail", "failed"], ["cancelled", "cancelled"],
  [null, "completed"], [undefined, "completed"],
] as const) test(`done(${String(status)}) keeps its outcome and summary through persistence and UI projection`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-outcome-"));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  const computer = createFakeComputerClient("outcome-browser");
  const summary = "Partial Northstar audit: Directory A confirmed; Launch C is scheduled, not launched. Follow-ups are drafts, not sent.";
  let providerCalls = 0;
  try {
    const task = store.insertTask({ computer_id: computer.computerId, goal: "Review synthetic campaign evidence", max_steps: 5 });
    const result = await runAgentLoop({
      taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
      computer, driver: createA11yDriver(computer), store,
      policyGate: () => ({ decision: "allow" }),
      adapter: { kind: "openai_compat", complete: async () => {
        providerCalls++;
        return { tool_calls: [{ id: "finish", name: "done", arguments: { summary, status } }],
          usage: { tokens_in: 0, tokens_out: 0, usd_est: 0 } };
      } },
      emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body,
        task_id: task.id, computer_id: computer.computerId, hash: "synthetic-unit-test" }); },
    });
    assert.equal(result.status, expected);
    assert.equal(result.reason, expected === "completed" ? "completed" : expected);
    assert.equal(result.summary, summary);
    assert.equal(providerCalls, 1, "finishing must not start another model turn");
    store.close(); store = new Store(path);
    assert.equal(store.getTask(task.id)?.status, expected);
    if (expected === "cancelled") assert.ok(store.getTask(task.id)?.cancelled_at);
    const terminal = taskActivity(store, task.id).steps.filter((s) => /^task\.(completed|failed|cancelled)$/.test(s.kind));
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]!.kind, `task.${expected}`);
    assert.equal(stepText(terminal[0]!), summary, "partial results remain copyable/downloadable through the existing UI");
    assert.equal(taskStatus(store.getTask(task.id)!.status), expected === "completed" ? "Completed" : expected === "failed" ? "Failed" : "Stopped");
  } finally { await computer.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an operator cancellation winning during done cannot retain a success summary", async () => {
  const computer = createFakeComputerClient("cancel-outcome");
  const original = computer.call.bind(computer);
  let cancelled = false;
  computer.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "done") cancelled = true;
    return result;
  };
  const store = new Store();
  const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic cancellation race", max_steps: 5 });
  try {
    const result = await runAgentLoop({
      taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
      computer, driver: createA11yDriver(computer), store, isCancelled: () => cancelled,
      policyGate: () => ({ decision: "allow" }),
      adapter: { kind: "openai_compat", complete: async () => ({
        tool_calls: [{ id: "finish", name: "done", arguments: { summary: "Everything was completed", status: "success" } }],
        usage: { tokens_in: 0, tokens_out: 0, usd_est: 0 },
      }) },
      emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body, task_id: task.id, hash: "synthetic-unit-test" }); },
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.summary, undefined);
    const terminal = taskActivity(store, task.id).steps.find((s) => s.kind === "task.cancelled");
    assert.ok(terminal);
    assert.doesNotMatch(stepText(terminal) ?? "", /Everything was completed/);
  } finally { await computer.close(); store.close(); }
});

test("provider failure is visible without projecting raw exception details", async () => {
  const computer = createFakeComputerClient("error-outcome");
  const store = new Store();
  const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic provider failure", max_steps: 5 });
  try {
    const result = await runAgentLoop({
      taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
      computer, driver: createA11yDriver(computer), store,
      adapter: { kind: "openai_compat", complete: async () => { throw new Error("PRIVATE_EXCEPTION_CANARY"); } },
      emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body, task_id: task.id, hash: "synthetic-unit-test" }); },
    });
    assert.equal(result.status, "failed");
    const view = taskActivity(store, task.id);
    assert.equal(JSON.stringify(view).includes("PRIVATE_EXCEPTION_CANARY"), false);
    const terminal = view.steps.find((s) => s.kind === "task.failed");
    assert.ok(terminal);
    assert.match(stepText(terminal) ?? "", /did not finish/i);
  } finally { await computer.close(); store.close(); }
});
