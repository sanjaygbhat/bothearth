import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { taskActivity } from "../../../src/daemon/task-view.ts";
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
