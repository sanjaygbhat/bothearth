import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { createCodexConnection } from "../../../src/daemon/codex-connection.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { until } from "../../helpers/until.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli, isolateModelbotHome } from "../../helpers/fake-cli.ts";

isolateModelbotHome();

function fixture() {
  const cli = fakeCli("mb-login", () => `import {existsSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const home=process.env.CODEX_HOME,p=(name)=>join(home,name);
if(process.env.MODELBOT_VAULT_KEY_HEX||process.env.MODELBOT_TOKEN)process.exit(9);
if(process.argv[2]!=='login')process.exit(8);
if(process.argv[3]==='status') {
 appendFileSync(p('probes'),'x');
 if(existsSync(p('delay'))) {writeFileSync(p('probing'),String(process.pid));await new Promise(r=>setTimeout(r,500));}
 if(existsSync(p('probe-error')))process.exit(7);
 process.exit(existsSync(p('authenticated'))?0:1);
}

appendFileSync(p('logins'),'x');writeFileSync(p('login-pid'),String(process.pid));
console.log('PRIVATE_AUTH_URL_CANARY');console.error('PRIVATE_AUTH_URL_CANARY');
if(existsSync(p('hold')))await new Promise(()=>setInterval(()=>{},1000));
if(existsSync(p('success')))writeFileSync(p('authenticated'),'SYNTHETIC_CREDENTIAL');
if(existsSync(p('delay-final')))writeFileSync(p('delay'),'1');
`, "codex.mjs");
  const connected: string[] = [];
  const options = { codexHome: cli.home, binary: cli.binary, model: () => connected.at(-1) ?? "gpt-6-astra",
    configured: () => connected.length > 0, connected: (model: string) => { connected.push(model); } };
  return { ...cli, connected, connection: createCodexConnection(options) };
}

test("native sign-in is singleton and enables only after CLI status confirms success", async () => {
  const f = fixture();
  try {
    assert.equal((await f.connection.status()).status, "signed_out");
    writeFileSync(f.path("success"), "1");
    await Promise.all([f.connection.signIn(), f.connection.signIn()]);
    await until(() => f.connected.length === 1);
    assert.equal(readFileSync(f.path("logins"), "utf8"), "x");
    assert.equal((await f.connection.status()).status, "connected");
    assert.equal(JSON.stringify(await f.connection.status()).includes("PRIVATE_AUTH_URL_CANARY"), false);
    assert.equal((await f.connection.cancel()).status, "connected");
    assert.ok(existsSync(f.path("authenticated")));
  } finally { await f.connection.close(); }
});

test("exit zero without a login stays signed out; missing and broken CLI are distinct", async () => {
  const f = fixture();
  try {
    await f.connection.signIn(); await until(() => existsSync(f.path("logins")));
    // The login child exits 0 without writing a credential, so the connection is
    // only settled once its follow-up `login status` probe has run and failed.
    await until(async () => (await f.connection.status()).status !== "signing_in", "sign-in never settled");
    assert.equal((await f.connection.status()).status, "signed_out"); assert.equal(f.connected.length, 0);
    writeFileSync(f.path("probe-error"), "1"); assert.equal((await f.connection.status()).status, "error");
    const missing = createCodexConnection({ codexHome: f.home, binary: f.path("absent"), model: () => "example", configured: () => false, connected: () => assert.fail() });
    assert.equal((await missing.status()).status, "missing"); await missing.close();
  } finally { await f.connection.close(); }
});

test("cancel and shutdown during the initial probe cannot launch a login afterward", async () => {
  for (const shutdown of [false, true]) {
    const f = fixture(); writeFileSync(f.path("delay"), "1");
    const signing = f.connection.signIn(); await until(() => existsSync(f.path("probing")));
    await (shutdown ? f.connection.close() : f.connection.cancel()); await signing;
    assert.equal(existsSync(f.path("logins")), false); assert.equal(f.connected.length, 0);
    await f.connection.close();
  }
});

test("cancel during final authentication probe never enables the runner", async () => {
  const f = fixture();
  try {
    writeFileSync(f.path("success"), "1"); writeFileSync(f.path("delay-final"), "1");
    await f.connection.signIn(); await until(() => existsSync(f.path("probing")));
    await f.connection.cancel();
    assert.equal(f.connected.length, 0); assert.ok(existsSync(f.path("authenticated")));
  } finally { await f.connection.close(); }
});

test("cancellation terminates the owned login process without logout", async () => {
  const f = fixture();
  try {
    writeFileSync(f.path("hold"), "1"); await f.connection.signIn();
    await until(() => existsSync(f.path("login-pid")));
    const pid = Number(readFileSync(f.path("login-pid"), "utf8"));
    await f.connection.cancel(); assert.throws(() => process.kill(pid, 0));
    assert.equal(f.connected.length, 0);
  } finally { await f.connection.close(); }
});

test("connection defaults can change without changing existing task models and stale login is reported", async () => {
  const f = fixture(), sqlitePath = f.path("state.sqlite");
  writeFileSync(f.path("authenticated"), "SYNTHETIC_CREDENTIAL");
  const daemon = await startDaemon({ port: 0, sqlitePath, workspaceRoot: f.path("workspace"), bootstrapToken: "synthetic-bootstrap",
    codexLogin: { codexHome: f.home, binary: f.binary } });
  try {
    const { headers } = await bootstrapSession(daemon, "synthetic-bootstrap");
    const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}/api/v1/${path}`, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    assert.equal((await fetch(`${daemon.baseUrl}/api/v1/connection`)).status, 401);
    const initial = await api("connection").then((r) => r.json()) as any;
    assert.equal(initial.status, "signed_in");
    assert.equal(initial.login_mode, "browser");
    const connected = await api("connection/connect", { model: "gpt-5.6-sol" }).then((r) => r.json());
    assert.equal(connected.status, "connected"); assert.equal(JSON.stringify(connected).includes(f.home), false);
    const ready = await api("session").then((r) => r.json()); assert.equal(ready.task_start_available, true); assert.equal(ready.model, "gpt-5.6-sol");
    const stored = new Store(sqlitePath); try { assert.deepEqual({ ...stored.getCodexConnection() }, { home: f.home, model: "gpt-5.6-sol", provider: "codex" }); } finally { stored.close(); }
    const active = daemon.store.insertTask({ computer_id: "test", goal: "Existing task", max_steps: 1 });
    daemon.store.insertStep(active.id, 0, "native_settings", { adapter: "codex", model: "gpt-5.6-sol", execution_mode: "executor" });
    assert.equal((await api("connection/connect", {})).status, 200);
    writeFileSync(f.path("delay"), "1");
    const changing = api("connection/connect", { model: "gpt-6-astra" });
    await until(() => existsSync(f.path("probing")));
    const raced = daemon.store.insertTask({ computer_id: "test", goal: "Started during probe", max_steps: 1 });
    assert.equal((await changing.then((r) => r.json())).status, "connected");
    assert.equal(daemon.store.getCodexConnection()?.model, "gpt-6-astra");
    assert.equal(daemon.store.getTask(active.id)?.model, "gpt-5.6-sol");
    daemon.store.cancelTask(active.id); daemon.store.cancelTask(raced.id);
    writeFileSync(f.path("probe-error"), "1");
    assert.equal((await api("session").then((r) => r.json())).task_start_available, false);
    assert.equal((await api("tasks", { goal: "Must not allocate" })).status, 503); assert.equal(daemon.store.listComputers().length, 0);
  } finally { await daemon.close(); await f.connection.close(); }
});

test("task start retries a one-shot probe failure and agrees with /connection", async () => {
  const cli = fakeCli("start-probe", home => `
import {existsSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const p=(name)=>join(${JSON.stringify(home)},name);
if(process.argv[2]==='login'||process.argv[2]==='auth') {
  if(process.argv[3]==='status') {
    const n=existsSync(p('probes'))?Number(readFileSync(p('probes'),'utf8'))+1:1;
    writeFileSync(p('probes'),String(n));
    if(existsSync(p('fail-once'))) { unlinkSync(p('fail-once')); process.stderr.write('cannot exec: container is not running\\n'); process.exit(1); }
    if(existsSync(p('probe-transport'))) { process.stderr.write('cannot exec: container is not running\\n'); process.exit(1); }
    process.exit(existsSync(p('authenticated'))?0:1);
  }
  process.exit(0);
}
for await (const chunk of process.stdin) {}
`);
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  writeFileSync(cli.path("authenticated"), "SYNTHETIC_CREDENTIAL");
  const daemon = await startDaemon({
    port: 0, sqlitePath: cli.path("state.sqlite"), workspaceRoot: cli.path("workspace"),
    bootstrapToken: "start-probe-boot",
    codexRunner: { execution_location: "host", codexHome: cli.home, binary: cli.binary, model: "gpt-6-astra", runsRoot: cli.path("runs") },
    codexLogin: { codexHome: cli.home, binary: cli.binary },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "start-probe-boot");
    const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, {
      headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    daemon.store.insertComputer({ id: "browser-ready", name: "Ready", capabilities: ["browser"], persistent: true, status: "running" });
    const connected = await api("/api/v1/connection").then((r) => r.json()) as { status: string; computer_id?: string };
    assert.equal(connected.status, "connected");
    assert.equal(connected.computer_id, "browser-ready");
    writeFileSync(cli.path("fail-once"), "1");
    const created = await api("/api/v1/tasks", { goal: "Start after a missed probe", adapter: "codex", computer_id: "browser-ready" });
    assert.equal(created.status, 201, await created.clone().text());
    const after = await api("/api/v1/connection").then((r) => r.json()) as { status: string };
    assert.equal(after.status, "connected");
    writeFileSync(cli.path("probe-transport"), "1");
    const { task } = await created.json() as { task: { id: string } };
    assert.equal((await api(`/api/v1/tasks/${task.id}/cancel`, {})).status, 200);
    const staleStart = await api("/api/v1/tasks", { goal: "Start on stale connected", adapter: "codex", computer_id: "browser-ready" });
    assert.equal(staleStart.status, 201, await staleStart.clone().text());
  } finally {
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
});

test("create-task waits out a signed-out start probe then succeeds", async () => {
  const cli = fakeCli("start-probe-lag", home => `
import {existsSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const p=(name)=>join(${JSON.stringify(home)},name);
if(process.argv[2]==='login'||process.argv[2]==='auth') {
  if(process.argv[3]==='status') {
    const n=existsSync(p('probes'))?Number(readFileSync(p('probes'),'utf8'))+1:1;
    writeFileSync(p('probes'),String(n));
    if(existsSync(p('fail-once'))) { unlinkSync(p('fail-once')); process.exit(1); }
    process.exit(existsSync(p('authenticated'))?0:1);
  }
  process.exit(0);
}
for await (const chunk of process.stdin) {}
`);
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  writeFileSync(cli.path("authenticated"), "SYNTHETIC_CREDENTIAL");
  const daemon = await startDaemon({
    port: 0, sqlitePath: cli.path("state.sqlite"), workspaceRoot: cli.path("workspace"),
    bootstrapToken: "start-probe-lag-boot",
    codexRunner: { execution_location: "host", codexHome: cli.home, binary: cli.binary, model: "gpt-6-astra", runsRoot: cli.path("runs") },
    codexLogin: { codexHome: cli.home, binary: cli.binary },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "start-probe-lag-boot");
    const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, {
      headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    daemon.store.insertComputer({ id: "browser-ready", name: "Ready", capabilities: ["browser"], persistent: true, status: "running" });
    const connected = await api("/api/v1/connection").then((r) => r.json()) as { status: string };
    assert.equal(connected.status, "connected");
    writeFileSync(cli.path("fail-once"), "1");
    const created = await api("/api/v1/tasks", { goal: "Start after a signed-out probe", adapter: "codex", computer_id: "browser-ready" });
    assert.equal(created.status, 201, await created.clone().text());
    const started = await created.json() as { error?: string; status?: string; task?: { id: string } };
    assert.notEqual(started.status, "signed_out");
    assert.equal(started.error, undefined);
    const { task } = started as { task: { id: string } };
    assert.equal((await api(`/api/v1/tasks/${task.id}/cancel`, {})).status, 200);
  } finally {
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
});

test("create-task waits out a signed-out probe after 15s of daemon uptime", async () => {
  const cli = fakeCli("start-probe-lag-uptime", home => `
import {existsSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const p=(name)=>join(${JSON.stringify(home)},name);
if(process.argv[2]==='login'||process.argv[2]==='auth') {
  if(process.argv[3]==='status') {
    const n=existsSync(p('probes'))?Number(readFileSync(p('probes'),'utf8'))+1:1;
    writeFileSync(p('probes'),String(n));
    if(existsSync(p('fail-once'))) { unlinkSync(p('fail-once')); process.exit(1); }
    process.exit(existsSync(p('authenticated'))?0:1);
  }
  process.exit(0);
}
for await (const chunk of process.stdin) {}
`);
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  writeFileSync(cli.path("authenticated"), "SYNTHETIC_CREDENTIAL");
  const daemon = await startDaemon({
    port: 0, sqlitePath: cli.path("state.sqlite"), workspaceRoot: cli.path("workspace"),
    bootstrapToken: "start-probe-lag-uptime-boot",
    codexRunner: { execution_location: "host", codexHome: cli.home, binary: cli.binary, model: "gpt-6-astra", runsRoot: cli.path("runs") },
    codexLogin: { codexHome: cli.home, binary: cli.binary },
  });
  const realNow = Date.now;
  try {
    const { headers } = await bootstrapSession(daemon, "start-probe-lag-uptime-boot");
    const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, {
      headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    daemon.store.insertComputer({ id: "browser-ready", name: "Ready", capabilities: ["browser"], persistent: true, status: "running" });
    const connected = await api("/api/v1/connection").then((r) => r.json()) as { status: string };
    assert.equal(connected.status, "connected");
    Date.now = () => realNow() + 16_000;
    writeFileSync(cli.path("fail-once"), "1");
    const created = await api("/api/v1/tasks", { goal: "Start after idle probe lag", adapter: "codex", computer_id: "browser-ready" });
    assert.equal(created.status, 201, await created.clone().text());
    const started = await created.json() as { error?: string; status?: string; task?: { id: string } };
    assert.notEqual(started.status, "signed_out");
    assert.notEqual(started.error, "E_PROVIDER_UNAVAILABLE");
    assert.equal(started.error, undefined);
    const { task } = started as { task: { id: string } };
    assert.equal((await api(`/api/v1/tasks/${task.id}/cancel`, {})).status, 200);
  } finally {
    Date.now = realNow;
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
});

test("exhausted start-probe wait is starting while unsettled and signed_out once settled", async () => {
  async function createTask(kind: "settled" | "unsettled") {
    const cli = fakeCli(`start-probe-exhausted-${kind}`, home => `
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const p=(name)=>join(${JSON.stringify(home)},name);
if(process.argv[2]==='login'||process.argv[2]==='auth') {
  if(process.argv[3]==='status') {
    const n=existsSync(p('probes'))?Number(readFileSync(p('probes'),'utf8'))+1:1;
    writeFileSync(p('probes'),String(n));
    if(existsSync(p('hold'))) {
      writeFileSync(p('probing'),String(process.pid));
      await new Promise(()=>setInterval(()=>{},1000));
    }
    process.exit(1);
  }
  process.exit(0);
}
for await (const chunk of process.stdin) {}
`);
    const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
    process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
    const daemon = await startDaemon({
      port: 0, sqlitePath: cli.path("state.sqlite"), workspaceRoot: cli.path("workspace"),
      bootstrapToken: `start-probe-exhausted-${kind}-boot`,
      codexRunner: { execution_location: "host", codexHome: cli.home, binary: cli.binary, model: "gpt-6-astra", runsRoot: cli.path("runs") },
      codexLogin: { codexHome: cli.home, binary: cli.binary },
    });
    const realNow = Date.now;
    let extra = 0;
    Date.now = () => realNow() + extra;
    const began = realNow();
    try {
      const { headers } = await bootstrapSession(daemon, `start-probe-exhausted-${kind}-boot`);
      const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, {
        headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      });
      daemon.store.insertComputer({ id: "browser-ready", name: "Ready", capabilities: ["browser"], persistent: true, status: "running" });
      const probesBefore = existsSync(cli.path("probes")) ? Number(readFileSync(cli.path("probes"), "utf8")) : 0;
      if (kind === "unsettled") writeFileSync(cli.path("hold"), "1");
      const created = api("/api/v1/tasks", { goal: `Exhausted ${kind} probe`, adapter: "codex", computer_id: "browser-ready" });
      await until(() => {
        if (kind === "unsettled") return existsSync(cli.path("probing"));
        return existsSync(cli.path("probes")) && Number(readFileSync(cli.path("probes"), "utf8")) > probesBefore;
      });
      extra = 16_000;
      const started = await created;
      const startedBody = await started.json() as { error?: string; status?: string };
      return { started, startedBody, ms: realNow() - began };
    } finally {
      Date.now = realNow;
      await daemon.close();
      if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
      else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
    }
  }

  const settled = await createTask("settled");
  assert.ok(settled.ms < 3_000, `settled wait slept ${settled.ms}ms`);
  assert.equal(settled.started.status, 503);
  assert.equal(settled.startedBody.error, "E_PROVIDER_UNAVAILABLE");
  assert.equal(settled.startedBody.status, "signed_out");
  assert.notEqual(settled.startedBody.error, "E_RUNTIME_STARTING");

  const unsettled = await createTask("unsettled");
  assert.ok(unsettled.ms < 3_000, `unsettled wait slept ${unsettled.ms}ms`);
  assert.equal(unsettled.started.status, 503);
  assert.equal(unsettled.startedBody.error, "E_RUNTIME_STARTING");
  assert.equal(unsettled.startedBody.status, "starting");
  assert.notEqual(unsettled.startedBody.status, "signed_out");
});

test("a transport-only probe does not start a task as signed out", async () => {
  const cli = fakeCli("start-probe-transport", () => `
process.stderr.write('cannot exec: container is not running\\n');
process.exit(1);
`);
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({
    port: 0, sqlitePath: cli.path("state.sqlite"), workspaceRoot: cli.path("workspace"),
    bootstrapToken: "start-probe-transport-boot",
    codexRunner: { execution_location: "host", codexHome: cli.home, binary: cli.binary, model: "gpt-6-astra", runsRoot: cli.path("runs") },
    codexLogin: { codexHome: cli.home, binary: cli.binary },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "start-probe-transport-boot");
    const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, {
      headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    daemon.store.insertComputer({ id: "browser-ready", name: "Ready", capabilities: ["browser"], persistent: true, status: "running" });
    const connection = await api("/api/v1/connection");
    assert.equal(connection.status, 200);
    const connectionBody = await connection.json() as { status: string };
    assert.notEqual(connectionBody.status, "signed_out");
    const started = await api("/api/v1/tasks", { goal: "Must not look signed out", adapter: "codex", computer_id: "browser-ready" });
    const startedBody = await started.json() as { error?: string; status?: string };
    assert.equal(started.status, 503);
    assert.equal(startedBody.error, "E_PROVIDER_UNAVAILABLE");
    assert.notEqual(startedBody.status, "signed_out");
    assert.equal(startedBody.status, connectionBody.status);
    assert.equal(startedBody.message, "The bot’s computer is not running");
  } finally {
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
});


test("a 503 while signing in logs no device challenge", async () => {
  const prompt = "1. Open this URL\nhttps://auth.openai.com/codex/device\n2. Enter this one-time code (expires soon)\nABCD-12345\n";
  const cli = fakeCli("start-probe-signin", () => `import {writeFileSync} from 'node:fs';
if(process.argv[3]==='status')process.exit(1);
if(process.argv[3]!=='--device-auth')process.exit(9);
writeFileSync(process.env.CODEX_HOME+'/pid',String(process.pid));
console.log(${JSON.stringify(prompt)});
setInterval(()=>{},1000);
`);
  const previous = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const lines: string[] = [];
  const log = mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const daemon = await startDaemon({
    port: 0, sqlitePath: cli.path("state.sqlite"), workspaceRoot: cli.path("workspace"),
    bootstrapToken: "start-probe-signin-boot",
    codexLogin: { codexHome: cli.home, binary: cli.binary, loginMode: "device", timeoutMs: 5000 },
  });
  try {
    const { headers } = await bootstrapSession(daemon, "start-probe-signin-boot");
    const api = (path: string, body?: unknown) => fetch(`${daemon.baseUrl}${path}`, {
      headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    daemon.store.insertComputer({ id: "browser-ready", name: "Ready", capabilities: ["browser"], persistent: true, status: "running" });
    assert.equal((await api("/api/v1/connection/sign-in", {})).status, 200);
    let connection = await api("/api/v1/connection").then((r) => r.json()) as { status: string; device_auth?: { user_code?: string; verification_uri?: string } };
    for (let i = 0; i < 100 && !connection.device_auth; i++) {
      await new Promise((r) => setTimeout(r, 10));
      connection = await api("/api/v1/connection").then((r) => r.json()) as typeof connection;
    }
    assert.equal(connection.status, "signing_in");
    assert.equal(connection.device_auth?.user_code, "ABCD-12345");
    const started = await api("/api/v1/tasks", { goal: "Must not leak the code", adapter: "codex", computer_id: "browser-ready" });
    assert.equal(started.status, 503);
    const startedBody = await started.json() as { error?: string; status?: string };
    assert.equal(startedBody.error, "E_PROVIDER_UNAVAILABLE");
    assert.equal(startedBody.status, "signing_in");
    const unavailable = lines.flatMap((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        return row.msg === "provider unavailable" ? [row] : [];
      } catch {
        return [];
      }
    });
    assert.equal(unavailable.length, 1, JSON.stringify(unavailable));
    const row = unavailable[0]!;
    assert.equal(row.path, "/api/v1/tasks");
    assert.equal(row.computer, "browser-ready");
    assert.equal(row.status, "signing_in");
    assert.equal(row.cause, "signing_in");
    assert.equal(typeof row.message, "string");
    const allowed = new Set(["level", "msg", "ts", "path", "computer", "status", "message", "cause"]);
    for (const key of Object.keys(row)) {
      assert.ok(allowed.has(key), `unexpected log key ${key}`);
    }
    const serialized = JSON.stringify(row);
    assert.equal("device_auth" in row, false);
    assert.equal("probe" in row, false);
    assert.equal("native_terminal" in row, false);
    assert.doesNotMatch(serialized, /device_auth|user_code|verification_uri|ABCD-12345|auth\.openai\.com|native_terminal/);
  } finally {
    log.mock.restore();
    await daemon.close();
    if (previous === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
    else process.env.MODELBOT_TEST_FAKE_COMPUTER = previous;
  }
});

test("an older status probe cannot hide a newly started login", async () => {
  const f = fixture();
  try {
    writeFileSync(f.path("delay"), "1");
    const status = f.connection.status();
    await until(() => existsSync(f.path("probing")));
    unlinkSync(f.path("delay"));
    writeFileSync(f.path("hold"), "1");
    await f.connection.signIn();
    assert.equal((await status).status, "signing_in");
  } finally { await f.connection.close(); }
});


test("guest native sign-in relays only to its initiating operator and accepts Enter without saving replies", async () => {
  const cli = fakeCli("guest-login", home => `import {existsSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const authenticated=${JSON.stringify(home + "/authenticated")};
if(process.argv[3]==='status')process.exit(existsSync(authenticated)?0:1);
console.log('Official CLI: press Enter, then enter the sign-in code.');
let entered=false;
createInterface({input:process.stdin}).on('line',line=>{
 if(line===''){entered=true; console.log('Ready for the code.');return;}
 if(entered&&line==='SYNTHETIC_PRIVATE_REPLY'){writeFileSync(authenticated,'yes');process.exit(0);}
});`);
  let connected = false;
  const connection = createCodexConnection({ provider: "claude", codexHome: cli.home, loginMode: "terminal",
    model: () => "claude-opus-5", configured: () => connected, connected: () => { connected = true; },
    authorized: owner => owner === "operator-a" || owner === "operator-b",
    async spawn(args) {
      const child = spawn(cli.binary, args, { stdio: "pipe", detached: true });
      return { child, async stop() { if(child.pid)try{process.kill(-child.pid,"SIGKILL");}catch{} } };
    },
  });
  try {
    assert.equal((await connection.signIn(undefined, "subscription", "operator-a")).status, "signing_in");
    await until(async () => Boolean((await connection.status("operator-a")).native_terminal?.output.includes("Official CLI")));
    assert.equal((await connection.status("operator-b")).native_terminal, undefined);
    assert.equal(connection.input("SYNTHETIC_PRIVATE_REPLY", "operator-b"), false);
    assert.equal(connection.input("bad\nline", "operator-a"), false);
    assert.equal(connection.input("", "operator-a"), true);
    await until(async () => Boolean((await connection.status("operator-a")).native_terminal?.output.includes("Ready for the code")));
    assert.equal(connection.input("SYNTHETIC_PRIVATE_REPLY", "operator-a"), true);
    await until(() => connected);
    const status = await connection.status("operator-a");
    assert.equal(status.status, "connected");
    assert.equal(status.native_terminal, undefined);
    assert.equal(JSON.stringify(status).includes("SYNTHETIC_PRIVATE_REPLY"), false);
    assert.equal(connection.input("later", "operator-a"), false);
  } finally { await connection.close(); }
});


test("guest cleanup failure stays visible without an unhandled rejection and cancellation can retry", async () => {
  const cli = fakeCli("mb-login-cleanup", () => `if(process.argv[3]==='status')process.exit(1);setInterval(()=>{},1000);`);
  let stops = 0;
  const connection = createCodexConnection({ codexHome: "/home/agent/.codex", timeoutMs: 40,
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail(),
    spawn: async (args) => {
      const child = spawn(cli.binary, args, { stdio: "pipe", detached: true });
      return { child, async stop() {
        if (++stops === 1) throw new Error("Synthetic guest transport failure");
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      } };
    },
  });
  try {
    await connection.signIn(undefined, "subscription", "owner");
    await until(async () => (await connection.status("owner")).message.includes("Could not confirm"));
    assert.equal((await connection.status("owner")).status, "signing_in");
    assert.equal((await connection.cancel()).status, "signed_out");
    assert.ok(stops >= 2);
  } finally { await connection.close(); }
});

test("a failed status-probe cleanup cannot leave its concurrent native sign-in running", async () => {
  const children: ReturnType<typeof spawn>[] = [], stopped: string[] = [];
  let probes = 0, failProbe = true, loginReady = false;
  const connection = createCodexConnection({ codexHome: "/synthetic-guest-home",
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail("cancelled sign-in connected"),
    spawn: async args => {
      const kind = args[1] === "status" ? `probe-${++probes}` : "login";
      const child = spawn(process.execPath, ["-e", kind === "probe-1" ? "setInterval(()=>{},1000)"
        : kind === "login" ? "console.log('ready');setInterval(()=>{},1000)" : "process.exit(1)"], { detached: true, stdio: "pipe" });
      children.push(child);
      if (kind === "login") child.stdout!.once("data", () => { loginReady = true; });
      return { child, async stop() {
        stopped.push(kind);
        if (kind === "probe-1" && failProbe) throw new Error("Synthetic probe cleanup failure");
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      } };
    },
  });
  const pendingStatus = connection.status();
  try {
    await until(() => probes === 1);
    await connection.signIn(undefined, "subscription", "operator-a");
    await until(() => loginReady);
    await assert.rejects(connection.cancel(false), /Synthetic probe cleanup failure/);
    assert.ok(stopped.includes("login"), "cancellation must stop the login even when an older probe cannot stop");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probes, 2, "a cancelled login must not launch another authentication probe");
    failProbe = false;
    assert.equal((await connection.cancel(false)).status, "signed_out");
  } finally {
    failProbe = false;
    for (const child of children) if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Test-owned processes only. */ }
    await connection.close();
    await pendingStatus;
  }
});

test("sign-in scratch lives under MODELBOT_HOME and is removed when the attempt finishes", async () => {
  const home = isolateModelbotHome();
  const f = fixture();
  try {
    writeFileSync(f.path("success"), "1");
    await f.connection.signIn();
    await until(() => f.connected.length === 1);
    await until(async () => (await f.connection.status()).status === "connected");
    const root = join(home, "sign-in");
    assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0);
  } finally { await f.connection.close(); }
});

function spawnScript(source: string) {
  return async () => {
    const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    return { child, async stop() { if (child.pid) try { process.kill(child.pid, "SIGKILL"); } catch { /* Test-owned. */ } } };
  };
}

test("a blocked status probe during private control is not signed out", async () => {
  const connection = createCodexConnection({
    codexHome: "/synthetic-guest-home", loginMode: "device",
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail(),
    spawn: spawnScript("process.stderr.write('Error: Native execution is paused for private control.\\n'); process.exit(1)"),
  });
  try {
    const status = await connection.status();
    assert.notEqual(status.status, "signed_out");
    assert.equal(status.status, "unknown");
    assert.match(status.message, /check while you have control/i);
    assert.notEqual(status.message, "");
  } finally { await connection.close(); }
});

test("a status probe that exits 1 without a login is signed out, never with an empty message", async () => {
  const connection = createCodexConnection({
    codexHome: "/synthetic-guest-home", loginMode: "device",
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail(),
    spawn: spawnScript("process.exit(1)"),
  });
  try {
    const status = await connection.status();
    assert.equal(status.status, "signed_out");
    assert.ok(status.message.length > 0);
  } finally { await connection.close(); }
});

test("a status probe refused by private control is rechecked after control returns", async () => {
  let held = true;
  const connection = createCodexConnection({
    codexHome: "/synthetic-guest-home",
    model: () => "gpt-6-astra", configured: () => true, connected: () => {},
    spawn: async () => spawnScript(held
      ? "process.stderr.write('Native execution is paused for private control.\\n'); process.exit(75)"
      : "process.exit(0)")(),
  });
  try {
    const blocked = await connection.status();
    assert.equal(blocked.status, "unknown");
    assert.notEqual(blocked.status, "signed_out");
    held = false;
    const ready = await connection.status();
    assert.equal(ready.status, "connected");
    assert.equal(ready.message, "");
    assert.doesNotMatch(ready.message, /could not be checked|have control/i);
  } finally { await connection.close(); }
});

test("a status probe that cannot start is not signed out", async () => {
  const connection = createCodexConnection({
    codexHome: "/synthetic-guest-home",
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail(),
    spawn: async () => { throw new Error("Native execution is paused for private control."); },
  });
  try {
    const status = await connection.status();
    assert.notEqual(status.status, "signed_out");
    assert.equal(status.status, "unknown");
    assert.ok(status.message.length > 0);
  } finally { await connection.close(); }
});

test("a status probe that exits 1 with a transport error is not signed out", async () => {
  const connection = createCodexConnection({
    codexHome: "/synthetic-guest-home",
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail(),
    spawn: spawnScript("process.stderr.write('cannot exec: container is not running\\n'); process.exit(1)"),
  });
  try {
    const status = await connection.status();
    assert.notEqual(status.status, "signed_out");
    assert.equal(status.status, "error");
    assert.equal(status.message, "The bot’s computer is not running");
  } finally { await connection.close(); }
});

test("a status probe that fails once then succeeds is connected", async () => {
  let probes = 0;
  const connection = createCodexConnection({
    codexHome: "/synthetic-guest-home",
    model: () => "gpt-6-astra", configured: () => true, connected: () => {},
    spawn: async () => spawnScript(++probes === 1
      ? "process.stderr.write('cannot exec: container is not running\\n'); process.exit(1)"
      : "process.exit(0)")(),
  });
  try {
    const status = await connection.status();
    assert.equal(status.status, "connected");
    assert.equal(probes, 2);
    assert.equal(status.stale, undefined);
  } finally { await connection.close(); }
});

test("a transport probe after a successful check returns the last known status stale", async () => {
  let fail = false;
  const connection = createCodexConnection({
    codexHome: "/synthetic-guest-home",
    model: () => "gpt-6-astra", configured: () => true, connected: () => {},
    spawn: async () => spawnScript(fail
      ? "process.stderr.write('cannot exec: container is not running\\n'); process.exit(1)"
      : "process.exit(0)")(),
  });
  try {
    assert.equal((await connection.status()).status, "connected");
    fail = true;
    const stale = await connection.status();
    assert.equal(stale.status, "connected");
    assert.equal(stale.stale, true);
    assert.notEqual(stale.status, "signed_out");
  } finally { await connection.close(); }
});

for (const outcome of ["cancelled", "failed", "closed"] as const) test(`sign-in scratch is removed when sign-in is ${outcome}`, async () => {
  const home = isolateModelbotHome();
  const f = fixture();
  const leftover = () => existsSync(join(home, "sign-in")) ? readdirSync(join(home, "sign-in")).length : 0;
  try {
    if (outcome === "failed") {
      await f.connection.signIn();
      await until(() => existsSync(f.path("logins")));
      await until(async () => (await f.connection.status()).status !== "signing_in");
    } else {
      writeFileSync(f.path("hold"), "1");
      await f.connection.signIn();
      await until(() => existsSync(f.path("login-pid")));
      assert.ok(readdirSync(join(home, "sign-in")).some((name) => name.startsWith("codex-")));
      if (outcome === "cancelled") await f.connection.cancel();
      else await f.connection.close();
    }
    assert.equal(leftover(), 0);
  } finally { await f.connection.close(); }
});
