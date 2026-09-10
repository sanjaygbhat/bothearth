import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { claudeEnvironment, claudeTaskArgs } from "../../../src/daemon/claude-code.ts";
import { createCodexConnection } from "../../../src/daemon/codex-connection.ts";
import { until } from "../../helpers/until.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli } from "../../helpers/fake-cli.ts";

test("default native login keeps its keychain identity and model tools stay scoped", () => {
  const old = process.env.CLAUDE_CONFIG_DIR; delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(claudeEnvironment("").CLAUDE_CONFIG_DIR, undefined);
    assert.equal(claudeEnvironment("").PATH?.split(delimiter)[0], dirname(process.execPath));
    assert.equal(claudeEnvironment("/custom").CLAUDE_CONFIG_DIR, "/custom");
    process.env.CLAUDE_CONFIG_DIR = "/native-choice";
    assert.equal(claudeEnvironment("").CLAUDE_CONFIG_DIR, "/native-choice");
    const args = claudeTaskArgs("sonnet", "http://localhost:7777/mcp/tasks/synthetic");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");
    assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]!).disableAllHooks, true);
    assert.equal(claudeTaskArgs("", "http://localhost:7777/mcp/tasks/synthetic").includes("--model"), false);
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; }
});

test("Claude native Console sign-in connects only after status success and keeps native default model", async () => {
  const { binary } = fakeCli("mb-claude-login", (root) => `import{existsSync,writeFileSync}from'node:fs';import assert from'node:assert/strict';
const state=${JSON.stringify(join(root,"signed-in"))};const a=process.argv.slice(2);assert.equal(a[0],'auth');
if(a[1]==='status')process.exit(existsSync(state)?0:1);
assert.deepEqual(a,['auth','login','--console']);writeFileSync(state,'yes');
`, "native.mjs");
  let connected = false;
  const connection = createCodexConnection({provider:"claude",codexHome:"",binary,model:()=>"",configured:()=>connected,connected(model){assert.equal(model,"");connected=true;}});
  try {
    assert.equal((await connection.status()).status,"signed_out");
    assert.equal((await connection.signIn("","console")).status,"signing_in");
    await until(()=>connected);
    assert.equal((await connection.status()).status,"connected");
  } finally { await connection.close(); }
});

test("native Claude protocol uses scoped MCP, canonical completion, failure and cancellation", async () => {
  const { home: root, binary } = fakeCli("mb-claude", () => `import assert from 'node:assert/strict';import{writeFileSync}from'node:fs';
import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))};
const a=process.argv.slice(2);if(a[0]==='auth'&&a[1]==='status')process.exit(0);
const config=JSON.parse(a[a.indexOf('--mcp-config')+1]),url=config.mcpServers.modelbot.url,token=process.env.MODELBOT_SCOPED_TOKEN;
assert.ok(a.includes('--print'));assert.ok(a.includes('--strict-mcp-config'));assert.equal(a[a.indexOf('--tools')+1],'');assert.ok(!a.includes('--bare'));assert.ok(!a.includes('--dangerously-skip-permissions'));
assert.equal(a.join(' ').includes(token),false);assert.equal(process.env.MODELBOT_VAULT_KEY_HEX,undefined);
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const emit=x=>console.log(JSON.stringify(x));emit({type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111'});
const c=new Client({name:'claude-fixture',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:'Bearer '+token}}}));
writeFileSync('scope.json',JSON.stringify({url,token,pid:process.pid}),{mode:0o600});
assert.equal((await c.callTool({name:'takeover_status',arguments:{computer_id:'wrong'}})).isError,true);
assert.equal((await c.callTool({name:'shell_exec',arguments:{command:'forbidden'}})).isError,true);
if(prompt.includes('hold-fixture')){process.on('SIGTERM',()=>{emit({type:'assistant',message:{content:[{type:'text',text:'late forbidden'}]}});process.exit(0)});setInterval(()=>{},1000)}
else{if(!prompt.includes('no-done-fixture'))await c.callTool({name:'done',arguments:{status:'success',summary:'Synthetic Claude result'}});await c.close();emit({type:'result',subtype:'success',is_error:false});}
`, "claude-fixture.mjs");
  const runsRoot = join(root, "runs");
  const old = process.env.MODELBOT_TEST_FAKE_COMPUTER; process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({ port: 0, mcpToken: "fixture-general", bootstrapToken: "fixture-boot", workspaceRoot: join(root,"workspace"),
    claudeLogin: { codexHome: root, binary },
    codexRunner: { execution_location: "host", provider: "claude", codexHome: root, binary, model: "claude-opus-5", runsRoot } });
  try {
    const { headers } = await bootstrapSession(daemon, "fixture-boot");
    assert.equal(((await fetch(daemon.baseUrl + "/api/v1/session", { headers }).then((r) => r.json())) as any).execution_mode, "claude");
    const api = (path: string, body?: unknown) => fetch(daemon.baseUrl + "/api/v1" + path, { headers, ...(body ? { method:"POST", body:JSON.stringify(body) } : {}) });
    daemon.store.insertComputer({id:"selected",name:"Selected",capabilities:["browser"],persistent:false,status:"running"});
    for (const [goal, expected] of [["complete-fixture","completed"],["no-done-fixture","cancelled"],["hold-fixture","cancelled"]]) {
      const response = await api("/tasks", {computer_id:"selected",goal,max_steps:8,capabilities:["browser"],adapter:"claude",model:"claude-opus-5"});
      assert.equal(response.status,201); const task = (await response.json() as any).task; assert.equal(task.adapter,"claude");
      if (goal === "no-done-fixture") {
        await until(async () => (await api(`/tasks/${task.id}`).then(r => r.json()) as any).task.awaiting_message === true);
        assert.equal(daemon.store.getTask(task.id)?.status, "running");
      }
      if (expected === "cancelled") {
        await until(()=>readdirSync(runsRoot).some(d=>{try{return JSON.parse(readFileSync(join(runsRoot,d,"scope.json"),"utf8")).url.endsWith(task.id)}catch{return false}}));
        if (goal === "hold-fixture") assert.equal((await api("/connection/connect", {provider:"codex",model:"gpt-6-astra"})).status,200);
        assert.equal(daemon.store.getTask(task.id)?.adapter,"claude", "changing defaults cannot replace an active provider");
        assert.equal((await api(`/tasks/${task.id}/cancel`, {})).status,200);
      }
      await until(()=>daemon.store.getTask(task.id)?.status===expected);
      await until(()=>readdirSync(runsRoot).every(d=>{try{const s=JSON.parse(readFileSync(join(runsRoot,d,"scope.json"),"utf8"));process.kill(s.pid,0);return false}catch{return true}}));
      const detail = await api(`/tasks/${task.id}`).then(r=>r.json()) as any;
      assert.equal(JSON.stringify(detail).includes("late forbidden"),false);
    }
    for(const d of readdirSync(runsRoot)) { const scope=JSON.parse(readFileSync(join(runsRoot,d,"scope.json"),"utf8")); assert.equal((await fetch(scope.url,{headers:{authorization:"Bearer "+scope.token}})).status,401); }
  } finally { await daemon.close(); if(old===undefined)delete process.env.MODELBOT_TEST_FAKE_COMPUTER;else process.env.MODELBOT_TEST_FAKE_COMPUTER=old; }
});
