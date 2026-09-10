import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { test } from "node:test";
import { createCodexConnection } from "../../../src/daemon/codex-connection.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { until } from "../../helpers/until.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";

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
