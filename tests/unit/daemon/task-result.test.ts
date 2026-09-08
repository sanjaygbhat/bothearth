import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { redactAuditBody } from "../../../src/audit/log.ts";
import { Store } from "../../../src/daemon/store.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const summary = "Synthetic evidence. ".repeat(1000).slice(0, 19814 - " FINAL DECISION: review before send".length) + " FINAL DECISION: review before send";

test("saved terminal result exports preserve the final decision, remain bounded and require operator authority", async () => {
  assert.equal(summary.length, 19814);
  const dir = mkdtempSync(join(tmpdir(), "mb-result-"));
  const dbPath = join(dir, "state.sqlite");
  const store = new Store(dbPath);
  const cases = ["completed", "failed", "cancelled"].map((status) => {
    const task = store.insertTask({ computer_id: "synthetic", goal: "synthetic result", max_steps: 1 });
    store.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
    const event = store.appendAuditRef({ type: `task.${status}`, task_id: task.id,
      body: { summary, private: "RAW_AUDIT_CANARY" }, hash: "test" });
    return { task, event };
  });
  const owner = cases[0]!.task;
  const observation = store.appendAuditRef({ type: "tool.result", task_id: owner.id,
    body: { summary: "RAW_OBSERVATION_CANARY" }, hash: "test" });
  const nonterminal = store.appendAuditRef({ type: "task.step", task_id: owner.id,
    body: { summary: "NOT_A_FINAL_RESULT" }, hash: "test" });
  const oversized = store.appendAuditRef({ type: "task.failed", task_id: owner.id,
    body: { summary: "x".repeat(300000) + "TAIL" }, hash: "test" });
  const redacted = store.appendAuditRef({ type: "task.completed", task_id: owner.id,
    body: redactAuditBody("task.completed", { summary: "x".repeat(17000) + " Bearer SYNTHETIC_TOKEN_CANARY", password: "PRIVATE_PASSWORD_CANARY" }), hash: "test" });
  store.close();
  const daemon = await startDaemon({ port: 0, sqlitePath: dbPath, workspaceRoot: dir,
    mcpToken: "test-mcp", bootstrapToken: "test-bootstrap" });
  try {
    const { cookie } = await bootstrapSession(daemon, "test-bootstrap");
    const headers = { cookie };
    for (const { task, event } of cases) {
      const detail = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}`, { headers }).then((r) => r.json()) as any;
      const step = detail.steps.find((s: any) => typeof s.body.summary === "string" && s.body.summary.startsWith("Synthetic evidence."));
      assert.equal(step.body.summary.length, 16000);
      assert.equal(step.body.summary_truncated, true);
      assert.equal(detail.truncated, true);
      const url = `${daemon.baseUrl}/api/v1/tasks/${task.id}/results/${event.seq}`;
      const result = await fetch(url, { headers }).then((r) => r.json()) as any;
      assert.equal(result.text, summary);
      assert.equal(result.truncated, false);
      assert.equal(result.total_chars, 19814);
      assert.doesNotMatch(JSON.stringify(result), /RAW_AUDIT_CANARY/);
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: "Bearer test-mcp" } })).status, 403);
    }
    const prefix = `${daemon.baseUrl}/api/v1/tasks/${owner.id}/results/`;
    for (const seq of [cases[1]!.event.seq, observation.seq, nonterminal.seq, 999999])
      assert.equal((await fetch(prefix + seq, { headers })).status, 404, "task and terminal event must both match");
    const bounded = await fetch(prefix + oversized.seq, { headers }).then((r) => r.json()) as any;
    assert.equal(bounded.text.length, 256000); assert.equal(bounded.max_chars, 256000);
    assert.equal(bounded.total_chars, 300004); assert.equal(bounded.truncated, true);
    const safe = await fetch(prefix + redacted.seq, { headers }).then((r) => r.json()) as any;
    assert.match(safe.text, /\[redacted\]$/);
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_TOKEN_CANARY|PRIVATE_PASSWORD_CANARY/);
  } finally { await daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});
