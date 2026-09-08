/**
 * Runtime detection: OrbStack → Colima → Docker Desktop → Podman.
 * Pure parsers exported for unit tests; live detect probes CLI/context/socket.
 */

import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { toolPath } from "../daemon/resolve-tool.ts";

export type RuntimeKind = "orbstack" | "colima" | "docker" | "podman";

export interface DetectedRuntime {
  kind: RuntimeKind;
  /** CLI used for container ops (`docker` or `podman`). */
  binary: string;
  context?: string;
  socket?: string;
  detail?: string;
}

export interface ProbeResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Runner = (
  bin: string,
  args: string[],
) => Promise<ProbeResult>;

async function defaultRunner(bin: string, args: string[]): Promise<ProbeResult> {
  return await new Promise((resolve) => {
    // A GUI launch inherits launchd's PATH; resolve the tool explicitly.
    const child = spawn(toolPath(bin), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      resolve({
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        code: 127,
      });
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code: code ?? 1,
      });
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Parse `docker context ls` / `docker context show` style output. */
export function parseDockerContextList(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const names: string[] = [];
  for (const line of lines) {
    if (/^NAME\b/i.test(line) || /^NAME\s+TYPE/i.test(line)) continue;
    // `docker context ls` → first column; `*` marks current
    const cleaned = line.replace(/^\*\s*/, "");
    const name = cleaned.split(/\s+/)[0];
    if (name) names.push(name.toLowerCase());
  }
  return names;
}

export function parseDockerContextShow(stdout: string): string {
  return stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Parse `docker info` / `docker version` Operating System / Name fields. */
export function parseDockerInfoKind(
  infoStdout: string,
): RuntimeKind | null {
  const text = infoStdout.toLowerCase();
  if (text.includes("orbstack")) return "orbstack";
  if (text.includes("colima")) return "colima";
  if (
    text.includes("docker desktop") ||
    text.includes("dockerdesktop") ||
    /\bdesktop\b/.test(text) && text.includes("docker")
  ) {
    return "docker";
  }
  return null;
}

export interface DetectFixtures {
  contextList?: string;
  contextShow?: string;
  dockerInfo?: string;
  orbctlOk?: boolean;
  colimaOk?: boolean;
  orbSocket?: boolean;
  colimaSocket?: boolean;
  podmanOk?: boolean;
  dockerOk?: boolean;
}

/**
 * Pure decision from sample probe outputs (unit-testable).
 * Order: OrbStack → Colima → Docker Desktop → Podman.
 */
export function decideRuntime(f: DetectFixtures): DetectedRuntime | null {
  if (f.orbctlOk || f.orbSocket) {
    return {
      kind: "orbstack",
      binary: "docker",
      context: "orbstack",
      socket: join(homedir(), ".orbstack", "run", "docker.sock"),
      detail: f.orbctlOk ? "orbctl present" : "orbstack socket",
    };
  }
  const contexts = f.contextList
    ? parseDockerContextList(f.contextList)
    : [];
  const current = f.contextShow
    ? parseDockerContextShow(f.contextShow)
    : "";
  if (
    contexts.includes("orbstack") ||
    current === "orbstack" ||
    (f.dockerInfo && parseDockerInfoKind(f.dockerInfo) === "orbstack")
  ) {
    return {
      kind: "orbstack",
      binary: "docker",
      context: current || "orbstack",
      detail: "docker context/info",
    };
  }

  if (f.colimaOk || f.colimaSocket) {
    return {
      kind: "colima",
      binary: "docker",
      context: "colima",
      socket: join(homedir(), ".colima", "default", "docker.sock"),
      detail: f.colimaOk ? "colima present" : "colima socket",
    };
  }
  if (
    contexts.includes("colima") ||
    current === "colima" ||
    (f.dockerInfo && parseDockerInfoKind(f.dockerInfo) === "colima")
  ) {
    return {
      kind: "colima",
      binary: "docker",
      context: current || "colima",
      detail: "docker context/info",
    };
  }

  if (f.dockerOk) {
    const fromInfo = f.dockerInfo
      ? parseDockerInfoKind(f.dockerInfo)
      : null;
    if (fromInfo === "docker" || fromInfo === null) {
      return {
        kind: "docker",
        binary: "docker",
        context: current || undefined,
        detail: fromInfo === "docker" ? "Docker Desktop" : "docker engine",
      };
    }
  }

  if (f.podmanOk) {
    return {
      kind: "podman",
      binary: "podman",
      detail: "podman info",
    };
  }

  // docker present but not classified → still docker
  if (f.dockerOk) {
    return {
      kind: "docker",
      binary: "docker",
      context: current || undefined,
      detail: "docker fallback",
    };
  }

  return null;
}

export async function detectRuntime(
  runner: Runner = defaultRunner,
): Promise<DetectedRuntime> {
  const home = homedir();
  const orbSocket = join(home, ".orbstack", "run", "docker.sock");
  const colimaSocket = join(home, ".colima", "default", "docker.sock");

  const orbctl = await runner("orbctl", ["version"]);
  const colima = await runner("colima", ["status"]);
  const ctxList = await runner("docker", ["context", "ls"]);
  const ctxShow = await runner("docker", ["context", "show"]);
  const info = await runner("docker", ["info"]);
  const podman = await runner("podman", ["info"]);

  const decided = decideRuntime({
    orbctlOk: orbctl.code === 0,
    orbSocket: await pathExists(orbSocket),
    colimaOk: colima.code === 0,
    colimaSocket: await pathExists(colimaSocket),
    contextList: ctxList.code === 0 ? ctxList.stdout : undefined,
    contextShow: ctxShow.code === 0 ? ctxShow.stdout : undefined,
    dockerInfo: info.code === 0 ? info.stdout : undefined,
    dockerOk: info.code === 0 || ctxShow.code === 0,
    podmanOk: podman.code === 0,
  });

  if (!decided) {
    throw new Error(
      "no container runtime detected (tried OrbStack → Colima → Docker → Podman)",
    );
  }
  return decided;
}
