import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { guestTaskArgs, runCodexTask } from "../../../src/daemon/codex-runner.ts";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import { until } from "../../helpers/until.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli, isolateModelbotHome } from "../../helpers/fake-cli.ts";

isolateModelbotHome();

async function fixture(mode: string, publicOrigin?: string, maxRuntimeSec = 0, takeoverTtlSec?: number) {
  const { home: root, binary } = fakeCli("mb-codex-runner", () => `import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
if(process.argv[2]==='login'&&process.argv[3]==='status') process.exit(0);
const argv=process.argv.slice(2), emit=(v)=>console.log(JSON.stringify(v));
const url=JSON.parse(argv.find(a=>a.startsWith('mcp_servers.modelbot.url=')).split('=').slice(1).join('='));
const mode=argv[argv.indexOf('-m')+1];
const token=process.env.MODELBOT_SCOPED_TOKEN;
assert.ok(token); assert.equal(argv.join(' ').includes(token),false);
assert.equal(process.env.MODELBOT_VAULT_KEY_HEX,undefined); assert.equal(process.env.MODELBOT_MCP_TOKEN,undefined);
assert.ok(argv.includes('--ignore-user-config')); assert.ok(argv.includes('features.shell_tool=false'));
assert.ok(argv.includes('features.multi_agent=false')); assert.ok(argv.includes('model_reasoning_effort="medium"'));
assert.ok(argv.includes('web_search="disabled"'));
assert.ok(argv.includes('mcp_servers.modelbot.tool_timeout_sec=300'));
const report={url,token,pid:process.pid,argv};
const publish=()=>{writeFileSync('scope.tmp',JSON.stringify(report),{mode:0o600});renameSync('scope.tmp','scope.json');};
publish();
let input=''; for await (const chunk of process.stdin) input+=chunk;
assert.ok(input.startsWith('Execute this task directly in executor mode. Do not spawn or delegate to subagents.'));
assert.equal(input.includes('Use your native subagents'),false);
assert.equal(input.includes('Exit without done is not successful completion'),false);
emit({type:'thread.started',thread_id:'00000000-0000-0000-0000-000000000001'});
const client=new Client({name:'runner-fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:'Bearer '+token}}}));
const tools=(await client.listTools()).tools;
assert.ok(tools.some(t=>t.name==='done')); assert.equal(tools.some(t=>t.name==='shell_exec'),false);
assert.equal((await client.callTool({name:'shell_exec',arguments:{command:'echo forbidden'}})).isError,true);
const observed=await client.callTool({name:'takeover_status',arguments:{}});
const status=JSON.parse(observed.content[0].text); report.observedState=(status.data??status).state; publish();
const wrong=await client.callTool({name:'takeover_status',arguments:{computer_id:'wrong-computer'}});
assert.equal(wrong.isError,true);
if(mode==='nonzero') { emit({type:'turn.failed',error:{message:'Synthetic provider failure'}}); process.exit(7); }
if(mode==='hold') {
 process.on('SIGTERM',()=>{emit({type:'item.completed',item:{type:'agent_message',text:'late after cancel'}});process.exit(0);});
 setInterval(()=>{},1000);
} else {
 if(mode==='wait-idle'&&!argv.includes('resume')) {
  emit({type:'item.completed',item:{type:'agent_message',text:'The conversation is open.'}});
 } else if(mode.startsWith('question')&&!argv.includes('resume')) {
  emit({type:'item.completed',item:{type:'agent_message',text:'Which public website should I audit?'}});
  if(mode==='question-queued') await new Promise(r=>setTimeout(r,500));
 } else if(mode.startsWith('question')) {
  assert.ok(input.includes('Use the public website'));
  assert.equal(input.includes('STILL pending'),false);
  assert.equal((await client.callTool({name:'browser_snapshot',arguments:{}})).isError,false);
  report.continuedTools=true;publish();
  assert.equal((await client.callTool({name:'done',arguments:{status:'success',summary:'Continued on the same conversation'}})).isError,false);
 } else if(mode==='instruction') {
  report.chatReady=true;publish();await new Promise(r=>setTimeout(r,500));
  const message=await client.callTool({name:'takeover_status',arguments:{}});
  assert.equal(message.isError,true);assert.ok(message.content[0].text.includes('Keep going'));
  emit({type:'item.completed',item:{type:'agent_message',text:'I will use that direction and continue.'}});
  assert.equal((await client.callTool({name:'browser_snapshot',arguments:{}})).isError,false);
  report.continuedTools=true;publish();
  assert.equal((await client.callTool({name:'done',arguments:{status:'success',summary:'Followed the direction without another permission'}})).isError,false);
 } else if(mode==='chat'&&!argv.includes('resume')) {
  report.chatReady=true;publish();await new Promise(r=>setTimeout(r,500));
  const message=await client.callTool({name:'takeover_status',arguments:{}});
  assert.equal(message.isError,true);assert.ok(message.content[0].text.includes('Just answer'));
  emit({type:'item.completed',item:{type:'agent_message',text:'Here is my status. Waiting for your direction.'}});
 } else if(mode==='chat') {
  assert.ok(input.includes('Continue'));
  assert.equal((await client.callTool({name:'done',arguments:{status:'success',summary:'Continued after conversation'}})).isError,false);
 } else if(mode==='wait-existing' &&!argv.includes('resume')) {
  await new Promise(r=>setTimeout(r,300));
 } else if(mode.startsWith('wait')&&!argv.includes('resume')) {
  const request=await client.callTool({name:'request_takeover',arguments:{reason:'Synthetic control request',timeout_sec:60}});
  assert.equal(request.isError,false);
  const requestData=JSON.parse(request.content[0].text).data;
  assert.equal(new URL(requestData.url).hash,'#/live/selected');
  assert.equal((await fetch(requestData.url)).status,200);
  if(mode==='wait-fast') await new Promise(r=>setTimeout(r,300));
 } else if(mode==='wait-message'&&input.includes('What is blocking you?')) {
  assert.ok(input.includes('STILL pending'));
  emit({type:'item.completed',item:{type:'agent_message',text:'I am waiting for your control handoff.'}});
 } else if((mode==='stall-timeout'||mode==='stall-queued'||mode==='stall-held')&&!argv.includes('resume')) {
  if(mode==='stall-held') { report.chatReady=true;publish(); await new Promise(r=>setTimeout(r,800)); }
  else {
   const snap=await client.callTool({name:'browser_snapshot',arguments:{}});
   assert.equal(snap.isError,true);
   assert.ok(JSON.stringify(snap).includes('E_TIMEOUT'));
  }
  emit({type:'item.completed',item:{type:'mcp_tool_call',tool:'browser_snapshot',result:{isError:true,error:{code:'E_TIMEOUT',message:'tool exceeded 60000ms'}}}});
  emit({type:'item.completed',item:{type:'todo_list'}});
  emit({type:'item.completed',item:{type:'reasoning'}});
  emit({type:'item.completed',item:{type:'agent_message',text:'The snapshot timed out. Please take control.'}});
  if(mode==='stall-queued') await new Promise(r=>setTimeout(r,500));
 } else if(mode==='stall-queued') {
  assert.ok(input.includes('New messages from the operator'));
  assert.ok(input.includes('Use the public website'));
  assert.equal(input.includes('Continue the existing BotHearth task'),false);
  assert.equal((await client.callTool({name:'done',arguments:{status:'success',summary:'Continued from queued stall reply'}})).isError,false);
 } else if(mode==='stall-timeout') {
  assert.equal((await client.callTool({name:'done',arguments:{status:'success',summary:'Resumed after stall'}})).isError,false);
 } else if(mode.startsWith('complete')||mode.startsWith('wait')) {
  const done=await client.callTool({name:'done',arguments:{summary:'Synthetic task completed',status:mode==='complete-fail'?'fail':mode==='complete-cancelled'?'cancelled':'success'}});
  assert.equal(done.isError,false);
 }
 await client.close().catch(()=>{});
 emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
}
`, "codex-fixture.mjs");
  const runsRoot = join(root, "runs");
  const oldToolPath = process.env.MODELBOT_TOOL_PATH;
  if (mode === "complete-service-path") {
    symlinkSync(binary, join(root, "codex"));
    process.env.MODELBOT_TOOL_PATH = root;
  }
  const oldFake = process.env.MODELBOT_TEST_FAKE_COMPUTER, oldVault = process.env.MODELBOT_VAULT_KEY_HEX;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1"; process.env.MODELBOT_VAULT_KEY_HEX = "daemon-only-canary";
  const daemon = await startDaemon({ port: 0, mcpToken: "daemon-mcp", bootstrapToken: "bootstrap",
    publicOrigin, workspaceRoot: join(root, "workspace"), maxRuntimeSec, takeoverTtlSec,
    codexRunner: { execution_location: "host", binary: mode === "complete-service-path" ? undefined : binary, codexHome: root, model: mode, runsRoot } });
  const bootstrap = publicOrigin ? new URL(daemon.store.createPairing(daemon.baseUrl)!.url).hash.slice(11) : "bootstrap";
  const { headers } = await bootstrapSession(daemon, bootstrap);
  const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, { headers,
    ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const session = await api("/api/v1/session").then((r) => r.json()) as any;
  assert.equal(session.execution_mode, "codex"); assert.equal(session.budget_kind, "tool_proxy");
  for (const id of ["selected", "other"]) daemon.store.insertComputer({ id, name: id, capabilities: ["browser", "shell"], persistent: false, status: "running" });
  const start = async (computer_id = "selected") => {
    const res = await api("/api/v1/tasks", { computer_id, goal: "Synthetic task", capabilities: ["browser"], max_steps: 20 });
    assert.equal(res.status, 201); return (await res.json() as any).task;
  };
  const scopes = () => existsSync(runsRoot) ? readdirSync(runsRoot).map((dir) => join(runsRoot, dir, "scope.json"))
    .filter(existsSync).map((file) => JSON.parse(readFileSync(file, "utf8"))) : [];
  return { daemon, api, start, scopes, headers, async close() {
    await daemon.close();
    if (oldToolPath === undefined) delete process.env.MODELBOT_TOOL_PATH; else process.env.MODELBOT_TOOL_PATH = oldToolPath;
    if (oldFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER; else process.env.MODELBOT_TEST_FAKE_COMPUTER = oldFake;
    if (oldVault === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX; else process.env.MODELBOT_VAULT_KEY_HEX = oldVault;
  } };
}

test("scoped Codex completion works with multiple computers and revokes its token", async () => {
  const f = await fixture("complete");
  try {
    const task = await f.start();
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "task did not complete");
    const scope = f.scopes()[0];
    assert.equal((await fetch(scope.url, { headers: { authorization: `Bearer ${scope.token}` } })).status, 401);
    const detail = await f.api(`/api/v1/tasks/${task.id}`).then((r) => r.json()) as any;
    assert.ok(detail.steps.some((s: any) => s.body.summary === "Synthetic task completed"));
  } finally { await f.close(); }
});

test("a clean first-turn question stays open and its answer continues tools on the same thread", async () => {
  const f = await fixture("question");
  try {
    const task = await f.start();
    await until(async () => (await f.api(`/api/v1/tasks/${task.id}`).then(r => r.json()) as any).task.awaiting_message,
      "clean question did not leave the conversation open");
    assert.equal(f.daemon.store.getTask(task.id)?.status, "running");
    assert.ok(f.daemon.store.taskTranscript(task.id).some(message => message.content === "Which public website should I audit?"));
    const first = f.scopes()[0];
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(f.scopes()[0].pid, first.pid, "the runner must not prompt itself again");
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "Use the public website" })).status, 202);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "answer did not continue the task");
    assert.ok(f.scopes()[0].argv.includes("resume"));
    assert.ok(f.scopes()[0].argv.includes("00000000-0000-0000-0000-000000000001"));
    assert.equal(f.scopes()[0].continuedTools, true);
  } finally { await f.close(); }
});

test("native tools keep running after a mid-task instruction without another permission", async () => {
  const f = await fixture("instruction");
  try {
    const task = await f.start();
    await until(() => f.scopes()[0]?.chatReady, "runner not ready");
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "Keep going; check the current page." })).status, 202);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "instruction caused an unnecessary wait");
    assert.equal(f.scopes()[0].continuedTools, true);
    assert.equal(f.scopes()[0].argv.includes("resume"), false, "the native turn itself should continue its tools");
    assert.equal(f.daemon.store.activeTakeoverForComputer("selected", task.id), undefined);
  } finally { await f.close(); }
});

test("a reply queued before native turn completion resumes without another message", async () => {
  const f = await fixture("question-queued");
  try {
    const task = await f.start();
    await until(() => f.daemon.store.taskTranscript(task.id).some(message => message.content === "Which public website should I audit?"),
      "native question was not displayed");
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "Use the public website" })).status, 202);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "queued reply was stranded");
    assert.equal(f.scopes()[0].continuedTools, true);
    assert.equal(f.daemon.store.pendingMessages(task.id).length, 0);
  } finally { await f.close(); }
});

test("cancelling an idle native conversation never prompts it again", async () => {
  const f = await fixture("question");
  try {
    const task = await f.start();
    await until(async () => (await f.api(`/api/v1/tasks/${task.id}`).then(r => r.json()) as any).task.awaiting_message,
      "question did not wait");
    const firstPid = f.scopes()[0].pid;
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/cancel`, {})).status, 200);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(f.daemon.store.getTask(task.id)?.status, "cancelled");
    assert.equal(f.scopes()[0].pid, firstPid);
    assert.equal(f.scopes()[0].argv.includes("resume"), false);
  } finally { await f.close(); }
});

test("native login and tasks use the daemon's Node when a service has no Node on PATH", async () => {
  const previous = process.env.PATH;
  process.env.PATH = "/no-service-node";
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture("complete-service-path");
    const task = await f.start();
    await until(() => f!.daemon.store.getTask(task.id)?.status === "completed", "native CLI could not find Node");
  } finally {
    await f?.close();
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("different tasks cannot exchange tokens; stop revokes scope and ignores late output", async () => {
  const f = await fixture("hold");
  try {
    const first = await f.start(), second = await f.start("other");
    await until(() => f.scopes().length === 2, "children did not start");
    const [a, b] = f.scopes();
    assert.equal((await fetch(b.url, { headers: { authorization: `Bearer ${a.token}` } })).status, 401);
    assert.equal((await f.api("/api/v1/tasks", { computer_id: "selected", goal: "overlap", max_steps: 2 })).status, 409);
    assert.equal((await f.api(`/api/v1/tasks/${first.id}/cancel`, {})).status, 200);
    assert.equal((await f.api(`/api/v1/tasks/${second.id}/cancel`, {})).status, 200);
    for (const scope of [a, b]) {
      assert.equal((await fetch(scope.url, { headers: { authorization: `Bearer ${scope.token}` } })).status, 401);
      await until(() => { try { process.kill(scope.pid, 0); return false; } catch { return true; } }, "child survived cancellation");
    }
    const detail = await f.api(`/api/v1/tasks/${first.id}`).then((r) => r.json());
    assert.equal(JSON.stringify(detail).includes("late after cancel"), false);
  } finally { await f.close(); }
});

test("operator wait parks the runner and resumes the same thread after control is resolved", async () => {
  const f = await fixture("wait");
  try {
    const task = await f.start();
    await until(() => Boolean(f.daemon.store.activeTakeoverForComputer("selected")), "takeover was not requested");
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(f.daemon.store.getTask(task.id)?.status, "running");
    assert.equal(f.scopes()[0].argv.includes("resume"), false);
    const takeover = f.daemon.store.activeTakeoverForComputer("selected")!;
    assert.equal((await f.api(`/api/v1/takeover/${takeover.id}/decline`, {})).status, 200);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "task did not resume");
    assert.equal(f.scopes()[0].argv.includes("resume"), true);
  } finally { await f.close(); }
});

test("taking and returning control from an idle conversation resumes the same native thread", async () => {
  const f = await fixture("wait-idle");
  try {
    const task = await f.start();
    await until(async () => (await f.api(`/api/v1/tasks/${task.id}`).then(r => r.json()) as any).task.awaiting_message,
      "native conversation did not become idle");
    const request = await f.api("/api/v1/takeover/request", { computer_id: "selected", task_id: task.id });
    assert.equal(request.status, 200);
    const id = ((await request.json()) as any).takeover.takeover_id;
    assert.equal((await f.api(`/api/v1/takeover/${id}/acquire`, {})).status, 200);
    await until(async () => !(await f.api(`/api/v1/tasks/${task.id}`).then(r => r.json()) as any).task.awaiting_message,
      "runner did not observe the computer handoff");
    assert.equal(f.scopes()[0].argv.includes("resume"), false, "native tools must stay idle while the operator has control");
    assert.equal((await f.api(`/api/v1/takeover/${id}/release`, {})).status, 200);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "returning control stranded the conversation");
    assert.ok(f.scopes()[0].argv.includes("resume"));
  } finally { await f.close(); }
});


test("an operator wait that outlasts the runtime ceiling still resumes instead of stopping", async () => {
  const f = await fixture("wait", undefined, 2);
  try {
    const task = await f.start();
    await until(() => Boolean(f.daemon.store.activeTakeoverForComputer("selected")), "takeover was not requested");
    // Outlive the 2s runtime ceiling while nobody has answered yet.
    await new Promise((r) => setTimeout(r, 3_000));
    assert.equal(f.daemon.store.getTask(task.id)?.status, "running",
      "a pending ask must never end on the runner's own wall clock");
    const takeover = f.daemon.store.activeTakeoverForComputer("selected")!;
    assert.equal((await f.api(`/api/v1/takeover/${takeover.id}/decline`, {})).status, 200);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "task did not resume after a long wait", 8_000);
    const detail = await f.api(`/api/v1/tasks/${task.id}`).then((r) => r.json()) as any;
    assert.equal(JSON.stringify(detail).includes("timed out waiting for the operator"), false);
  } finally { await f.close(); }
});

test("provider failure remains failed and a quickly resolved wait still resumes", async () => {
  const failed = await fixture("nonzero");
  try {
    const task = await failed.start();
    await until(() => failed.daemon.store.getTask(task.id)?.status === "failed", "provider failure did not fail task");
  } finally { await failed.close(); }
  const fast = await fixture("wait-fast");
  try {
    const task = await fast.start();
    await until(() => Boolean(fast.daemon.store.activeTakeoverForComputer("selected")), "missing request");
    const takeover = fast.daemon.store.activeTakeoverForComputer("selected")!;
    await fast.api(`/api/v1/takeover/${takeover.id}/decline`, {});
    await until(() => fast.daemon.store.getTask(task.id)?.status === "completed", "early operator response was lost");
    assert.equal(fast.scopes()[0].argv.includes("resume"), true);
  } finally { await fast.close(); }
});

test("cancellation during operator wait never starts a resume process", async () => {
  const f = await fixture("wait");
  try {
    const task = await f.start();
    await until(() => Boolean(f.daemon.store.activeTakeoverForComputer("selected")), "missing request");
    await new Promise((r) => setTimeout(r, 350));
    await f.api(`/api/v1/tasks/${task.id}/cancel`, {});
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(f.daemon.store.getTask(task.id)?.status, "cancelled");
    assert.equal(f.scopes()[0].argv.includes("resume"), false);
  } finally { await f.close(); }
});


test("a replacement task cannot start while cancellation is closing its computer client", async () => {
  const f = await fixture("hold");
  const original = FakeComputer.prototype.close;
  const closing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let once = true;
  FakeComputer.prototype.close = async function () {
    if (this.computerId === "selected" && once) { once = false; closing.resolve(); await release.promise; }
    return original.call(this);
  };
  try {
    const task = await f.start();
    await until(() => (f.daemon.store.getHarnessTaskBinding("selected")?.observed_tool_calls ?? 0) >= 1, "client not opened");
    const cancel = f.api(`/api/v1/tasks/${task.id}/cancel`, {});
    await closing.promise;
    assert.equal((await f.api("/api/v1/tasks", { computer_id: "selected", goal: "replacement", capabilities: ["browser"], max_steps: 2 })).status, 409);
    release.resolve(); await cancel;
  } finally { release.resolve(); FakeComputer.prototype.close = original; await f.close(); }
});


test("preexisting HUMAN observed through status can resolve before the child exits", async () => {
  const f = await fixture("wait-existing");
  try {
    const requested = await f.api("/api/v1/takeover/request", { computer_id: "selected" }).then((r) => r.json()) as any;
    const id = requested.takeover.takeover_id;
    assert.equal((await f.api(`/api/v1/takeover/${id}/acquire`, {})).status, 200);
    const task = await f.start();
    await until(() => f.scopes()[0]?.observedState === "human", "existing HUMAN state was not observed");
    assert.equal((await f.api(`/api/v1/takeover/${id}/release`, {})).status, 200);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "status-only handoff failed to resume");
    assert.equal(f.scopes()[0].argv.includes("resume"), true);
  } finally { await f.close(); }
});

test("a tool connection error does not turn a clean native question into a failed conversation", async () => {
  const original = FakeComputer.prototype.call;
  FakeComputer.prototype.call = async () => ({ ok: false, error: { code: "E_IO", message: "computer-server stream closed" } });
  const f = await fixture("question");
  try {
    const task = await f.start();
    await until(async () => (await f.api(`/api/v1/tasks/${task.id}`).then(r => r.json()) as any).task.awaiting_message,
      "native question was not kept open after a tool error");
    const detail = await f.api(`/api/v1/tasks/${task.id}`).then((r) => r.json()) as any;
    assert.equal(detail.task.status, "running");
    assert.ok(detail.steps.some((step: any) => step.body.content === "Which public website should I audit?"));
    assert.equal(JSON.stringify(detail).includes("Codex ended without marking"), false);
  } finally { FakeComputer.prototype.call = original; await f.close(); }
});

for (const [mode, expected] of [["complete-fail", "failed"], ["complete-cancelled", "cancelled"]]) test(`scoped Codex done outcome persists ${expected} with its summary`, async () => {
  const f = await fixture(mode!);
  try {
    const task = await f.start();
    await until(() => f.daemon.store.getTask(task.id)?.status === expected, "done outcome was not preserved");
    const detail = await f.api(`/api/v1/tasks/${task.id}`).then((r) => r.json()) as any;
    assert.equal(detail.task.status, expected);
    assert.ok(detail.steps.some((s: any) => s.kind === `task.${expected}` && s.body.summary === "Synthetic task completed"));
    if (expected === "cancelled") assert.ok(detail.task.cancelled_at);
  } finally { await f.close(); }
});


test("remote operator origin leaves local scoped provider MCP transport on loopback", async () => {
  const f = await fixture("complete", "https://operator.synthetic.ts.net");
  try {
    const task = await f.start();
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "remote-configured task did not complete");
    assert.ok(f.scopes()[0].url.startsWith(f.daemon.baseUrl + "/mcp/tasks/"));
  } finally { await f.close(); }
});


for (const expired of [false, true]) test(`operator can converse during ${expired ? "expired" : "active"} takeover without granting control; messages persist and terminal tasks reject them`, async () => {
  const f = await fixture("wait-message", undefined, 0, expired ? 0.5 : undefined);
  try {
    const task = await f.start();
    await until(() => Boolean(f.daemon.store.activeTakeoverForComputer("selected", task.id)), "no takeover");
    const takeover = f.daemon.store.activeTakeoverForComputer("selected", task.id)!;
    assert.equal((await f.api(`/api/v1/takeover/${takeover.id}/acquire`, {})).status, 200);
    if (expired) await until(() => f.daemon.store.getTakeover(takeover.id)?.state === "paused", "lease did not expire");
    assert.equal((await fetch(`${f.daemon.baseUrl}/api/v1/tasks/${task.id}/messages`, { method: "POST", headers: { ...f.headers, "X-CSRF-Token": "wrong" }, body: JSON.stringify({ text: "unauthorised" }) })).status, 403);
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: " " })).status, 400);
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "x".repeat(8001) })).status, 400);
    assert.equal((await f.api(`/api/v1/tasks/missing/messages`, { text: "hello" })).status, 404);
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "What is blocking you?" })).status, 202);
    await until(() => f.daemon.store.taskTranscript(task.id).some(m => m.content === "I am waiting for your control handoff."), "no mid-task reply");
    assert.equal(f.daemon.store.getTask(task.id)?.status, "running");
    assert.equal(f.daemon.store.activeTakeoverForComputer("selected", task.id)?.state, expired ? "paused" : "human");
    const detail = await f.api(`/api/v1/tasks/${task.id}`).then(r => r.json()) as any;
    assert.ok(detail.steps.some((s: any) => s.kind === "user" && s.body.content === "What is blocking you?"));
    assert.equal(f.daemon.store.pendingMessages(task.id).length, 0);
    let releaseId = takeover.id;
    if (expired) {
      const request = await f.api("/api/v1/takeover/request", { computer_id: "selected", task_id: task.id });
      assert.equal(request.status, 200);
      releaseId = ((await request.json()) as any).takeover.takeover_id;
      assert.equal((await f.api(`/api/v1/takeover/${releaseId}/acquire`, {})).status, 200);
    }
    assert.equal((await f.api(`/api/v1/takeover/${releaseId}/release`, {})).status, 200);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "did not resume");
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "late" })).status, 409);
  } finally { await f.close(); }
});

test("native Codex MCP config writes tool_timeout_sec 300", () => {
  const args = guestTaskArgs("codex", "gpt-6-astra", {}, { command: "node", args: ["/opt/mcp"] });
  const configs = args.flatMap((arg, i) => arg === "-c" ? [args[i + 1]] : []);
  assert.ok(configs.includes("mcp_servers.modelbot.tool_timeout_sec=300"));
});

async function withSnapshotTimeout<T>(fn: () => Promise<T>): Promise<T> {
  const original = FakeComputer.prototype.call;
  FakeComputer.prototype.call = async function (method, ...rest: unknown[]) {
    if (method === "browser_snapshot") {
      return { ok: false, error: { code: "E_TIMEOUT", message: "tool exceeded 60000ms" } };
    }
    return original.call(this, method, ...rest);
  };
  try { return await fn(); } finally { FakeComputer.prototype.call = original; }
}

async function runJsonlTurn(script: string, opts: {
  hasMessages?: () => boolean;
  takeMessages?: () => string[];
  isWaiting?: () => boolean;
  isTerminal?: () => boolean;
} = {}) {
  isolateModelbotHome();
  const cli = fakeCli("mb-stall-unit", () => script);
  let stall: { hadDone: boolean; lastToolError?: string } | undefined;
  let taken: string[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    await runCodexTask(
      { binary: cli.binary, codexHome: cli.home, model: "gpt-6-astra", execution_location: "host" },
      { id: "t", computer_id: "c", goal: "g" },
      {
        url: "http://127.0.0.1:1/mcp", token: "tok", signal: ac.signal, maxRuntimeSec: 0,
        onMessage() {},
        onTurnEnded(info) { stall = info; },
        hasMessages: opts.hasMessages ?? (() => false),
        takeMessages: () => {
          taken = opts.takeMessages?.() ?? [];
          return taken;
        },
        isWaiting: opts.isWaiting ?? (() => false),
        waitGeneration: () => 0,
        isTerminal: opts.isTerminal ?? (() => false),
      },
    );
  } finally { clearTimeout(timer); }
  return { stall, taken };
}

const STALL_JSONL = `for await (const chunk of process.stdin) {}
const resume=process.argv.includes('resume');
const emit=(v)=>console.log(JSON.stringify(v));
emit({type:'thread.started',thread_id:'stall-thread'});
if(!resume) {
 emit({type:'item.completed',item:{type:'mcp_tool_call',tool:'browser_snapshot',result:{isError:true,error:{code:'E_TIMEOUT',message:'tool exceeded 60000ms'}}}});
 emit({type:'item.completed',item:{type:'todo_list'}});
 emit({type:'item.completed',item:{type:'file_change'}});
 emit({type:'item.completed',item:{type:'reasoning'}});
 emit({type:'item.completed',item:{type:'agent_message',text:'timed out'}});
}
emit({type:'turn.completed'});`;

test("a timed-out last tool without done pauses the native task", async () => {
  await withSnapshotTimeout(async () => {
    const f = await fixture("stall-timeout");
    try {
      const task = await f.start();
      await until(() => f.daemon.store.getTask(task.id)?.status === "paused", "timed-out turn did not pause");
      const detail = await f.api(`/api/v1/tasks/${task.id}`).then((r) => r.json()) as any;
      assert.equal(detail.task.status, "paused");
      assert.notEqual(detail.task.awaiting_message, true);
      const paused = [...detail.steps].reverse().find((s: any) => s.kind === "task.step" && s.body.status === "paused");
      assert.ok(paused, "missing paused task.step");
      assert.ok(["stalled", "waiting_for_you"].includes(paused.body.failure_kind), paused.body.failure_kind);
      assert.equal((await f.api(`/api/v1/tasks/${task.id}/resume`, {})).status, 202);
      await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "resume after stall did not complete");
    } finally { await f.close(); }
  });
});

test("a later non-tool item does not wipe a failed last tool", async () => {
  const { stall } = await runJsonlTurn(STALL_JSONL);
  assert.equal(stall?.hadDone, false);
  assert.match(stall?.lastToolError ?? "", /E_TIMEOUT|tool exceeded/);
});

test("a queued operator reply skips stall pause and is injected", async () => {
  let delivered = false;
  const { stall, taken } = await runJsonlTurn(STALL_JSONL, {
    hasMessages: () => !delivered,
    takeMessages: () => { delivered = true; return ["Use the public website"]; },
    isTerminal: () => delivered,
  });
  assert.equal(stall, undefined);
  assert.deepEqual(taken, ["Use the public website"]);
});

test("MCP result.isError stalls; a bare mcp_tool_call does not", async () => {
  const failed = await runJsonlTurn(`for await (const chunk of process.stdin) {}
console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',tool:'browser_snapshot',result:{isError:true,error:{code:'E_TIMEOUT'}}}}));
console.log(JSON.stringify({type:'turn.completed'}));`);
  assert.match(failed.stall?.lastToolError ?? "", /E_TIMEOUT|tool error/);
  let delivered = false;
  const bare = await runJsonlTurn(`for await (const chunk of process.stdin) {}
console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',tool:'browser_snapshot'}}));
console.log(JSON.stringify({type:'turn.completed'}));`, {
    hasMessages: () => !delivered,
    takeMessages: () => { delivered = true; return ["continue"]; },
    isTerminal: () => delivered,
  });
  assert.equal(bare.stall, undefined);
  assert.deepEqual(bare.taken, ["continue"]);
});

test("a reply queued before a stalled turn continues instead of pausing", async () => {
  await withSnapshotTimeout(async () => {
    const f = await fixture("stall-queued");
    try {
      const task = await f.start();
      await until(() => f.daemon.store.taskTranscript(task.id).some(message => message.content === "The snapshot timed out. Please take control."),
        "stall message was not displayed");
      assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "Use the public website" })).status, 202);
      await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "queued stall reply was stranded");
      assert.equal(f.daemon.store.getTask(task.id)?.status, "completed");
      assert.equal(f.daemon.store.pendingMessages(task.id).length, 0);
      assert.ok(f.scopes()[0].argv.includes("resume"));
    } finally { await f.close(); }
  });
});

test("an audit failure after stall pause does not fail the task", async () => {
  await withSnapshotTimeout(async () => {
    const f = await fixture("stall-timeout");
    const append = f.daemon.store.appendAuditRef.bind(f.daemon.store);
    f.daemon.store.appendAuditRef = (input) => {
      if (input.type === "task.step" && (input.body as { reason?: string }).reason === "stall") {
        throw new Error("stall audit failed");
      }
      return append(input);
    };
    try {
      const task = await f.start();
      await until(() => {
        const status = f.daemon.store.getTask(task.id)?.status;
        return status === "paused" || status === "failed";
      }, "stall did not settle");
      assert.equal(f.daemon.store.getTask(task.id)?.status, "paused");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(f.daemon.store.getTask(task.id)?.status, "paused");
    } finally { await f.close(); }
  });
});

test("an open takeover skips stall pause and keeps the lease wait", async () => {
  await withSnapshotTimeout(async () => {
    const f = await fixture("stall-held");
    try {
      const task = await f.start();
      await until(() => f.scopes()[0]?.chatReady, "runner not ready");
      const requested = await f.api("/api/v1/takeover/request", { computer_id: "selected", task_id: task.id }).then((r) => r.json()) as any;
      const id = requested.takeover.takeover_id;
      assert.equal((await f.api(`/api/v1/takeover/${id}/acquire`, {})).status, 200);
      await until(() => f.daemon.store.taskTranscript(task.id).some(message => message.content === "The snapshot timed out. Please take control."),
        "stall message was not displayed");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(f.daemon.store.getTask(task.id)?.status, "running");
      assert.ok(f.daemon.store.activeTakeoverForComputer("selected", task.id));
      assert.notEqual((await f.api(`/api/v1/tasks/${task.id}`).then((r) => r.json()) as any).task.awaiting_message, true);
    } finally { await f.close(); }
  });
});

test("a paused native task resumes its saved provider conversation", async () => {
  const f = await fixture("complete");
  try {
    const id = "task_resume_fixture";
    f.daemon.store.insertHarnessTaskBinding({ task_id: id, computer_id: "selected", spend_cap_usd: 20, max_steps: 20, proxy_usd_per_tool_call: 0.01 });
    f.daemon.store.db.prepare("UPDATE tasks SET adapter = 'codex', capabilities = '[\"browser\"]' WHERE id = ?").run(id);
    const task = f.daemon.store.getTask(id)!;
    f.daemon.store.pauseTask(task.id);
    f.daemon.store.insertStep(task.id, 0, "runner_session", { thread_id: "00000000-0000-0000-0000-000000000001", provider: "codex" });
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/resume`, {})).status, 202);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "saved task did not complete");
    assert.ok(f.scopes()[0].argv.includes("resume"));
    assert.ok(f.scopes()[0].argv.includes("00000000-0000-0000-0000-000000000001"));
  } finally { await f.close(); }
});


test("a mid-task conversational reply waits for another message instead of failing", async () => {
  const f = await fixture("chat");
  try {
    const task = await f.start();
    await until(() => f.scopes()[0]?.chatReady, "runner not ready");
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "Just answer my status question; wait for further direction." })).status, 202);
    await until(async () => (await f.api(`/api/v1/tasks/${task.id}`).then(r => r.json()) as any).task.awaiting_message, "reply did not park");
    assert.equal(f.daemon.store.getTask(task.id)?.status, "running");
    assert.equal((await f.api(`/api/v1/tasks/${task.id}/messages`, { text: "Continue" })).status, 202);
    await until(() => f.daemon.store.getTask(task.id)?.status === "completed", "did not continue");
  } finally { await f.close(); }
});

test("task-run directories default under MODELBOT_HOME and are kept after the task ends", async () => {
  const home = isolateModelbotHome();
  const cli = fakeCli("mb-runs-home", () => `for await (const chunk of process.stdin) {}
console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
console.log(JSON.stringify({type:'turn.completed'}));`);
  await runCodexTask({ binary: cli.binary, codexHome: cli.home, model: "gpt-6-astra", execution_location: "host" },
    { id: "t", computer_id: "c", goal: "g" },
    { url: "http://127.0.0.1:1/mcp", token: "tok", signal: new AbortController().signal, maxRuntimeSec: 0,
      onMessage() {}, isWaiting: () => false, waitGeneration: () => 0, isTerminal: () => true });
  const dirs = readdirSync(join(home, "task-runs"));
  assert.ok(dirs.some((dir) => dir.startsWith("codex-")));
  assert.ok(existsSync(join(home, "task-runs", dirs[0]!, "runner.log")));
});
