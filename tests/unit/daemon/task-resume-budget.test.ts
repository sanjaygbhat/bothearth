/**
 * The spend cap and the step count are totals for one task, not an allowance a
 * person re-buys with every Resume. A task that stopped on its budget needs a
 * bigger budget to go on, and the receipt has to name what the whole task cost.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { until } from "../../helpers/until.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const PER_CALL_USD = 0.15;
const CONFIG_CAP = 1;
const TASK_CAP = 0.2;

function near(actual: unknown, expected: number, what: string): void {
  assert.equal(typeof actual, "number", `${what} is not a number: ${String(actual)}`);
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${what}: ${String(actual)} != ${expected}`);
}

test("resume continues the same budget and the same step count", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  let turns = 0;
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "budget-mcp", bootstrapToken: "budget-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-budget-")),
    // The configured per-task figure is also the ceiling unless a maximum is
    // named, so a run that means to raise a task's budget has to name one.
    spendCapMaxUsd: 100,
    agentLoop: {
      model: "test", mode: "supervised", spendCapUsd: CONFIG_CAP,
      declaredOrigins: { readable: [], writable: [] },
      adapter: { kind: "openai_compat", complete: async () => {
        turns += 1;
        return {
          tool_calls: turns >= 3
            ? [{ id: `done_${turns}`, name: "done", arguments: { summary: "finished after the budget went up" } }]
            : [{ id: `look_${turns}`, name: "browser_snapshot", arguments: {} }],
          usage: { tokens_in: 10, tokens_out: 5, usd_est: PER_CALL_USD },
        };
      } },
    },
  });
  const lastUsage = (taskId: string) => daemon.store.taskUsage(taskId);
  try {
    const { headers } = await bootstrapSession(daemon, "budget-boot");
    daemon.store.insertComputer({ id: "budget", name: "budget", capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers,
      body: JSON.stringify({ computer_id: "budget", goal: "spend the budget", spend_cap_usd: TASK_CAP }) });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };

    await until(() => daemon.store.getTask(task.id)?.status === "paused", "the task never reached its cap");
    const paused = lastUsage(task.id)!;
    near(paused.usd_est, 2 * PER_CALL_USD, "spend at the first pause");
    assert.equal(paused.steps, 2);
    const firstTurns = turns;

    // Resume with no new budget: there is nothing left to spend.
    const refused = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers });
    assert.equal(refused.status, 409);
    const refusal = (await refused.json()) as { error: string; spend_cap_usd: number; spend_usd: number };
    assert.equal(refusal.error, "E_SPEND_CAP");
    near(refusal.spend_cap_usd, TASK_CAP, "the cap named in the refusal");
    near(refusal.spend_usd, 2 * PER_CALL_USD, "the spend named in the refusal");
    assert.equal(daemon.store.getTask(task.id)?.status, "paused", "a refused resume restarted the task");
    assert.equal(turns, firstTurns, "a refused resume called the model");

    // `agent.spend_cap_usd` is the default a task gets; `agent.spend_cap_max_usd`
    // is the most a person may then give it, and a resume under that is honoured
    // as asked.
    const resumed = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers,
      body: JSON.stringify({ spend_cap_usd: 50 }) });
    assert.equal(resumed.status, 202);
    near(daemon.store.getTask(task.id)?.spend_cap_usd, 50, "the raised cap");

    await until(() => daemon.store.getTask(task.id)?.status === "completed", "the resumed task never finished");
    const total = lastUsage(task.id)!;
    near(total.usd_est, 3 * PER_CALL_USD, "spend after the resume");
    assert.equal(total.steps, 3, "the resumed run restarted the step count");
    assert.equal(total.tokens_in, 30, "the resumed run restarted the token count");

    const summary = daemon.store.getTask(task.id)?.summary as { cost_usd: number; steps: number };
    near(summary.cost_usd, 3 * PER_CALL_USD, "the receipt cost");
    assert.ok(summary.steps >= 3, `the receipt lost steps: ${summary.steps}`);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("a task that used every step needs more steps, not another click", async () => {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  let turns = 0;
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "steps-mcp", bootstrapToken: "steps-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-steps-budget-")),
    agentLoop: {
      model: "test", mode: "supervised",
      declaredOrigins: { readable: [], writable: [] },
      adapter: { kind: "openai_compat", complete: async () => {
        turns += 1;
        return {
          tool_calls: turns >= 2
            ? [{ id: `done_${turns}`, name: "done", arguments: { summary: "finished with the extra steps" } }]
            : [{ id: `look_${turns}`, name: "browser_snapshot", arguments: {} }],
          usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
        };
      } },
    },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "steps-boot");
    daemon.store.insertComputer({ id: "steps", name: "steps", capabilities: ["browser"], persistent: false, status: "running" });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers,
      body: JSON.stringify({ computer_id: "steps", goal: "use every step", max_steps: 1 }) });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };
    await until(() => daemon.store.getTask(task.id)?.status === "paused", "the task never ran out of steps");

    const refused = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "E_LIMIT");
    assert.equal(daemon.store.getTask(task.id)?.status, "paused");

    const resumed = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers,
      body: JSON.stringify({ max_steps: 3 }) });
    assert.equal(resumed.status, 202);
    assert.equal(daemon.store.getTask(task.id)?.max_steps, 3);
    await until(() => daemon.store.getTask(task.id)?.status === "completed", "the resumed task never finished");
    assert.equal(daemon.store.taskUsage(task.id)?.steps, 2, "the resumed run restarted the step count");
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});
