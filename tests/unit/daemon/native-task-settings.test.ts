import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { until } from "../../helpers/until.ts";

test("native task choices reach the selected CLI and survive changed defaults and reopening", async () => {
  const cli = fakeCli("native-task-settings", root => `
import {writeFileSync} from 'node:fs';
if(process.argv[2]==='login'||process.argv[2]==='auth') process.exit(0);
const args=process.argv.slice(2),claude=args.includes('--print');
writeFileSync(${JSON.stringify(join(root, "selection.json"))},JSON.stringify({claude,model:args[args.indexOf(claude?'--model':'-m')+1]}));
for await(const chunk of process.stdin) {}
for(const event of claude ? [{type:'system',subtype:'init',session_id:'selected-thread'},
{type:'assistant',message:{content:[{type:'text',text:'What date range should I use?'}]}},
{type:'result',subtype:'success'}] : [{type:'thread.started',thread_id:'selected-thread'},
{type:'item.completed',item:{type:'agent_message',text:'What date range should I use?'}},
{type:'turn.completed'}]) console.log(JSON.stringify(event));
`);
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const sqlitePath = join(cli.home, "state.sqlite");
  const daemon = await startDaemon({ port: 0, sqlitePath, workspaceRoot: join(cli.home, "workspace"), bootstrapToken: "settings-test",
    codexRunner: { execution_location: "host", codexHome: cli.home, binary: cli.binary, model: "gpt-6-astra", runsRoot: join(cli.home, "runs") },
    claudeLogin: { codexHome: cli.home, binary: cli.binary } });
  let taskId = "";
  try {
    const { headers } = await bootstrapSession(daemon, "settings-test");
    const post = (path: string, body: unknown) => fetch(daemon.baseUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
    daemon.store.insertComputer({ id: "selected", name: "Selected", capabilities: ["browser"], persistent: true, status: "running" });
    const chosen = { adapter: "claude", model: "claude-opus-5", execution_mode: "executor" };
    const response = await post("/api/v1/tasks", { computer_id: "selected", goal: "Review the website", ...chosen });
    assert.equal(response.status, 201);
    const { task } = await response.json() as any;
    taskId = task.id;
    await until(() => daemon.store.db.prepare("SELECT id FROM steps WHERE task_id=? AND kind='assistant'").get(taskId) !== undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(cli.home, "selection.json"), "utf8")), { claude: true, model: chosen.model });
    assert.equal(daemon.store.getTask(taskId)?.status, "running", "a model question is an open conversation");
    assert.equal((await post("/api/v1/connection/connect", { provider: "codex", model: "gpt-6-astra-custom" })).status, 200);
    const detail = await fetch(daemon.baseUrl + "/api/v1/tasks/" + taskId, { headers }).then(r => r.json()) as any;
    for (const [key, value] of Object.entries(chosen)) assert.equal(detail.task[key], value);
    const rejected = await post("/api/v1/tasks", { computer_id: "selected", goal: "Invalid options", adapter: "constructor", model: "x" });
    assert.equal(rejected.status, 400);
    assert.equal(daemon.store.listTasks().length, 1);
  } finally {
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
  const reopened = new Store(sqlitePath);
  try {
    assert.equal(reopened.getTask(taskId)?.model, "claude-opus-5");
    assert.equal(reopened.listTasks()[0]?.execution_mode, "executor");
  } finally { reopened.close(); }
});

test("browsing native model choices keeps a configured standalone runner available", async () => {
  const cli = fakeCli("model-choice-standalone", () => "process.exit(1);");
  const daemon = await startDaemon({ host: "127.0.0.1", port: 0, mcpToken: "test-mcp", bootstrapToken: "test-boot",
    workspaceRoot: join(cli.home, "workspace"), nativeExecutionLocation: "computer",
    agentLoop: { model: "configured-local-model", credentialed: true,
      adapter: { kind: "openai_compat", complete: async () => { throw new Error("No task should run in this test"); } } } });
  try {
    const { headers } = await bootstrapSession(daemon, "test-boot");
    const read = async (path: string) => {
      const response = await fetch(daemon.baseUrl + path, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await read("/api/v1/session")).task_start_available, true);
    const catalog = await read("/api/v1/models");
    assert.ok(catalog.providers.length > 0);
    for (const provider of catalog.providers) {
      assert.equal(provider.connection_status, "signed_out");
      assert.equal(provider.connected, false);
      assert.equal(provider.limit, null);
      assert.ok(provider.models.length > 0, "listed model choices stay separate from authentication");
    }
    const session = await read("/api/v1/session");
    assert.equal(session.execution_mode, "standalone");
    assert.equal(session.task_start_available, true);
  } finally { await daemon.close(); }
});
