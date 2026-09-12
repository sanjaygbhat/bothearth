import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../../src/daemon/server.ts";
import { ConnectorMcpClient } from "../../../src/mcp/client.ts";
import { createSandboxRuntime } from "../../../src/sandbox/lifecycle.ts";
import { decodeLiveFrame } from "../../../src/protocol/live.ts";
import { withDockerLock } from "../lock.ts";
import { until } from "../../helpers/until.ts";

test("real browser-only UI takeover blocks model tools and resumes after release", { timeout: 120_000 }, async () => {
  await withDockerLock(async () => {
    const root = mkdtempSync(join(tmpdir(), "modelbot-takeover-"));
    const token = randomUUID();
    const daemon = await startDaemon({ port: 0, mcpToken: token, bootstrapToken: token, sqlitePath: join(root, "state.sqlite"), workspaceRoot: join(root, "computers"), sandbox: createSandboxRuntime({ workspaceRoot: join(root, "computers"), browserImage: process.env.MODELBOT_TEST_BROWSER_IMAGE }), idlePauseMin: 0, declaredOrigins: { readable: ["http://127.0.0.1:8080"], writable: ["http://127.0.0.1:8080"] } });
    const bootstrap = await fetch(`${daemon.baseUrl}/api/v1/session/bootstrap`, { method: "POST", headers: { Origin: daemon.baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(bootstrap.status, 200);
    const { csrf } = await bootstrap.json() as { csrf: string };
    const headers = { Origin: daemon.baseUrl, "Content-Type": "application/json", "X-CSRF-Token": csrf, Cookie: bootstrap.headers.get("set-cookie")!.split(";")[0]! };
    const name = `takeover-${randomUUID().slice(0, 8)}`;
    let created = false;
    let ws: WebSocket | undefined;
    let mcp: ConnectorMcpClient | undefined;
    const post = async (path: string, body = {}) => {
      const res = await fetch(`${daemon.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      const data = await res.json();
      assert.equal(res.status < 300, true, JSON.stringify(data));
      return data as Record<string, any>;
    };
    try {
      await post("/api/v1/computers", { name, capabilities: ["browser"], persistent: false });
      created = true;
      const canary = `modelbot-canary-${randomUUID()}`;
      const typedEmail = "owner@example.test ._-@é🙂@r";
      const html = `<form style="position:fixed;left:100px;top:200px" onsubmit="event.preventDefault();if(this.email.value===${JSON.stringify(typedEmail).replaceAll('"', '&quot;')}&&this.secret.value===${JSON.stringify(canary).replaceAll('"', '&quot;')}){document.body.textContent='Signed in';fetch('/passed')}else{fetch('/failed',{method:'POST',body:this.email.value})};"><label>Email<input name="email" autofocus></label><label>Password<input name="secret" type="password"></label><button>Login</button></form>`;
      const server = `let passed=false,failed='';require('node:http').createServer((req,res)=>{if(req.url==='/passed'){passed=true;res.end();return}if(req.url==='/failed'){req.on('data',d=>failed+=d);req.on('end',()=>res.end());return}if(req.url==='/status'){res.end(JSON.stringify({passed,failed}));return}if(req.url==='/redirect'){res.writeHead(302,{location:'http://localhost:8080/blocked'});res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(${JSON.stringify(html)})}).listen(8080,'127.0.0.1')`;
      const fixture = spawnSync("docker", ["exec", "-d", `modelbot-${name}-browser`, "node", "-e", server], { encoding: "utf8" });
      assert.equal(fixture.status, 0, fixture.stderr);

      const taskA = `task-${randomUUID()}`;
      const bindingInput = { task_id: taskA, computer_id: name, execution: "harness", spend_cap_usd: 10, max_steps: 100 };
      await post("/api/v1/harness-bindings", bindingInput);
      const premature = await fetch(`${daemon.baseUrl}/api/v1/harness-bindings`, { method: "POST", headers,
        body: JSON.stringify({ ...bindingInput, task_id: `task-${randomUUID()}` }) });
      assert.equal(premature.status, 409, "active task budget cannot be reset");
      mcp = await ConnectorMcpClient.connectHttp({ url: `${daemon.baseUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } });
      const call = async (tool: string, args = {}) => {
        const result = await mcp!.callTool(tool, args);
        return JSON.parse(String(result.content[0]!.text));
      };
      assert.equal((await call("browser_navigate", { url: "http://127.0.0.1:8080", wait_until: "domcontentloaded" })).ok, true);
      const redirect = await call("browser_navigate", { url: "http://127.0.0.1:8080/redirect", wait_until: "domcontentloaded" });
      assert.equal(redirect.ok, true, "ordinary public navigation does not require submission consent");
      assert.equal((await call("done", { summary: "First harness task complete" })).ok, true);
      assert.equal(daemon.store.getTask(taskA)?.status, "completed");
      assert.equal((await call("browser_snapshot", { depth: null, interactive_only: false, max_chars: 1000, scope: null })).error?.code, "E_POLICY", "terminal tasks cannot keep using their grant");
      const taskB = `task-${randomUUID()}`;
      await post("/api/v1/harness-bindings", { ...bindingInput, task_id: taskB });
      const archive = daemon.store.db.prepare("SELECT body_json FROM steps WHERE task_id = ? AND kind = 'harness_binding'").get(taskA) as { body_json: string };
      assert.ok(JSON.parse(archive.body_json).observed_tool_calls > 0, "previous task budget history survives rebinding");
      const isolated = await call("browser_navigate", { url: "http://127.0.0.1:8080/redirect", wait_until: "domcontentloaded" });
      assert.equal(isolated.ok, true, "the next task can also open public pages without submission consent");
      await post(`/api/v1/tasks/${taskB}/cancel`);
      const reused = await fetch(`${daemon.baseUrl}/api/v1/harness-bindings`, { method: "POST", headers, body: JSON.stringify(bindingInput) });
      assert.equal(reused.status, 409, "old task IDs and their approvals cannot be recycled");
      await post("/api/v1/harness-bindings", { ...bindingInput, task_id: `task-${randomUUID()}` });
      assert.equal((await call("browser_navigate", { url: "http://127.0.0.1:8080", wait_until: "domcontentloaded" })).ok, true);
      const frames: Array<{ mode: string; size: number; target: string }> = [];
      let mode = "", epoch = 0;
      ws = new WebSocket(`${daemon.baseUrl.replace("http", "ws")}/api/v1/live/${name}`, { headers: { Origin: daemon.baseUrl, Cookie: headers.Cookie } });
      ws.binaryType = "arraybuffer";
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const message = JSON.parse(event.data);
          if (message.t === "mode") { mode = message.mode; epoch = message.epoch; }
        } else {
          const frame = decodeLiveFrame(new Uint8Array(event.data));
          assert.equal(frame.payload[0], 0xff, "JPEG pixels, not an emitted placeholder");
          if (process.env.MODELBOT_TEST_FRAME && frame.header.mode === "human") writeFileSync(process.env.MODELBOT_TEST_FRAME, frame.payload);
          frames.push({ mode: frame.header.mode, size: frame.payload.length, target: frame.header.target });
        }
      });
      await until(() => frames.some((frame) => frame.size > 100 && frame.mode === "agent"), "live-view condition timed out", 15_000);
      const requested = await post("/api/v1/takeover/request", { computer_id: name, reason: "synthetic login-transfer verification" });
      const id = requested.takeover.takeover_id;
      assert.equal((await post(`/api/v1/takeover/${id}/acquire`)).takeover.state, "human");
      await until(() => mode === "human", "live-view condition timed out", 15_000);
      const key = (key: string, mods = 0, code = key) => {
        for (const kind of ["keyDown", "keyUp"]) ws!.send(JSON.stringify({ v: 1, t: "key", epoch, key, code, mods, kind }));
      };
      const type = (text: string) => { for (const char of text) key(char, char === "@" || char === "_" ? 8 : 0); };
      if (process.env.MODELBOT_TEST_BROWSER_IMAGE) {
        await until(() => frames.some(frame => frame.mode === "human" && frame.target === "desktop"), "no full desktop frame", 15000);
        for (const kind of ["down", "up"]) ws!.send(JSON.stringify({ v: 1, t: "pointer", epoch, kind, x: 200, y: 300, button: 0 }));
      }
      type("junk"); key("a", 2, "KeyA"); key("Backspace");
      type("replace me"); key("a", 4, "KeyA"); key("Backspace");
      type("owner@example.test ._-@é🙂");
      type("X"); key("ArrowLeft", 8); key("Backspace");
      type("Y"); key("ArrowLeft"); key("Delete");
      type("Z"); key("Backspace");
      key("@", 1, "Digit2"); // Option-resolved printable text, e.g. UK Mac layout.
      ws.send(JSON.stringify({ v: 1, t: "key", epoch, key: "Control", mods: 2, kind: "keyDown" }));
      ws.send(JSON.stringify({ v: 1, t: "key", epoch, key: "", mods: 0, kind: "reset" }));
      type("r"); key("Tab");
      ws.send(JSON.stringify({ v: 1, t: "text", epoch, text: canary }));
      ws.send(JSON.stringify({ v: 1, t: "key", epoch, kind: "keyDown", code: "Enter", key: "Enter" }));
      ws.send(JSON.stringify({ v: 1, t: "key", epoch, kind: "keyUp", code: "Enter", key: "Enter" }));
      const verifyTyping = await promisify(execFile)("docker", ["exec", `modelbot-${name}-browser`, "node", "-e",
        "(async()=>{for(let i=0;i<600;i++){const s=await(await fetch('http://127.0.0.1:8080/status')).json();if(s.passed){console.log('passed');return}if(s.failed){console.error('Wrong synthetic input:',s.failed);process.exit(1)}await new Promise(r=>setTimeout(r,50))}process.exit(2)})()"], { encoding: "utf8" });
      assert.equal(verifyTyping.stdout.trim(), "passed", "actual key events produced the complete expected input");
      await until(() => frames.some((frame) => frame.mode === "human"), "live-view condition timed out", 15_000);
      for (const tool of ["browser_snapshot", "browser_screenshot"]) {
        const blocked = await call(tool, tool === "browser_snapshot" ? { depth: null, interactive_only: false, max_chars: 1000, scope: null } : { full_page: false });
        assert.equal(blocked.error.code, "E_TAKEOVER_BUSY", tool);
      }
      if (process.env.MODELBOT_TEST_BROWSER_IMAGE) {
        await until(() => frames.some(frame => frame.mode === "human" && frame.target === "desktop"), "no full desktop frame", 15000);
        key("t", 3, "KeyT");
        await new Promise(resolve => setTimeout(resolve, 700));
        const windows = await promisify(execFile)("docker", ["top", `modelbot-${name}-browser`, "-eo", "pid,comm"], { encoding: "utf8" });
        assert.match(windows.stdout, /xterm/, "desktop shortcut opened an actual terminal");
        key("e", 3, "KeyE");
        await new Promise(resolve => setTimeout(resolve, 700));
        const files = await promisify(execFile)("docker", ["top", `modelbot-${name}-browser`, "-eo", "pid,comm"], { encoding: "utf8" });
        assert.match(files.stdout, /pcmanfm/, "desktop shortcut opened the file manager");
      }
      assert.equal((await post(`/api/v1/takeover/${id}/release`)).takeover.state, "agent");
      await until(() => mode === "agent", "live-view condition timed out", 15_000);
      const resumed = await call("browser_snapshot", { depth: null, interactive_only: false, max_chars: 1000, scope: null });
      assert.equal(resumed.ok, true);
      assert.match(resumed.data.yaml, /Signed in/);
      assert.equal(readFileSync(join(root, "computers", "audit.jsonl"), "utf8").includes(canary), false, "operator secret never enters audit");
      const gap = daemon.store.listAuditRefs(100).some((row) => row.type === "takeover.gap");
      assert.equal(gap, true, "audited model-blind interval");
      const lastTask = daemon.store.getHarnessTaskBinding(name)!.task_id;
      assert.equal((await call("done", { status: "fail", summary: "Synthetic failure receipt" })).ok, true);
      assert.equal(daemon.store.getTask(lastTask)?.status, "failed", "harness failure is not reported as success");
      assert.ok(daemon.store.listAuditRefs(100).some((row) => row.type === "task.failed"));
    } finally {
      ws?.close();
      await mcp?.close();
      if (created) await fetch(`${daemon.baseUrl}/api/v1/computers/${name}`, { method: "DELETE", headers });
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
