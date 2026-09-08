/**
 * `failure_kind` lets the UI switch on why a task stopped instead of matching
 * `reason` strings itself: a timeout waiting for a person, an approval that
 * lapsed, and a provider refusal are not "machine" failures.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentLoop } from "../../../src/daemon/agent-loop.ts";
import { classifyFailureKind } from "../../../src/daemon/provider-limit.ts";
import { Store } from "../../../src/daemon/store.ts";
import { taskActivity } from "../../../src/daemon/task-view.ts";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";

describe("classifyFailureKind", () => {
  it("maps every pause/fail reason to its bucket", () => {
    assert.equal(classifyFailureKind("spend_cap", null), "spend_cap");
    assert.equal(classifyFailureKind("max_steps", null), "max_steps");
    assert.equal(classifyFailureKind("stall", null), "stalled");
    assert.equal(classifyFailureKind("loop_detected", null), "loop");
    assert.equal(classifyFailureKind("takeover", null), "waiting_for_you");
    assert.equal(classifyFailureKind("approval", null), "waiting_for_you");
    assert.equal(classifyFailureKind("failed", null), "machine");
    assert.equal(classifyFailureKind("runner_error", null), "machine");
  });

  it("a provider limit outranks the reason string", () => {
    assert.equal(
      classifyFailureKind("stall", { reason: "rate_limited", resets_at: null }),
      "provider_limit",
    );
  });

  it("an explicit override wins over everything", () => {
    assert.equal(
      classifyFailureKind("failed", { reason: "quota_exhausted", resets_at: null }, "model_error"),
      "model_error",
    );
  });
});

describe("failure_kind on the task record", () => {
  it("a model-declared done(fail) is model_error, not machine", async () => {
    const store = new Store();
    const computer = createFakeComputerClient("fail-kind-model");
    const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic model failure", max_steps: 5 });
    try {
      await runAgentLoop({
        taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
        computer, driver: createA11yDriver(computer), store,
        adapter: { kind: "openai_compat", complete: async () => ({
          tool_calls: [{ id: "finish", name: "done", arguments: { summary: "could not complete", status: "fail" } }],
          usage: { tokens_in: 0, tokens_out: 0, usd_est: 0 },
        }) },
        emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body, task_id: task.id, hash: "synthetic-unit-test" }); },
      });
      const terminal = taskActivity(store, task.id).steps.find((s) => s.kind === "task.failed");
      assert.ok(terminal);
      assert.equal(terminal!.body.failure_kind, "model_error");
    } finally { await computer.close(); store.close(); }
  });

  it("an uncaught exception is machine, not model_error", async () => {
    const store = new Store();
    const computer = createFakeComputerClient("fail-kind-machine");
    const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic crash", max_steps: 5 });
    try {
      await runAgentLoop({
        taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
        computer, driver: createA11yDriver(computer), store,
        adapter: { kind: "openai_compat", complete: async () => { throw new Error("PRIVATE_EXCEPTION_CANARY"); } },
        emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body, task_id: task.id, hash: "synthetic-unit-test" }); },
      });
      const terminal = taskActivity(store, task.id).steps.find((s) => s.kind === "task.failed");
      assert.ok(terminal);
      assert.equal(terminal!.body.failure_kind, "machine");
    } finally { await computer.close(); store.close(); }
  });

  it("a provider quota refusal is provider_limit, surfaced through the task-view whitelist", async () => {
    const store = new Store();
    const computer = createFakeComputerClient("fail-kind-provider");
    const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic quota", max_steps: 5 });
    try {
      await runAgentLoop({
        taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
        computer, driver: createA11yDriver(computer), store,
        adapter: { kind: "openai_compat", complete: async () => { throw new Error("You've hit your usage limit."); } },
        emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body, task_id: task.id, hash: "synthetic-unit-test" }); },
      });
      const terminal = taskActivity(store, task.id).steps.find((s) => s.kind === "task.failed");
      assert.ok(terminal);
      assert.equal(terminal!.body.failure_kind, "provider_limit");
      assert.equal(terminal!.body.provider_limit_reason, "quota_exhausted");
    } finally { await computer.close(); store.close(); }
  });

  it("a spend-cap pause carries failure_kind spend_cap on the paused step", async () => {
    const store = new Store();
    const computer = createFakeComputerClient("fail-kind-spend");
    const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic spend cap", max_steps: 5 });
    try {
      const result = await runAgentLoop({
        taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
        computer, driver: createA11yDriver(computer), store, spendCapUsd: 0.5,
        policyGate: () => ({ decision: "allow" }),
        adapter: { kind: "openai_compat", complete: async () => ({
          tool_calls: [{ id: "d", name: "done", arguments: { summary: "would complete", status: "success" } }],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 1 },
        }) },
        emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body, task_id: task.id, hash: "synthetic-unit-test" }); },
      });
      assert.equal(result.status, "paused");
      const paused = taskActivity(store, task.id).steps.find((s) => s.kind === "task.step");
      assert.ok(paused);
      assert.equal(paused!.body.failure_kind, "spend_cap");
    } finally { await computer.close(); store.close(); }
  });
});
