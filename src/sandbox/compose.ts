/**
 * Product compose path — same hardening as flags.ts / ARCHITECTURE §9.
 * Daemon stays on the host; never a compose service.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { createDockerCli, type DockerCli } from "./docker.ts";
import { detectRuntime } from "./detect.ts";
import {
  DEFAULT_BROWSER_IMAGE,
  BROWSER_GID,
  DEFAULT_LIMITS,
  DEFAULT_PROXY_IMAGE,
  DEFAULT_SHELL_IMAGE,
  LABEL_COMPUTER,
  PROXY_ENV,
  INTERNAL_DNS_SUBNET,
  INTERNAL_PROXY_IP,
  collectPersistedInternalSubnets,
  forceAllocateInternalDnsPlan,
  internalDnsPlan,
  isPoolOverlapMessage,
  loadPersistedInternalDnsPlan,
  probeUsedInternalSubnets,
  resolveInternalDnsPlan,
  type HardeningLimits,
  type InternalDnsPlan,
} from "./flags.ts";
import {
  defaultSeccompPath,
  defaultWorkspaceRoot,
  workspaceHostPath,
  type LifecycleOpts,
} from "./lifecycle.ts";
import { ensureWorkspaceBrowserWritable } from "./workspace-perm.ts";
import { resourceNames, sanitizeComputerName } from "./names.ts";
import type { ComputerCapability, SandboxHandle } from "../types/contracts.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const COMPOSE_FILE_NAME = "docker-compose.yml";

export function defaultComposeFilePath(repoRoot = REPO_ROOT): string {
  return join(repoRoot, COMPOSE_FILE_NAME);
}

export interface ComposeRenderOpts {
  /** Literal computer name, or "${COMPUTER_NAME}" for the product template. */
  computerName: string;
  /** Absolute workspace host path, or "${WORKSPACE}" for the product template. */
  workspaceHost: string;
  workspaceGid?: number;
  /** Seccomp path relative to compose file / project dir, or absolute. */
  seccompPath?: string;
  browserImage?: string;
  shellImage?: string;
  proxyImage?: string;
  limits?: Partial<HardeningLimits>;
  /** When true, emit ${COMPUTER_NAME} / ${WORKSPACE} placeholders in names. */
  template?: boolean;
  /** Non-template stacks: allocated /24. Template uses ${INTERNAL_SUBNET}. */
  dnsPlan?: InternalDnsPlan;
}

function limitsOf(opts: ComposeRenderOpts): HardeningLimits {
  return { ...DEFAULT_LIMITS, ...opts.limits };
}

function proxyEnvObject(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of PROXY_ENV) out[k] = v;
  return out;
}

function namesFor(opts: ComposeRenderOpts) {
  if (opts.template || opts.computerName.includes("${")) {
    const n = "${COMPUTER_NAME}";
    return {
      name: n,
      networkInternal: `modelbot-${n}-internal`,
      networkEgress: `modelbot-${n}-egress`,
      volumeProfile: `modelbot-${n}-profile`,
      containerBrowser: `modelbot-${n}-browser`,
      containerShell: `modelbot-${n}-shell`,
      containerProxy: `modelbot-${n}-proxy`,
    };
  }
  return resourceNames(opts.computerName);
}

/** Structured compose document — single source for YAML + field asserts. */
function buildComposeSpec(opts: ComposeRenderOpts): Record<string, unknown> {
  const r = namesFor(opts);
  const lim = limitsOf(opts);
  const label = opts.template || opts.computerName.includes("${")
    ? "${COMPUTER_NAME}"
    : sanitizeComputerName(opts.computerName);
  const workspace = opts.workspaceHost;
  const seccomp =
    opts.seccompPath ?? "./sandbox/seccomp-chromium.json";
  const browserImage = opts.browserImage ?? DEFAULT_BROWSER_IMAGE;
  const shellImage = opts.shellImage ?? DEFAULT_SHELL_IMAGE;
  const proxyImage = opts.proxyImage ?? DEFAULT_PROXY_IMAGE;
  // Separate objects so YAML stringify does not emit anchors.
  const browserEnv = proxyEnvObject();
  const shellEnv = proxyEnvObject();
  const plan =
    opts.template || opts.computerName.includes("${")
      ? {
          subnet: "${INTERNAL_SUBNET:-10.233.77.0/24}",
          proxyIp: "${INTERNAL_PROXY_IP:-10.233.77.2}",
        }
      : (opts.dnsPlan ?? internalDnsPlan(r.name));

  return {
    services: {
      proxy: {
        image: proxyImage,
        container_name: r.containerProxy,
        networks: {
          egress: {},
          internal: { ipv4_address: plan.proxyIp },
        },
        restart: "unless-stopped",
        user: "1000:1000",
        read_only: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=64m"],
        mem_limit: "256m",
        cpus: 1,
        pids_limit: 128,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        sysctls: { "net.ipv4.ip_unprivileged_port_start": 0 },
        logging: {
          driver: "json-file",
          options: { "max-size": "1m", "max-file": "3" },
        },
        environment: {
          PROXY_ACCESS_LOG_VERBOSE: "0",
        },
        labels: { [LABEL_COMPUTER]: label },
      },
      browser: {
        image: browserImage,
        container_name: r.containerBrowser,
        user: "1001:1001",
        group_add: [opts.template ? "${WORKSPACE_GID:-1001}" : String(opts.workspaceGid ?? BROWSER_GID)],
        read_only: true,
        tmpfs: [
          "/tmp:rw,noexec,nosuid,nodev,size=512m",
          "/run:rw,noexec,nosuid,nodev,size=16m",
          "/quarantine:rw,noexec,nosuid,nodev,size=128m,mode=0700,uid=1001,gid=1001",
        ],
        shm_size: lim.browserShm,
        mem_limit: lim.browserMemory,
        cpus: lim.browserCpus,
        pids_limit: lim.browserPids,
        cap_drop: ["ALL"],
        security_opt: [
          "no-new-privileges:true",
          `seccomp=${seccomp}`,
        ],
        networks: ["internal"],
        dns: [plan.proxyIp],
        extra_hosts: { proxy: plan.proxyIp },
        environment: browserEnv,
        volumes: [
          "profile:/home/browser/profile",
          `${workspace}:/workspace:rw`,
        ],
        labels: { [LABEL_COMPUTER]: label },
        depends_on: ["proxy"],
      },
      shell: {
        image: shellImage,
        container_name: r.containerShell,
        user: "1002:1002",
        group_add: [opts.template ? "${WORKSPACE_GID:-1001}" : String(opts.workspaceGid ?? BROWSER_GID)],
        read_only: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=256m"],
        mem_limit: lim.shellMemory,
        cpus: lim.shellCpus,
        pids_limit: lim.shellPids,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        networks: ["internal"],
        dns: [plan.proxyIp],
        extra_hosts: { proxy: plan.proxyIp },
        environment: shellEnv,
        volumes: [`${workspace}:/workspace:rw`],
        labels: { [LABEL_COMPUTER]: label },
        depends_on: ["proxy"],
      },
    },
    networks: {
      internal: {
        name: r.networkInternal,
        internal: true,
        ipam: { config: [{ subnet: plan.subnet }] },
      },
      egress: {
        name: r.networkEgress,
      },
    },
    volumes: {
      profile: {
        name: r.volumeProfile,
      },
    },
  };
}

const HEADER = `# ModelBot per-computer stack (ARCHITECTURE §9).
# Daemon runs on the HOST via \`npx modelbot start\` — never a compose service.
# Required env: COMPUTER_NAME, WORKSPACE. INTERNAL_SUBNET / INTERNAL_PROXY_IP default to 10.233.77.0/24 / .2.
# See docs/COMPOSE.md.
`;

function renderComposeYaml(opts: ComposeRenderOpts): string {
  const spec = buildComposeSpec(opts);
  const body = stringifyYaml(spec, {
    lineWidth: 120,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
    singleQuote: false,
  });
  return `${HEADER}${body}`;
}

/** Product template with ${COMPUTER_NAME} / ${WORKSPACE} placeholders. */
export function renderProductComposeYaml(
  seccompPath = "./sandbox/seccomp-chromium.json",
): string {
  return renderComposeYaml({
    computerName: "${COMPUTER_NAME}",
    workspaceHost: "${WORKSPACE}",
    seccompPath,
    template: true,
  });
}

async function writeProductComposeFile(
  path = defaultComposeFilePath(),
): Promise<string> {
  const yaml = renderProductComposeYaml();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, yaml, "utf8");
  return path;
}

export interface ComposeLifecycleOpts extends LifecycleOpts {
  composeFile?: string;
  projectDirectory?: string;
  cli?: DockerCli;
}

async function resolveComposeCli(
  opts: ComposeLifecycleOpts,
): Promise<{ cli: DockerCli; composeFile: string; projectDir: string }> {
  const runtime = opts.runtime ?? (await detectRuntime());
  const cli = opts.cli ?? createDockerCli(runtime);
  const composeFile = opts.composeFile ?? defaultComposeFilePath(REPO_ROOT);
  const projectDir = opts.projectDirectory ?? dirname(composeFile);
  return { cli, composeFile, projectDir };
}

export function composeComputerEnv(
  name: string,
  workspaceHost: string,
  plan: InternalDnsPlan,
  workspaceGid = BROWSER_GID,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPUTER_NAME: name,
    WORKSPACE: workspaceHost,
    WORKSPACE_GID: String(workspaceGid),
    INTERNAL_SUBNET: plan.subnet,
    INTERNAL_PROXY_IP: plan.proxyIp,
  };
}

function composeUpArgs(
  composeFile: string,
  projectName: string,
): string[] {
  return [
    "compose",
    "-f",
    composeFile,
    "-p",
    projectName,
    "up",
    "-d",
    "--remove-orphans",
  ];
}

function composeDownArgs(
  composeFile: string,
  projectName: string,
  removeVolumes = false,
): string[] {
  const args = ["compose", "-f", composeFile, "-p", projectName, "down"];
  if (removeVolumes) args.push("-v");
  return args;
}

export function composeConfigArgs(composeFile: string): string[] {
  return ["compose", "-f", composeFile, "config"];
}

function composeProjectName(computerName: string): string {
  return `modelbot-${sanitizeComputerName(computerName)}`;
}

/**
 * Create computer via compose (alternative to direct docker create argv).
 * Uses the same resource names as flags.ts so inspect/exec keep working.
 */
export async function createComputerCompose(
  name: string,
  createOpts: { capabilities?: ComputerCapability[] } = {
    capabilities: ["browser", "shell"],
  },
  life: ComposeLifecycleOpts = {},
): Promise<SandboxHandle> {
  const n = sanitizeComputerName(name);
  const caps = createOpts.capabilities?.length
    ? createOpts.capabilities
    : (["browser", "shell"] as ComputerCapability[]);
  const workspaceHost = workspaceHostPath(n, life.workspaceRoot ?? defaultWorkspaceRoot());
  await mkdir(workspaceHost, { recursive: true, mode: 0o700 });
  ensureWorkspaceBrowserWritable(workspaceHost);
  const workspaceGid = statSync(workspaceHost).gid;

  const { cli, composeFile, projectDir } = await resolveComposeCli(life);
  const workspaceRoot = life.workspaceRoot ?? defaultWorkspaceRoot();
  const probed = await probeUsedInternalSubnets(cli);
  const used = new Set<string>([...collectPersistedInternalSubnets(workspaceRoot), ...probed]);
  const own = loadPersistedInternalDnsPlan(workspaceHost);
  if (own) used.delete(own.subnet);
  let dnsPlan = resolveInternalDnsPlan(n, used, workspaceHost);
  // Ensure product file exists (idempotent rewrite from renderer).
  await writeProductComposeFile(composeFile);

  const project = composeProjectName(n);
  const env = composeComputerEnv(n, workspaceHost, dnsPlan, workspaceGid);
  // compose needs cwd = project dir so relative seccomp path resolves
  try {
    await runCompose(cli, composeUpArgs(composeFile, project), {
      cwd: projectDir,
      env,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isPoolOverlapMessage(msg)) throw e;
    used.add(dnsPlan.subnet);
    dnsPlan = forceAllocateInternalDnsPlan(n, used, workspaceHost);
    await runCompose(cli, composeUpArgs(composeFile, project), {
      cwd: projectDir,
      env: composeComputerEnv(n, workspaceHost, dnsPlan, workspaceGid),
    });
  }

  return { computer_id: n, name: n, capabilities: caps };
}

export async function destroyComputerCompose(
  name: string,
  life: ComposeLifecycleOpts & { keepProfile?: boolean } = {},
): Promise<void> {
  const n = sanitizeComputerName(name);
  const { cli, composeFile, projectDir } = await resolveComposeCli(life);
  const workspaceHost = workspaceHostPath(
    n,
    life.workspaceRoot ?? defaultWorkspaceRoot(),
  );
  const removeVolumes = life.keepProfile === false;
  await runCompose(
    cli,
    composeDownArgs(composeFile, composeProjectName(n), removeVolumes),
    {
      cwd: projectDir,
      env: composeComputerEnv(
        n,
        workspaceHost,
        loadPersistedInternalDnsPlan(workspaceHost) ?? {
          subnet: INTERNAL_DNS_SUBNET,
          proxyIp: INTERNAL_PROXY_IP,
        },
      ),
    },
  );
}

async function runCompose(
  cli: DockerCli,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(cli.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: opts.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `${cli.binary} ${args.join(" ")} failed (${code}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolvePromise(stdout);
    });
  });
}
