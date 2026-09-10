/** Native model CLIs live in the computer. Only scoped MCP crosses Docker stdio. */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDockerCli, type DockerCli } from "../sandbox/docker.ts";
import { detectRuntime } from "../sandbox/detect.ts";
import { resourceNames } from "../sandbox/names.ts";
import { runMcpStdioBridge } from "../mcp/stdio-bridge.ts";
import type { NativeProvider } from "../types/contracts.ts";

const entry = "/opt/computer-server/src/native-process.ts";
export const GUEST_CODEX_HOME = "/home/agent/.codex";
export const GUEST_CLAUDE_HOME = "/home/agent/.claude";
const pendingCleanup = new Map<string, { computerId: string; stop(): Promise<void> }>();

async function finishGuestCleanup(computerId: string): Promise<void> {
  for (const cleanup of [...pendingCleanup.values()]) if (cleanup.computerId === computerId) await cleanup.stop();
}

function execArgs(computerId: string, command: string[]): string[] {
  return ["exec", "-i", "--user", "1002:1002", "--workdir", "/workspace",
    "--env", "HOME=/home/agent", "--env", `CODEX_HOME=${GUEST_CODEX_HOME}`,
    "--env", `CLAUDE_CONFIG_DIR=${GUEST_CLAUDE_HOME}`,
    resourceNames(computerId).containerBrowser, ...command];
}

async function docker() { return createDockerCli(await detectRuntime()); }

function managedSpawn(cli: DockerCli, computerId: string, provider: string, args: string[], id: string, mode: "run" | "exec") {
  const child = cli.spawn(execArgs(computerId, ["/usr/bin/tini", "-s", "--", "node", entry, mode, id, provider, ...args]));
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    pendingCleanup.set(id, { computerId, stop });
    return stopping = (async () => {
      child.stdin?.destroy();
      const cleanup = cli.spawn(execArgs(computerId, ["node", entry, "stop", id]));
      cleanup.stdout?.resume(); cleanup.stderr?.resume();
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Guest cleanup could not be confirmed. Stop this computer before starting another task.")), 5000);
          const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
          cleanup.once("error", () => finish(new Error("Guest cleanup could not start.")));
          cleanup.once("close", code => finish(code === 0 ? undefined : new Error("Guest cleanup could not be confirmed. Stop this computer before starting another task.")));
        });
      } finally { cleanup.kill("SIGKILL"); child.kill("SIGKILL"); }
      pendingCleanup.delete(id);
    })().catch(error => { stopping = undefined; throw error; });
  };
  return { child, stop };
}

/** Stock guest auth/catalog commands with passthrough streams and guest-tree cleanup. */
export async function guestSpawn(computerId: string, provider: NativeProvider, args: string[]): Promise<{ child: ChildProcess; stop(): Promise<void> }> {
  await finishGuestCleanup(computerId);
  return managedSpawn(await docker(), computerId, provider, args, randomUUID(), "exec");
}

/** Acknowledges only after model-owned processes stop/resume; the operator desktop stays alive. */
export async function setGuestComputerPaused(computerId: string, paused: boolean): Promise<void> {
  // A cancelled frozen child must be killed, not resumed after a Docker error.
  if (!paused) await finishGuestCleanup(computerId);
  await (await docker()).run(execArgs(computerId, ["node", entry, paused ? "pause" : "resume", randomUUID()]));
}

export async function startGuestNativeTask(options: {
  computerId: string;
  provider: NativeProvider;
  url: string;
  token: string;
  signal?: AbortSignal;
  args(mcp: { command: string; args: string[] }): string[];
  cli?: DockerCli;
}) {
  options.signal?.throwIfAborted();
  await finishGuestCleanup(options.computerId);
  options.signal?.throwIfAborted();
  const cli = options.cli ?? await docker();
  const id = randomUUID();
  const relayControl = managedSpawn(cli, options.computerId, "node", [entry, "mcp-listen", id], randomUUID(), "exec");
  const relay = relayControl.child;
  if (!relay.stdin || !relay.stdout || !relay.stderr) throw new Error("Guest MCP pipe could not start.");
  let bridge: Awaited<ReturnType<typeof runMcpStdioBridge>> | undefined;
  let command: ReturnType<typeof managedSpawn> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await command?.stop(); }
    finally {
      try { await bridge?.close(); }
      finally { await relayControl.stop(); }
    }
  })().catch(error => { closing = undefined; throw error; });
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = "";
      const unavailable = () => new Error("This computer could not start its native tools. Check that it is running and its image is current.");
      const timer = setTimeout(() => finish(unavailable()), 10_000);
      const abort = () => finish(new Error("Task cancelled"));
      const finish = (error?: Error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
      relay.once("error", finish);
      relay.once("exit", () => finish(unavailable()));
      relay.stderr!.on("data", (bytes: Buffer) => {
        ready = (ready + bytes.toString()).slice(-256);
        if (ready.includes("BOTHEARTH_MCP_READY")) finish();
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    bridge = await runMcpStdioBridge({ endpoint: options.url, mcpToken: options.token, input: relay.stdout, output: relay.stdin, signal: options.signal });
    options.signal?.throwIfAborted();
    const args = options.args({ command: "node", args: [entry, "mcp-connect", id] });
    command = managedSpawn(cli, options.computerId, options.provider, args, id, "run");
    const child = command.child;
    child.stderr?.resume();
    relay.once("exit", () => { child?.stdin?.destroy(); });
    // No operator/session bearer or host HOME is present in the guest argv/env.
    return { child, async stop() { await close(); },
      prompt(text: string) { child.stdin!.write(JSON.stringify({ prompt: text }) + "\n"); } };
  } catch (error) { await close(); throw error; }
}
