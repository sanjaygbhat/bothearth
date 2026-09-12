/**
 * Step budget precedence for a created task: the request wins, then
 * `agent.max_steps` carried in as `maxSteps`, then the built-in default.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MAX_STEPS } from "../../../src/daemon/agent-loop.ts";
import { startDaemon, type DaemonOptions } from "../../../src/daemon/server.ts";

async function signIn(baseUrl: string, token: string) {
  const boot = await fetch(`${baseUrl}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const { csrf } = (await boot.json()) as { csrf: string };
  return {
    origin: baseUrl,
    cookie: boot.headers.getSetCookie()[0]!.split(";")[0]!,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };
}

/** The adapter finishes on its first turn: this asserts on the row, not the run. */
async function withDaemon(
  over: Partial<DaemonOptions>,
  fn: (baseUrl: string, headers: Record<string, string>) => Promise<void>,
) {
  const fake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    host: "127.0.0.1", port: 0, mcpToken: "steps-mcp", bootstrapToken: "steps-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-steps-")),
    agentLoop: {
      model: "test", mode: "supervised",
      declaredOrigins: { readable: [], writable: [] },
      adapter: { kind: "openai_compat", complete: async () => ({
        tool_calls: [{ id: "finish", name: "done", arguments: { summary: "done" } }],
        usage: { tokens_in: 1, tokens_out: 1, usd_est: 0 },
      }) },
    },
    ...over,
  });
  try {
    daemon.store.insertComputer({ id: "c1", name: "c1", capabilities: ["browser"], persistent: false, status: "running" });
    await fn(daemon.baseUrl, await signIn(daemon.baseUrl, "steps-boot"));
  } finally {
    await daemon.close();
    if (fake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = fake;
  }
}

async function create(baseUrl: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: "POST", headers, body: JSON.stringify({ computer_id: "c1", goal: "count the steps", ...body }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { task: { max_steps: number } }).task;
}

test("agent.max_steps sets the default, and a request still overrides it", async () => {
  await withDaemon({ maxSteps: 12 }, async (baseUrl, headers) => {
    assert.equal((await create(baseUrl, headers, {})).max_steps, 12);
    assert.equal((await create(baseUrl, headers, { max_steps: 5 })).max_steps, 5);
  });
});

test("without a configured budget a task falls back to the built-in default", async () => {
  await withDaemon({}, async (baseUrl, headers) => {
    assert.equal((await create(baseUrl, headers, {})).max_steps, DEFAULT_MAX_STEPS);
  });
});

test("a request may name max_steps 0 for no cap", async () => {
  await withDaemon({ maxSteps: 12 }, async (baseUrl, headers) => {
    assert.equal((await create(baseUrl, headers, { max_steps: 0 })).max_steps, 0);
  });
});
