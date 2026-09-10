import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

const THREAD = "00000000-0000-0000-0000-000000000091";

async function fixture(t: TestContext) {
  const cli = fakeCli("mb-resume-takeover", home => `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
if(process.argv[2]==='login'&&process.argv[3]==='status') process.exit(0);
const argv=process.argv.slice(2);
assert.ok(argv.includes('resume')); assert.ok(argv.includes(${JSON.stringify(THREAD)}));
appendFileSync(${JSON.stringify(join(home, "resumes.jsonl"))}, JSON.stringify({thread:${JSON.stringify(THREAD)}})+'\\n');
for await (const chunk of process.stdin) {}
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(THREAD)}}));
const url=JSON.parse(argv.find(a=>a.startsWith('mcp_servers.modelbot.url=')).split('=').slice(1).join('='));
const client=new Client({name:'resume-takeover-fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url),
  {requestInit:{headers:{authorization:'Bearer '+process.env.MODELBOT_SCOPED_TOKEN}}}));
const status=await client.callTool({name:'takeover_status',arguments:{takeover_id:readFileSync(${JSON.stringify(join(home, "lease"))},'utf8')}});
assert.equal(status.isError, false, JSON.stringify(status));
assert.equal(JSON.parse(status.content[0].text).data.state,'agent');
assert.equal((await client.callTool({name:'browser_snapshot',arguments:{}})).isError,false);
assert.equal((await client.callTool({name:'done',arguments:{summary:'Continued the saved conversation',status:'success'}})).isError,false);
await client.close();
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  let computer: FakeComputer | undefined;
  const screen = { sensitive: false, available: true, checks: 0 };
  const originalCall = FakeComputer.prototype.call;
  t.mock.method(FakeComputer.prototype, "call", async function (this: FakeComputer, method: string, params?: unknown) {
    computer = this;
    if (method === "takeover.masked-observation") {
      screen.checks++;
      return screen.available ? { ok: true, data: { still_sensitive: screen.sensitive } }
        : { ok: false, error: { code: "E_IO", message: "Synthetic observation failure" } };
    }
    return originalCall.call(this, method, params);
  });
  const daemon = await startDaemon({ port: 0, mcpToken: "resume-control-mcp", bootstrapToken: "resume-control-boot",
    workspaceRoot: cli.path("workspace"),
    codexRunner: { binary: cli.binary, codexHome: cli.home, model: "test", runsRoot: cli.path("runs"), execution_location: "host" } });
  const { headers } = await bootstrapSession(daemon, "resume-control-boot");
  const post = (path: string, body: unknown = {}) => fetch(`${daemon.baseUrl}${path}`,
    { method: "POST", headers, body: JSON.stringify(body) });
  daemon.store.insertComputer({ id: "resume-control", name: "Synthetic", capabilities: ["browser"], persistent: false, status: "running" });
  daemon.store.insertHarnessTaskBinding({ task_id: "resume-native", computer_id: "resume-control", spend_cap_usd: 2, max_steps: 20, proxy_usd_per_tool_call: 0 });
  daemon.store.db.prepare("UPDATE tasks SET goal = ?, adapter = 'codex', capabilities = ? WHERE id = 'resume-native'")
    .run("Continue a public website audit", JSON.stringify(["browser"]));
  const task = daemon.store.getTask("resume-native")!;
  daemon.store.insertStep(task.id, 0, "runner_session", { provider: "codex", thread_id: THREAD });
  daemon.store.insertStep(task.id, 0, "assistant", { role: "assistant", content: "Earlier audit findings are saved." });
  daemon.store.pauseTask(task.id);
  t.after(async () => {
    if (daemon.store.getTask(task.id)?.status === "failed" && existsSync(cli.path("runs"))) {
      for (const run of readdirSync(cli.path("runs"))) t.diagnostic(readFileSync(join(cli.path("runs"), run, "runner.log"), "utf8"));
    }
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
    rmSync(cli.home, { recursive: true, force: true });
  });
  return {
    daemon, task, screen, post,
    resume: () => post(`/api/v1/tasks/${task.id}/resume`),
    launches: () => existsSync(cli.path("resumes.jsonl")) ? readFileSync(cli.path("resumes.jsonl"), "utf8").trim().split("\n") : [],
    async hold(owner: string | null = task.id, granted = false, paused = true) {
      const requested = await post("/api/v1/takeover/request", { computer_id: task.computer_id, ...(owner ? { task_id: owner } : {}) });
      assert.equal(requested.status, 200);
      const id = ((await requested.json()) as { takeover: { takeover_id: string } }).takeover.takeover_id;
      writeFileSync(cli.path("lease"), id);
      if (granted) assert.equal((await post(`/api/v1/takeover/${id}/grant`)).status, 200);
      if (paused) {
        assert.equal((await computer!.expireTakeover(id)).ok, true);
        daemon.store.updateTakeoverState(id, "paused");
      }
      return id;
    },
  };
}

for (const granted of [false, true]) test(`Resume clears a paused ${granted ? "previously human" : "unanswered"} hold and continues the saved native thread`, async t => {
  const f = await fixture(t);
  const lease = await f.hold(f.task.id, granted);
  const responses = await Promise.all([f.resume(), f.resume()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  await until(() => f.daemon.store.getTask(f.task.id)?.status === "completed", "Resume left a second hidden control wait", 10_000);
  assert.equal(f.daemon.store.getTakeover(lease)?.state, "agent");
  assert.equal(f.daemon.store.getTakeover(lease)?.declined, 0, "Resume must not override the sensitive-field guard");
  assert.equal(f.launches().length, 1, "two clicks must not start two native sessions");
  assert.ok(f.screen.checks > 0);
  assert.ok(f.daemon.store.taskTranscript(f.task.id).some(message => message.content === "Earlier audit findings are saved."));
  const events = f.daemon.store.db.prepare("SELECT type FROM audit_refs WHERE task_id = ? ORDER BY seq").all(f.task.id) as { type: string }[];
  assert.ok(events.findIndex(event => event.type === "takeover.released") < events.findIndex(event => event.type === "task.resumed"));
});

test("Resume retains expired human control until its private input check succeeds", async t => {
  const f = await fixture(t), lease = await f.hold(f.task.id, true);
  for (const [sensitive, available] of [[true, true], [false, false]]) {
    Object.assign(f.screen, { sensitive, available });
    assert.equal((await f.resume()).status, 409);
    assert.equal(f.daemon.store.getTask(f.task.id)?.status, "paused");
    assert.equal(f.daemon.store.getTakeover(lease)?.state, "paused");
    assert.equal(f.launches().length, 0);
  }
  Object.assign(f.screen, { sensitive: false, available: true });
  assert.equal((await f.resume()).status, 202);
  await until(() => f.daemon.store.getTask(f.task.id)?.status === "completed", "safe return did not continue", 10_000);
});

test("Resume preserves active human and validating holds", async t => {
  const f = await fixture(t), lease = await f.hold(f.task.id, true, false);
  for (const state of ["human", "resume_validating", "takeover_requested"] as const) {
    f.daemon.store.updateTakeoverState(lease, state);
    assert.equal((await f.resume()).status, 409);
    assert.equal(f.daemon.store.getTask(f.task.id)?.status, "paused");
    assert.equal(f.daemon.store.getTakeover(lease)?.state, state);
  }
  assert.equal(f.screen.checks, 0);
  assert.equal(f.launches().length, 0);
});

for (const owner of ["other task", "operator"]) test(`Resume preserves a paused hold owned by ${owner}`, async t => {
  const f = await fixture(t);
  const other = f.daemon.store.insertTask({ computer_id: f.task.computer_id, goal: "Another task", max_steps: 20 });
  const lease = await f.hold(owner === "operator" ? null : other.id);
  assert.equal((await f.resume()).status, 409);
  assert.equal(f.daemon.store.getTask(f.task.id)?.status, "paused");
  assert.equal(f.daemon.store.getTakeover(lease)?.state, "paused");
  assert.equal(f.screen.checks, 0);
  assert.equal(f.launches().length, 0);
});
