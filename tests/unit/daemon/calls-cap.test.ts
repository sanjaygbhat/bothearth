import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

/**
 * `calls_cap` is the meter's promise about what stops the task, so it may only
 * be a number where tool calls are the counter a cap is measured in. A
 * standalone run is priced by the provider's own dollar estimate and stepped in
 * model turns, several of which each make several tool calls, so dividing its
 * budget by the harness proxy's per-call price named a ceiling nothing enforces.
 */

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

let daemon: DaemonHandle;
let headers: Record<string, string>;

before(async () => {
  daemon = await startDaemon({
    port: 0, mcpToken: "calls-mcp", bootstrapToken: "calls-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-calls-cap-")),
    agentLoop: { model: "calls-cap-test", adapter: { kind: "openai_compat", complete: () => new Promise(() => {}) } },
  });
  ({ headers } = await bootstrapSession(daemon, "calls-boot"));
  daemon.store.insertComputer({ id: "c1", name: "c1", capabilities: ["browser"], persistent: false, status: "running" });
});

after(async () => { await daemon.close(); });

test("a standalone run names no tool-call ceiling, because it has none", async () => {
  const task = daemon.store.insertTask({ computer_id: "c1", goal: "standalone", max_steps: 7, spend_cap_usd: 20 });
  const detail = (await (await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}`, { headers })).json()) as {
    task: { spend_cap_usd: number; calls: number; calls_cap: number | null };
  };
  assert.equal(detail.task.spend_cap_usd, 20);
  assert.equal(detail.task.calls, 0);
  assert.equal(detail.task.calls_cap, null);
});

test("a harness run's ceiling is whichever of its two budgets runs out first", async () => {
  for (const [spend_cap_usd, max_steps, expected] of [[0.05, 400, 5], [20, 3, 3]] as const) {
    const id = `task_${spend_cap_usd}_${max_steps}`;
    daemon.store.insertHarnessTaskBinding({ task_id: id, computer_id: `h${max_steps}`,
      spend_cap_usd, max_steps, proxy_usd_per_tool_call: 0.01 });
    const detail = (await (await fetch(`${daemon.baseUrl}/api/v1/tasks/${id}`, { headers })).json()) as {
      task: { calls_cap: number | null };
    };
    assert.equal(detail.task.calls_cap, expected, `$${spend_cap_usd} / ${max_steps} steps`);
  }
});
