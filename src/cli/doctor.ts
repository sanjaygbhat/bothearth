/**
 * Security audit + `modelbot doctor`.
 * Nonzero exit on: docker.sock mount, public bind, tag-only image.
 */

import { existsSync } from "node:fs";
import { verifyAuditFile } from "../audit/verify.ts";
import {
  applyLegacyTemplate,
  loadConfigDoc,
  loadModelbotYamlFile,
  templateMigrationLines,
} from "../config/load.ts";
import { daemonLogPath } from "../daemon/log.ts";
import { isDeniedAddress } from "../proxy/policy.ts";
import { detectRuntime } from "../sandbox/detect.ts";
import { createDockerCli, type DockerCli } from "../sandbox/docker.ts";
import { DEFAULT_LIMITS, LABEL_COMPUTER, parseDockerMemoryBytes } from "../sandbox/flags.ts";
import { limitsFromSandboxYaml } from "../sandbox/lifecycle.ts";
import { resolveAuditVerifyKey } from "./audit-key.ts";
import {
  configPath,
  defaultDataDir,
  expandHome,
  modelbotHome,
  tokensPath,
} from "./paths.ts";
import {
  classifyStartupError,
  type RecoveryAction,
} from "./startup-error.ts";
import { readTokensFile } from "./tokens.ts";

type AuditSeverity = "PASS" | "FAIL" | "WARN" | "INFO";

interface AuditCheck {
  id: string;
  severity: AuditSeverity;
  detail: string;
  /** Present when the app can offer the user a specific way out (`doctor --json`). */
  action?: RecoveryAction;
}

interface VaultUnlockResult {
  ok: boolean;
  detail: string;
  action?: RecoveryAction;
}

interface ContainerInspectLike {
  Name?: string;
  Config?: { Image?: string };
  HostConfig?: {
    Privileged?: boolean;
    ReadonlyRootfs?: boolean;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    IpcMode?: string;
    NetworkMode?: string;
    PidMode?: string;
    Devices?: unknown[];
    ShmSize?: number;
    Binds?: string[] | null;
    Mounts?: Array<{ Source?: string; Destination?: string }>;
  };
  Mounts?: Array<{ Source?: string; Destination?: string }>;
}

export interface SecurityAuditInput {
  bind: string;
  port: number;
  mcpTokenPresent: boolean;
  bootstrapTokenPresent: boolean;
  vaultMode: "auto" | "passphrase" | "missing";
  vaultPath?: string;
  /**
   * Result of actually unlocking the vault. Undefined = not attempted (unit tests that
   * only exercise the pure audit rules); the CLI always attempts it.
   */
  vaultUnlock?: VaultUnlockResult;
  images: string[];
  containers: ContainerInspectLike[];
  /** Omitted for injected fixtures; a failed live inspection must not imply safety. */
  containerInspection?: { ok: boolean; detail: string };
  proxyDenylistActive: boolean;
  auditChain: { ok: boolean; detail: string };
  allowPublicBind?: boolean;
  /** Resolved `policy.gates`. Empty (the default) is off. */
  policyGates?: readonly string[];
  /** `modelbot.yaml` path, for the on-line that names where the list lives. */
  configPath?: string;
  /** Loaded `policy.kill_switch`. True means evaluateGate will deny acting tools. */
  killSwitch?: boolean;
  /**
   * Docker `info` MemTotal bytes. Omitted = fixtures that do not check host RAM.
   * `null` = live inspect could not read MemTotal.
   */
  dockerMemTotalBytes?: number | null;
  /** Injected browser memory. Omit to use the 4g create default. */
  browserMemory?: string;
  /** Injected shell memory. Omit to use the 512m create default. */
  shellMemory?: string;
  /** Plain lines from an unversioned yaml that still holds old template values. */
  templateMigrations?: string[];
}

export function killSwitchTrueWarning(configPath: string): string {
  return `policy.kill_switch is true in ${configPath}; the bot will refuse state-changing actions`;
}

const GIB = 1024 ** 3;

function formatGiB(bytes: number): string {
  return `${Number((bytes / GIB).toFixed(2))} GiB`;
}

/** WARN copy when Docker MemTotal is below browser+shell limits plus 1 GiB. */
export function dockerMemoryHeadroomWarning(
  memTotalBytes: number,
  browserMemory: string,
  shellMemory: string,
): string | null {
  const browser = parseDockerMemoryBytes(browserMemory);
  const shell = parseDockerMemoryBytes(shellMemory);
  if (browser === undefined || shell === undefined) return null;
  const need = browser + shell + GIB;
  if (memTotalBytes >= need) return null;
  return `Docker total memory is ${formatGiB(memTotalBytes)}; browser ${browserMemory} + shell ${shellMemory} + 1g headroom needs ${formatGiB(need)}. Raise Docker's memory.`;
}

export function isPublicBind(bind: string): boolean {
  const b = bind.trim().toLowerCase();
  return b === "0.0.0.0" || b === "::" || b === "[::]" || b === "*";
}

/** Tag-only (no digest) → FAIL for security audit (except MVP `:dev`). */
export function isTagOnlyImage(image: string): boolean {
  const img = image.trim();
  if (!img) return true;
  if (img.includes("@sha256:")) return false;
  if (/^sha256:[0-9a-f]{64}$/i.test(img)) return false;
  return true;
}

/** arm64 MVP local tags — digest-pin at release (DECISIONS / ARCH §3). */
function isMvpDevTag(image: string): boolean {
  const img = image.trim();
  if (!img || img.includes("@sha256:")) return false;
  return /:dev$/i.test(img);
}

export function mountsDockerSock(c: ContainerInspectLike): boolean {
  const mounts = [...(c.Mounts ?? []), ...(c.HostConfig?.Mounts ?? [])];
  for (const m of mounts) {
    const src = (m.Source ?? "").toLowerCase();
    const dst = (m.Destination ?? "").toLowerCase();
    if (src.includes("docker.sock") || dst.includes("docker.sock")) {
      return true;
    }
  }
  for (const b of c.HostConfig?.Binds ?? []) {
    if (b.toLowerCase().includes("docker.sock")) return true;
  }
  return false;
}

function hardeningProblems(c: ContainerInspectLike): string[] {
  const problems: string[] = [];
  const hc = c.HostConfig ?? {};
  if (hc.Privileged) problems.push("privileged");
  if (hc.ReadonlyRootfs !== true) problems.push("readonly_rootfs=false");
  const caps = (hc.CapDrop ?? []).map((x) => x.toUpperCase());
  if (!caps.includes("ALL")) problems.push("cap_drop_missing_ALL");
  const sec = (hc.SecurityOpt ?? []).map((x) => x.toLowerCase());
  if (!sec.some((s) => s.includes("no-new-privileges"))) {
    problems.push("no_new_privileges_missing");
  }
  if ((hc.IpcMode ?? "").toLowerCase() === "host") problems.push("ipc_host");
  if ((hc.NetworkMode ?? "").toLowerCase() === "host") problems.push("network_host");
  if ((hc.PidMode ?? "").toLowerCase() === "host") problems.push("pid_host");
  if ((hc.Devices ?? []).length > 0) problems.push("host_devices");
  // The lifecycle names browser containers with this suffix. Shell/proxy use the
  // runtime's normal 64 MiB; only Chromium needs the larger shared-memory mount.
  const shm = hc.ShmSize ?? 0;
  if (c.Name?.endsWith("-browser") && shm < 512 * 1024 * 1024) {
    problems.push(`shm_too_small=${shm}`);
  }
  return problems;
}

export function runSecurityAudit(input: SecurityAuditInput): AuditCheck[] {
  const out: AuditCheck[] = [];

  for (const line of input.templateMigrations ?? []) {
    out.push({ id: "template_migration", severity: "INFO", detail: line });
  }

  if (isPublicBind(input.bind) && !input.allowPublicBind) {
    out.push({
      id: "bind",
      severity: "FAIL",
      detail: `public bind ${input.bind}:${input.port}`,
    });
  } else {
    out.push({
      id: "bind",
      severity: "PASS",
      detail: `${input.bind}:${input.port}`,
    });
  }

  out.push({
    id: "tokens",
    severity:
      input.mcpTokenPresent && input.bootstrapTokenPresent ? "PASS" : "FAIL",
    detail: `mcp=${input.mcpTokenPresent ? "yes" : "no"} bootstrap=${input.bootstrapTokenPresent ? "yes" : "no"}`,
  });

  let sockHit = false;
  const hardenFails: string[] = [];
  const inspectionFailed = input.containerInspection?.ok === false;
  if (input.containerInspection) {
    out.push({
      id: "container_runtime",
      severity: inspectionFailed ? "FAIL" : "PASS",
      detail: input.containerInspection.detail,
    });
  }
  for (const c of input.containers) {
    const name = c.Name ?? "unknown";
    if (mountsDockerSock(c)) {
      sockHit = true;
      out.push({
        id: "docker.sock",
        severity: "FAIL",
        detail: `mounted in ${name}`,
      });
    }
    const probs = hardeningProblems(c);
    if (probs.length) hardenFails.push(`${name}: ${probs.join(",")}`);
  }
  if (!sockHit) {
    out.push({
      id: "docker.sock",
      severity: inspectionFailed ? "WARN" : input.containers.length ? "PASS" : "INFO",
      detail: inspectionFailed
        ? "not checked (container inspection unavailable)"
        : `none in ${input.containers.length} container(s)`,
    });
  }
  out.push({
    id: "hardening",
    severity: hardenFails.length ? "FAIL" : inspectionFailed ? "WARN" : input.containers.length ? "PASS" : "INFO",
    detail:
      inspectionFailed && hardenFails.length === 0
        ? "not checked (container inspection unavailable)"
        : hardenFails.length === 0
        ? input.containers.length
          ? "ok"
          : "n/a (no containers)"
        : hardenFails.join("; "),
  });

  const images = [...new Set([
    ...input.images,
    ...input.containers.map((c) => c.Config?.Image).filter((image): image is string => Boolean(image)),
  ])];
  const tagOnly = images.filter(isTagOnlyImage);
  const releaseTagOnly = tagOnly.filter((img) => !isMvpDevTag(img));
  const mvpDevTags = tagOnly.filter(isMvpDevTag);
  if (releaseTagOnly.length) {
    out.push({
      id: "image_digest",
      severity: "FAIL",
      detail: `tag-only: ${releaseTagOnly.join(", ")}`,
    });
  } else if (mvpDevTags.length) {
    out.push({
      id: "image_digest",
      severity: "PASS",
      detail: `mvp-dev-tags: ${mvpDevTags.join(", ")}`,
    });
  } else {
    out.push({
      id: "image_digest",
      severity: "PASS",
      detail: images.length ? "digest-pinned" : "n/a",
    });
  }

  out.push({
    id: "proxy_denylist",
    severity: input.proxyDenylistActive ? "PASS" : "FAIL",
    detail: input.proxyDenylistActive ? "active" : "inactive",
  });

  // File existence is not health: a `vault: PASS` once showed for a vault the daemon
  // could not decrypt. A PASS here means the master key really opened it.
  const vaultWhere = input.vaultPath ? ` path=${input.vaultPath}` : "";
  if (input.vaultUnlock && !input.vaultUnlock.ok) {
    out.push({
      id: "vault",
      severity: "FAIL",
      detail: `${input.vaultUnlock.detail}${vaultWhere}`,
      action: input.vaultUnlock.action,
    });
  } else {
    out.push({
      id: "vault",
      severity: input.vaultMode === "missing" ? "WARN" : "PASS",
      detail: `${input.vaultMode}${input.vaultUnlock?.ok ? " unlocked" : ""}${vaultWhere}`,
    });
  }

  out.push({
    id: "audit_chain",
    severity: input.auditChain.ok ? "PASS" : "FAIL",
    detail: input.auditChain.detail,
  });

  const gates = input.policyGates ?? [];
  out.push({
    id: "ask_before_sensitive",
    severity: "PASS",
    detail: gates.length === 0
      ? "off"
      : `on (policy.gates in ${input.configPath}: ${gates.join(", ")}) — turn off in Settings → Sensitive actions`,
  });

  if (input.killSwitch) {
    out.push({
      id: "kill_switch",
      severity: "WARN",
      detail: killSwitchTrueWarning(input.configPath ?? "modelbot.yaml"),
    });
  }

  const browserMemory = input.browserMemory ?? DEFAULT_LIMITS.browserMemory;
  const shellMemory = input.shellMemory ?? DEFAULT_LIMITS.shellMemory;
  if (typeof input.dockerMemTotalBytes === "number") {
    const warn = dockerMemoryHeadroomWarning(input.dockerMemTotalBytes, browserMemory, shellMemory);
    out.push(
      warn
        ? { id: "docker_memory", severity: "WARN", detail: warn }
        : {
            id: "docker_memory",
            severity: "PASS",
            detail: `MemTotal ${formatGiB(input.dockerMemTotalBytes)} covers browser ${browserMemory} + shell ${shellMemory} + 1g`,
          },
    );
  } else if (input.dockerMemTotalBytes === null) {
    out.push({
      id: "docker_memory",
      severity: "INFO",
      detail: "Docker MemTotal unavailable",
    });
  }

  return out;
}

function resolveDoctorLogPath(opts: DoctorLoadOpts): string {
  const home = modelbotHome(opts.home);
  const cfgFile = opts.configFile ?? process.env.MODELBOT_CONFIG ?? configPath(home);
  let dataDir = defaultDataDir();
  if (existsSync(cfgFile)) {
    const doc = loadConfigDoc(cfgFile);
    if (typeof doc.data_dir === "string") dataDir = doc.data_dir;
  }
  return daemonLogPath(expandHome(process.env.MODELBOT_DATA_DIR ?? dataDir));
}

export function formatDoctorReport(checks: AuditCheck[], logFile?: string): string {
  const lines = ["modelbot doctor"];
  if (logFile) lines.push(`log: ${logFile}`);
  for (const c of checks) {
    if (c.id === "kill_switch" || c.id === "template_migration") lines.push(c.detail);
    else if (c.id === "ask_before_sensitive") {
      lines.push(`Ask before sensitive actions: ${c.detail}`);
    } else {
      lines.push(`${c.id}: ${c.severity} ${c.detail}`);
    }
  }
  const failed = checks.filter((c) => c.severity === "FAIL");
  lines.push(
    failed.length ? `RESULT: FAIL (${failed.length})` : "RESULT: PASS",
  );
  return `${lines.join("\n")}\n`;
}

function auditExitCode(checks: AuditCheck[]): number {
  return checks.some((c) => c.severity === "FAIL") ? 1 : 0;
}

function proxyDenylistSelfCheck(): boolean {
  const samples = [
    "169.254.169.254",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "::",
    "::1",
    "64:ff9b::7f00:1",
  ];
  return samples.every((ip) => isDeniedAddress(ip).denied);
}

interface DoctorLoadOpts {
  home?: string;
  configFile?: string;
  containers?: ContainerInspectLike[];
  cli?: Pick<DockerCli, "run">;
  images?: string[];
  auditKey?: Buffer | string;
  allowPublicBind?: boolean;
  dockerMemTotalBytes?: number | null;
}

// Project only fields used by this audit. Never retrieve Config.Env or other
// container configuration that can contain credentials.
const CONTAINER_INSPECT_FORMAT = '{"Name":{{json .Name}},"Config":{"Image":{{json .Config.Image}}},"HostConfig":{'
  + ["Privileged", "ReadonlyRootfs", "CapDrop", "SecurityOpt", "IpcMode", "NetworkMode", "PidMode", "Devices", "ShmSize"]
    .map((field) => `"${field}":{{json .HostConfig.${field}}}`).join(",")
  + '},"Mounts":[{{range $i, $mount := .Mounts}}{{if $i}},{{end}}{"Source":{{json $mount.Source}},"Destination":{{json $mount.Destination}}}{{end}}]}';

async function buildDoctorInputFromDisk(
  opts: DoctorLoadOpts = {},
): Promise<SecurityAuditInput> {
  const home = modelbotHome(opts.home);
  const cfgFile = opts.configFile ?? process.env.MODELBOT_CONFIG ?? configPath(home);
  let bind = "127.0.0.1";
  let port = 7777;
  let vaultMode: SecurityAuditInput["vaultMode"] = "missing";
  let vaultPath: string | undefined;
  let images: string[] = opts.images ?? [];
  let auditFile: string | undefined;
  let containers = opts.containers ?? [];
  let containerInspection: SecurityAuditInput["containerInspection"];
  let policyGates: string[] = [];
  let killSwitch = false;
  let browserMemory = DEFAULT_LIMITS.browserMemory;
  let shellMemory = DEFAULT_LIMITS.shellMemory;
  let dockerMemTotalBytes: number | null | undefined = opts.dockerMemTotalBytes;
  let templateMigrations: string[] = [];

  if (opts.containers === undefined) {
    try {
      const cli = opts.cli ?? createDockerCli(await detectRuntime());
      const ids = (await cli.run(["ps", "--all", "--quiet", "--filter", `label=${LABEL_COMPUTER}`]))
        .trim().split(/\s+/).filter(Boolean);
      if (ids.some((id) => !/^[0-9a-f]{12,64}$/i.test(id))) throw new Error("invalid container IDs");
      if (ids.length) {
        const output = await cli.run(["inspect", "--format", CONTAINER_INSPECT_FORMAT, ...ids]);
        const inspected = output.trim().split(/\r?\n/).filter(Boolean)
          .map((line) => JSON.parse(line) as ContainerInspectLike);
        if (inspected.length !== ids.length || inspected.some((c) => !c?.Name || !c.Config?.Image || !c.HostConfig)) {
          throw new Error("incomplete container inspection");
        }
        containers = inspected;
      }
      containerInspection = { ok: true, detail: `inspected ${containers.length} managed container(s), including stopped` };
    } catch {
      containerInspection = { ok: false, detail: "could not inspect managed containers; check that the container runtime is running and reachable" };
    }
  }

  if (dockerMemTotalBytes === undefined && opts.cli === undefined && opts.containers === undefined) {
    try {
      const cli = createDockerCli(await detectRuntime());
      const raw = (await cli.run(["info", "--format", "{{.MemTotal}}"])).trim();
      const n = Number(raw);
      dockerMemTotalBytes = Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      dockerMemTotalBytes = null;
    }
  }

  if (existsSync(cfgFile)) {
    const raw = loadModelbotYamlFile(cfgFile) as Record<string, unknown>;
    templateMigrations = templateMigrationLines(raw);
    const migrated = applyLegacyTemplate(raw) as Record<string, unknown>;
    const lim = { ...DEFAULT_LIMITS, ...limitsFromSandboxYaml(migrated.sandbox) };
    browserMemory = lim.browserMemory;
    shellMemory = lim.shellMemory;
    const doc = loadConfigDoc(cfgFile);
    if (typeof doc.bind === "string") bind = doc.bind;
    if (typeof doc.port === "number") port = doc.port;
    const vault = doc.vault as
      | { path?: string; keychain?: string }
      | undefined;
    if (vault?.path) vaultPath = expandHome(vault.path);
    if (vault?.keychain === "passphrase") vaultMode = "passphrase";
    else if (vault?.keychain) vaultMode = "auto";
    if (vaultPath && !existsSync(vaultPath)) vaultMode = "missing";
    const audit = doc.audit as { path?: string } | undefined;
    if (audit?.path) auditFile = expandHome(audit.path);
    if (!opts.images) {
      const sandbox = doc.sandbox as
        | { image_browser?: string; image_shell?: string }
        | undefined;
      images = [sandbox?.image_browser, sandbox?.image_shell].filter(
        (x): x is string => Boolean(x),
      );
    }
    const policy = doc.policy as { gates?: unknown; kill_switch?: unknown } | undefined;
    if (Array.isArray(policy?.gates)) {
      policyGates = policy.gates.filter((g): g is string => typeof g === "string");
    }
    killSwitch = policy?.kill_switch === true;
  }

  const tokens = readTokensFile(tokensPath(home));
  const mcpTokenPresent = Boolean(
    process.env.MODELBOT_MCP_TOKEN ||
      process.env.MODELBOT_TOKEN ||
      tokens?.mcp_token,
  );
  const bootstrapTokenPresent = Boolean(
    process.env.MODELBOT_BOOTSTRAP_TOKEN ||
      tokens?.bootstrap_token ||
      tokens?.bootstrap_token_hash,
  );

  let auditChain = { ok: true, detail: "n/a (no file)" };
  if (auditFile && existsSync(auditFile)) {
    try {
      const key = opts.auditKey ?? await resolveAuditVerifyKey({ config: cfgFile });
      const result = verifyAuditFile(key, auditFile);
      auditChain = result.ok
        ? { ok: true, detail: `OK ${result.records} records` }
        : {
            ok: false,
            detail: `FAIL seq=${result.seq ?? "?"} ${result.reason}`,
          };
    } catch {
      auditChain = { ok: false, detail: "could not unlock the configured audit key; check vault access" };
    }
  }

  return {
    bind,
    port,
    mcpTokenPresent,
    bootstrapTokenPresent,
    vaultMode,
    vaultPath,
    images,
    containers,
    containerInspection,
    proxyDenylistActive: proxyDenylistSelfCheck(),
    auditChain,
    allowPublicBind: opts.allowPublicBind,
    policyGates,
    killSwitch,
    configPath: cfgFile,
    dockerMemTotalBytes,
    browserMemory,
    shellMemory,
    templateMigrations,
  };
}

/**
 * Opens the vault for real and reads its entry names. Listing forces a full decrypt,
 * and the master key it decrypts with was just read back out of the OS keychain — so a
 * PASS proves both halves of what the daemon needs at startup, which is precisely what
 * the old existence check could not tell anyone.
 */
export async function checkVaultUnlock(
  vaultPath: string,
  keychain: "auto" | "passphrase",
  homeOpt?: string,
): Promise<VaultUnlockResult> {
  const { openVault } = await import("../vault/vault.ts");
  try {
    const vault = await openVault({ path: vaultPath, keychain });
    const names = await vault.list();
    return { ok: true, detail: `${keychain} unlocked ${names.length} entries` };
  } catch (err) {
    // Same wording and same recovery id the daemon prints when it dies on this.
    const failure = classifyStartupError(err, homeOpt);
    return { ok: false, detail: failure.message, action: failure.action };
  }
}

function parseDoctorFlags(argv: string[]): DoctorLoadOpts & { json?: boolean } {
  const out: DoctorLoadOpts & { json?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home" && argv[i + 1]) {
      out.home = argv[++i];
    } else if (argv[i] === "--config" && argv[i + 1]) {
      out.configFile = argv[++i];
    } else if (argv[i] === "--json") {
      out.json = true;
    }
  }
  return out;
}

/** `doctor --json` — one object the Mac app can act on without parsing prose. */
function formatDoctorJson(checks: AuditCheck[], logFile: string): string {
  return `${JSON.stringify(
    {
      result: auditExitCode(checks) ? "FAIL" : "PASS",
      checks,
      log: logFile,
    },
    null,
    2,
  )}\n`;
}

export async function runDoctorCli(
  argv: string[] = [],
  opts: DoctorLoadOpts = {},
): Promise<number> {
  const { json, ...flags } = parseDoctorFlags(argv);
  const load = { ...opts, ...flags };
  // Runtime/tool resolution emits diagnostics through console.log. Keep the CLI's
  // machine-readable stdout to one report, even on hosts with missing tools.
  const log = console.log;
  if (json) console.log = console.error;
  try {
    const input = await buildDoctorInputFromDisk(load);
    // Only "auto" (OS keychain / env key) can be unlocked unattended. A passphrase host
    // keeps the old existence-only PASS: doctor has no passphrase to try, and prompting
    // for one would turn a diagnostic into an interactive command.
    if (input.vaultPath && input.vaultMode === "auto") {
      input.vaultUnlock = await checkVaultUnlock(input.vaultPath, "auto", load.home);
    }
    const checks = runSecurityAudit(input);
    const logFile = resolveDoctorLogPath(load);
    process.stdout.write(json ? formatDoctorJson(checks, logFile) : formatDoctorReport(checks, logFile));
    return auditExitCode(checks);
  } finally {
    if (json) console.log = log;
  }
}
