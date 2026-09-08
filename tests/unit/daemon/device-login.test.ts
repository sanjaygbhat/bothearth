import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../../../src/daemon/server.ts";
import { deviceId } from "../../../src/daemon/auth.ts";
import { createCodexConnection, parseDeviceChallenge } from "../../../src/daemon/codex-connection.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";

const prompt = "1. Open this URL\nhttps://auth.openai.com/codex/device\n2. Enter this one-time code (expires soon)\nABCD-12345\n";
test("device prompt parsing exposes only the official verification URL and bounded code", () => {
  assert.deepEqual(parseDeviceChallenge(prompt), { verification_uri: "https://auth.openai.com/codex/device", user_code: "ABCD-12345" });
  assert.ok(parseDeviceChallenge(prompt.replace("ABCD", "\u001b[32mABCD\u001b[0m")));
  assert.equal(parseDeviceChallenge(prompt.replace("auth.openai.com", "attacker.example")), undefined);
  assert.equal(parseDeviceChallenge(prompt.replace("ABCD-12345", "PRIVATE_TOKEN_OR_URL")), undefined);
  assert.equal(parseDeviceChallenge(prompt + "x".repeat(16384)), undefined);
});

test("official device login is owner-only, has a fixed deadline and cancels its owned process", async () => {
  const { home, binary } = fakeCli("mb-device-login", () => `import {writeFileSync} from 'node:fs';
if(process.argv[3]==='status')process.exit(1);
if(process.argv[3]!=='--device-auth')process.exit(9);
writeFileSync(process.env.CODEX_HOME+'/pid',String(process.pid));
console.log(${JSON.stringify(prompt)});
setInterval(()=>console.log('PRIVATE_AUTH_OUTPUT_CANARY'),40);
`);
  const connection = createCodexConnection({ codexHome: home, binary, loginMode: "device", timeoutMs: 3000,
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail("cancel must not connect") });
  try {
    await connection.signIn(undefined, "subscription", "owner-a");
    let state = await connection.status("owner-a");
    for (let i = 0; i < 100 && !state.device_auth; i++) { await new Promise(r => setTimeout(r, 10)); state = await connection.status("owner-a"); }
    assert.equal(state.device_auth?.user_code, "ABCD-12345");
    const expiry = state.device_auth!.expires_at;
    await new Promise(r => setTimeout(r, 120));
    assert.equal((await connection.status("owner-a")).device_auth?.expires_at, expiry);
    assert.equal((await connection.status("owner-b")).device_auth, undefined);
    assert.equal((await connection.status()).device_auth, undefined);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_AUTH_OUTPUT_CANARY/);
    assert.ok(existsSync(join(home, "pid")));
    const pid = Number(readFileSync(join(home, "pid"), "utf8"));
    await connection.cancel(false);
    assert.equal(connection.loginSession(), undefined);
    assert.equal((await connection.status("owner-a")).device_auth, undefined);
    assert.throws(() => process.kill(pid, 0));
  } finally { await connection.close(); rmSync(home, { recursive: true, force: true }); }
});

test("remote Claude sign-in gives native terminal instructions without starting hidden authentication", async () => {
  const { home, binary } = fakeCli("mb-terminal-login", (root) => `import {writeFileSync} from 'node:fs';
if(process.argv[3]==='status')process.exit(1);
writeFileSync(${JSON.stringify(join(root, "unexpected-login"))},'started');
`);
  const connection = createCodexConnection({ codexHome: "", provider: "claude", binary, loginMode: "terminal",
    model: () => "", configured: () => false, connected: () => assert.fail() });
  try {
    const state = await connection.signIn();
    assert.equal(state.status, "signed_out"); assert.equal(state.login_mode, "terminal");
    assert.match(state.message, /on this server/); assert.equal(existsSync(join(home, "unexpected-login")), false);
  } finally { await connection.close(); rmSync(home, { recursive: true, force: true }); }
});

test("revocation during the initial login probe cannot launch a device flow", async () => {
  const { home, binary } = fakeCli("mb-revoked-login", () => `import {writeFileSync} from 'node:fs';
if(process.argv[3]==='status'){writeFileSync(process.env.CODEX_HOME+'/probe','1');await new Promise(r=>setTimeout(r,150));process.exit(1);}
writeFileSync(process.env.CODEX_HOME+'/unexpected-login','1');
`);
  let valid = true;
  const connection = createCodexConnection({ codexHome: home, binary, loginMode: "device", authorized: () => valid,
    model: () => "gpt-6-astra", configured: () => false, connected: () => assert.fail() });
  try {
    const pending = connection.signIn(undefined, "subscription", "owner-a");
    for (let i=0; i<100 && !existsSync(join(home,"probe")); i++) await new Promise(r=>setTimeout(r,10));
    valid = false; await pending;
    assert.equal(existsSync(join(home,"unexpected-login")), false);
  } finally { await connection.close(); rmSync(home, {recursive:true,force:true}); }
});


test("HTTP device challenges belong to one session and its revocation or expiry cancels login", async () => {
  const { home, binary } = fakeCli("mb-http-device", () => `import {writeFileSync} from 'node:fs';
if(process.argv[3]==='status')process.exit(1);
writeFileSync(process.env.CODEX_HOME+'/pid',String(process.pid));
console.log(${JSON.stringify(prompt)});setInterval(()=>{},1000);
`);
  const daemon = await startDaemon({ port:0, workspaceRoot:home, mcpToken:"synthetic", bootstrapToken:"synthetic-bootstrap",
    codexLogin:{ codexHome:home,binary,loginMode:"device",timeoutMs:5000 } });
  const other = daemon.store.createSession(60000,daemon.baseUrl);
  const api = async (session: typeof other,path:string,body?:unknown,method=body===undefined?"GET":"POST") => {
    const response = await fetch(daemon.baseUrl+path,{method,headers:{origin:daemon.baseUrl,cookie:`modelbot_session=${session.id}`,"x-csrf-token":session.csrf,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,cache:response.headers.get("cache-control"),body:await response.json() as any};
  };
  try {
    for (const expiry of [false,true]) {
      for(let i=0;i<100&&(await api(other,"/api/v1/connection")).body.status==="signing_in";i++) await new Promise(r=>setTimeout(r,10));
      const owner = daemon.store.createSession(60000,daemon.baseUrl);
      const started=await api(owner,"/api/v1/connection/sign-in",{});
      assert.equal(started.status,200);assert.equal(started.cache,"no-store");
      let state = await api(owner,"/api/v1/connection");
      for(let i=0;i<100&&!state.body.device_auth;i++){await new Promise(r=>setTimeout(r,10));state=await api(owner,"/api/v1/connection");}
      assert.equal(state.body.device_auth?.user_code,"ABCD-12345",JSON.stringify({expiry,state}));
      assert.equal(state.cache,"no-store");
      assert.equal((await api(other,"/api/v1/connection")).body.device_auth,undefined);
      const pid=Number(readFileSync(join(home,"pid"),"utf8"));
      if(expiry) daemon.store.db.prepare("UPDATE sessions SET expires_at='2000-01-01' WHERE id=?").run(owner.id);
      else assert.equal((await api(other,`/api/v1/session/devices/${deviceId(owner.id)}`,{},"DELETE")).status,200);
      for(let i=0;i<200;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,10));}
      assert.throws(()=>process.kill(pid,0));
      assert.equal((await api(owner,"/api/v1/connection")).status,401);
      assert.equal((await api(other,"/api/v1/connection")).body.device_auth,undefined);
    }
  } finally { await daemon.close();rmSync(home,{recursive:true,force:true}); }
});

test("expired owner cannot commit a connection after native authentication completes", async () => {
  const { home, binary } = fakeCli("mb-device-final", () => `import {existsSync,writeFileSync} from 'node:fs';
const p=(name)=>process.env.CODEX_HOME+'/'+name;
if(process.argv[3]==='status'){
 if(existsSync(p('authenticated'))){writeFileSync(p('final-probe'),'1');await new Promise(r=>setTimeout(r,150));process.exit(0);}
 process.exit(1);
}
writeFileSync(p('authenticated'),'synthetic');
`);
  let valid=true,commits=0;
  const connection=createCodexConnection({codexHome:home,binary,loginMode:"device",authorized:()=>valid,
    model:()=>"gpt-6-astra",configured:()=>false,connected:()=>{commits++;}});
  try {
    await connection.signIn(undefined,"subscription","owner");
    for(let i=0;i<100&&!existsSync(join(home,"final-probe"));i++)await new Promise(r=>setTimeout(r,10));
    assert.ok(existsSync(join(home,"final-probe")));valid=false;
    for(let i=0;i<100&&connection.loginSession();i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(commits,0);assert.ok(existsSync(join(home,"authenticated")),"expiry never logs out the native provider");
    assert.equal((await connection.connect("gpt-5.6-sol","owner")).status,"signed_out");assert.equal(commits,0);
  } finally {await connection.close();rmSync(home,{recursive:true,force:true});}
});


test("login cancellation kills same-group descendants after the CLI parent exits", async () => {
  for (const provider of ["codex","claude"] as const) {
    const { home, binary } = fakeCli("mb-login-descendant", (root) => `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
if(process.argv[3]==='status')process.exit(1);
const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",${JSON.stringify(join(root,"descendant"))}],{stdio:'ignore'});
setInterval(()=>{},1000);
`);
    const connection=createCodexConnection({provider,codexHome:home,binary,model:()=>"",configured:()=>false,connected:()=>assert.fail()});
    let descendant: number|undefined;
    try {
      await connection.signIn();
      for(let i=0;i<100&&!existsSync(join(home,"descendant"));i++)await new Promise(r=>setTimeout(r,10));
      assert.ok(existsSync(join(home,"descendant")));descendant=Number(readFileSync(join(home,"descendant"),"utf8"));
      await connection.cancel(false);
      for(let i=0;i<50;i++){try{process.kill(descendant,0);}catch{break;}await new Promise(r=>setTimeout(r,10));}
      assert.throws(()=>process.kill(descendant!,0),provider+" login left a descendant alive after cancellation");
    } finally {await connection.close();if(descendant)try{process.kill(descendant,"SIGKILL");}catch{}rmSync(home,{recursive:true,force:true});}
  }
});
