/**
 * Native Codex / Claude Code tasks have no BotHearth spend or call cap: the
 * $0.01/call figure is a proxy estimate, and the 400-step default belongs to
 * the API-adapter loop only.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enforceHarnessMcpSpendCap } from "../../../src/daemon/dispatcher.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";

const COMPUTER_ID = "c_native";
const TASK_ID = "native-unlimited";

test("401 tool calls do not stop a native harness binding", async () => {
  const store = new Store(":memory:");
  store.insertComputer({
    id: COMPUTER_ID, name: "native", capabilities: ["browser"], persistent: false, status: "running",
  });
  store.insertHarnessTaskBinding({
    task_id: TASK_ID, computer_id: COMPUTER_ID,
    spend_cap_usd: 0, max_steps: 0, proxy_usd_per_tool_call: 0.01,
  });
  const events: Array<{ type: string; body: Record<string, unknown> }> = [];
  const emit = async (type: string, body: Record<string, unknown>) => {
    events.push({ type, body });
  };
  try {
    for (let i = 1; i <= 401; i += 1) {
      const denied = await enforceHarnessMcpSpendCap({ store, emit }, COMPUTER_ID);
      assert.equal(denied, null, `call ${i} was refused`);
    }
    const binding = store.getHarnessTaskBinding(COMPUTER_ID);
    assert.equal(binding?.observed_tool_calls, 401);
    assert.equal(binding?.denied, 0);
    const usages = events.filter((event) => event.type === "usage");
    assert.equal(usages.length, 401);
    assert.equal(usages[400]!.body.usd_est, 4.01);
    assert.equal(usages[400]!.body.steps, 401);
    assert.equal(events.some((event) => event.type === "policy.denied"), false);
  } finally {
    store.close();
  }
});

test("resume of a native task stored with a spend cap does not refuse the 401st tool call", async () => {
  const cli = fakeCli("native-resume-uncap", () => `
if (process.argv[2] === 'login' && process.argv[3] === 'status') process.exit(0);
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-native-resume-uncap' }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    port: 0, mcpToken: "native-resume-mcp", bootstrapToken: "native-resume-boot",
    workspaceRoot: join(cli.home, "workspace"),
    sqlitePath: join(cli.home, "state.sqlite"),
    codexRunner: {
      execution_location: "host", binary: cli.binary, codexHome: cli.home,
      model: "stub", runsRoot: join(cli.home, "runs"),
    },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "native-resume-boot");
    daemon.store.insertComputer({
      id: "c_old_cap", name: "native", capabilities: ["browser"], persistent: false, status: "running",
    });
    daemon.store.insertHarnessTaskBinding({
      task_id: "old-native-cap", computer_id: "c_old_cap",
      spend_cap_usd: 20, max_steps: 400, proxy_usd_per_tool_call: 0.01,
    });
    daemon.store.db.prepare("UPDATE tasks SET adapter = 'codex', goal = ? WHERE id = ?")
      .run("continue the stored native task", "old-native-cap");
    assert.equal(daemon.store.pauseTask("old-native-cap"), true);
    const before = daemon.store.harnessBindingForTask("old-native-cap");
    assert.equal(before?.spend_cap_usd, 20);
    assert.equal(before?.max_steps, 400);

    const resumed = await fetch(`${daemon.baseUrl}/api/v1/tasks/old-native-cap/resume`, {
      method: "POST", headers, body: JSON.stringify({}),
    });
    assert.equal(resumed.status, 202, await resumed.text());
    const binding = daemon.store.harnessBindingForTask("old-native-cap")!;
    assert.equal(binding.spend_cap_usd, 0);
    assert.equal(binding.max_steps, 0);

    const events: Array<{ type: string }> = [];
    const emit = async (type: string) => { events.push({ type }); };
    for (let i = 1; i <= 401; i += 1) {
      const denied = await enforceHarnessMcpSpendCap({ store: daemon.store, emit }, "c_old_cap");
      assert.equal(denied, null, `call ${i} was refused`);
    }
    assert.equal(events.some((event) => event.type === "policy.denied"), false);
    assert.equal(daemon.store.getHarnessTaskBinding("c_old_cap")?.observed_tool_calls, 401);
    assert.equal(daemon.store.getHarnessTaskBinding("c_old_cap")?.denied, 0);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("a stored native binding with a step ceiling is uncapped when the daemon boots", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-native-boot-"));
  const sqlitePath = join(root, "state.sqlite");
  const seed = new Store(sqlitePath);
  seed.insertComputer({
    id: "c_boot_cap", name: "native", capabilities: ["browser"], persistent: false, status: "running",
  });
  seed.insertHarnessTaskBinding({
    task_id: "boot-native-cap", computer_id: "c_boot_cap",
    spend_cap_usd: 20, max_steps: 400, proxy_usd_per_tool_call: 0.01,
  });
  seed.db.prepare("UPDATE tasks SET adapter = 'codex' WHERE id = ?").run("boot-native-cap");
  seed.close();

  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    port: 0, mcpToken: "native-boot-mcp", bootstrapToken: "native-boot-boot",
    workspaceRoot: join(root, "workspace"),
    sqlitePath,
  });
  try {
    const binding = daemon.store.harnessBindingForTask("boot-native-cap")!;
    assert.equal(binding.spend_cap_usd, 0);
    assert.equal(binding.max_steps, 0);
    const events: Array<{ type: string }> = [];
    const emit = async (type: string) => { events.push({ type }); };
    for (let i = 1; i <= 401; i += 1) {
      const denied = await enforceHarnessMcpSpendCap({ store: daemon.store, emit }, "c_boot_cap");
      assert.equal(denied, null, `call ${i} was refused`);
    }
    assert.equal(events.some((event) => event.type === "policy.denied"), false);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});

test("a native task is created with no spend cap and no call ceiling", async () => {
  const cli = fakeCli("native-no-cap", () => `
if (process.argv[2] === 'login' && process.argv[3] === 'status') process.exit(0);
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-native-no-cap' }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    port: 0, mcpToken: "native-cap-mcp", bootstrapToken: "native-cap-boot",
    workspaceRoot: join(cli.home, "workspace"),
    codexRunner: {
      execution_location: "host", binary: cli.binary, codexHome: cli.home,
      model: "stub", runsRoot: join(cli.home, "runs"),
    },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "native-cap-boot");
    const session = await (await fetch(`${daemon.baseUrl}/api/v1/session`, { headers })).json() as {
      spend_cap_usd: number | null; budget: unknown; budget_kind: string;
    };
    assert.equal(session.spend_cap_usd, null);
    assert.equal(session.budget, null);
    assert.equal(session.budget_kind, "tool_proxy");

    daemon.store.insertComputer({
      id: "c1", name: "c1", capabilities: ["browser"], persistent: false, status: "running",
    });
    const created = await fetch(`${daemon.baseUrl}/api/v1/tasks`, {
      method: "POST", headers,
      body: JSON.stringify({
        computer_id: "c1", goal: "work until the plan says stop",
        spend_cap_usd: 0.05, max_steps: 20,
      }),
    });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string; max_steps: number; spend_cap_usd: number | null } };
    assert.equal(task.max_steps, 0);
    assert.equal(task.spend_cap_usd, 0);

    const detail = await (await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}`, { headers })).json() as {
      task: { spend_cap_usd: number | null; calls_cap: number | null; max_steps: number };
    };
    assert.equal(detail.task.spend_cap_usd, null);
    assert.equal(detail.task.calls_cap, null);
    assert.equal(detail.task.max_steps, 0);
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
});
