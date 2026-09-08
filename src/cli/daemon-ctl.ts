/**
 * Daemon process control: `--daemon`, stop, status.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfigDoc } from "../config/load.ts";
import { configPath, logPath, modelbotHome, parseFlags, pidPath } from "./paths.ts";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** A graceful close takes ~5s: closing browsers, draining runs, flushing the audit tail. */
const SHUTDOWN_WAIT_MS = 10_000;

function rotateLogIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    const rotated = `${path}.1`;
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(path, rotated);
  } catch {
    /* ignore */
  }
}

function readPid(home?: string): number | null {
  const p = pidPath(modelbotHome(home));
  if (!existsSync(p)) return null;
  const n = Number(readFileSync(p, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function writePid(pid: number, home?: string): void {
  const homeDir = modelbotHome(home);
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(pidPath(homeDir), `${pid}\n`, { encoding: "utf8" });
}

function clearPid(home?: string): void {
  const p = pidPath(modelbotHome(home));
  if (existsSync(p)) unlinkSync(p);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the pid file only when it still names this process. The daemon calls this
 * as it exits; between its SIGTERM and that moment a new daemon may already have
 * written its own pid, and deleting that would hide a live daemon.
 */
export function clearOwnPid(home?: string): void {
  if (readPid(home) === process.pid) clearPid(home);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** Where the daemon would listen: flags, then env, then the config file. */
export function daemonAddress(extraArgs: string[] = [], home?: string): { host: string; port: number } {
  const { flags } = parseFlags(extraArgs);
  let host = flags.host ?? process.env.MODELBOT_HOST ?? process.env.MODELBOT_BIND;
  let port = Number(flags.port ?? process.env.MODELBOT_PORT ?? NaN);
  const cfg = configPath(modelbotHome(home));
  if ((!host || !Number.isFinite(port)) && existsSync(cfg)) {
    const doc = loadConfigDoc(cfg);
    if (!host && typeof doc.bind === "string") host = doc.bind;
    if (!Number.isFinite(port) && typeof doc.port === "number") port = doc.port;
  }
  return { host: host || "127.0.0.1", port: Number.isFinite(port) ? port : 7777 };
}

/** The only proof a daemon is serving: something accepts a connection on its port. */
export function isListening(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Clear the way for a new daemon. A pid file only proves a process once existed:
 * the pid may be dead (crash, or a daemon that predates the exit cleanup), or
 * alive but mid-shutdown, which takes seconds and ends with the port free. Only a
 * process that still answers on its port is a daemon that is actually running.
 */
export async function awaitFreeDaemonSlot(
  extraArgs: string[],
  home: string | undefined,
  log: (line: string) => void = console.log,
  waitMs = SHUTDOWN_WAIT_MS,
): Promise<void> {
  const homeDir = modelbotHome(home);
  const pid = readPid(homeDir);
  if (!pid) return;
  if (isPidAlive(pid)) {
    const { host, port } = daemonAddress(extraArgs, homeDir);
    if (await isListening(host, port)) throw new Error(`daemon already running pid=${pid}`);
    log(`daemon pid=${pid} is shutting down; waiting up to ${Math.round(waitMs / 1000)}s for it to exit`);
    if (!(await waitForExit(pid, waitMs))) {
      throw new Error(`daemon pid=${pid} is still shutting down after ${Math.round(waitMs / 1000)}s; retry once it exits`);
    }
  }
  clearPid(homeDir);
}

export async function runStop(argv: string[] = []): Promise<void> {
  const home = parseFlags(argv).flags.home;
  const pid = readPid(home);
  if (!pid) {
    console.log("status: not running (no pid file)");
    return;
  }
  if (!isPidAlive(pid)) {
    clearPid(home);
    console.log(`status: stale pid ${pid} cleared`);
    return;
  }
  process.kill(pid, "SIGTERM");
  // Leave the pid file in place if it is still shutting down, so the next
  // `start --daemon` waits for the port instead of colliding with it.
  if (!(await waitForExit(pid, SHUTDOWN_WAIT_MS))) {
    console.log(`sent SIGTERM to pid ${pid}; still shutting down after ${SHUTDOWN_WAIT_MS / 1000}s`);
    process.exitCode = 1;
    return;
  }
  // The daemon clears its own pid file as it exits; this covers one started
  // before that did.
  clearPid(home);
  console.log(`stopped pid ${pid}`);
}

export async function runStatus(argv: string[] = []): Promise<void> {
  const home = parseFlags(argv).flags.home;
  const pid = readPid(home);
  if (!pid) {
    console.log("status: stopped");
    process.exitCode = 1;
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(`status: dead (stale pid ${pid})`);
    process.exitCode = 1;
    return;
  }
  console.log(`status: running pid=${pid}`);
}

/**
 * Parent Node flags safe to copy onto the detached daemon.
 * Drops `--inspect*` so the vault-holding process does not open a debugger.
 */
export function filterDaemonExecArgv(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i]!;
    if (/^--inspect/.test(a)) continue;
    if (a === "--experimental-strip-types" || a === "--no-warnings") {
      out.push(a);
      continue;
    }
    if (a === "--conditions" || a.startsWith("--conditions=")) {
      out.push(a);
      const next = execArgv[i + 1];
      if (a === "--conditions" && next && !next.startsWith("-")) {
        out.push(next);
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Spawn detached foreground `start` with pid file + appending log, and return
 * the link from its ready handshake. The child's stdout is the log file, so the
 * one-time token exists only in this IPC message and whatever the caller prints.
 */
export async function spawnDaemon(
  extraArgs: string[],
  home?: string,
  execArgv: readonly string[] = process.execArgv,
): Promise<{ pid: number; bootstrapUrl: string }> {
  const homeDir = modelbotHome(home);
  await awaitFreeDaemonSlot(extraArgs, homeDir);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const logFile = logPath(homeDir);
  for (const path of [logFile, `${logFile}.1`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  rotateLogIfNeeded(logFile);
  const fd = openSync(logFile, "a", 0o600);

  const self = fileURLToPath(new URL(import.meta.url.endsWith(".js") ? "./index.js" : "./index.ts", import.meta.url));
  const forwarded = extraArgs.filter(
    (a, i, arr) =>
      a !== "--daemon" &&
      a !== "--home" &&
      arr[i - 1] !== "--home",
  );
  let child;
  try {
    child = spawn(
      process.execPath,
      [...filterDaemonExecArgv(execArgv), self, "start", ...forwarded],
      {
        detached: true,
        stdio: ["ignore", fd, fd, "ipc"],
        env: { ...process.env, MODELBOT_HOME: homeDir },
      },
    );
  } finally {
    closeSync(fd);
  }
  const bootstrapUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`daemon startup timed out; see ${logFile}`));
    }, 30_000);
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (child.connected) child.disconnect();
      if (error) reject(error);
      else resolve(url!);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`daemon exited before ready (${code}); see ${logFile}`));
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const ready = message as { type?: unknown; bootstrap_url?: unknown };
      if (ready.type !== "modelbot.ready") return;
      if (typeof ready.bootstrap_url !== "string" || !ready.bootstrap_url) {
        finish(new Error(`daemon ready message carried no link; see ${logFile}`));
        return;
      }
      finish(undefined, ready.bootstrap_url);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
  if (child.pid == null) throw new Error("failed to spawn daemon");
  writePid(child.pid, homeDir);
  child.unref();
  return { pid: child.pid, bootstrapUrl };
}
