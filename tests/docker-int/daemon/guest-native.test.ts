import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDockerCli } from "../../../src/sandbox/docker.ts";
import { browserRuntimeFlags } from "../../../src/sandbox/flags.ts";
import { resourceNames } from "../../../src/sandbox/names.ts";
import { startComputer } from "../../../src/sandbox/lifecycle.ts";
import { ensureWorkspaceBrowserWritable } from "../../../src/sandbox/workspace-perm.ts";
import { execArgs, guestSpawn, setGuestComputerPaused, startGuestNativeTask } from "../../../src/daemon/guest-native.ts";
import { ExecComputerClient } from "../../../src/computer-client/exec-client.ts";
import { mcpStandalone } from "../../../src/mcp/server.ts";
import { until } from "../../helpers/until.ts";
import { withDockerLock } from "../lock.ts";

const entry = "/opt/computer-server/src/native-process.ts";

// No model login, credentials, public network or paid generation is used here.
test("guest native CLI, concurrent MCP, shared files, private freeze and cleanup", { timeout: 150_000 }, async () => {
  await withDockerLock(async () => {
    const cli = createDockerCli({ kind: "docker", binary: "docker" });
    const id = "guest-int-" + randomUUID().slice(0, 8), names = resourceNames(id);
    const workspace = await mkdtemp(join(tmpdir(), "bothearth-guest-int-"));
    ensureWorkspaceBrowserWritable(workspace);
    const agent = (args: string[]) => execArgs(id, args);
    const browser = (args: string[]) => ["exec", "-i", "--user", "1001:1001", names.containerBrowser, ...args];
    const create = async () => {
      await cli.run(["create", "--name", names.containerBrowser, "--network", "none",
        ...browserRuntimeFlags(resolve("sandbox/seccomp-chromium.json")), "--group-add", String(statSync(workspace).gid),
        "--mount", `type=volume,source=${names.volumeAgentHome},target=/home/agent`,
        "--mount", `type=volume,source=${names.volumeProfile},target=/home/browser/profile`,
        "--mount", `type=bind,source=${workspace},target=/workspace`,
        "--env", "MODELBOT_PROXY_SERVER=http://127.0.0.1:9", "--env", "MODELBOT_PROXY_BYPASS=127.0.0.1,localhost",
        process.env.MODELBOT_TEST_GUEST_IMAGE ?? "modelbot/computer:dev"]);
      await cli.run(["start", names.containerBrowser]);
    };
    const stop: Array<() => Promise<unknown>> = [];
    try {
      await create();
      await cli.run(["pause", names.containerBrowser]);
      await startComputer(id, { cli, runtime: { kind: "docker", binary: "docker" }, workspaceRoot: workspace });
      assert.equal((await cli.run(["inspect", "--format", "{{.State.Paused}}", names.containerBrowser])).trim(), "false", "starting a computer also wakes an idle container");
      assert.match(await cli.run(agent(["codex", "--version"])), /codex-cli 0\.153\.4/);
      assert.match(await cli.run(agent(["claude", "--version"])), /2\.1\.263/);
      const permissions = JSON.parse(await cli.run(agent(["node", "-e", `const fs=require('fs');const ws=fs.statSync('/workspace');console.log(JSON.stringify({uid:process.getuid(),groups:process.getgroups(),gid:ws.gid,home:fs.statSync('/home/agent').mode&511,auth:fs.existsSync('/home/agent/.codex/auth.json')}))`])));
      assert.equal(permissions.uid, 1001);
      assert.ok(permissions.groups.includes(permissions.gid), "Docker exec must retain the shared workspace supplementary group");
      assert.equal(permissions.home, 0o700);
      assert.equal(permissions.auth, false, "guest home must start without host credentials");
      await cli.run(browser(["node", "-e", `require('fs').writeFileSync('/home/browser/profile/private-fixture','synthetic',{mode:384})`]));
      await cli.run(agent(["node", "-e", `const fs=require('fs'),a=require('assert/strict');a.equal(fs.readFileSync('/home/browser/profile/private-fixture','utf8'),'synthetic');fs.readdirSync('/quarantine');fs.writeFileSync('/home/agent/persistence-proof','guest-only');`]));

      // Real stock app-server JSON comes from the guest CLI, without starting a model turn.
      const native = await guestSpawn(id, "codex", ["app-server", "--stdio"]);
      stop.push(native.stop);
      let nativeOutput = "", nativeError = "";
      native.child.stdout!.on("data", chunk => { nativeOutput += chunk; }); native.child.stderr?.on("data", chunk => { nativeError += chunk; });
      native.child.stdin!.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "guest-integration", version: "1" }, capabilities: {} } }) + "\n");
      await until(() => nativeOutput.includes('"id":1') || native.child.exitCode !== null, "guest app-server did not answer initialize");
      assert.ok(nativeOutput.includes('"id":1'), `unauthenticated test app-server exited: ${nativeError}`);
      const init = nativeOutput.trim().split("\n").map(line => JSON.parse(line)).find(e => e.id === 1);
      assert.ok(init.result && !init.error, "stock guest initialization must succeed without a model request");
      const processes = await cli.run(browser(["ps", "-eo", "uid,pid,args"]));
      assert.match(processes, /1001\s+\d+[^\n]*codex[^\n]*app-server/);
      await native.stop();

      // Real browser in the container; two MCP clients deliberately reuse JSON-RPC ids.
      const web = cli.spawn(browser(["node", "-e", `require('http').createServer((q,s)=>s.end('<h1>Guest browser proof</h1>')).listen(18349,'127.0.0.1')`]));
      stop.push(async () => { web.stdin?.destroy(); web.kill(); });
      const computer = new ExecComputerClient(id, { cli, capabilities: ["browser"] });
      stop.push(() => computer.close());
      const mcp = await mcpStandalone({ port: 0, mcpToken: "synthetic-guest-scoped-token", backend: {
        uiBaseUrl: "http://127.0.0.1", callTool: (name, args) => computer.call(name, args, { navigationOrigins: [], allowPublicNavigation: true }),
        releaseTakeover: key => computer.releaseTakeover(key), grantTakeover: key => computer.grantTakeover(key), declineTakeover: key => computer.declineTakeover(key),
      } });
      stop.push(() => mcp.close());
      let pipe: { command: string; args: string[] } | undefined;
      const task = await startGuestNativeTask({ cli, computerId: id, provider: "codex", url: mcp.url, token: "synthetic-guest-scoped-token",
        args: config => { pipe = config; return ["--version"]; } });
      stop.push(task.stop);
      const clients = await Promise.all(["leader", "executor"].map(async name => {
        const client = new Client({ name, version: "1" });
        await client.connect(new StdioClientTransport({ command: cli.binary, args: agent([pipe!.command, ...pipe!.args]), stderr: "ignore" }));
        stop.push(() => client.close());
        return client;
      }));
      const lists = await Promise.all(clients.map(c => c.listTools()));
      assert.ok(lists.every(list => list.tools.some(tool => tool.name === "browser_snapshot")));
      const nav = await clients[0]!.callTool({ name: "browser_navigate", arguments: { url: "http://127.0.0.1:18349" } });
      assert.notEqual(nav.isError, true, JSON.stringify(nav));
      const snapshot = await clients[1]!.callTool({ name: "browser_snapshot", arguments: {} });
      assert.match(JSON.stringify(snapshot), /Guest browser proof/);
      const browserProcesses = await cli.run(browser(["ps", "-eo", "pid,args"]));
      const chromiumLine = browserProcesses.split("\n").find(line => line.includes("/usr/lib/chromium/chromium ") && !line.includes("--type="));
      assert.ok(chromiumLine, "the Machine must run the distribution's regular Chromium");
      const chromiumPid = chromiumLine.trim().split(/\s+/)[0]!;
      const browserCommand = chromiumLine.trim().slice(chromiumPid.length).trim();
      assert.match(browserCommand, /--remote-debugging-pipe/);
      assert.doesNotMatch(browserCommand, /--(?:headless|no-sandbox|user-agent|remote-debugging-port|disable-dev-shm-usage)/);
      await cli.run(agent(["kill", "-0", chromiumPid]));
      assert.match(await cli.run(agent(["xdotool", "getdisplaygeometry"])), /1280\s+900/);
      await clients[1]!.close();
      assert.ok((await clients[0]!.listTools()).tools.length > 0, "executor disconnection must not end the leader's bridge");
      let version = "";
      task.child.stdout!.on("data", chunk => { version += chunk; });
      const exited = once(task.child, "close");
      task.prompt("synthetic prompt");
      await exited;
      assert.match(version, /codex-cli 0\.153\.4/);
      await task.stop();

      // A native tool process and detached child stop together; operator processes keep working.
      const runId = randomUUID();
      const heartbeat = `const fs=require('fs');process.umask(7);fs.writeFileSync('/workspace/out/native.txt','native');setInterval(()=>fs.appendFileSync('/workspace/out/native-beats','x'),30);require('child_process').spawn('node',['-e',"setInterval(()=>require('fs').appendFileSync('/workspace/out/child-beats','x'),30)"],{detached:true,stdio:'ignore'}).unref();`;
      const run = cli.spawn(agent(["/usr/bin/tini", "-s", "--", "node", entry, "run", runId, "node", "-e", heartbeat]));
      run.stderr?.resume(); run.stdout?.resume();
      run.stdin!.write(JSON.stringify({ prompt: "synthetic" }) + "\n");
      stop.push(async () => { await cli.run(agent(["node", entry, "stop", runId])); run.stdin?.destroy(); run.kill(); });
      await until(async () => (await readFile(join(workspace, "out/child-beats"), "utf8").catch(() => "")).length > 1);
      await cli.run(browser(["node", "-e", `const fs=require('fs');process.umask(7);fs.appendFileSync('/workspace/out/native.txt','+operator');fs.writeFileSync('/workspace/out/operator.txt','operator');`]));
      await cli.run(agent(["node", "-e", `require('fs').appendFileSync('/workspace/out/operator.txt','+native')`]));
      assert.equal(await readFile(join(workspace, "out/native.txt"), "utf8"), "native+operator");
      assert.equal(await readFile(join(workspace, "out/operator.txt"), "utf8"), "operator+native");
      await setGuestComputerPaused(id, true);
      const before = await readFile(join(workspace, "out/child-beats"), "utf8");
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await readFile(join(workspace, "out/child-beats"), "utf8"), before);
      await cli.run(browser(["node", "-e", "require('fs').appendFileSync('/workspace/out/operator.txt','+during-control')"]));
      const blocked = await guestSpawn(id, "codex", ["--version"]);
      blocked.child.stdout?.resume(); blocked.child.stderr?.resume();
      assert.notEqual((await once(blocked.child, "close"))[0], 0, "new CLI cannot start inside private control");
      await blocked.stop();
      await cli.run(agent(["node", entry, "stop", runId]));
      await setGuestComputerPaused(id, false);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await readFile(join(workspace, "out/child-beats"), "utf8"), before, "cancelled detached tools must not restart on control release");

      const paused = await guestSpawn(id, "codex", ["app-server", "--stdio"]);
      paused.child.stdout?.resume(); paused.child.stderr?.resume();
      await cli.run(["pause", names.containerBrowser]);
      const start = Date.now();
      await assert.rejects(paused.stop(), /cleanup could not be confirmed/);
      assert.ok(Date.now() - start < 6500);
      assert.equal((await cli.run(["inspect", "--format", "{{.State.Paused}}", names.containerBrowser])).trim(), "true");
      await cli.run(["unpause", names.containerBrowser]);
      const recovered = await guestSpawn(id, "codex", ["--version"]);
      recovered.child.stdout?.resume(); recovered.child.stderr?.resume();
      assert.equal((await once(recovered.child, "close"))[0], 0, "new commands retry pending cleanup after the runtime recovers");
      await recovered.stop();
      await paused.stop();
      for (const close of stop.splice(0).reverse()) await close().catch(() => {});
      await cli.run(["rm", "-f", names.containerBrowser]);
      await create();
      assert.equal(await cli.run(agent(["cat", "/home/agent/persistence-proof"])), "guest-only");
    } finally {
      for (const close of stop.reverse()) await close().catch(() => {});
      // Only this test's uniquely named resources are ever removed.
      await cli.run(["rm", "-f", names.containerBrowser]).catch(() => {});
      await cli.run(["volume", "rm", names.volumeAgentHome, names.volumeProfile]).catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
