import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { taskActivity, takeoverContext } from "../../../src/daemon/task-view.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

test("UI readiness is truthful and unconfigured task creation cannot create a running row", async () => {
  const daemon = await startDaemon({ port: 0, mcpToken: "test-mcp", bootstrapToken: "test-bootstrap",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-task-view-")) });
  try {
    const { headers } = await bootstrapSession(daemon, "test-bootstrap");
    const boot = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers }).then((r) => r.json()) as any;
    assert.equal(boot.task_start_available, false); assert.equal(boot.model, null); assert.equal(boot.spend_cap_usd, null);
    const session = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers }).then((r) => r.json()) as any;
    assert.equal(session.standalone_available, false);
    assert.equal((await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers,
      body: JSON.stringify({ computer_id: "missing", goal: "example" }) })).status, 503);
    assert.equal(daemon.store.listTasks().length, 0);
    for (const path of ["/api/v1/routines", "/api/v1/routines/missing/run"]) {
      assert.equal((await fetch(`${daemon.baseUrl}${path}`, { method: "POST", headers, body: "{}" })).status, 503);
    }
    const task = daemon.store.insertTask({ computer_id: "test", goal: "synthetic task", max_steps: 5 });
    daemon.store.insertStep(task.id, 0, "assistant", { content: "Synthetic result", tool_calls: [{ name: "browser_snapshot", arguments: { private: "NO_EXPOSE_CANARY" } }] });
    daemon.store.insertStep(task.id, 1, "observation", { content: "NO_EXPOSE_CANARY" });
    daemon.store.appendAuditRef({ type: "task.completed", task_id: task.id, body: { summary: "Finished", private: "NO_EXPOSE_CANARY" }, hash: "test-hash" });
    const detail = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}`, { headers });
    assert.equal(detail.status, 200);
    const view = await detail.json() as any;
    assert.equal(view.task.id, task.id);
    assert.ok(view.steps.some((s: any) => s.body.content === "Synthetic result"));
    assert.ok(view.steps.some((s: any) => s.body.summary === "Finished"));
    assert.equal(JSON.stringify(view).includes("NO_EXPOSE_CANARY"), false);
    assert.equal((await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}`)).status, 401);
    assert.equal((await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}`, { headers: { authorization: "Bearer test-mcp" } })).status, 403);
  } finally { await daemon.close(); }
});

test("task activity is bounded and excludes arbitrary tool results", () => {
  const store = new Store();
  try {
    for (let i = 0; i < 103; i++) store.appendAuditRef({ task_id: "bounded", type: "tool.result",
      body: { name: "browser_snapshot", result: { yaml: "NO_EXPOSE_CANARY", image: "NO_EXPOSE_CANARY" } }, hash: `hash${i}` });
    const view = taskActivity(store, "bounded");
    assert.equal(view.steps.length, 100); assert.equal(view.truncated, true);
    assert.equal(JSON.stringify(view).includes("NO_EXPOSE_CANARY"), false);
  } finally { store.close(); }
});

test("native tool activity keeps its step id so live and durable rows can share a key", () => {
  const store = new Store();
  try {
    const task = store.insertTask({ computer_id: "computer", goal: "Open GitHub", max_steps: 10 });
    store.insertStep(task.id, 0, "native_tool", {
      id: "step_nav1", name: "browser_navigate", type: "mcp_tool_call", status: "started",
    });
    const body = taskActivity(store, task.id).steps.find(step => step.kind === "native_tool")!.body;
    assert.deepEqual(body, {
      id: "step_nav1", name: "browser_navigate", type: "mcp_tool_call", status: "started",
    });
  } finally { store.close(); }
});

test("handoff instructions survive replay, remain bounded and expose no raw arguments", () => {
  const store = new Store();
  try {
    const task = store.insertTask({ computer_id: "computer", goal: "Review the FAQ", max_steps: 10 });
    store.insertTakeover({ id: "tk_review", computer_id: "computer", task_id: task.id, state: "takeover_requested", expires_at: null });
    const source = { takeover_id: "tk_review", reason: "Review the FAQ. Bearer SYNTHETIC_SECRET",
      arguments: { password: "PRIVATE_ARGUMENT" }, result: "PRIVATE_RESULT" };
    const saved = store.appendAuditRef({ task_id: task.id, type: "takeover.requested", body: source, hash: "test" });
    const body = taskActivity(store, task.id).steps[0]!.body;
    assert.deepEqual(body, { takeover_id: "tk_review", reason: "Review the FAQ. [redacted]" });
    assert.deepEqual(takeoverContext(source), body, "live and replay use the same projection");
    assert.doesNotMatch(JSON.stringify(body), /SYNTHETIC_SECRET|PRIVATE_/);
    assert.equal(takeoverContext({ reason: "x".repeat(3000), takeover_id: "bad id" }).reason!.length, 2000);
    assert.equal(takeoverContext({ takeover_id: "bad id" }).takeover_id, undefined);
    store.db.prepare("UPDATE audit_refs SET ts = '2026-01-01T00:00:00Z' WHERE seq = ?").run(saved.seq);
    for (let i = 0; i < 105; i++) store.appendAuditRef({ task_id: task.id, type: "tool.call", body: { name: "takeover_status" }, hash: "test" });
    const history = taskActivity(store, task.id);
    assert.equal(history.steps.length, 100);
    assert.equal(history.history_truncated, true);
    assert.deepEqual(history.steps.find(step => step.kind === "takeover.requested")!.body, body);
  } finally { store.close(); }
});

test("a cancelled takeover receipt counts the ask and the same steps as the live view", () => {
  const store = new Store();
  try {
    const task = store.insertTask({ computer_id: "computer", goal: "Sign in to GitHub", max_steps: 10 });
    const append = (type: string, body: Record<string, unknown>) =>
      store.appendAuditRef({ type, body, task_id: task.id, computer_id: "computer", hash: "takeover" });
    append("usage", { tokens_in: 0, tokens_out: 0, usd_est: 0, steps: 0 });
    append("task.step", { status: "running" });
    append("tool.call", { name: "browser_navigate" });
    append("tool.result", { name: "browser_navigate", arguments: { url: "https://github.com/login" }, result: { ok: true } });
    append("usage", { tokens_in: 0, tokens_out: 0, usd_est: 0.01, steps: 1 });
    append("tool.call", { name: "request_takeover" });
    append("takeover.requested", {
      takeover_id: "tk_sign_in",
      reason: "GitHub’s sign-in page is open. Please sign in directly in the browser.",
      field: { kind: "password", label: "password" },
    });
    append("tool.result", { name: "request_takeover" });
    append("usage", { tokens_in: 0, tokens_out: 0, usd_est: 0.02, steps: 2 });
    append("task.step", { status: "running" });
    store.finishTask(task.id, "cancelled");
    append("task.cancelled", {});
    store.freezeTaskSummary(task.id);

    const summary = store.getTask(task.id)!.summary!;
    assert.equal(summary.asks, 1, "a takeover request is a thing it asked you");
    assert.equal(summary.steps, 2, "heartbeat task.step rows must not inflate the count");
    assert.equal(summary.steps, store.countToolCalls(task.id), "frozen steps equal the live tool.call count");
    assert.deepEqual(summary.sites, ["github.com"]);
    const replayed = taskActivity(store, task.id).steps.find((step) => step.kind === "takeover.requested")!.body;
    assert.equal(replayed.field_kind, "password");
    assert.equal(replayed.reason, "GitHub’s sign-in page is open. Please sign in directly in the browser.");
  } finally { store.close(); }
});
