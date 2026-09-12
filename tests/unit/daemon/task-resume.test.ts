import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import type { AdapterCompleteRequest } from "../../../src/types/contracts.ts";
import { until } from "../../helpers/until.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

test("an approval timeout pauses the task and resume carries the transcript on", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const requests: AdapterCompleteRequest[] = [];
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "resume-mcp", bootstrapToken: "resume-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-resume-")),
    approvalTtlSec: 1,
    enabledGates: ["new_domain"],
    agentLoop: {
      model: "test", mode: "supervised",
      declaredOrigins: { readable: ["https://example.com"], writable: [] },
      adapter: { kind: "openai_compat", complete: async (req) => {
        requests.push(req);
        return { tool_calls: requests.length === 1
          ? [{ id: "submit", name: "browser_type", arguments: { snapshot_id: "s", ref: "e1", text: "fixture", submit: true } }]
          : [{ id: "finish", name: "done", arguments: { summary: "resumed and finished" } }],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 } };
      } },
    },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "resume-boot");
    daemon.store.insertComputer({ id: "resume", name: "resume", capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers,
      body: JSON.stringify({ computer_id: "resume", goal: "submit the form", driver: "a11y" }) });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };

    await until(() => daemon.store.getTask(task.id)?.status === "paused", "task never paused on the approval timeout");
    assert.equal(requests.length, 1);
    const pauses = daemon.store.db
      .prepare("SELECT body_json FROM audit_refs WHERE task_id = ? AND type = 'task.step'").all(task.id) as Array<{ body_json: string }>;
    assert.ok(pauses.some((row) => JSON.parse(row.body_json).reason === "approval"), "pause reason not recorded");

    const resumed = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers });
    assert.equal(resumed.status, 202);
    assert.deepEqual(await resumed.json(), { ok: true, status: "running" });

    await until(() => daemon.store.getTask(task.id)?.status === "completed", "resumed task never finished");
    assert.equal(requests.length, 2);
    const second = requests[1]!;
    assert.ok(second.messages.some((m) => m.role === "assistant" && JSON.stringify(m).includes("browser_type")),
      "the resumed transcript lost the earlier assistant turn");
    assert.ok(second.messages.some((m) => m.role === "tool" && m.tool_call_id === "submit"),
      "the resumed transcript left the paused tool call unanswered");
    assert.ok(second.messages.length > requests[0]!.messages.length,
      "the resumed run started from an empty transcript");
    assert.equal(daemon.store.getTask(task.id)?.computer_id, "resume");
    const events = daemon.store.db
      .prepare("SELECT COUNT(*) AS n FROM audit_refs WHERE task_id = ? AND type = 'task.resumed'").get(task.id) as { n: number };
    assert.equal(Number(events.n), 1);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("resuming a task that is not paused is refused with E_STATE", async () => {
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "state-mcp", bootstrapToken: "state-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-resume-state-")),
  });
  try {
    const { headers } = await bootstrapSession(daemon, "state-boot");
    daemon.store.insertComputer({ id: "state", name: "state", capabilities: ["browser"], persistent: false, status: "running" });
    const task = daemon.store.insertTask({ computer_id: "state", goal: "already running", max_steps: 5 });
    const running = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers });
    assert.equal(running.status, 409);
    assert.equal(((await running.json()) as { error: string }).error, "E_STATE");
    assert.equal(daemon.store.getTask(task.id)?.status, "running");

    daemon.store.finishTask(task.id, "completed");
    const finished = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers });
    assert.equal(finished.status, 409);
    assert.equal(((await finished.json()) as { error: string }).error, "E_STATE");

    const missing = await fetch(`${daemon.baseUrl}/api/v1/tasks/nope/resume`, { method: "POST", headers });
    assert.equal(missing.status, 404);
  } finally {
    await daemon.close();
  }
});
