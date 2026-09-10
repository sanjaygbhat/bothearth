import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

/**
 * A budget is a pause, not a death — on the CLI-runner path too. A task killed
 * by its spend cap or its step cap used to end `failed` there, while
 * `POST /tasks/:id/resume` accepts only a paused task, so "Resume with a higher
 * budget" answered 409 on exactly the task that needed it.
 */

const PER_CALL_USD = 0.01;

/** A model CLI that reads the page until a budget refuses it, then tries to finish. */
function fixture() {
  return fakeCli("mb-cap-resume", () => `import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
if(process.argv[2]==='login'&&process.argv[3]==='status') process.exit(0);
const argv=process.argv.slice(2);
const url=JSON.parse(argv.find(a=>a.startsWith('mcp_servers.modelbot.url=')).split('=').slice(1).join('='));
let input=''; for await (const chunk of process.stdin) input+=chunk;
const client=new Client({name:'cap-resume-fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url),
  {requestInit:{headers:{authorization:'Bearer '+process.env.MODELBOT_SCOPED_TOKEN}}}));
for(let i=0;i<6;i+=1){
  const result=await client.callTool({name:'browser_snapshot',arguments:{}});
  if(result.isError) break;
}
await client.callTool({name:'done',arguments:{summary:'read the page',status:'success'}});
await client.close().catch(()=>{});
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, "codex-cap-resume.mjs");
}

interface Ctx {
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  api(path: string, body?: unknown): Promise<Response>;
}

async function withDaemon(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const { home, binary } = fixture();
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    port: 0, mcpToken: "cap-mcp", bootstrapToken: "cap-boot",
    workspaceRoot: join(home, "workspace"),
    codexRunner: { execution_location: "host", binary, codexHome: home, model: "stub", runsRoot: join(home, "runs") },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "cap-boot");
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

/** The paused event the runner wrote, whole: the API projection drops `detail`. */
async function pausedStep(ctx: Ctx, taskId: string): Promise<Record<string, unknown>> {
  const activity = (await (await ctx.api(`/api/v1/tasks/${taskId}`)).json()) as {
    steps: Array<{ kind: string }>;
  };
  assert.equal(activity.steps.some((step) => step.kind === "task.failed"), false,
    "a budget stop was recorded as a failure");
  const paused = (ctx.daemon.store.db
    .prepare("SELECT body_json FROM audit_refs WHERE task_id = ? AND type = 'task.step'")
    .all(taskId) as Array<{ body_json: string }>)
    .map((row) => JSON.parse(row.body_json) as Record<string, unknown>)
    .filter((body) => body.status === "paused");
  assert.equal(paused.length, 1, `expected one paused step, got ${paused.length}`);
  return paused[0]!;
}

test("a spend cap on the CLI-runner path pauses, and a bigger budget resumes it", async () => {
  await withDaemon(async (ctx) => {
    const created = await ctx.api("/api/v1/tasks",
      { computer_id: "c1", goal: "read the page until the budget stops it", spend_cap_usd: 5 * PER_CALL_USD });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };

    await until(() => ctx.daemon.store.getTask(task.id)?.status === "paused",
      "the capped task did not pause", 20_000);
    assert.deepEqual(await pausedStep(ctx, task.id), {
      status: "paused",
      reason: "spend_cap",
      // Word for word what the standalone loop says when it stops on the same cap.
      detail: "estimated spend reached $0.05",
      failure_kind: "spend_cap",
      steps: 5,
    });

    // Resume with nothing more to spend is refused, not started.
    const refused = await ctx.api(`/api/v1/tasks/${task.id}/resume`, {});
    assert.equal(refused.status, 409);
    const refusal = (await refused.json()) as { error: string; spend_usd: number };
    assert.equal(refusal.error, "E_SPEND_CAP");
    assert.equal(refusal.spend_usd, 0.05);
    assert.equal(ctx.daemon.store.getTask(task.id)?.status, "paused", "a refused resume restarted the task");

    // A raised budget un-refuses the calls the old one refused: the same task
    // carries on and finishes.
    const resumed = await ctx.api(`/api/v1/tasks/${task.id}/resume`, { spend_cap_usd: 30 });
    assert.equal(resumed.status, 202);
    await until(() => ctx.daemon.store.getTask(task.id)?.status === "completed",
      "the resumed task never finished", 20_000);

    const detail = (await (await ctx.api(`/api/v1/tasks/${task.id}`)).json()) as {
      task: { spend_usd: number; spend_cap_usd: number; calls: number };
    };
    assert.equal(detail.task.spend_cap_usd, 30);
    // Twelve calls in total: the budget is one running total, not an allowance
    // the second run buys again.
    assert.equal(detail.task.calls, 12);
    assert.equal(detail.task.spend_usd, 0.12);
  });
});

test("a step cap on the CLI-runner path pauses, and more steps resume it", async () => {
  await withDaemon(async (ctx) => {
    const created = await ctx.api("/api/v1/tasks",
      { computer_id: "c1", goal: "read the page until the steps run out", spend_cap_usd: 5, max_steps: 3 });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };

    await until(() => ctx.daemon.store.getTask(task.id)?.status === "paused",
      "the step-capped task did not pause", 20_000);
    assert.deepEqual(await pausedStep(ctx, task.id), {
      status: "paused",
      reason: "max_steps",
      detail: "maximum 3 steps reached",
      failure_kind: "max_steps",
      steps: 3,
    });
    // The step budget is the ceiling the meter shows, since the cap it would
    // otherwise report buys far more calls than the task may make.
    const capped = (await (await ctx.api(`/api/v1/tasks/${task.id}`)).json()) as { task: { calls_cap: number } };
    assert.equal(capped.task.calls_cap, 3);

    const refused = await ctx.api(`/api/v1/tasks/${task.id}/resume`, {});
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: "E_LIMIT",
      message: "It used every one of the 3 steps set for this task. Give it more steps to carry on.",
      max_steps: 3,
      steps: 3,
    });
    assert.equal(ctx.daemon.store.getTask(task.id)?.status, "paused", "a refused resume restarted the task");

    const resumed = await ctx.api(`/api/v1/tasks/${task.id}/resume`, { max_steps: 30 });
    assert.equal(resumed.status, 202);
    await until(() => ctx.daemon.store.getTask(task.id)?.status === "completed",
      "the resumed task never finished", 20_000);
    assert.equal(ctx.daemon.store.getTask(task.id)?.max_steps, 30);
  });
});
