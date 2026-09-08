/**
 * `agent.spend_cap_usd` is what a task gets when nobody chooses; a request may
 * raise it up to `agent.spend_cap_max_usd`, and asking for more is refused by
 * name rather than clamped in silence. A budget field the person can edit that
 * the server quietly overrules is how a task ran on $2 while the box read $10.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SPEND_CAP_MAX_USD, DEFAULT_SPEND_CAP_USD } from "../../../src/daemon/agent-loop.ts";
import { startDaemon, type DaemonOptions } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

const adapter = { kind: "openai_compat" as const, complete: async () => ({
  tool_calls: [{ id: "finish", name: "done" as const, arguments: { summary: "done" } }],
  usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
}) };

async function withDaemon(
  over: Partial<DaemonOptions>,
  fn: (daemon: Awaited<ReturnType<typeof startDaemon>>, headers: Record<string, string>) => Promise<void>,
): Promise<void> {
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "prec-mcp", bootstrapToken: "prec-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-prec-")),
    ...over,
  });
  try {
    const { headers } = await bootstrapSession(daemon, "prec-boot");
    daemon.store.insertComputer({ id: "c1", name: "c1", capabilities: ["browser"], persistent: false, status: "running" });
    await fn(daemon, headers);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
}

async function budget(daemon: Awaited<ReturnType<typeof startDaemon>>, headers: Record<string, string>) {
  const res = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    spend_cap_usd: number;
    budget: { default_usd: number; max_usd: number; per_call_usd: number };
  };
}

test("the connection payload names the default, the maximum and the per-call price", async () => {
  await withDaemon({ agentLoop: { model: "test", spendCapUsd: 5, adapter }, spendCapMaxUsd: 40 },
    async (daemon, headers) => {
      const info = await budget(daemon, headers);
      assert.equal(info.spend_cap_usd, 5);
      assert.deepEqual(info.budget, { default_usd: 5, max_usd: 40, per_call_usd: 0.01 });
    });

  await withDaemon({ agentLoop: { model: "test", adapter } }, async (daemon, headers) => {
    const info = await budget(daemon, headers);
    assert.deepEqual(info.budget, {
      default_usd: DEFAULT_SPEND_CAP_USD,
      max_usd: DEFAULT_SPEND_CAP_MAX_USD,
      per_call_usd: 0.01,
    });
  });
});

test("a request may raise the configured default, up to the maximum", async () => {
  await withDaemon({ agentLoop: { model: "test", spendCapUsd: 5, adapter }, spendCapMaxUsd: 40 },
    async (daemon, headers) => {
      const create = (body: Record<string, unknown>) =>
        fetch(`${daemon.baseUrl}/api/v1/tasks`, { method: "POST", headers,
          body: JSON.stringify({ computer_id: "c1", ...body }) });

      const silent = await create({ goal: "no budget named" });
      assert.equal(silent.status, 201);
      assert.equal(((await silent.json()) as { task: { spend_cap_usd: number } }).task.spend_cap_usd, 5);

      const raised = await create({ goal: "a bigger job", spend_cap_usd: 30 });
      assert.equal(raised.status, 201);
      assert.equal(((await raised.json()) as { task: { spend_cap_usd: number } }).task.spend_cap_usd, 30);

      const lowered = await create({ goal: "a small job", spend_cap_usd: 1.5 });
      assert.equal(lowered.status, 201);
      assert.equal(((await lowered.json()) as { task: { spend_cap_usd: number } }).task.spend_cap_usd, 1.5);

      const over = await create({ goal: "spend the house", spend_cap_usd: 100000 });
      assert.equal(over.status, 400);
      assert.deepEqual(await over.json(), { error: "E_LIMIT",
        message: "spend_cap_usd must not exceed the configured cap of 40" });

      const negative = await create({ goal: "nonsense", spend_cap_usd: -1 });
      assert.equal(negative.status, 400);
    });
});

test("a resume is held to the same maximum, and never clamped in silence", async () => {
  await withDaemon({ agentLoop: { model: "test", spendCapUsd: 5, adapter }, spendCapMaxUsd: 40 },
    async (daemon, headers) => {
      const task = daemon.store.insertTask({ computer_id: "c1", goal: "paused work",
        max_steps: 10, spend_cap_usd: 5 });
      daemon.store.finishTask(task.id, "paused");

      const over = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, {
        method: "POST", headers, body: JSON.stringify({ spend_cap_usd: 60 }) });
      assert.equal(over.status, 400);
      assert.deepEqual(await over.json(), { error: "E_LIMIT",
        message: "spend_cap_usd must not exceed the configured cap of 40" });
      assert.equal(daemon.store.getTask(task.id)!.spend_cap_usd, 5);

      const raised = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, {
        method: "POST", headers, body: JSON.stringify({ spend_cap_usd: 30 }) });
      assert.equal(raised.status, 202);
      assert.equal(daemon.store.getTask(task.id)!.spend_cap_usd, 30);
    });
});
