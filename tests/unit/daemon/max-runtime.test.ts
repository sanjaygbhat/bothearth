import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

/**
 * A run used to die on a 30-minute clock nobody had set, with budget and steps
 * unspent, as `failed` / `runner_error` / `failure_kind: machine`. The only
 * wall clock left is `agent.max_runtime_sec`, it defaults to off, and when it
 * is set it pauses the run and keeps the receipt.
 */

/** A model CLI that does real work and then never finishes on its own. */
function fixture() {
  return fakeCli("mb-max-runtime", () => `import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
if(process.argv[2]==='login'&&process.argv[3]==='status') process.exit(0);
const argv=process.argv.slice(2);
const url=JSON.parse(argv.find(a=>a.startsWith('mcp_servers.modelbot.url=')).split('=').slice(1).join('='));
let input=''; for await (const chunk of process.stdin) input+=chunk;
const client=new Client({name:'max-runtime-fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url),
  {requestInit:{headers:{authorization:'Bearer '+process.env.MODELBOT_SCOPED_TOKEN}}}));
for(let i=0;i<3;i+=1) await client.callTool({name:'browser_navigate',arguments:{url:'https://example.com/'}});
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);
`, "codex-max-runtime.mjs");
}

async function withDaemon(maxRuntimeSec: number, fn: (ctx: {
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  api(path: string, body?: unknown): Promise<Response>;
}) => Promise<void>): Promise<void> {
  const { home, binary } = fixture();
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    port: 0, mcpToken: "runtime-mcp", bootstrapToken: "runtime-boot",
    workspaceRoot: join(home, "workspace"), maxRuntimeSec,
    codexRunner: { binary, codexHome: home, model: "stub", runsRoot: join(home, "runs") },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "runtime-boot");
    daemon.store.insertComputer({ id: "c1", name: "c1", capabilities: ["browser"], persistent: false, status: "running" });
    await fn({
      daemon,
      api: (path, body) => fetch(`${daemon.baseUrl}${path}`, { headers,
        ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}) }),
    });
  } finally {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
  }
}

function events(daemon: Awaited<ReturnType<typeof startDaemon>>, id: string) {
  return (daemon.store.db.prepare("SELECT type, body_json FROM audit_refs WHERE task_id = ? ORDER BY seq")
    .all(id) as Array<{ type: string; body_json: string }>)
    .map((row) => ({ type: row.type, body: JSON.parse(row.body_json) as Record<string, unknown> }));
}

test("a runtime ceiling pauses the run, keeps its receipt, and resumes when raised", async () => {
  await withDaemon(1, async ({ daemon, api }) => {
    const created = await api("/api/v1/tasks", { computer_id: "c1", goal: "work past the runtime ceiling" });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };

    await until(() => daemon.store.getTask(task.id)?.status === "paused",
      "the runtime ceiling did not pause the task", 20_000);

    const log = events(daemon, task.id);
    const paused = log.find((e) => e.type === "task.step" && e.body.status === "paused");
    assert.ok(paused, "no paused event was recorded");
    assert.equal(paused.body.reason, "max_runtime");
    assert.equal(paused.body.failure_kind, "max_runtime");
    // The old wall clock failed the task and blamed the machine for a clock.
    assert.equal(log.some((e) => e.type === "task.failed"), false, "a runtime stop is not a failure");
    assert.equal(JSON.stringify(log).includes("Task runner timed out"), false);
    assert.equal(log.some((e) => e.body.failure_kind === "machine"), false);

    // Work done before the stop is on the receipt, exactly as it is for a run
    // that finished: a paused task used to carry no summary at all.
    const detail = (await (await api(`/api/v1/tasks/${task.id}`)).json()) as {
      task: { summary: { steps: number; sites: string[]; files_saved: string[]; cost_usd: number | null } | null };
    };
    assert.ok(detail.task.summary, "a paused run left no receipt");
    assert.ok(detail.task.summary.steps > 0, `steps: ${detail.task.summary.steps}`);
    assert.deepEqual(detail.task.summary.sites, ["example.com"]);
    assert.deepEqual(detail.task.summary.files_saved, []);
    assert.ok((detail.task.summary.cost_usd ?? 0) > 0, `cost: ${detail.task.summary.cost_usd}`);

    const resumed = await api(`/api/v1/tasks/${task.id}/resume`, { max_runtime_sec: 600 });
    assert.equal(resumed.status, 202);
    assert.equal(daemon.store.getTask(task.id)?.max_runtime_sec, 600);
    await until(() => daemon.store.getTask(task.id)?.status === "running", "a raised ceiling did not resume the run");
    await api(`/api/v1/tasks/${task.id}/cancel`, {});
  });
});

test("no ceiling is the default: a long run is left alone", async () => {
  await withDaemon(0, async ({ daemon, api }) => {
    const created = await api("/api/v1/tasks", { computer_id: "c1", goal: "run without a clock" });
    const { task } = (await created.json()) as { task: { id: string } };
    await until(() => (daemon.store.getHarnessTaskBinding("c1")?.observed_tool_calls ?? 0) >= 3, "no work happened");
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(daemon.store.getTask(task.id)?.status, "running");
    await api(`/api/v1/tasks/${task.id}/cancel`, {});
  });
});

test("a resume rejects a runtime ceiling that is not a whole number of seconds", async () => {
  await withDaemon(0, async ({ daemon, api }) => {
    const created = await api("/api/v1/tasks", { computer_id: "c1", goal: "reject a bad ceiling" });
    const { task } = (await created.json()) as { task: { id: string } };
    const res = await api(`/api/v1/tasks/${task.id}/resume`, { max_runtime_sec: -1 });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "E_LIMIT");
    assert.equal(daemon.store.getTask(task.id)?.max_runtime_sec, null);
    await api(`/api/v1/tasks/${task.id}/cancel`, {});
  });
});
