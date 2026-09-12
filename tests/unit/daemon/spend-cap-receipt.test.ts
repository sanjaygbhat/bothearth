import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli, isolateModelbotHome } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

isolateModelbotHome();

/**
 * Native tasks still report the proxy estimate on every counted call. That
 * figure is not a cap: the task is not stopped by it, and the receipt names it
 * as spend without a ceiling.
 */

const PER_CALL_USD = 0.01;
const CALLS = 7;

/** A model CLI that reads the page until the budget refuses it, then gives up. */
function fixture() {
  return fakeCli("mb-spend-cap", () => `import assert from 'node:assert/strict';
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
if(process.argv[2]==='login'&&process.argv[3]==='status') process.exit(0);
const argv=process.argv.slice(2);
const url=JSON.parse(argv.find(a=>a.startsWith('mcp_servers.modelbot.url=')).split('=').slice(1).join('='));
let input=''; for await (const chunk of process.stdin) input+=chunk;
const client=new Client({name:'spend-cap-fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url),
  {requestInit:{headers:{authorization:'Bearer '+process.env.MODELBOT_SCOPED_TOKEN}}}));
console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-0000-0000-0000000000bb'}));
for(let i=0;i<6;i+=1){
  const result=await client.callTool({name:'browser_snapshot',arguments:{}});
  if(result.isError) break;
}
await client.callTool({name:'done',arguments:{summary:'read the page',status:'success'}});
await client.close().catch(()=>{});
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, "codex-spend-cap.mjs");
}

async function withDaemon(fn: (ctx: {
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  api(path: string, body?: unknown): Promise<Response>;
}) => Promise<void>): Promise<void> {
  const { home, binary } = fixture();
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    port: 0, mcpToken: "spend-mcp", bootstrapToken: "spend-boot",
    workspaceRoot: join(home, "workspace"),
    codexRunner: { execution_location: "host", binary, codexHome: home, model: "stub", runsRoot: join(home, "runs") },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "spend-boot");
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

test("the task detail counts the proxy estimate without a ceiling", async () => {
  await withDaemon(async ({ daemon, api }) => {
    const created = await api("/api/v1/tasks",
      { computer_id: "c1", goal: "read the page", spend_cap_usd: 0.05 });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };

    await until(() => daemon.store.getTask(task.id)?.status === "completed",
      "the native task never finished", 20_000);

    const detail = (await (await api(`/api/v1/tasks/${task.id}`)).json()) as {
      task: { spend_usd: number; spend_cap_usd: number | null; calls: number; calls_cap: number | null };
      steps: Array<{ kind: string; body: Record<string, unknown> }>;
    };
    assert.equal(detail.task.spend_cap_usd, null);
    assert.equal(detail.task.calls_cap, null);
    assert.equal(detail.task.calls, CALLS);
    assert.equal(detail.task.spend_usd, Number((CALLS * PER_CALL_USD).toFixed(12)));

    const spends = detail.steps.filter((s) => s.kind === "usage").map((s) => s.body.usd_est);
    assert.deepEqual(spends, [0, ...Array.from({ length: CALLS }, (_, i) => Number(((i + 1) * PER_CALL_USD).toFixed(12)))]);
    assert.equal(detail.steps.some((s) => s.body.reason === "spend_cap"), false);
    assert.equal(daemon.store.getTask(task.id)!.summary?.cost_usd, Number((CALLS * PER_CALL_USD).toFixed(12)));
  });
});
