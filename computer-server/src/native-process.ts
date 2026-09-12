/** Guest-only native process control and a Unix-socket/stdio MCP pipe. No TCP listener. */
import { spawn } from "node:child_process";
import { accessSync, readdirSync, unlinkSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type ProcInfo = { parent: number; state: string; start: string; command: string };

export function resolveXauthority(tmpNames: string[], exists: (path: string) => boolean): string {
  for (const name of tmpNames) {
    if (!name.startsWith("modelbot-chromium-")) continue;
    const file = join("/tmp", name, "Xauthority");
    if (exists(file)) return file;
  }
  throw new Error("Desktop display cookie is missing.");
}

export function resolveDesktopEnv(env: NodeJS.ProcessEnv = process.env, tmpNames?: string[], exists?: (path: string) => boolean): NodeJS.ProcessEnv {
  env.DISPLAY ||= ":99";
  try {
    env.XAUTHORITY = resolveXauthority(tmpNames ?? readdirSync("/tmp"), exists ?? (file => {
      try { accessSync(file); return true; } catch { return false; }
    }));
  } catch { delete env.XAUTHORITY; }
  return env;
}

export function isDesktopCommand(command: string): boolean {
  if (command.includes("native-process.ts")) return false;
  return command.includes("/usr/lib/chromium/chromium") || /\bXvfb\b/.test(command)
    || /\bopenbox\b/.test(command) || /\bffmpeg\b/.test(command)
    || command.includes("/opt/computer-server/");
}

export function tree(parent: number, all: Map<number, { parent: number }>) {
  const descendants = new Set([parent]);
  for (;;) {
    const size = descendants.size;
    for (const [pid, info] of all) if (descendants.has(info.parent)) descendants.add(pid);
    if (descendants.size === size) break;
  }
  return descendants;
}

export function controlPids(all: Map<number, ProcInfo>, mode: "pause" | "resume", selfPid: number): number[] {
  const protectedPids = new Set<number>([1]);
  for (const [pid, info] of all) {
    if (info.command.includes("native-process.ts")) continue;
    if (/\btini\b/.test(info.command) || /\bsleep\s+infinity\b/.test(info.command)) protectedPids.add(pid);
    else if (isDesktopCommand(info.command)) for (const child of tree(pid, all)) protectedPids.add(child);
  }
  return [...all].filter(([pid, info]) => pid !== selfPid && !protectedPids.has(pid) && info.state !== "Z"
    && (mode === "pause" ? info.state !== "T" : info.state === "T")).map(([pid]) => pid);
}

const launched = new Set(["pause", "resume", "mcp-listen", "mcp-connect", "stop", "run", "exec"]);
const [mode, id, ...args] = process.argv.slice(2);
const root = "/tmp/bothearth-native";
const agentUid = process.getuid?.();
const skip = !launched.has(mode ?? "");
if (!skip && (process.platform !== "linux" || (agentUid !== 1001 && agentUid !== 1002))) throw new Error("Native process control requires the guest agent user.");
// Shared files inherit the workspace GID; private model homes remain 0700.
if (!skip) process.umask(0o007);
if (!skip && !/^[a-f0-9-]{20,64}$/.test(id ?? "")) throw new Error("Invalid native session id.");
if (!skip) await mkdir(root, { recursive: true, mode: 0o700 });
const socketPath = join(root, `${id}.sock`);
const pidPath = join(root, `${id}.json`);
const pausePath = join(root, "paused");
if (!skip) resolveDesktopEnv();

async function refuseWhilePaused() {
  try { await access(pausePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  process.stderr.write("Native execution is paused for private control.\n");
  process.exit(75);
}

async function processes() {
  const result = new Map<number, ProcInfo>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      if (!new RegExp(`^Uid:\\s+${agentUid}\\s`, "m").test(status)) continue;
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const command = (await readFile(`/proc/${name}/cmdline`)).toString().replace(/\0/g, " ").trim()
        || status.match(/^Name:\s+(\S+)/m)?.[1] || "";
      result.set(Number(name), { state: fields[0]!, parent: Number(fields[1]), start: fields[19]!, command });
    } catch { /* Process exited during the scan. */ }
  }
  return result;
}

function signal(pid: number, sig: NodeJS.Signals) {
  try { process.kill(pid, sig); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function killChildren(parent: number) {
  // A second scan catches children reparented to tini after their parent dies.
  for (let attempt = 0; attempt < 50; attempt++) {
    const all = await processes(), descendants = tree(parent, all);
    const live = [...descendants].filter(pid => pid !== parent && pid !== process.pid && all.get(pid)?.state !== "Z");
    if (!live.length) return;
    for (const pid of live.reverse()) signal(pid, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Native child processes did not stop.");
}

if (mode === "pause" || mode === "resume") {
  // Mark first: a Docker exec created after the final scan must not start a CLI.
  if (mode === "pause") await writeFile(pausePath, "", { mode: 0o600 });
  else await rm(pausePath, { force: true });
  // Freeze every uid-1001 process except the operator desktop (Chromium, Xvfb,
  // openbox, computer-server and their children). Pid1-reparented model tools stay frozen.
  for (let attempt = 0; attempt < 50; attempt++) {
    const remaining = controlPids(await processes(), mode, process.pid);
    if (!remaining.length) break;
    for (const pid of remaining) signal(pid, mode === "pause" ? "SIGSTOP" : "SIGCONT");
    if (attempt === 49) throw new Error("Native processes did not acknowledge control change.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
} else if (mode === "mcp-listen") {
  await refuseWhilePaused();
  // The leader and native executors share this task's tools-only MCP scope.
  // Namespace their JSON-RPC ids so simultaneous clients cannot steal replies.
  const sockets = new Map<number, Socket>();
  let sequence = 0;
  const server = createServer(socket => {
    const client = ++sequence;
    sockets.set(client, socket);
    const input = createInterface({ input: socket });
    input.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) message.id = JSON.stringify([client, message.id]);
        if (message.method === "notifications/cancelled" && message.params?.requestId !== undefined)
          message.params.requestId = JSON.stringify([client, message.params.requestId]);
        process.stdout.write(JSON.stringify(message) + "\n");
      } catch { socket.destroy(); }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(client); input.close(); });
  });
  const replies = createInterface({ input: process.stdin });
  replies.on("line", line => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const [client, original] = JSON.parse(message.id);
        message.id = original;
        sockets.get(client)?.write(JSON.stringify(message) + "\n");
      } else for (const socket of sockets.values()) socket.write(line + "\n");
    } catch { process.exit(1); }
  });
  server.on("error", () => process.exit(1));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(socketPath, resolve);
  });
  process.stderr.write("BOTHEARTH_MCP_READY\n");
  process.stdin.on("end", () => process.exit(0));
  process.on("exit", () => { try { unlinkSync(socketPath); } catch { /* Already removed. */ } });
} else if (mode === "mcp-connect") {
  const socket = connect(socketPath);
  socket.on("error", () => process.exit(1));
  socket.on("close", () => process.exit(0));
  process.stdin.pipe(socket); socket.pipe(process.stdout);
} else if (mode === "stop") {
  let record: { pid: number; start: string };
  try { record = JSON.parse(await readFile(pidPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") process.exit(0); throw error; }
  const all = await processes();
  if (all.get(record.pid)?.start === record.start) {
    // Killing a stopped process does not resume its model tools.
    await killChildren(record.pid);
    signal(record.pid, "SIGKILL");
  }
  await rm(pidPath, { force: true });
} else if (mode === "run" || mode === "exec") {
  await refuseWhilePaused();
  for (const home of [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR]) {
    if (!home) continue;
    try { await mkdir(home, { recursive: true, mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES")
        throw new Error("This computer cannot write /home/agent. Recreate the modelbot-*-agent-home volume or chown it to 1001:1001.");
      throw error;
    }
  }
  const command = args.shift();
  if (!command) throw new Error("Native command is required.");
  // tini --subreaper is our parent, so orphaned tool processes remain descendants
  // of this one task and can be stopped without touching another computer/task.
  const supervisor = process.ppid;
  const start = (await processes()).get(supervisor)?.start;
  if (!start) throw new Error("Native process supervisor is unavailable.");
  await writeFile(pidPath, JSON.stringify({ pid: supervisor, start }), { mode: 0o600, flag: "wx" });
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
    void killChildren(supervisor).finally(() => rm(pidPath, { force: true })).finally(() => process.exit(1));
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  // Keep Docker stdin open after the initial prompt: loss of the host pipe stops
  // the guest model, rather than leaving an unobserved docker-exec process alive.
  const startCommand = (prompt?: string) => {
    resolveDesktopEnv();
    child = spawn(command, args, { detached: true, cwd: "/workspace", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    child.stdout!.pipe(process.stdout);
    // Native diagnostics can contain account data. Keep them inside the model
    // home; only documented JSON display events leave the task runner.
    if (mode === "exec") child.stderr!.pipe(process.stderr);
    else child.stderr!.resume();
    child.once("error", () => { process.stderr.write("Native CLI could not start.\n"); stop(); });
    child.once("close", code => {
      stopping = true;
      if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      void killChildren(supervisor).finally(() => rm(pidPath, { force: true })).finally(() => process.exit(code ?? 1));
    });
    child.stdin!.on("error", () => {});
    if (prompt !== undefined) child.stdin!.end(prompt);
    else process.stdin.pipe(child.stdin!);
  };
  if (mode === "exec") {
    process.stdin.once("end", stop);
    startCommand();
  } else {
    const input = createInterface({ input: process.stdin });
    input.once("close", stop);
    input.once("line", line => {
      const message = JSON.parse(line) as { prompt: string };
      if (typeof message.prompt !== "string") throw new Error("Invalid native prompt.");
      startCommand(message.prompt);
    });
  }
} else if (skip && !process.argv[1]?.endsWith("native-process.ts")) {
  // helpers imported by unit tests
} else throw new Error("Unknown native process operation.");
