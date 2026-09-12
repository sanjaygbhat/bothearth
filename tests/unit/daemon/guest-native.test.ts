import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { controlPids, resolveXauthority } from "../../../computer-server/src/native-process.ts";
import { guestTaskArgs, runCodexTask } from "../../../src/daemon/codex-runner.ts";
import { createCodexConnection } from "../../../src/daemon/codex-connection.ts";
import { agentHomeHelperArgs, agentHomeMigrateArgs, agentHomeStatArgs, ensureAgentHomeOwner, execArgs } from "../../../src/daemon/guest-native.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { mcpStandalone } from "../../../src/mcp/server.ts";
import { type DockerCli, DockerError } from "../../../src/sandbox/docker.ts";
import { defaultSeccompPath, startComputer } from "../../../src/sandbox/lifecycle.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";
import { fakeCli, isolateModelbotHome } from "../../helpers/fake-cli.ts";
import { until } from "../../helpers/until.ts";

isolateModelbotHome();

test("guest native docker exec uses the computer uid and desktop display", () => {
  const args = execArgs("fixture-computer", ["true"]);
  assert.equal(args[args.indexOf("--user") + 1], "1001:1001");
  assert.ok(args.includes("DISPLAY=:99"));
  assert.ok(!args.some(arg => arg.startsWith("XAUTHORITY=")));
  assert.ok(args.every((arg, i) => args[i - 1] !== "--env" || !arg.includes("*")));
  assert.ok(args.includes("HOME=/home/agent"));
  assert.ok(args.includes("sh"));
  assert.ok(!args.includes("--privileged"));
  assert.match(args[args.indexOf("-c") + 1]!, /XAUTHORITY=/);
});

test("native start chowns existing agent-home as root to the computer uid", async () => {
  const probe = agentHomeStatArgs("fixture-computer");
  const chown = agentHomeMigrateArgs("fixture-computer");
  for (const args of [probe, chown, execArgs("fixture-computer", ["true"])]) assert.ok(!args.includes("--privileged"));
  assert.equal(chown[chown.indexOf("--user") + 1], "0");
  assert.equal(chown[0], "run");
  assert.ok(chown.includes("--rm"));
  assert.ok(chown.includes("modelbot-fixture-computer-agent-home:/home/agent"));
  assert.ok(chown.includes("modelbot/computer:dev"));
  assert.ok(!chown.includes("modelbot-fixture-computer-browser"));
  assert.deepEqual(probe.slice(probe.indexOf("stat")), ["stat", "-c", "%u", "/home/agent"]);
  assert.deepEqual(chown.slice(chown.indexOf("chown")), ["chown", "-R", "1001:1001", "/home/agent"]);
  const recording = (uid: string): { cli: DockerCli; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, cli: { binary: "docker", async run(args) { calls.push(args); return args.includes("stat") ? `${uid}\n` : ""; },
      runSync() { throw new Error("runSync unused"); }, spawn() { throw new Error("spawn unused"); } } };
  };
  const stale = recording("1002");
  await ensureAgentHomeOwner(stale.cli, "probe-uid-1002");
  assert.deepEqual(stale.calls, [agentHomeStatArgs("probe-uid-1002"), agentHomeMigrateArgs("probe-uid-1002")]);
  stale.calls.length = 0;
  await ensureAgentHomeOwner(stale.cli, "probe-uid-1002");
  assert.deepEqual(stale.calls, []);
  const owned = recording("1001");
  await ensureAgentHomeOwner(owned.cli, "probe-uid-1001");
  assert.deepEqual(owned.calls, [agentHomeStatArgs("probe-uid-1001")]);
  const denied: string[][] = [];
  const deniedCli: DockerCli = { binary: "docker", async run(args) {
    denied.push(args);
    if (args[0] === "exec") throw new Error("cannot read directory '/home/agent': Permission denied");
    return args.includes("stat") ? "1002\n" : "";
  }, runSync() { throw new Error("runSync unused"); }, spawn() { throw new Error("spawn unused"); } };
  await ensureAgentHomeOwner(deniedCli, "probe-eacces-1002");
  assert.deepEqual(denied, [
    agentHomeStatArgs("probe-eacces-1002"),
    agentHomeHelperArgs("probe-eacces-1002", ["stat", "-c", "%u", "/home/agent"]),
    agentHomeMigrateArgs("probe-eacces-1002"),
  ]);
});

test("computer start migrates agent-home when probe is 1002 and skips when 1001", async () => {
  const runtime = { kind: "docker", binary: "docker" } as const;
  const seccomp = JSON.stringify([{ HostConfig: { SecurityOpt: ["seccomp=/sandbox/seccomp-chromium.json"] } }]);
  async function startWith(id: string, uid: string) {
    const root = mkdtempSync(join(tmpdir(), "mb-start-home-"));
    mkdirSync(join(root, id, "workspace"), { recursive: true });
    const calls: string[][] = [];
    const cli: DockerCli = {
      binary: "docker",
      async run(args) {
        calls.push(args);
        if (args[0] === "inspect" && !args.includes("-f")) return seccomp;
        if (args[0] === "exec" && args.includes("stat")) return `${uid}\n`;
        return "";
      },
      runSync() { throw new Error("runSync unused"); },
      spawn() { throw new Error("spawn unused"); },
    };
    await startComputer(id, { runtime, cli, workspaceRoot: root, seccompPath: defaultSeccompPath() });
    return calls;
  }
  const stale = await startWith("start-home-1002", "1002");
  assert.ok(stale.some(args => args[0] === "exec" && args.includes("stat")));
  const migrate = stale.find(args => args[0] === "run");
  assert.ok(migrate);
  assert.ok(!migrate.includes("--privileged"));
  assert.deepEqual(migrate, agentHomeMigrateArgs("start-home-1002"));
  const owned = await startWith("start-home-1001", "1001");
  assert.ok(owned.some(args => args[0] === "exec" && args.includes("stat")));
  assert.equal(owned.some(args => args[0] === "run"), false);
});

const AGENT_HOME_WRAP = "This computer cannot write /home/agent. Recreate the modelbot-*-agent-home volume or chown it to 1001:1001.";
function guestProbeChild(code: number, stderr = "") {
  const src = stderr
    ? `process.stderr.write(${JSON.stringify(stderr)}); setTimeout(() => process.exit(${code}), 20)`
    : `process.exit(${code})`;
  const child = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "ignore", "pipe"] });
  return { child, async stop() { child.kill("SIGKILL"); } };
}

test("probe cannot-write /home/agent migrates and retries instead of could not be checked", async () => {
  let probes = 0, repaired = 0;
  const connection = createCodexConnection({
    codexHome: "/home/agent/.codex",
    model: () => "gpt-6-astra", configured: () => false, connected: () => {},
    async spawn() {
      probes++;
      return probes === 1 ? guestProbeChild(1, AGENT_HOME_WRAP) : guestProbeChild(1);
    },
    async repairAgentHome() { repaired++; },
  });
  try {
    const status = await connection.status();
    assert.equal(repaired, 1);
    assert.equal(probes, 2);
    assert.equal(status.status, "signed_out");
    assert.doesNotMatch(status.message, /could not be checked/);
  } finally { await connection.close(); }
});

test("probe EACCES without /home/agent does not migrate agent-home", async () => {
  let repaired = 0;
  const connection = createCodexConnection({
    codexHome: "/tmp/other/.codex",
    model: () => "gpt-6-astra", configured: () => false, connected: () => {},
    async spawn() {
      throw Object.assign(new Error("EACCES: permission denied, mkdir '/tmp/other/.codex'"), { code: "EACCES" });
    },
    async repairAgentHome() { repaired++; },
  });
  try {
    const status = await connection.status();
    assert.equal(repaired, 0);
    assert.equal(status.status, "error");
  } finally { await connection.close(); }
});

test("probe DockerError numeric exit migrates agent-home and retries", async () => {
  let probes = 0, repaired = 0;
  const connection = createCodexConnection({
    codexHome: "/home/agent/.codex",
    model: () => "gpt-6-astra", configured: () => false, connected: () => {},
    async spawn() {
      probes++;
      if (probes === 1) {
        throw new DockerError(
          "docker run --rm -v modelbot-x-agent-home:/home/agent failed (1): This computer cannot write /home/agent",
          1,
          AGENT_HOME_WRAP,
          ["run", "--rm", "-v", "modelbot-x-agent-home:/home/agent"],
        );
      }
      return guestProbeChild(1);
    },
    async repairAgentHome() { repaired++; },
  });
  try {
    const status = await connection.status();
    assert.equal(repaired, 1);
    assert.equal(probes, 2);
    assert.equal(status.status, "signed_out");
    assert.doesNotMatch(status.message, /could not be checked/);
  } finally { await connection.close(); }
});

test("probe repair failure still returns a connection view", async () => {
  let probes = 0, repaired = 0;
  const connection = createCodexConnection({
    codexHome: "/home/agent/.codex",
    model: () => "gpt-6-astra", configured: () => false, connected: () => {},
    async spawn() { probes++; return guestProbeChild(1, AGENT_HOME_WRAP); },
    async repairAgentHome() { repaired++; throw new DockerError("docker run failed (1): helper", 1, "helper", ["run"]); },
  });
  try {
    const status = await connection.status();
    assert.equal(repaired, 1);
    assert.equal(probes, 1);
    assert.equal(status.status, "error");
    assert.match(status.message, /could not be checked/);
  } finally { await connection.close(); }
});

test("resolveXauthority uses the desktop cookie file and fails closed", () => {
  const file = "/tmp/modelbot-chromium-xy/Xauthority";
  assert.equal(resolveXauthority(["foo", "modelbot-chromium-xy", "bar"], path => path === file), file);
  assert.throws(() => resolveXauthority([], () => true), /Desktop display cookie is missing/);
  assert.throws(() => resolveXauthority(["modelbot-chromium-xy"], () => false), /Desktop display cookie is missing/);
  assert.throws(() => resolveXauthority(["other-dir"], () => true), /Desktop display cookie is missing/);
});

test("pause freezes session and pid1-reparented pids and skips Chromium", () => {
  const all = new Map([
    [1, { parent: 0, state: "S", start: "1", command: "/usr/bin/tini -- sleep infinity" }],
    [2, { parent: 1, state: "S", start: "2", command: "sleep infinity" }],
    [10, { parent: 1, state: "S", start: "10", command: "/usr/lib/chromium/chromium --remote-debugging-pipe" }],
    [11, { parent: 10, state: "S", start: "11", command: "/usr/lib/chromium/chromium --type=gpu" }],
    [20, { parent: 1, state: "S", start: "20", command: "node /opt/computer-server/stdio.js" }],
    [21, { parent: 20, state: "S", start: "21", command: "ffmpeg -f x11grab -i :99" }],
    [30, { parent: 1, state: "S", start: "30", command: "/usr/bin/tini -s -- node /opt/computer-server/src/native-process.ts run sess" }],
    [31, { parent: 30, state: "S", start: "31", command: "codex" }],
    [40, { parent: 1, state: "S", start: "40", command: "node -e orphan" }],
  ]);
  const targets = controlPids(all, "pause", 99);
  assert.deepEqual([...targets].sort((a, b) => a - b), [30, 31, 40]);
});

test("SECURITY.md does not call /home/agent a private home", () => {
  const text = readFileSync(new URL("../../../SECURITY.md", import.meta.url), "utf8");
  assert.doesNotMatch(text, /private home at `\/home\/agent`/);
  assert.match(text, /not private from the computer uid/);
  assert.match(text, /migrated to the browser user \(1001:1001\) on first native use/);
  assert.doesNotMatch(text, /cannot create `CODEX_HOME`/);
  assert.doesNotMatch(text, /keep that owner until they are recreated/);
  assert.match(text, /without `--privileged`/);
});

const mcp = { command: "node", args: ["/opt/computer-server/src/native-process.ts", "mcp-connect", "fixture-session"] };
const configs = (args: string[]) => args.flatMap((arg, i) => arg === "-c" ? [args[i + 1]] : []);

test("guest Codex keeps native tools, exact model and separate stdio MCP in executor mode", () => {
  const args = guestTaskArgs("codex", "gpt-6-astra", {}, mcp);
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-astra");
  assert.equal(args[args.indexOf("-s") + 1], "danger-full-access");
  assert.ok(configs(args).includes("features.multi_agent=false"));
  assert.ok(configs(args).includes('model_reasoning_effort="medium"'));
  assert.ok(configs(args).includes("mcp_servers.modelbot.required=true"));
  assert.ok(configs(args).includes(`mcp_servers.modelbot.args=${JSON.stringify(mcp.args)}`));
  assert.doesNotMatch(args.join(" "), /shell_tool=false|web_search=|ignore-user-config|https?:|TOKEN|bearer/);
});

test("guest native orchestration pins same-provider executor and preserves the selected thread", () => {
  const args = guestTaskArgs("codex", "gpt-6-astra", { execution_mode: "orchestrator", executor: { adapter: "codex", model: "gpt-6-astra-custom" } }, mcp, "saved-thread");
  assert.ok(configs(args).includes("features.multi_agent=true"));
  assert.ok(configs(args).includes('agents.default_subagent_model="gpt-6-astra-custom"'));
  assert.deepEqual(args.slice(-3), ["resume", "saved-thread", "-"]);
});

test("guest Codex preserves high reasoning on first launch and resume without enabling delegation", () => {
  for (const thread of [undefined, "saved-thread"]) {
    const args = guestTaskArgs("codex", "gpt-6-astra", { reasoning_effort: "high" }, mcp, thread);
    assert.ok(configs(args).includes('model_reasoning_effort="high"'));
    assert.ok(configs(args).includes("features.multi_agent=false"));
  }
});

test("cross-provider orchestration cannot silently use the leader provider's native subagents", () => {
  const codex = guestTaskArgs("codex", "gpt-6-astra", { execution_mode: "orchestrator", executor: { adapter: "claude", model: "claude-opus-5" } }, mcp);
  assert.ok(configs(codex).includes("features.multi_agent=false"));
  const claude = guestTaskArgs("claude", "claude-opus-5", { execution_mode: "orchestrator", executor: { adapter: "codex", model: "gpt-6-astra" } }, mcp);
  assert.equal(claude[claude.indexOf("--disallowedTools") + 1], "Agent");
});

test("guest Claude keeps stock tools and skills while disabling model fallback and default delegation", () => {
  const args = guestTaskArgs("claude", "claude-opus-5", {}, mcp, "saved-session");
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "Agent");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
  assert.deepEqual(settings.fallbackModel, []);
  assert.equal(settings.switchModelsOnFlag, false);
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-opus-5");
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]!).mcpServers.modelbot, { type: "stdio", ...mcp });
  assert.equal(args.includes("--tools"), false);
  assert.equal(args.includes("--disable-slash-commands"), false);
  assert.equal(args.includes("--strict-mcp-config"), false);
  assert.deepEqual(args.slice(-2), ["--resume", "saved-session"]);
  const orchestrator = guestTaskArgs("claude", "claude-opus-5", { execution_mode: "orchestrator", executor: { adapter: "claude", model: "claude-fable-5-1" } }, mcp);
  assert.equal(orchestrator.includes("--disallowedTools"), false);
  assert.equal(JSON.parse(orchestrator[orchestrator.indexOf("--settings") + 1]!).env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-fable-5-1");
});

for (const provider of ["codex", "claude"] as const) test(`${provider} tool activity relays names and status without native tool arguments`, async () => {
  const events = provider === "codex" ? [
    { type: "thread.started", thread_id: "fixture-thread" },
    { type: "item.started", item: { type: "command_execution", command: "private-command-fixture" } },
    { type: "item.completed", item: { type: "command_execution", command: "private-command-fixture", aggregated_output: "private-output-fixture" } },
    { type: "item.completed", item: { type: "agent_message", text: "Saved the result." } }, { type: "turn.completed" },
  ] : [
    { type: "system", subtype: "init", session_id: "fixture-session" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "private-command-fixture" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "private-output-fixture" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Saved the result." }] } }, { type: "result", subtype: "success" },
  ];
  const cli = fakeCli("guest-event-protocol", () => `for await (const chunk of process.stdin) {}\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`);
  const activity: unknown[] = [], messages: string[] = [];
  await runCodexTask({ provider, binary: cli.binary, codexHome: cli.home, model: provider === "codex" ? "gpt-6-astra" : "claude-opus-5", execution_location: "host", runsRoot: join(cli.home, "runs") },
    { id: "fixture-task", computer_id: "fixture-computer", goal: "Save a report" },
    { url: "http://127.0.0.1:1/mcp", token: "synthetic-scoped-token", signal: new AbortController().signal, maxRuntimeSec: 0,
      onActivity: e => activity.push(e), onMessage: m => messages.push(m), isWaiting: () => false, waitGeneration: () => 0, isTerminal: () => true });
  assert.deepEqual(activity, ["started", "completed"].map(status => ({ type: provider === "codex" ? "command_execution" : "tool_use", name: provider === "codex" ? "command_execution" : "Bash", status })));
  assert.deepEqual(messages, ["Saved the result."]);
  assert.doesNotMatch(JSON.stringify(activity), /private-command|private-output/);
});

// Use real child pipes, the Unix MCP relay and the host MCP bridge. Only Docker
// and the model CLI are synthetic; no account or existing computer is accessed.
type StartupFixtureOptions = { relay?: boolean; output?: string; threadId?: string; failAgain?: boolean };
function startupCli(options: StartupFixtureOptions = {}) {
  const entry = new URL("../../../computer-server/src/native-process.ts", import.meta.url).href;
  const cli = fakeCli("guest-startup", home => `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const root = ${JSON.stringify(home)}, setup = ${JSON.stringify(options)}, argv = process.argv.slice(2);
const index = argv.indexOf('/opt/computer-server/src/native-process.ts');
if (index < 0) { console.log(argv.includes('info') ? 'Docker Desktop' : 'default'); process.exit(0); }
const action = argv[index + 1];
const count = name => { const file = root + '/' + name, n = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1; writeFileSync(file, String(n)); return n; };
const wait = async n => { while (!existsSync(root + '/exit-' + n)) await new Promise(r => setTimeout(r, 10)); };
if (action === 'stop') process.exit(0);
if (action === 'pause' || action === 'resume') { writeFileSync(root + '/private', action); process.exit(0); }
if (action === 'exec' && argv.includes('login') && argv.includes('status')) process.exit(0);
if (action === 'exec' && argv.includes('mcp-listen')) {
  const n = count('relays');
  if (setup.relay && n === 1) { writeFileSync(root + '/entered', 'yes'); await wait(1); process.exit(1); }
  process.argv = [process.execPath, process.argv[1], 'mcp-listen', argv.at(-1)];
  Object.defineProperty(process, 'platform', { value: 'linux' }); process.getuid = () => 1001;
  await import(${JSON.stringify(entry)});
} else if (action === 'run') {
  createInterface({ input: process.stdin }).once('line', async line => {
    const n = count('commands');
    const prompt = JSON.parse(line).prompt;
    writeFileSync(root + '/prompt-' + n, prompt);
    if ((!setup.relay && n === 1) || setup.failAgain) {
      if (setup.output) process.stdout.write(setup.output);
      writeFileSync(root + '/entered', 'yes'); await wait(n); process.exit(1);
    }
    const events = [{ type: 'thread.started', thread_id: 'new-guest-thread' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Finished once.' } }, { type: 'turn.completed' }];
    process.stdout.write(events.map(v => JSON.stringify(v)).join('\\n') + '\\n', () => process.exit(0));
  });
} else process.exit(3);
`, "docker");
  for (const binary of ["orbctl", "colima", "podman"]) writeFileSync(cli.path(binary), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  return cli;
}

async function interruptedStartup(t: TestContext, options: StartupFixtureOptions = {}) {
  const cli = startupCli(options);
  const previousPath = process.env.MODELBOT_TOOL_PATH;
  process.env.MODELBOT_TOOL_PATH = cli.home;
  const server = await mcpStandalone({ port: 0, mcpToken: "synthetic-startup-token", backend: { uiBaseUrl: "http://127.0.0.1",
    async callTool() { return { ok: true, data: {} }; }, async releaseTakeover() { return { ok: true, data: {} }; },
    async grantTakeover() { return { ok: true, data: {} }; }, async declineTakeover() { return { ok: true, data: {} }; },
  } });
  const abort = new AbortController();
  const state = { waiting: false, generation: 0, done: false };
  const threads: string[] = [], messages: string[] = [];
  const outcome = runCodexTask({ model: "gpt-6-astra", codexHome: cli.home, runsRoot: cli.path("runs"), execution_location: "computer" },
    { id: "startup-fixture", computer_id: "startup-fixture", goal: "Save the public report once." },
    { url: server.url, token: "synthetic-startup-token", signal: abort.signal, maxRuntimeSec: 0, threadId: options.threadId,
      onThread: id => threads.push(id), onMessage: message => { messages.push(message); state.done = true; },
      isWaiting: () => state.waiting, waitGeneration: () => state.generation, isTerminal: () => state.done,
    }).then(() => undefined, error => error as Error);
  t.after(async () => {
    abort.abort(); await outcome; await server.close();
    if (previousPath === undefined) delete process.env.MODELBOT_TOOL_PATH; else process.env.MODELBOT_TOOL_PATH = previousPath;
    rmSync(cli.home, { recursive: true, force: true });
  });
  await until(() => existsSync(cli.path("entered")), "synthetic guest never reached startup");
  return { cli, state, abort, outcome, threads, messages,
    count: (name: string) => existsSync(cli.path(name)) ? Number(readFileSync(cli.path(name), "utf8")) : 0,
    exit: (n = 1) => writeFileSync(cli.path(`exit-${n}`), "yes"),
  };
}

for (const relay of [false, true]) test(`private control during ${relay ? "MCP setup" : "native startup"} retries untouched setup only after release`, { timeout: 10_000 }, async t => {
  const f = await interruptedStartup(t, { relay });
  f.state.waiting = true; f.state.generation++;
  f.exit();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(f.count("relays"), 1, "no new guest process may start during human control");
  assert.equal(f.state.done, false);
  f.state.waiting = false;
  assert.equal(await f.outcome, undefined);
  assert.equal(f.count("relays"), 2);
  assert.deepEqual(f.threads, ["new-guest-thread"]);
  assert.deepEqual(f.messages, ["Finished once."]);
  if (!relay) assert.equal(readFileSync(f.cli.path("prompt-1"), "utf8"), readFileSync(f.cli.path("prompt-2"), "utf8"));
});

for (const options of [
  { name: "without a control change", changed: false },
  { name: "after a thread starts", changed: true, output: JSON.stringify({ type: "thread.started", thread_id: "existing-thread" }) + "\n" },
  { name: "after any native output", changed: true, output: "partial native output" },
  { name: "when resuming an existing thread", changed: true, threadId: "saved-thread" },
]) test(`startup failure is not retried ${options.name}`, { timeout: 10_000 }, async t => {
  const f = await interruptedStartup(t, options);
  if (options.changed) f.state.generation++;
  f.exit();
  assert.match((await f.outcome)?.message ?? "", /without a completed turn/);
  assert.equal(f.count("commands"), 1);
  assert.equal(f.count("relays"), 1);
});

test("cancelling an interrupted startup stops without waiting for private control or retrying", { timeout: 10_000 }, async t => {
  const f = await interruptedStartup(t);
  f.state.waiting = true; f.state.generation++;
  f.exit();
  await new Promise(resolve => setTimeout(resolve, 200));
  f.abort.abort();
  assert.match((await f.outcome)?.message ?? "", /Task cancelled/);
  assert.equal(f.count("relays"), 1);
});

test("one control interruption cannot authorize repeated native startup retries", { timeout: 10_000 }, async t => {
  const f = await interruptedStartup(t, { failAgain: true });
  f.state.generation++; f.exit();
  await until(() => f.count("commands") === 2, "interrupted startup did not retry");
  f.exit(2);
  assert.match((await f.outcome)?.message ?? "", /without a completed turn/);
  assert.equal(f.count("commands"), 2);
});

test("manual daemon takeover before any MCP call records the interruption and resumes untouched guest startup", { timeout: 15_000 }, async t => {
  const cli = startupCli();
  const previousPath = process.env.MODELBOT_TOOL_PATH, previousFake = process.env.MODELBOT_TEST_FAKE_COMPUTER;
  process.env.MODELBOT_TOOL_PATH = cli.home; process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
  const daemon = await startDaemon({ port: 0, mcpToken: "startup-daemon-mcp", bootstrapToken: "startup-daemon-boot", workspaceRoot: cli.path("workspace"), nativeExecutionLocation: "computer",
    codexRunner: { model: "gpt-6-astra", codexHome: cli.home, runsRoot: cli.path("runs"), execution_location: "computer" } });
  t.after(async () => {
    await daemon.close();
    if (previousPath === undefined) delete process.env.MODELBOT_TOOL_PATH; else process.env.MODELBOT_TOOL_PATH = previousPath;
    if (previousFake === undefined) delete process.env.MODELBOT_TEST_FAKE_COMPUTER; else process.env.MODELBOT_TEST_FAKE_COMPUTER = previousFake;
    rmSync(cli.home, { recursive: true, force: true });
  });
  const { headers } = await bootstrapSession(daemon, "startup-daemon-boot");
  const post = (path: string, body: unknown = {}) => fetch(daemon.baseUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
  const created = await post("/api/v1/computers", { name: "Synthetic", capabilities: ["browser"] });
  assert.equal(created.status, 201, await created.clone().text());
  const { computer } = await created.json() as { computer: { id: string } };
  const started = await post("/api/v1/tasks", { computer_id: computer.id, goal: "Save the public report once." });
  assert.equal(started.status, 201, await started.clone().text());
  const { task } = await started.json() as { task: { id: string } };
  await until(() => existsSync(cli.path("entered")), "guest never entered startup");
  const thread = () => daemon.store.db.prepare("SELECT body_json FROM steps WHERE task_id = ? AND kind = 'runner_session'").get(task.id);
  assert.equal(thread(), undefined);
  assert.equal(daemon.store.harnessBindingForTask(task.id)?.observed_tool_calls, 0);
  const requested = await post("/api/v1/takeover/request", { computer_id: computer.id, task_id: task.id });
  assert.equal(requested.status, 200, await requested.clone().text());
  const { takeover } = await requested.json() as { takeover: { takeover_id: string } };
  assert.equal((await post(`/api/v1/takeover/${takeover.takeover_id}/grant`)).status, 200);
  writeFileSync(cli.path("exit-1"), "yes");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(readFileSync(cli.path("private"), "utf8"), "pause");
  assert.equal(readFileSync(cli.path("commands"), "utf8"), "1");
  assert.equal(daemon.store.getTask(task.id)?.status, "running");
  assert.equal((await post(`/api/v1/takeover/${takeover.takeover_id}/release`)).status, 200);
  await until(() => Boolean(thread()), "manual takeover never restarted untouched startup");
  assert.equal(readFileSync(cli.path("private"), "utf8"), "resume");
  assert.equal(readFileSync(cli.path("commands"), "utf8"), "2");
  assert.equal(daemon.store.getTask(task.id)?.status, "running");
  assert.equal((await post(`/api/v1/tasks/${task.id}/cancel`)).status, 200);
});
