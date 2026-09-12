import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { guestSpawn, startGuestNativeTask } from "../../../src/daemon/guest-native.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

// Exercise the real daemon and Docker transport, with only the Docker executable
// and browser RPC faked. Never launch a model or modify a developer's computer.
async function fixture(t: TestContext, run?: { entered: () => void; aborted: () => void; cleanup: Promise<void> }) {
  const cli = fakeCli("guest-control-cleanup", home => `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const home = ${JSON.stringify(home)}, argv = process.argv.slice(2);
const entry = argv.indexOf('/opt/computer-server/src/native-process.ts');
if (entry < 0) { console.log(argv.includes('info') ? 'Docker Desktop' : 'default'); process.exit(0); }
const action = argv[entry + 1];
appendFileSync(home + '/calls', action + '\\n');
if (action === 'pause' || action === 'resume') {
  if (action === 'pause') writeFileSync(home + '/paused', 'yes');
  if (existsSync(home + '/fail-' + action)) process.exit(1);
  if (action === 'resume') writeFileSync(home + '/paused', 'no');
} else if (action === 'stop') {
  if (existsSync(home + '/fail-stop')) process.exit(1);
} else if (action === 'exec' || action === 'run') {
  if (existsSync(home + '/paused') && (await import('node:fs')).readFileSync(home + '/paused', 'utf8') === 'yes') process.exit(2);
  if (argv.includes('mcp-listen')) console.error('BOTHEARTH_MCP_READY');
  if (argv.includes('--hold') || argv.includes('mcp-listen')) { process.stdin.resume(); setInterval(() => {}, 1000); }
  else console.log('guest-ready');
} else process.exit(3);
`, "docker");
  for (const bin of ["orbctl", "colima", "podman"]) writeFileSync(cli.path(bin), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER, oldPath = process.env.MODELBOT_TOOL_PATH;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  process.env.MODELBOT_TOOL_PATH = cli.home;
  let computer: FakeComputer | undefined;
  const call = FakeComputer.prototype.call;
  t.mock.method(FakeComputer.prototype, "call", function (this: FakeComputer, method: string, params?: unknown) {
    computer = this;
    return call.call(this, method, params);
  });
  const daemon = await startDaemon({ port: 0, mcpToken: "control-cleanup-mcp", bootstrapToken: "control-cleanup-boot",
    workspaceRoot: cli.path("workspace"),
    ...(run ? { agentLoop: { model: "test", adapter: { kind: "openai_compat" as const, async complete(request) {
      run.entered();
      await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => { run.aborted(); resolve(); }, { once: true }));
      await run.cleanup;
      throw new Error("Task cancelled");
    } } } } : {}),
  });
  const { headers } = await bootstrapSession(daemon, "control-cleanup-boot");
  const post = (path: string, body: unknown = {}) => fetch(`${daemon.baseUrl}${path}`,
    { method: "POST", headers, body: JSON.stringify(body) });
  daemon.store.insertComputer({ id: "guest-control", name: "Synthetic", capabilities: ["browser"], persistent: false, status: "running" });
  const task = daemon.store.insertTask({ computer_id: "guest-control", goal: "Save a draft", max_steps: 20 });
  daemon.store.insertStep(task.id, 0, "native_settings", { adapter: "codex", model: "gpt-6-astra", execution_mode: "executor", execution_location: "computer" });
  t.after(async () => {
    await daemon.close();
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER; else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
    if (oldPath === undefined) delete process.env.MODELBOT_TOOL_PATH; else process.env.MODELBOT_TOOL_PATH = oldPath;
    rmSync(cli.home, { recursive: true, force: true });
  });
  return { cli, daemon, task, post, computer: () => computer!,
    paused: () => existsSync(cli.path("paused")) && readFileSync(cli.path("paused"), "utf8") === "yes",
    calls: () => existsSync(cli.path("calls")) ? readFileSync(cli.path("calls"), "utf8").trim().split("\n") : [],
    async request() {
      const response = await post("/api/v1/takeover/request", { computer_id: task.computer_id, task_id: task.id });
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as { takeover: { takeover_id: string } }).takeover.takeover_id;
    },
  };
}

for (const expired of [false, true]) test(`cancel during ${expired ? "expired" : "active"} human control closes the hold and unblocks guest commands`, async t => {
  const f = await fixture(t), id = await f.request();
  assert.equal((await f.post(`/api/v1/takeover/${id}/grant`)).status, 200);
  assert.equal(f.paused(), true);
  if (expired) {
    assert.equal((await f.computer().expireTakeover(id)).ok, true);
    f.daemon.store.updateTakeoverState(id, "paused");
  }
  assert.equal((await f.post(`/api/v1/tasks/${f.task.id}/cancel`)).status, 200);
  assert.equal(f.daemon.store.getTask(f.task.id)?.status, "cancelled");
  assert.equal(f.daemon.store.activeTakeoverForComputer(f.task.computer_id, "next-task"), undefined);
  await until(() => f.computer().getTakeoverState() === "agent" && !f.paused(),
    "computer gate was not released");
  assert.equal(f.daemon.store.getComputer(f.task.computer_id)?.status, "running");
  assert.ok(f.calls().every(action => action !== "volume"), "cancellation must not delete the computer’s model home");
  const next = await guestSpawn(f.task.computer_id, "codex", ["login", "status"]);
  let output = "";
  next.child.stdout!.on("data", bytes => { output += bytes; }); next.child.stderr!.resume();
  assert.deepEqual(await once(next.child, "close"), [0, null]);
  assert.equal(output.trim(), "guest-ready");
  await next.stop();
});

test("a partial freeze stays private until the unanswered task is cancelled, then clears for the next task", async t => {
  const f = await fixture(t), id = await f.request();
  writeFileSync(f.cli.path("fail-pause"), "yes");
  assert.equal((await f.post(`/api/v1/takeover/${id}/grant`)).status, 500);
  assert.equal(f.paused(), true);
  assert.equal(f.calls().includes("resume"), false, "a requested gate may contain private input from an earlier lease");
  assert.equal(f.computer().getTakeoverState(), "takeover_requested");
  assert.equal((await f.post(`/api/v1/tasks/${f.task.id}/cancel`)).status, 200);
  assert.equal(f.daemon.store.getTakeover(id)?.state, "terminated");
  assert.equal(f.computer().getTakeoverState(), "agent");
  assert.equal(f.paused(), false);
});

for (const kind of ["never resolves", "returns ok:false"] as const) test(`cancel of a leftover freeze that ${kind} still answers and unfreezes the next task`, async t => {
  const hung = Promise.withResolvers<void>();
  const original = FakeComputer.prototype.declineTakeover;
  t.mock.method(FakeComputer.prototype, "declineTakeover", async function (this: FakeComputer, id: string) {
    if (kind === "never resolves") await hung.promise;
    else return { ok: false as const, error: { code: "E_IO" as const, message: "decline failed" } };
    return original.call(this, id);
  });
  const f = await fixture(t), id = await f.request();
  writeFileSync(f.cli.path("fail-pause"), "yes");
  assert.equal((await f.post(`/api/v1/takeover/${id}/grant`)).status, 500);
  assert.equal(f.paused(), true);
  const started = Date.now();
  const cancel = await f.post(`/api/v1/tasks/${f.task.id}/cancel`);
  const elapsed = Date.now() - started;
  hung.resolve();
  assert.equal(cancel.status, 200);
  assert.ok(elapsed < 4_000, `cancel took ${elapsed}ms; leftover decline must not block the response`);
  assert.equal(f.daemon.store.getTask(f.task.id)?.status, "cancelled");
  assert.equal(f.paused(), false, "next task must not inherit the native freeze");
  const next = await guestSpawn(f.task.computer_id, "codex", ["login", "status"]);
  let output = "";
  next.child.stdout!.on("data", bytes => { output += bytes; }); next.child.stderr!.resume();
  assert.deepEqual(await once(next.child, "close"), [0, null]);
  assert.equal(output.trim(), "guest-ready");
  await next.stop();
});

test("cancelling during renewal of an expired human lease closes the leftover hold", async t => {
  const f = await fixture(t), original = await f.request();
  assert.equal((await f.post(`/api/v1/takeover/${original}/grant`)).status, 200);
  assert.equal((await f.computer().expireTakeover(original)).ok, true);
  f.daemon.store.updateTakeoverState(original, "paused");
  const renewed = await f.request();
  assert.notEqual(renewed, original);
  assert.equal((await f.post(`/api/v1/tasks/${f.task.id}/cancel`)).status, 200);
  assert.equal(f.daemon.store.activeTakeoverForComputer(f.task.computer_id), undefined);
  await until(() => f.computer().getTakeoverState() === "agent" && !f.paused(),
    "computer gate was not released");
});

test("a failed task's unanswered gate and partial pause do not block the next task", async t => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture(t, { entered: () => entered.resolve(), aborted() {}, cleanup: Promise.resolve() });
  const id = await f.request();
  writeFileSync(f.cli.path("fail-pause"), "yes");
  assert.equal((await f.post(`/api/v1/takeover/${id}/grant`)).status, 500);
  f.daemon.store.finishTask(f.task.id, "failed");
  assert.equal(f.paused(), true);
  assert.equal(f.computer().getTakeoverState(), "takeover_requested");
  const next = await f.post("/api/v1/tasks", { computer_id: f.task.computer_id, goal: "Continue public work", driver: "a11y" });
  assert.equal(next.status, 201);
  const { task } = await next.json() as { task: { id: string } };
  await entered.promise;
  assert.equal(f.computer().getTakeoverState(), "agent");
  assert.equal(f.paused(), false);
  assert.equal((await f.post(`/api/v1/tasks/${task.id}/cancel`)).status, 200);
});

test("Return control retries a failed native thaw after the browser already validated the same lease", async t => {
  const f = await fixture(t), id = await f.request();
  assert.equal((await f.post(`/api/v1/takeover/${id}/grant`)).status, 200);
  f.daemon.store.finishTask(f.task.id, "completed");
  writeFileSync(f.cli.path("fail-resume"), "yes");
  assert.equal((await f.post(`/api/v1/takeover/${id}/release`)).status, 500);
  assert.equal(f.computer().getTakeoverState(), "agent");
  assert.equal(f.paused(), true);
  assert.equal(f.daemon.store.getTakeover(id)?.state, "human", "retain a visible return action while native tools are still paused");
  rmSync(f.cli.path("fail-resume"));
  assert.equal((await f.post(`/api/v1/takeover/${id}/release`)).status, 200);
  assert.equal(f.paused(), false);
  assert.equal(f.daemon.store.getTakeover(id)?.state, "agent");
});

test("Return control waits for cancellation to finish before thawing native processes", async t => {
  const entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>();
  t.after(() => cleanup.resolve());
  const f = await fixture(t, { entered: () => entered.resolve(), aborted: () => aborted.resolve(), cleanup: cleanup.promise });
  const started = await f.post("/api/v1/tasks", { computer_id: f.task.computer_id, goal: "Wait for cancellation", driver: "a11y" });
  assert.equal(started.status, 201);
  const { task } = await started.json() as { task: { id: string } };
  await entered.promise;
  // The adapter is a deterministic stand-in for an in-flight native runner.
  f.daemon.store.insertStep(task.id, 0, "native_settings", { execution_location: "computer" });
  const id = await f.request();
  assert.equal((await f.post(`/api/v1/takeover/${id}/grant`)).status, 200);
  const cancelled = f.post(`/api/v1/tasks/${task.id}/cancel`);
  await aborted.promise;
  const returned = f.post(`/api/v1/takeover/${id}/release`);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.computer().getTakeoverState(), "human", "return raced past cancellation cleanup");
  assert.equal(f.paused(), true);
  cleanup.resolve();
  assert.equal((await cancelled).status, 200);
  assert.equal((await returned).status, 200);
  assert.equal(f.paused(), false);
});

test("guest process cleanup retries a rejected stop and keeps successful stops idempotent", async t => {
  const f = await fixture(t);
  const session = await guestSpawn(f.task.computer_id, "codex", ["--hold"]);
  session.child.stdout!.resume(); session.child.stderr!.resume();
  writeFileSync(f.cli.path("fail-stop"), "yes");
  await assert.rejects(session.stop(), /Guest cleanup could not be confirmed/);
  assert.equal(f.calls().filter(action => action === "stop").length, 1);
  rmSync(f.cli.path("fail-stop"));
  await Promise.all([session.stop(), session.stop()]);
  await session.stop();
  assert.equal(f.calls().filter(action => action === "stop").length, 2);
});

test("Return control kills a cancelled guest after failed cleanup before clearing the pause marker", async t => {
  const f = await fixture(t);
  const session = await guestSpawn(f.task.computer_id, "codex", ["--hold"]);
  session.child.stdout!.resume(); session.child.stderr!.resume();
  const id = await f.request();
  assert.equal((await f.post(`/api/v1/takeover/${id}/grant`)).status, 200);
  writeFileSync(f.cli.path("fail-stop"), "yes");
  await assert.rejects(session.stop(), /Guest cleanup could not be confirmed/);
  f.daemon.store.finishTask(f.task.id, "cancelled");
  assert.equal((await f.post(`/api/v1/takeover/${id}/release`)).status, 500);
  assert.equal(f.paused(), true, "unconfirmed cancelled processes must never thaw");
  rmSync(f.cli.path("fail-stop"));
  assert.equal((await f.post(`/api/v1/takeover/${id}/release`)).status, 200);
  assert.equal(f.paused(), false);
  const actions = f.calls();
  assert.equal(actions.filter(action => action === "stop").length, 3);
  assert.deepEqual(actions.slice(-2), ["stop", "resume"]);
});

test("guest task cleanup retries both the model and MCP relay after a failed stop", async t => {
  const f = await fixture(t);
  const session = await startGuestNativeTask({ computerId: f.task.computer_id, provider: "codex",
    url: `${f.daemon.baseUrl}/mcp`, token: "control-cleanup-mcp", args: () => ["--hold"] });
  session.child.stdout!.resume();
  writeFileSync(f.cli.path("fail-stop"), "yes");
  await assert.rejects(session.stop(), /Guest cleanup could not be confirmed/);
  assert.equal(f.calls().filter(action => action === "stop").length, 2);
  rmSync(f.cli.path("fail-stop"));
  await Promise.all([session.stop(), session.stop()]);
  await session.stop();
  assert.equal(f.calls().filter(action => action === "stop").length, 4);
});
