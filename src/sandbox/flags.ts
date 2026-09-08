/**
 * Pure docker argv builders — golden-tested (no docker calls).
 * Subnet probe/persist helpers take a DockerCli; argv builders stay pure.
 * Hardening flags: ARCHITECTURE §9 + DECISIONS R2.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DockerCli } from "./docker.ts";
import { resourceNames } from "./names.ts";

export const DEFAULT_BROWSER_IMAGE = "modelbot/computer:dev";
export const DEFAULT_SHELL_IMAGE = "modelbot/shell:dev";
export const DEFAULT_PROXY_IMAGE = "modelbot/proxy:dev";

const INTERNAL_DNS_FILE = "internal-dns.json";
const INTERNAL_SUBNET_RE = /^10\.233\.(\d+)\.0\/24$/;
const OCTET_COUNT = 254;

export interface InternalDnsPlan {
  subnet: string;
  proxyIp: string;
}

function dnsPlanFromOctet(oct: number): InternalDnsPlan {
  if (!Number.isInteger(oct) || oct < 1 || oct > OCTET_COUNT) {
    throw new Error(`E_INTERNAL_DNS: invalid octet ${oct}`);
  }
  return { subnet: `10.233.${oct}.0/24`, proxyIp: `10.233.${oct}.2` };
}

export function octetFromInternalSubnet(subnet: string): number | undefined {
  const m = INTERNAL_SUBNET_RE.exec(subnet);
  if (!m) return undefined;
  const oct = Number(m[1]);
  if (oct < 1 || oct > OCTET_COUNT) return undefined;
  return oct;
}

function hashPreferredOctet(computerName: string): number {
  const n = computerName.replace(/[^a-zA-Z0-9-]/g, "") || "x";
  let h = 2166136261;
  for (let i = 0; i < n.length; i++) {
    h ^= n.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 1 + (h % OCTET_COUNT);
}

function usedOctetsOf(used: Iterable<string | number>): Set<number> {
  const out = new Set<number>();
  for (const u of used) {
    if (typeof u === "number") {
      if (u >= 1 && u <= OCTET_COUNT) out.add(u);
      continue;
    }
    const oct = octetFromInternalSubnet(u);
    if (oct !== undefined) out.add(oct);
  }
  return out;
}

/**
 * Per-computer internal DNS subnet in 10.233.0.0/16 (avoids Docker 172.17–31).
 * Prefers the name hash, then walks 1..254 skipping `used` (subnets or octets).
 */
export function internalDnsPlan(
  computerName: string,
  used: Iterable<string | number> = [],
): InternalDnsPlan {
  const taken = usedOctetsOf(used);
  const preferred = hashPreferredOctet(computerName);
  for (let i = 0; i < OCTET_COUNT; i++) {
    const oct = 1 + ((preferred - 1 + i) % OCTET_COUNT);
    if (!taken.has(oct)) return dnsPlanFromOctet(oct);
  }
  throw new Error("E_INTERNAL_DNS: no free 10.233.x.0/24");
}

export function parseUsedInternalSubnets(inspectJson: string): Set<string> {
  const used = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectJson);
  } catch {
    return used;
  }
  const nets = Array.isArray(parsed) ? parsed : [parsed];
  for (const net of nets) {
    if (!net || typeof net !== "object") continue;
    const configs = (net as { IPAM?: { Config?: Array<{ Subnet?: string }> | null } })
      .IPAM?.Config;
    if (!Array.isArray(configs)) continue;
    for (const c of configs) {
      const s = c?.Subnet;
      if (typeof s === "string" && octetFromInternalSubnet(s) !== undefined) {
        used.add(s);
      }
    }
  }
  return used;
}

export async function probeUsedInternalSubnets(cli: DockerCli): Promise<Set<string>> {
  const ls = await cli.run(["network", "ls", "-q"]);
  const ids = ls.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const used = new Set<string>();
  for (const id of ids) {
    try {
      const json = await cli.run(["network", "inspect", id]);
      for (const s of parseUsedInternalSubnets(json)) used.add(s);
    } catch {
      /* id vanished between ls and inspect */
    }
  }
  return used;
}

function internalDnsPlanPath(workspaceHost: string): string {
  return join(dirname(workspaceHost), INTERNAL_DNS_FILE);
}

export function loadPersistedInternalDnsPlan(
  workspaceHost: string,
): InternalDnsPlan | undefined {
  try {
    const raw = JSON.parse(readFileSync(internalDnsPlanPath(workspaceHost), "utf8")) as {
      subnet?: unknown;
      proxyIp?: unknown;
    };
    if (typeof raw.subnet !== "string") return undefined;
    const oct = octetFromInternalSubnet(raw.subnet);
    if (oct === undefined) return undefined;
    return dnsPlanFromOctet(oct);
  } catch {
    return undefined;
  }
}

function persistInternalDnsPlan(
  workspaceHost: string,
  plan: InternalDnsPlan,
): void {
  const path = internalDnsPlanPath(workspaceHost);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function collectPersistedInternalSubnets(workspaceRoot: string): Set<string> {
  const used = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(workspaceRoot);
  } catch {
    return used;
  }
  for (const name of names) {
    const plan = loadPersistedInternalDnsPlan(join(workspaceRoot, name, "workspace"));
    if (plan) used.add(plan.subnet);
  }
  return used;
}

export function isPoolOverlapMessage(msg: string): boolean {
  return /pool overlaps/i.test(msg);
}

/** Allocate a fresh plan (ignore persist) and write it. */
export function forceAllocateInternalDnsPlan(
  computerName: string,
  used: Iterable<string | number> = [],
  workspaceHost?: string,
): InternalDnsPlan {
  const plan = internalDnsPlan(computerName, used);
  if (workspaceHost) persistInternalDnsPlan(workspaceHost, plan);
  return plan;
}

/**
 * Reuse persist only when its subnet is not in `used` (caller should omit this
 * computer's own persist file from `used`). Else allocate and persist.
 */
export function resolveInternalDnsPlan(
  computerName: string,
  used: Iterable<string | number> = [],
  workspaceHost?: string,
): InternalDnsPlan {
  const taken = usedOctetsOf(used);
  if (workspaceHost) {
    const persisted = loadPersistedInternalDnsPlan(workspaceHost);
    if (persisted) {
      const oct = octetFromInternalSubnet(persisted.subnet);
      if (oct !== undefined && !taken.has(oct)) return persisted;
    }
  }
  const plan = internalDnsPlan(computerName, taken);
  if (workspaceHost) persistInternalDnsPlan(workspaceHost, plan);
  return plan;
}

/** Test-stack defaults; product stacks use `internalDnsPlan(name)`. */
export const INTERNAL_DNS_SUBNET = "10.233.77.0/24";
export const INTERNAL_PROXY_IP = "10.233.77.2";

export const LABEL_COMPUTER = "modelbot.computer";

/** Dockerfile.computer `useradd --uid 1001 browser`; compose `user: 1001:1001`. */
export const BROWSER_UID = 1001;
export const BROWSER_GID = 1001;
const BROWSER_USER = `${BROWSER_UID}:${BROWSER_GID}`;
const BROWSER_QUARANTINE_PATH = "/quarantine";
const BROWSER_QUARANTINE_TMPFS =
  `${BROWSER_QUARANTINE_PATH}:rw,noexec,nosuid,nodev,size=128m,mode=0700,uid=1001,gid=1001`;

export const PROXY_ENV: ReadonlyArray<readonly [string, string]> = [
  ["HTTP_PROXY", "http://proxy:3128"],
  ["HTTPS_PROXY", "http://proxy:3128"],
  ["http_proxy", "http://proxy:3128"],
  ["https_proxy", "http://proxy:3128"],
  ["MODELBOT_PROXY_SERVER", "http://proxy:3128"],
  ["NO_PROXY", "localhost,127.0.0.1"],
  ["no_proxy", "localhost,127.0.0.1"],
];

export interface HardeningLimits {
  browserMemory: string;
  browserCpus: number;
  browserPids: number;
  browserShm: string;
  shellMemory: string;
  shellCpus: number;
  shellPids: number;
}

export const DEFAULT_LIMITS: HardeningLimits = {
  browserMemory: "2g",
  browserCpus: 2,
  browserPids: 512,
  browserShm: "1g",
  shellMemory: "512m",
  shellCpus: 1,
  shellPids: 512,
};

export interface FlagBuildOpts {
  name: string;
  workspaceHost: string;
  workspaceGid?: number;
  seccompPath: string;
  browserImage?: string;
  shellImage?: string;
  proxyImage?: string;
  limits?: Partial<HardeningLimits>;
  dnsPlan?: InternalDnsPlan;
}

function dnsOf(name: string, plan?: InternalDnsPlan): InternalDnsPlan {
  return plan ?? internalDnsPlan(name);
}

function limitsOf(opts: FlagBuildOpts): HardeningLimits {
  return { ...DEFAULT_LIMITS, ...opts.limits };
}

/** Browser flags shared by product create and image-backed integration fixtures. */
export function browserRuntimeFlags(
  seccompPath: string,
  limits: HardeningLimits = DEFAULT_LIMITS,
): string[] {
  return [
    "--user",
    BROWSER_USER,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=512m",
    "--tmpfs",
    "/run:rw,noexec,nosuid,nodev,size=16m",
    "--tmpfs",
    BROWSER_QUARANTINE_TMPFS,
    "--shm-size",
    limits.browserShm,
    "--memory",
    limits.browserMemory,
    "--cpus",
    String(limits.browserCpus),
    "--pids-limit",
    String(limits.browserPids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--security-opt",
    `seccomp=${seccompPath}`,
    "--env",
    `MODELBOT_QUARANTINE=${BROWSER_QUARANTINE_PATH}`,
  ];
}

function labelArgs(name: string): string[] {
  return ["--label", `${LABEL_COMPUTER}=${resourceNames(name).name}`];
}

/**
 * Host time zone for the container: the browser reads `process.env.TZ` for
 * Playwright's `timezoneId`, and without it the container reports UTC while the
 * owner's IP geolocates elsewhere.
 */
function hostTimeZone(): string | undefined {
  const explicit = process.env.TZ?.trim();
  if (explicit) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function proxyEnvArgs(): string[] {
  const out: string[] = [];
  for (const [k, v] of PROXY_ENV) {
    out.push("--env", `${k}=${v}`);
  }
  const tz = hostTimeZone();
  if (tz) out.push("--env", `TZ=${tz}`);
  const bypass = process.env.MODELBOT_PROXY_BYPASS?.trim();
  if (bypass) out.push("--env", `MODELBOT_PROXY_BYPASS=${bypass}`);
  return out;
}

/**
 * Optional bind-mount of host TypeScript sources into the image layout so a dev
 * run picks up host edits without rebuilding modelbot/computer:dev. Mounts only
 * computer-server/src and src/ so the image's node_modules and playwright links
 * stay put. Set MODELBOT_TEST_DEV_ROOT to the repo root.
 */
function computerServerBindArgs(): string[] {
  const root = process.env.MODELBOT_TEST_DEV_ROOT?.trim();
  if (!root) return [];
  return [
    "--mount",
    `type=bind,source=${root}/computer-server/src,target=/opt/computer-server-root/computer-server/src,readonly`,
    "--mount",
    `type=bind,source=${root}/src,target=/opt/computer-server-root/src,readonly`,
  ];
}

export function networkCreateArgs(
  name: string,
  kind: "internal" | "egress",
  plan?: InternalDnsPlan,
): string[] {
  const r = resourceNames(name);
  const dns = dnsOf(r.name, plan);
  const args = ["network", "create", ...labelArgs(name)];
  if (kind === "internal") {
    args.push(
      "--internal",
      "--subnet",
      dns.subnet,
      r.networkInternal,
    );
  } else {
    args.push(r.networkEgress);
  }
  return args;
}

export function profileVolumeCreateArgs(name: string): string[] {
  const r = resourceNames(name);
  return ["volume", "create", ...labelArgs(name), r.volumeProfile];
}

/** Proxy sidecar create argv (attach egress at create; connect internal later). */
export function proxyCreateArgs(opts: FlagBuildOpts): string[] {
  const r = resourceNames(opts.name);
  const image = opts.proxyImage ?? DEFAULT_PROXY_IMAGE;
  return [
    "create",
    "--name",
    r.containerProxy,
    ...labelArgs(opts.name),
    "--network",
    r.networkEgress,
    "--restart",
    "unless-stopped",
    "--user",
    "1000:1000",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--log-driver",
    "json-file",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=3",
    image,
  ];
}

export function proxyConnectInternalArgs(
  name: string,
  plan?: InternalDnsPlan,
): string[] {
  const r = resourceNames(name);
  const dns = dnsOf(r.name, plan);
  return [
    "network",
    "connect",
    "--ip",
    dns.proxyIp,
    "--alias",
    "proxy",
    r.networkInternal,
    r.containerProxy,
  ];
}

/**
 * Browser container create argv — EXACT hardening from ARCHITECTURE §9.
 * Browser uid 1001:1001, profile named volume, workspace bind.
 */
export function browserCreateArgs(opts: FlagBuildOpts): string[] {
  const r = resourceNames(opts.name);
  const lim = limitsOf(opts);
  const image = opts.browserImage ?? DEFAULT_BROWSER_IMAGE;
  const plan = dnsOf(r.name, opts.dnsPlan);
  return [
    "create",
    "--name",
    r.containerBrowser,
    ...labelArgs(opts.name),
    "--network",
    r.networkInternal,
    "--dns",
    plan.proxyIp,
    "--add-host",
    `proxy:${plan.proxyIp}`,
    ...browserRuntimeFlags(opts.seccompPath, lim),
    "--group-add",
    String(opts.workspaceGid ?? BROWSER_GID),
    "--mount",
    `type=volume,source=${r.volumeProfile},target=/home/browser/profile`,
    "--mount",
    `type=bind,source=${opts.workspaceHost},target=/workspace`,
    "--env",
    "MODELBOT_WORKSPACE=/workspace",
    ...proxyEnvArgs(),
    ...computerServerBindArgs(),
    image,
  ];
}

/**
 * Shell container create argv — no profile, no shm, no published ports.
 * Agent uid 1002:1002.
 */
export function shellCreateArgs(opts: FlagBuildOpts): string[] {
  const r = resourceNames(opts.name);
  const lim = limitsOf(opts);
  const image = opts.shellImage ?? DEFAULT_SHELL_IMAGE;
  const plan = dnsOf(r.name, opts.dnsPlan);
  return [
    "create",
    "--name",
    r.containerShell,
    ...labelArgs(opts.name),
    "--network",
    r.networkInternal,
    "--dns",
    plan.proxyIp,
    "--add-host",
    `proxy:${plan.proxyIp}`,
    "--user",
    "1002:1002",
    "--group-add",
    String(opts.workspaceGid ?? BROWSER_GID),
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--memory",
    lim.shellMemory,
    "--cpus",
    String(lim.shellCpus),
    "--pids-limit",
    String(lim.shellPids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=bind,source=${opts.workspaceHost},target=/workspace`,
    ...proxyEnvArgs(),
    ...computerServerBindArgs(),
    image,
  ];
}

export function startArgs(container: string): string[] {
  return ["start", container];
}

export function stopArgs(container: string): string[] {
  return ["stop", container];
}

export function pauseArgs(container: string): string[] {
  return ["pause", container];
}

export function unpauseArgs(container: string): string[] {
  return ["unpause", container];
}

export function rmArgs(container: string): string[] {
  return ["rm", "-f", container];
}

export function networkRmArgs(network: string): string[] {
  return ["network", "rm", network];
}

export function volumeRmArgs(volume: string): string[] {
  return ["volume", "rm", volume];
}

export function execStdioArgs(
  container: string,
  entry: string[] = ["node", "/opt/computer-server/stdio.js"],
): string[] {
  return ["exec", "-i", container, ...entry];
}

export function inspectArgs(container: string): string[] {
  return ["inspect", container];
}

