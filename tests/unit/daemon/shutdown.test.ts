/**
 * A graceful close takes seconds — closing browsers, draining runs, flushing the
 * audit tail. The listening socket has to go first: while it is up, a restart
 * reads the daemon as serving, refuses to start, and leaves nothing listening
 * once the shutdown finishes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { createFakeSandbox } from "../../../src/computer-client/fake-sandbox.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli, isolateModelbotHome } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

isolateModelbotHome();

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

test("close() stops listening before it drains, not after", async () => {
  const daemon = await startDaemon({
    port: 0,
    host: "127.0.0.1",
    mcpToken: "shutdown-mcp",
    bootstrapToken: "shutdown-boot",
    workspaceRoot: mkdtempSync(join(tmpdir(), "mb-shutdown-")),
  });
  assert.equal(await accepts(daemon.port), true);

  // Synchronous: `close()` runs to its first await before yielding, so this is
  // the state every probe during the drain would see.
  const closing = daemon.close();
  assert.equal(daemon.server.listening, false, "still listening after close() was called");

  await closing;
  assert.equal(await accepts(daemon.port), false);
});

test("boot image updates preserve paused task and private-control computers", async () => {
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
  const workspaceRoot = mkdtempSync(join(tmpdir(), "mb-preserve-browser-"));
  const sqlitePath = join(workspaceRoot, "state.sqlite");
  const seed = new Store(sqlitePath);
  for (const id of ["paused-task", "private-control", "idle"]) seed.insertComputer({
    id, name: id, capabilities: ["browser"], persistent: true, status: "running",
  });
  const task = seed.insertTask({ computer_id: "paused-task", goal: "Saved work", adapter: "codex", max_steps: 20 });
  seed.pauseTask(task.id);
  seed.insertTakeover({ id: "private-handoff", computer_id: "private-control", task_id: null,
    state: "paused", expires_at: null, epoch: 2 });
  seed.close();
  const refreshed: string[] = [];
  const daemon = await startDaemon({ port: 0, sqlitePath, workspaceRoot, bootstrapToken: "refresh-test", mcpToken: "refresh-mcp",
    sandbox: { ...createFakeSandbox(), async refreshImage(id) { refreshed.push(id); return false; } } });
  try {
    await until(() => refreshed.includes("idle"));
    assert.deepEqual(refreshed, ["idle"]);
    assert.equal(daemon.store.getTask(task.id)?.status, "paused");
    assert.equal(daemon.store.getTakeover("private-handoff")?.state, "paused");
  } finally {
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
});

for (const orphaned of [false, true]) test(`native task survives ${orphaned ? "a stale running record after host interruption" : "graceful shutdown"} and resumes its conversation`, async () => {
  const { home, binary } = fakeCli("mb-native-restart", (root) => `import {appendFileSync} from 'node:fs';
import {Client} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import {StreamableHTTPClientTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
if(process.argv[3]==='status')process.exit(0);
const args=process.argv.slice(2),url=JSON.parse(args.find(a=>a.startsWith('mcp_servers.modelbot.url=')).split('=').slice(1).join('='));
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const resumed=args.includes('resume');
appendFileSync(${JSON.stringify(join(root, "turns"))},JSON.stringify({resumed,thread:resumed?args[args.indexOf('resume')+1]:null})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-0000-0000-000000000001'}));
const client=new Client({name:'restart-fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:'Bearer '+process.env.MODELBOT_SCOPED_TOKEN}}}));
await client.callTool(resumed?{name:'done',arguments:{status:'success',summary:'Continued saved conversation'}}:{name:'request_takeover',arguments:{reason:'Review this synthetic draft'}});
await client.close();console.log(JSON.stringify({type:'turn.completed'}));
`);
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const sandbox = createFakeSandbox();
  let starts = 0, cannotRestart = true;
  sandbox.start = async (id) => {
    assert.equal(id, "saved"); starts++;
    if (cannotRestart) throw new Error("synthetic Docker unavailable");
  };
  const options = { port: 0, mcpToken: "restart-mcp", bootstrapToken: "restart-boot", sqlitePath: join(home, "state.sqlite"),
    workspaceRoot: join(home, "workspace"), sandbox, codexRunner: { execution_location: "host", binary, codexHome: home, model: "fixture", runsRoot: join(home, "runs") } };
  let daemon = await startDaemon(options);
  try {
    const first = await bootstrapSession(daemon, "restart-boot");
    daemon.store.insertComputer({ id: "saved", name: "Saved", capabilities: ["browser"], persistent: true, status: "running" });
    const response = await fetch(daemon.baseUrl + "/api/v1/tasks", { method: "POST", headers: first.headers,
      body: JSON.stringify({ computer_id: "saved", goal: "Review a synthetic draft", capabilities: ["browser"] }) });
    assert.equal(response.status, 201);
    const { task } = await response.json() as { task: { id: string } };
    await until(() => Boolean(daemon.store.activeTakeoverForComputer("saved", task.id)), "missing request");
    const takeover = daemon.store.activeTakeoverForComputer("saved", task.id)!;
    assert.equal((await fetch(`${daemon.baseUrl}/api/v1/takeover/${takeover.id}/acquire`, { method: "POST", headers: first.headers })).status, 200);
    await daemon.close();
    const saved = new Store(options.sqlitePath);
    try {
      assert.equal(saved.getTask(task.id)?.status, "paused");
      assert.equal(saved.getTask(task.id)?.cancelled_at, null);
      assert.equal(saved.getTakeover(takeover.id)?.state, "human");
      if (orphaned) saved.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.id);
    } finally { saved.close(); }
    daemon = await startDaemon({ ...options, bootstrapToken: "reopened-boot" });
    assert.equal(daemon.store.getTask(task.id)?.status, "paused");
    const next = await bootstrapSession(daemon, "reopened-boot");
    const post = async (path: string, body = {}) => {
      const res = await fetch(daemon.baseUrl + path, { method: "POST", headers: next.headers, body: JSON.stringify(body) });
      assert.ok(res.ok, await res.clone().text());
      return res.json() as Promise<any>;
    };
    const gate = createToolDispatcher({ store: daemon.store, getClient: () => assert.fail("capture remained private"), emit: () => {} });
    const blocked = await gate.dispatch("browser_snapshot", {}, { computerId: "saved", taskId: task.id });
    assert.equal(!blocked.ok && blocked.error.code, "E_TAKEOVER_BUSY");
    const renewed = await post("/api/v1/takeover/request", { computer_id: "saved", task_id: task.id });
    const id = renewed.takeover.takeover_id;
    await post(`/api/v1/takeover/${id}/acquire`);
    await post(`/api/v1/takeover/${id}/release`);
    const unavailable = await fetch(`${daemon.baseUrl}/api/v1/tasks/${task.id}/resume`, { method: "POST", headers: next.headers, body: "{}" });
    assert.equal(unavailable.status, 503);
    assert.equal(daemon.store.getTask(task.id)?.status, "paused", "a missing runtime must leave the task resumable");
    cannotRestart = false;
    await post(`/api/v1/tasks/${task.id}/resume`);
    await until(() => daemon.store.getTask(task.id)?.status === "completed", "saved task did not finish");
    const turns = readFileSync(join(home, "turns"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(turns, [{ resumed: false, thread: null }, { resumed: true, thread: "00000000-0000-0000-0000-000000000001" }]);
    assert.equal(starts, 2, "retry must start the existing computer before launching the runner");
  } finally {
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
});
