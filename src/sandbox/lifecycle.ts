import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureWorkspaceBrowserWritable } from "./workspace-perm.ts";
import type {
  ComputerCapability,
  SandboxCreateOpts,
  SandboxHandle,
  SandboxRuntime,
  SandboxRuntimeKind,
} from "../types/contracts.ts";
import { detectRuntime, type DetectedRuntime } from "./detect.ts";
import { createDockerCli, DockerError, runIgnore, type DockerCli } from "./docker.ts";
import {
  browserCreateArgs,
  collectPersistedInternalSubnets,
  forceAllocateInternalDnsPlan,
  inspectArgs,
  isPoolOverlapMessage,
  loadPersistedInternalDnsPlan,
  networkCreateArgs,
  networkRmArgs,
  pauseArgs,
  probeUsedInternalSubnets,
  profileVolumeCreateArgs,
  proxyConnectInternalArgs,
  proxyCreateArgs,
  resolveInternalDnsPlan,
  rmArgs,
  shellCreateArgs,
  startArgs,
  stopArgs,
  unpauseArgs,
  volumeRmArgs,
  type FlagBuildOpts,
  type InternalDnsPlan,
} from "./flags.ts";
import { resourceNames, sanitizeComputerName } from "./names.ts";
import { BUILD_STAMP_LABEL } from "../daemon/build-stamp.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

export function defaultSeccompPath(): string {
  return join(REPO_ROOT, "sandbox", "seccomp-chromium.json");
}

export function defaultWorkspaceRoot(): string {
  return join(homedir(), "ModelBot", "computers");
}

export function workspaceHostPath(
  name: string,
  workspaceRoot = defaultWorkspaceRoot(),
): string {
  return join(workspaceRoot, sanitizeComputerName(name), "workspace");
}

export interface LifecycleOpts {
  runtime?: DetectedRuntime;
  cli?: DockerCli;
  workspaceRoot?: string;
  seccompPath?: string;
  browserImage?: string;
  shellImage?: string;
  proxyImage?: string;
}

export interface DestroyOpts {
  /** Keep named profile volume (default true). Workspace always kept. */
  keepProfile?: boolean;
}

async function resolveCli(opts: LifecycleOpts = {}): Promise<{
  runtime: DetectedRuntime;
  cli: DockerCli;
}> {
  const runtime = opts.runtime ?? (await detectRuntime());
  const cli = opts.cli ?? createDockerCli(runtime);
  return { runtime, cli };
}

function toFlagOpts(
  name: string,
  workspaceHost: string,
  opts: LifecycleOpts,
  dnsPlan?: InternalDnsPlan,
): FlagBuildOpts {
  const seccompPath = opts.seccompPath ?? defaultSeccompPath();
  if (seccompPath.trim().toLowerCase() === "unconfined") {
    throw new Error("sandbox: seccomp=unconfined is forbidden");
  }
  return {
    name,
    workspaceHost,
    workspaceGid: statSync(workspaceHost).gid,
    seccompPath,
    browserImage: opts.browserImage,
    shellImage: opts.shellImage,
    proxyImage: opts.proxyImage,
    dnsPlan,
  };
}

function capsOf(opts: SandboxCreateOpts): ComputerCapability[] {
  return opts.capabilities?.length
    ? opts.capabilities
    : (["browser", "shell"] as ComputerCapability[]);
}

export async function createComputer(
  name: string,
  createOpts: Omit<SandboxCreateOpts, "name"> = {
    capabilities: ["browser", "shell"],
  },
  life: LifecycleOpts = {},
): Promise<SandboxHandle> {
  const n = sanitizeComputerName(name);
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  const caps = capsOf({ name: n, ...createOpts });
  const workspaceHost = workspaceHostPath(n, life.workspaceRoot);
  await mkdir(workspaceHost, { recursive: true, mode: 0o700 });
  ensureWorkspaceBrowserWritable(workspaceHost);
  const workspaceRoot = life.workspaceRoot ?? defaultWorkspaceRoot();
  const probed = await probeUsedInternalSubnets(cli);
  const used = new Set<string>([...collectPersistedInternalSubnets(workspaceRoot), ...probed]);
  const own = loadPersistedInternalDnsPlan(workspaceHost);
  if (own) used.delete(own.subnet);
  let dnsPlan = resolveInternalDnsPlan(n, used, workspaceHost);

  try {
    await runIgnore(cli, networkCreateArgs(n, "internal", dnsPlan), ["already exists"]);
  } catch (e) {
    const msg = e instanceof DockerError ? `${e.stderr} ${e.message}` : String(e);
    if (!isPoolOverlapMessage(msg)) throw e;
    used.add(dnsPlan.subnet);
    dnsPlan = forceAllocateInternalDnsPlan(n, used, workspaceHost);
    await runIgnore(cli, networkCreateArgs(n, "internal", dnsPlan), ["already exists"]);
  }
  const fo = toFlagOpts(n, workspaceHost, life, dnsPlan);
  await runIgnore(cli, networkCreateArgs(n, "egress"), ["already exists"]);

  if (caps.includes("browser")) {
    await runIgnore(cli, profileVolumeCreateArgs(n), ["already exists"]);
    await cli.run(["volume", "create", "--label", `${r.label}=${n}`, r.volumeAgentHome]);
  }

  await runIgnore(cli, ["rm", "-f", r.containerProxy], ["no such"]);
  await cli.run(proxyCreateArgs(fo));
  await runIgnore(cli, proxyConnectInternalArgs(n, dnsPlan), [
    "already exists",
    "already connected",
  ]);

  if (caps.includes("browser")) {
    await runIgnore(cli, ["rm", "-f", r.containerBrowser], ["no such"]);
    await cli.run(browserCreateArgs(fo));
  }
  if (caps.includes("shell")) {
    await runIgnore(cli, ["rm", "-f", r.containerShell], ["no such"]);
    await cli.run(shellCreateArgs(fo));
  }

  await startComputer(n, life);
  return { computer_id: n, name: n, capabilities: caps };
}

export async function startComputer(
  name: string,
  life: LifecycleOpts = {},
): Promise<void> {
  const n = sanitizeComputerName(name);
  ensureWorkspaceBrowserWritable(workspaceHostPath(n, life.workspaceRoot));
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  for (const c of [r.containerProxy, r.containerBrowser, r.containerShell]) {
    try {
      await runIgnore(cli, startArgs(c), ["no such", "already started", "is already running"]);
    } catch (error) {
      if (!/cannot start a paused container/i.test(String(error))) throw error;
      await cli.run(unpauseArgs(c));
    }
  }
  try {
    const inspected = JSON.parse(await cli.run(inspectArgs(r.containerBrowser))) as Array<{
      HostConfig?: { SecurityOpt?: string[] | null };
    }>;
    const security = inspected[0]?.HostConfig?.SecurityOpt ?? [];
    if (
      security.some((item) => item.toLowerCase().includes("unconfined")) ||
      !security.some((item) => item.toLowerCase().startsWith("seccomp="))
    ) {
      throw new Error(
        "sandbox: browser started without the shipped seccomp profile; runtime rejected hardening",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such (object|container)/i.test(message)) throw error;
  }
}

/**
 * A container pins the image *id* it was created from, so rebuilding a tag
 * never reaches a computer that already exists: the default browser is
 * `persistent: true` and outlives every rebuild, so the app
 * kept running a computer that had never heard of `write_file` while the daemon
 * offered the model that tool.
 *
 * Compare our build stamps first: Docker's OCI index, platform manifest and
 * config IDs can differ for the same image. Without stamps, Docker must resolve
 * both identities before a mismatch is evidence for recreating a computer.
 */
export async function computerImageDrifted(
  name: string,
  life: LifecycleOpts = {},
): Promise<boolean> {
  const n = sanitizeComputerName(name);
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  const tagImages = new Map<string, { id: string; stamp: string } | null>();
  const stampFormat = `{{index .Config.Labels ${JSON.stringify(BUILD_STAMP_LABEL)}}}`;
  for (const [container, desiredTag] of [[r.containerBrowser, life.browserImage], [r.containerShell, life.shellImage], [r.containerProxy, life.proxyImage]] as const) {
    let running = "";
    let tag = "";
    let stamp = "";
    try {
      const out = await cli.run(["inspect", "-f", `{{.Image}}|{{.Config.Image}}|${stampFormat}`, container]);
      [running = "", tag = "", stamp = ""] = out.trim().split("|");
    } catch {
      continue; // No such container: nothing to be out of date.
    }
    if (!running || !tag) continue;
    tag = desiredTag ?? tag;
    if (!tagImages.has(tag)) {
      tagImages.set(
        tag,
        await cli
          .run(["image", "inspect", "-f", `{{.Id}}|${stampFormat}`, tag])
          .then((out) => {
            const [id = "", stamp = ""] = out.trim().split("|");
            return id ? { id, stamp } : null;
          })
          // A tag that no longer resolves cannot prove drift; prepare will
          // rebuild it, and claiming drift here would recreate on every boot.
          .catch(() => null),
      );
    }
    const current = tagImages.get(tag);
    if (!current) continue;
    if (/^[a-f0-9]{16}$/.test(stamp) && /^[a-f0-9]{16}$/.test(current.stamp)) {
      if (stamp !== current.stamp) return true;
      continue;
    }
    if (current.id === running) continue;
    // Recent Docker exposes the exact platform manifest the container pins.
    // Resolve the tag for that platform rather than comparing it to an index.
    const manifest = await cli.run(["inspect", "-f", "{{json .ImageManifestDescriptor}}", container])
      .then(out => JSON.parse(out) as { digest?: string; platform?: { os?: string; architecture?: string; variant?: string } } | null)
      .catch(() => null);
    if (manifest?.digest && manifest.platform?.os && manifest.platform.architecture) {
      const platform = [manifest.platform.os, manifest.platform.architecture, manifest.platform.variant].filter(Boolean).join("/");
      const platformId = await cli.run(["image", "inspect", "--platform", platform, "-f", "{{.Id}}", tag])
        .then(out => out.trim()).catch(() => "");
      if (platformId) {
        if (platformId !== manifest.digest) return true;
        continue;
      }
    }
    const canonical = await cli.run(["image", "inspect", "-f", "{{.Id}}", running])
      .then(out => out.trim()).catch(() => "");
    if (canonical && canonical !== current.id) return true;
  }
  return false;
}

/**
 * Recreate the computer's containers from the current tags when they have
 * drifted. The workspace directory and the named profile volume are untouched,
 * so the owner keeps their files and their signed-in browser profile; only the
 * containers are replaced. Returns true when a recreate happened.
 */
export async function refreshComputerImage(
  name: string,
  capabilities: ComputerCapability[],
  life: LifecycleOpts = {},
): Promise<boolean> {
  if (!(await computerImageDrifted(name, life))) return false;
  await createComputer(name, { capabilities }, life);
  return true;
}

export async function stopComputer(
  name: string,
  life: LifecycleOpts = {},
): Promise<void> {
  const n = sanitizeComputerName(name);
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  for (const c of [r.containerBrowser, r.containerShell, r.containerProxy]) {
    await runIgnore(cli, stopArgs(c), ["no such", "is not running"]);
  }
}

/** Docker pause browser+shell. The idle timer is the production caller. */
export async function pauseComputer(
  name: string,
  life: LifecycleOpts = {},
): Promise<void> {
  const n = sanitizeComputerName(name);
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  for (const c of [r.containerBrowser, r.containerShell]) {
    await runIgnore(cli, pauseArgs(c), ["no such", "is not running", "paused"]);
  }
}

export async function unpauseComputer(
  name: string,
  life: LifecycleOpts = {},
): Promise<void> {
  const n = sanitizeComputerName(name);
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  for (const c of [r.containerBrowser, r.containerShell]) {
    await runIgnore(cli, unpauseArgs(c), ["no such", "is not paused"]);
  }
}

export async function destroyComputer(
  name: string,
  destroy: DestroyOpts = {},
  life: LifecycleOpts = {},
): Promise<void> {
  const n = sanitizeComputerName(name);
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  const keepProfile = destroy.keepProfile ?? true;

  for (const c of [r.containerBrowser, r.containerShell, r.containerProxy]) {
    await runIgnore(cli, rmArgs(c), ["no such"]);
  }
  await runIgnore(cli, networkRmArgs(r.networkInternal), ["no such", "not found"]);
  await runIgnore(cli, networkRmArgs(r.networkEgress), ["no such", "not found"]);
  if (!keepProfile) {
    await runIgnore(cli, volumeRmArgs(r.volumeProfile), ["no such", "not found"]);
  }
}

export async function inspectComputerContainer(
  name: string,
  role: "browser" | "shell" | "proxy",
  life: LifecycleOpts = {},
): Promise<Record<string, unknown> | null> {
  const n = sanitizeComputerName(name);
  const { cli } = await resolveCli(life);
  const r = resourceNames(n);
  const container =
    role === "browser"
      ? r.containerBrowser
      : role === "shell"
        ? r.containerShell
        : r.containerProxy;
  try {
    const out = await cli.run(inspectArgs(container));
    const arr = JSON.parse(out) as unknown[];
    return (arr[0] as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

export function createSandboxRuntime(life: LifecycleOpts = {}): SandboxRuntime {
  return {
    async detect(): Promise<Exclude<SandboxRuntimeKind, "auto">> {
      const r = life.runtime ?? (await detectRuntime());
      return r.kind;
    },
    async create(opts: SandboxCreateOpts): Promise<SandboxHandle> {
      return await createComputer(opts.name, opts, life);
    },
    async stop(computerId: string): Promise<void> {
      await stopComputer(computerId, life);
    },
    async destroy(computerId: string): Promise<void> {
      await destroyComputer(computerId, { keepProfile: true }, life);
    },
  };
}
