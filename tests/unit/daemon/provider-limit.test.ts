/**
 * A provider that refuses for quota is signed in and unusable at once. Two
 * layers here: the classifier and its memory (pure), and a daemon driven by a
 * fake `codex` whose first run returns the real usage-limit text and whose
 * second run completes — the runtime ladder must raise the blocker and then
 * drop it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import {
  classifyProviderLimit,
  createProviderLimits,
  providerLimitFields,
} from "../../../src/daemon/provider-limit.ts";
import { runAgentLoop } from "../../../src/daemon/agent-loop.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { taskActivity } from "../../../src/daemon/task-view.ts";
import { createFakeComputerClient } from "../../../src/computer-client/fake.ts";
import { createA11yDriver } from "../../../src/drivers/a11y.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { until } from "../../helpers/until.ts";

/** Verbatim from `~/.modelbot/daemon.log`, 2026-09-07T14:54:00.801Z. */
const CODEX_QUOTA =
  "Error: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
  "to purchase more credits or try again at Sep 11th, 2026 5:21 PM.";

describe("classifyProviderLimit", () => {
  it("reads the Codex usage-limit refusal and the reset time it names", () => {
    const limit = classifyProviderLimit(CODEX_QUOTA);
    assert.equal(limit?.reason, "quota_exhausted");
    assert.equal(limit?.resets_at, new Date("Sep 11, 2026 5:21 PM").toISOString());
  });

  it("reads the Claude Code refusal, whose reset time is a unix timestamp", () => {
    const limit = classifyProviderLimit("Claude AI usage limit reached|1757251260");
    assert.equal(limit?.reason, "quota_exhausted");
    assert.equal(limit?.resets_at, new Date(1_757_251_260_000).toISOString());
  });

  it("separates throttling from an exhausted plan, and takes no reset from it", () => {
    for (const text of [
      "Anthropic request failed (429): {\"type\":\"rate_limit_error\"}",
      "OpenAI-compatible request failed (429): Too Many Requests",
    ]) {
      const limit = classifyProviderLimit(text);
      assert.equal(limit?.reason, "rate_limited", text);
      assert.equal(limit?.resets_at, null, text);
    }
  });

  it("stays silent on every other failure, so nothing is blamed on the plan", () => {
    for (const text of [
      "Task runner timed out",
      "Codex ended without marking the task done",
      "codex task exited without a completed turn (exit 7)",
      "The browser connection closed before the task could finish.",
      "",
    ]) {
      assert.equal(classifyProviderLimit(text), null, text);
    }
  });
});

describe("remembered refusals", () => {
  it("holds a dated refusal until its reset time, then forgets it", () => {
    let clock = Date.parse("2026-09-07T14:54:00Z");
    const limits = createProviderLimits(() => clock);
    limits.record("codex", classifyProviderLimit(CODEX_QUOTA)!);
    assert.equal(limits.get("codex")?.reason, "quota_exhausted");
    assert.equal(limits.get("claude"), null);

    clock = Date.parse(classifyProviderLimit(CODEX_QUOTA)!.resets_at!);
    assert.equal(limits.get("codex"), null);
  });

  it("holds an undated refusal for a minute, and forgets it as soon as a call succeeds", () => {
    let clock = 1_000_000;
    const limits = createProviderLimits(() => clock);
    limits.record("claude", { reason: "rate_limited", resets_at: null });
    clock += 59_000;
    assert.equal(limits.get("claude")?.reason, "rate_limited");
    clock += 2_000;
    assert.equal(limits.get("claude"), null);

    clock = 1_000_000;
    limits.record("claude", { reason: "rate_limited", resets_at: null });
    limits.clear("claude");
    assert.equal(limits.get("claude"), null);
  });

  it("names the reason on a failure record only when there is one", () => {
    assert.deepEqual(providerLimitFields(null), {});
    assert.deepEqual(providerLimitFields({ reason: "rate_limited", resets_at: null }), {
      provider_limit_reason: "rate_limited",
    });
    assert.deepEqual(
      providerLimitFields({ reason: "quota_exhausted", resets_at: "2026-09-11T17:21:00.000Z" }),
      {
        provider_limit_reason: "quota_exhausted",
        provider_limit_resets_at: "2026-09-11T17:21:00.000Z",
      },
    );
  });
});

test("a throttled adapter names the reason on the task it killed", async () => {
  const computer = createFakeComputerClient("rate-limited");
  const store = new Store();
  const task = store.insertTask({ computer_id: computer.computerId, goal: "synthetic throttle", max_steps: 5 });
  try {
    const result = await runAgentLoop({
      taskId: task.id, computerId: computer.computerId, goal: task.goal, model: "synthetic",
      computer, driver: createA11yDriver(computer), store,
      adapter: { kind: "openai_compat", complete: async () => {
        throw new Error("OpenAI-compatible request failed (429): Too Many Requests");
      } },
      emit: async (event) => { store.appendAuditRef({ type: event.type, body: event.body, task_id: task.id, hash: "synthetic-unit-test" }); },
    });
    assert.equal(result.status, "failed");
    const failure = taskActivity(store, task.id).steps.find((step) => step.kind === "task.failed");
    assert.equal(failure?.body.provider_limit_reason, "rate_limited");
    assert.equal(failure?.body.provider_limit_resets_at, undefined);
  } finally { await computer.close(); store.close(); }
});

/** `codex`: signed in, refuses the first task for quota, completes the next. */
function fakeCodex(): { home: string; binary: string } {
  const home = mkdtempSync(join(tmpdir(), "mb-provider-limit-"));
  const impl = join(home, "codex-impl.mjs");
  writeFileSync(
    impl,
    `import { existsSync, writeFileSync } from 'node:fs';
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
const argv = process.argv.slice(2);
if (argv[0] === 'login' && argv[1] === 'status') process.exit(0);
const emit = (value) => console.log(JSON.stringify(value));
const refused = ${JSON.stringify(join(home, "refused"))};
if (!existsSync(refused)) {
  writeFileSync(refused, '1');
  emit({ type: 'turn.failed', error: { message: ${JSON.stringify(CODEX_QUOTA.replace(/^Error: /, ""))} } });
  process.exit(1);
}
const url = JSON.parse(argv.find((a) => a.startsWith('mcp_servers.modelbot.url=')).split('=').slice(1).join('='));
emit({ type: 'thread.started', thread_id: '00000000-0000-0000-0000-000000000002' });
const client = new Client({ name: 'provider-limit-fixture', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: 'Bearer ' + process.env.MODELBOT_SCOPED_TOKEN } },
}));
await client.callTool({ name: 'done', arguments: { summary: 'Synthetic task completed', status: 'success' } });
await client.close().catch(() => {});
emit({ type: 'turn.completed' });
`,
    { mode: 0o600 },
  );
  const binary = join(home, "codex");
  // Extensionless, so it must be a shell stub: node would read it as CommonJS.
  writeFileSync(binary, `#!/bin/sh\nexec ${process.execPath} ${impl} "$@"\n`, { mode: 0o700 });
  return { home, binary };
}

test("a quota refusal blocks the home screen until the provider answers again", async () => {
  const { home, binary } = fakeCodex();
  const previous = {
    fake: process.env.MODELBOT_TEST_FAKE_COMPUTER,
    toolPath: process.env.MODELBOT_TOOL_PATH,
  };
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  // The readiness probe resolves `codex` by name; point it at the fake.
  process.env.MODELBOT_TOOL_PATH = home;
  const daemon = await startDaemon({
    port: 0,
    mcpToken: "daemon-mcp",
    bootstrapToken: "bootstrap",
    workspaceRoot: join(home, "workspace"),
    dataDir: join(home, "data"),
    codexRunner: { execution_location: "host", binary, codexHome: home, model: "gpt-5.6-sol", runsRoot: join(home, "runs") },
  });
  const { headers } = await bootstrapSession(daemon, "bootstrap");
  const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, {
    headers,
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  const runtime = async () => await api("/api/v1/runtime").then((r) => r.json()) as {
    ai: { logged_in: boolean; limit: { reason: string; resets_at: string } | null };
    blockers: Array<{ id: string; title: string; detail: string }>;
  };
  daemon.store.insertComputer({ id: "selected", name: "selected", capabilities: ["browser"], persistent: false, status: "running" });
  const start = async () => {
    const res = await api("/api/v1/tasks", { computer_id: "selected", goal: "Synthetic task", capabilities: ["browser"], max_steps: 20 });
    assert.equal(res.status, 201);
    return (await res.json() as { task: { id: string } }).task.id;
  };

  try {
    const first = await start();
    await until(() => daemon.store.getTask(first)?.status === "failed", "first task never failed");

    const blocked = await runtime();
    assert.equal(blocked.ai.logged_in, true, "the CLI is still signed in");
    assert.equal(blocked.ai.limit?.reason, "quota_exhausted");
    assert.equal(blocked.ai.limit?.resets_at, new Date("Sep 11, 2026 5:21 PM").toISOString());
    const blocker = blocked.blockers.find((b) => b.id === "ai_limit_reached");
    assert.ok(blocker, "the ladder carries the limit");
    assert.match(blocker.detail, /^Codex plan limit reached until .+\. Switch to Claude Code in Settings or wait\.$/);

    const connection = await api("/api/v1/connection").then((r) => r.json()) as
      { status: string; limit?: { reason: string } };
    assert.equal(connection.status, "connected");
    assert.equal(connection.limit?.reason, "quota_exhausted");

    const detail = await api(`/api/v1/tasks/${first}`).then((r) => r.json()) as
      { steps: Array<{ kind: string; body: Record<string, string> }> };
    const failure = detail.steps.find((step) => step.kind === "task.failed");
    assert.equal(failure?.body.provider_limit_reason, "quota_exhausted");
    assert.equal(failure?.body.provider_limit_resets_at, new Date("Sep 11, 2026 5:21 PM").toISOString());

    const second = await start();
    await until(() => daemon.store.getTask(second)?.status === "completed", "second task never completed");
    // The refusal is dropped when the run returns, a moment after `done` lands.
    await until(async () => (await runtime()).ai.limit === null, "a successful task left the limit standing");
    const cleared = await runtime();
    assert.equal(cleared.blockers.some((b) => b.id === "ai_limit_reached"), false);
  } finally {
    await daemon.close();
    process.env.MODELBOT_TEST_FAKE_COMPUTER = previous.fake ?? "";
    if (previous.toolPath === undefined) delete process.env.MODELBOT_TOOL_PATH;
    else process.env.MODELBOT_TOOL_PATH = previous.toolPath;
  }
});
