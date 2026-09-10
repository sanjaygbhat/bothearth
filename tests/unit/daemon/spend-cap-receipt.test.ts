import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

/**
 * The budget the harness enforces is the budget the task detail reports, and a
 * task that dies on it says so. Both attempts at the Gmail task read
 * "$0.00 of your $2.00 budget" while the proxy estimate silently reached $2.00
 * and killed them, and the receipt blamed the machine.
 */

const CAP_USD = 0.05;
const PER_CALL_USD = 0.01;
const CALLS = CAP_USD / PER_CALL_USD;

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
for(let i=0;i<20;i+=1){
  const result=await client.callTool({name:'browser_snapshot',arguments:{}});
  if(result.isError) break;
}
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

test("the task detail counts the calls the cap counted, and the failure names the cap", async () => {
  await withDaemon(async ({ daemon, api }) => {
    const created = await api("/api/v1/tasks",
      { computer_id: "c1", goal: "read the page until the budget stops it", spend_cap_usd: CAP_USD });
    assert.equal(created.status, 201);
    const { task } = (await created.json()) as { task: { id: string } };

    await until(() => daemon.store.getTask(task.id)?.status === "paused",
      "the task never stopped on its cap", 20_000);

    const detail = (await (await api(`/api/v1/tasks/${task.id}`)).json()) as {
      task: { spend_usd: number; spend_cap_usd: number; calls: number; calls_cap: number };
      steps: Array<{ kind: string; body: Record<string, unknown> }>;
    };
    assert.deepEqual(detail.task, {
      ...detail.task,
      spend_usd: CAP_USD,
      spend_cap_usd: CAP_USD,
      calls: CALLS,
      calls_cap: CALLS,
    });

    // The live meter read the same counter all the way up, not only at the end.
    const spends = detail.steps.filter((s) => s.kind === "usage").map((s) => s.body.usd_est);
    assert.deepEqual(spends, [0, ...Array.from({ length: CALLS }, (_, i) => Number(((i + 1) * PER_CALL_USD).toFixed(12)))]);

    // The cap stopped it; it did not go wrong. A bigger budget resumes it, so
    // the stop is a pause carrying the same reason the standalone loop gives.
    const stopped = detail.steps.find((s) => s.kind === "task.step" && s.body.status === "paused");
    assert.ok(stopped, "no paused step");
    assert.equal(stopped!.body.failure_kind, "spend_cap");
    assert.equal(stopped!.body.reason, "spend_cap");

    // And once the person stops it for good, the receipt says what it cost
    // instead of $0.00.
    assert.equal((await api(`/api/v1/tasks/${task.id}/cancel`, {})).status, 200);
    assert.equal(daemon.store.getTask(task.id)!.summary?.cost_usd, CAP_USD);
  });
});
